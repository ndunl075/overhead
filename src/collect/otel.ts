/**
 * OpenTelemetry ingest for Claude Code (and GenAI-semconv) exports.
 *
 * Reads OTLP HTTP/JSON payloads dumped by a collector file exporter (or any
 * tool that writes ResourceLogs / ResourceSpans JSON). Primary signal is
 * Claude Code log events (`api_request` + `tool_result`); trace spans are a
 * fallback. Metrics alone have no file evidence, so they are ignored for
 * attribution (coverage still comes from the Admin API reconcile path).
 *
 * OTel's flat `cache_creation_tokens` does not split 5m vs 1h TTL. When the
 * event carries `cost_usd` we trust that dollar amount; otherwise cache writes
 * are priced as 5m (1.25×) — a known understatement for long-session agents.
 */

import fs from "node:fs";
import path from "node:path";

import {
  emptyUsage,
  type ModelPrice,
  type Session,
  type ToolKind,
  type Touch,
  type Turn,
  type Usage,
} from "../types.ts";
import { priceTurn } from "../pricing/cost.ts";
import {
  extractPathsFromCommand,
  extractPathsFromText,
  normalizePath,
} from "./paths.ts";
import { TOOL_WEIGHTS, PROMPT_WEIGHT, PROMPT_TOOL_NAME } from "./claude-code.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OtelCollectOptions {
  /** File or directory of OTLP JSON / NDJSON exports. */
  input: string;
  since?: string;
  repoRoot?: string;
  priceOpts?: { at?: Date; overrides?: Record<string, ModelPrice> };
}

export interface OtelCollectResult {
  sessions: Session[];
  stats: {
    files: number;
    events: number;
    spans: number;
    turns: number;
    sessions: number;
    skipped: number;
  };
}

export function collectOtel(opts: OtelCollectOptions): OtelCollectResult {
  const files = listOtelFiles(opts.input);
  const sessions = new Map<string, SessionBuilder>();
  let events = 0;
  let spans = 0;
  let skipped = 0;

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      skipped++;
      continue;
    }
    for (const payload of parseOtelPayloads(text)) {
      const fromLogs = ingestResourceLogs(payload, sessions, opts);
      events += fromLogs.events;
      skipped += fromLogs.skipped;
      const fromSpans = ingestResourceSpans(payload, sessions, opts);
      spans += fromSpans.spans;
      skipped += fromSpans.skipped;
    }
  }

  const out: Session[] = [];
  for (const b of sessions.values()) {
    const session = b.finish(opts);
    if (session.turns.length === 0) continue;
    if (opts.since && session.endedAt < opts.since) continue;
    out.push(session);
  }

  return {
    sessions: out,
    stats: {
      files: files.length,
      events,
      spans,
      turns: out.reduce((n, s) => n + s.turns.length, 0),
      sessions: out.length,
      skipped,
    },
  };
}

// ---------------------------------------------------------------------------
// File discovery + payload parsing
// ---------------------------------------------------------------------------

export function listOtelFiles(input: string): string[] {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) {
    throw new Error(`OTel input not found: ${abs}`);
  }
  const st = fs.statSync(abs);
  if (st.isFile()) return [abs];
  if (!st.isDirectory()) {
    throw new Error(`OTel input is neither a file nor a directory: ${abs}`);
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && /\.(json|jsonl|ndjson)$/i.test(ent.name)) {
        out.push(p);
      }
    }
  };
  walk(abs);
  out.sort();
  return out;
}

/** Split a file into one or more OTLP JSON objects (JSON, array, or NDJSON). */
export function parseOtelPayloads(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Whole-file JSON (object or array).
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed;
      return [parsed];
    } catch {
      // Fall through to NDJSON.
    }
  }
  const out: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OTLP attribute helpers
// ---------------------------------------------------------------------------

type AttrMap = Record<string, unknown>;

function anyValue(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if ("stringValue" in o) return o.stringValue;
  if ("intValue" in o) {
    const n = o.intValue;
    return typeof n === "string" ? Number(n) : n;
  }
  if ("doubleValue" in o) return o.doubleValue;
  if ("boolValue" in o) return o.boolValue;
  if ("arrayValue" in o) {
    const vals = (o.arrayValue as { values?: unknown[] })?.values ?? [];
    return vals.map(anyValue);
  }
  if ("kvlistValue" in o) {
    return attrsToMap(
      ((o.kvlistValue as { values?: unknown[] })?.values ?? []) as Array<{
        key?: string;
        value?: unknown;
      }>,
    );
  }
  if ("bytesValue" in o) return o.bytesValue;
  return v;
}

export function attrsToMap(
  attrs: Array<{ key?: string; value?: unknown }> | undefined,
): AttrMap {
  const out: AttrMap = {};
  if (!attrs) return out;
  for (const a of attrs) {
    if (!a?.key) continue;
    out[a.key] = anyValue(a.value);
  }
  return out;
}

function str(attrs: AttrMap, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = attrs[k];
    if (v == null) continue;
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return undefined;
}

function num(attrs: AttrMap, ...keys: string[]): number {
  for (const k of keys) {
    const v = attrs[k];
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function boolish(attrs: AttrMap, key: string): boolean {
  const v = attrs[key];
  if (v === true || v === 1) return true;
  if (typeof v === "string") return v.toLowerCase() === "true" || v === "1";
  return false;
}

function nanoToIso(nano: unknown): string | undefined {
  if (nano == null) return undefined;
  const n = typeof nano === "string" ? Number(nano) : Number(nano);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n / 1e6).toISOString();
}

function eventName(attrs: AttrMap): string | undefined {
  const raw =
    str(attrs, "event.name", "name") ??
    str(attrs, "eventName");
  if (!raw) return undefined;
  // Claude Code uses both `api_request` and `claude_code.api_request`.
  return raw.replace(/^claude_code\./, "");
}

function spanName(name: unknown): string {
  return typeof name === "string" ? name : "";
}

// ---------------------------------------------------------------------------
// Session builder
// ---------------------------------------------------------------------------

interface PendingTouch {
  promptId: string | null;
  ts: string;
  touches: Touch[];
}

class SessionBuilder {
  readonly id: string;
  readonly source = "otel";
  projectSlug = "otel";
  repoRoot: string | null = null;
  gitBranch: string | null = null;
  private turns = new Map<string, TurnDraft>();
  private pendingTouches: PendingTouch[] = [];
  private turnOrder: string[] = [];

  constructor(sessionId: string) {
    this.id = `otel:${sessionId}`;
  }

  addApiRequest(attrs: AttrMap, ts: string, opts: OtelCollectOptions): void {
    const requestId =
      str(attrs, "request_id", "gen_ai.response.id") ??
      str(attrs, "client_request_id") ??
      `${ts}:${str(attrs, "model", "gen_ai.request.model") ?? "unknown"}`;
    const turnKey = requestId;
    if (this.turns.has(turnKey)) return;

    const model =
      str(attrs, "model", "gen_ai.request.model") ?? "unknown";
    const usage = usageFromAttrs(attrs);
    const querySource = str(attrs, "query_source") ?? "";
    const isSidechain =
      Boolean(str(attrs, "agent_id")) ||
      /subagent|agent/i.test(querySource) ||
      querySource === "subagent";

    const draft: TurnDraft = {
      messageId: turnKey,
      ts,
      model,
      isSidechain,
      sidechainKey: str(attrs, "agent_id") ?? (isSidechain ? querySource : null),
      usage,
      promptId: str(attrs, "prompt.id") ?? null,
      costUsdHint: num(attrs, "cost_usd"),
      fast: str(attrs, "speed") === "fast" || boolish(attrs, "fast"),
      touches: [],
    };
    this.turns.set(turnKey, draft);
    this.turnOrder.push(turnKey);

    // Attach any tool evidence that arrived before this request for the same prompt.
    this.drainPendingTouches(draft);
  }

  addToolEvidence(attrs: AttrMap, ts: string, opts: OtelCollectOptions): void {
    const touches = touchesFromToolAttrs(attrs, opts.repoRoot);
    if (touches.length === 0) return;
    const promptId = str(attrs, "prompt.id") ?? null;
    // Prefer the latest turn sharing this prompt.id; else latest turn overall.
    const target = this.findTurnForPrompt(promptId) ?? this.latestTurn();
    if (target) {
      mergeTouches(target.touches, touches);
    } else {
      this.pendingTouches.push({ promptId, ts, touches });
    }
  }

  private findTurnForPrompt(promptId: string | null): TurnDraft | undefined {
    if (!promptId) return undefined;
    for (let i = this.turnOrder.length - 1; i >= 0; i--) {
      const t = this.turns.get(this.turnOrder[i]!);
      if (t?.promptId === promptId) return t;
    }
    return undefined;
  }

  private latestTurn(): TurnDraft | undefined {
    const id = this.turnOrder[this.turnOrder.length - 1];
    return id ? this.turns.get(id) : undefined;
  }

  private drainPendingTouches(draft: TurnDraft): void {
    if (this.pendingTouches.length === 0) return;
    const keep: PendingTouch[] = [];
    for (const p of this.pendingTouches) {
      if (p.promptId && draft.promptId && p.promptId === draft.promptId) {
        mergeTouches(draft.touches, p.touches);
      } else if (!p.promptId && !draft.promptId) {
        mergeTouches(draft.touches, p.touches);
      } else if (p.promptId && draft.promptId && p.promptId !== draft.promptId) {
        keep.push(p);
      } else {
        // Prompt mismatch unknown — attach to this turn as best effort if close in time.
        mergeTouches(draft.touches, p.touches);
      }
    }
    this.pendingTouches = keep;
  }

  finish(opts: OtelCollectOptions): Session {
    // Leftover tool evidence with no API request still has nowhere to go;
    // drop it rather than inventing zero-cost turns.
    const drafts = [...this.turns.values()].sort((a, b) =>
      a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
    );
    const turns: Turn[] = drafts.map((d, seq) => {
      let costUsd = 0;
      let priced = false;
      if (d.costUsdHint > 0) {
        costUsd = d.costUsdHint;
        priced = true;
      } else {
        const r = priceTurn(d.model, d.usage, {
          ...opts.priceOpts,
          fast: d.fast,
        });
        costUsd = r.costUsd;
        priced = r.priced;
      }
      return {
        id: `${this.id}:${d.messageId}`,
        sessionId: this.id,
        seq,
        ts: d.ts,
        model: d.model,
        isSidechain: d.isSidechain,
        sidechainKey: d.sidechainKey,
        usage: d.usage,
        costUsd,
        priced,
        touches: d.touches,
      };
    });

    const startedAt = turns[0]?.ts ?? new Date(0).toISOString();
    const endedAt = turns[turns.length - 1]?.ts ?? startedAt;
    return {
      id: this.id,
      source: this.source,
      projectSlug: this.projectSlug,
      repoRoot: opts.repoRoot ?? this.repoRoot,
      gitBranch: this.gitBranch,
      startedAt,
      endedAt,
      turns,
    };
  }
}

interface TurnDraft {
  messageId: string;
  ts: string;
  model: string;
  isSidechain: boolean;
  sidechainKey: string | null;
  usage: Usage;
  promptId: string | null;
  costUsdHint: number;
  fast: boolean;
  touches: Touch[];
}

function ensureSession(
  map: Map<string, SessionBuilder>,
  sessionId: string,
): SessionBuilder {
  let b = map.get(sessionId);
  if (!b) {
    b = new SessionBuilder(sessionId);
    map.set(sessionId, b);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Usage + touches
// ---------------------------------------------------------------------------

export function usageFromAttrs(attrs: AttrMap): Usage {
  const u = emptyUsage();
  // Prefer Anthropic-native flat names; also accept GenAI semconv.
  u.input = num(
    attrs,
    "input_tokens",
    "gen_ai.usage.input_tokens",
    "uncached_input_tokens",
  );
  // Some exporters put total input in gen_ai.usage.input_tokens including cache.
  // If both flat input and cache fields exist, flat input is the uncached portion.
  u.output = num(attrs, "output_tokens", "gen_ai.usage.output_tokens");
  u.cacheRead = num(
    attrs,
    "cache_read_tokens",
    "cache_read_input_tokens",
    "gen_ai.usage.cache_read_input_tokens",
    "gen_ai.usage.cached_tokens",
  );
  const cacheCreate = num(
    attrs,
    "cache_creation_tokens",
    "cache_creation_input_tokens",
    "gen_ai.usage.cache_creation_input_tokens",
  );
  // No TTL split in OTel — book as 5m (see module note).
  u.cacheWrite5m = cacheCreate;
  // If gen_ai total input includes cache and flat input was zero, peel cache out.
  if (
    u.input > 0 &&
    attrs["gen_ai.usage.input_tokens"] != null &&
    attrs["input_tokens"] == null
  ) {
    const peeled = u.input - u.cacheRead - u.cacheWrite5m;
    if (peeled >= 0) u.input = peeled;
  }
  return u;
}

function toolKind(name: string): { kind: ToolKind; weight: number } {
  return TOOL_WEIGHTS[name] ?? { kind: "other", weight: 0 };
}

export function touchesFromToolAttrs(
  attrs: AttrMap,
  repoRoot?: string,
): Touch[] {
  const toolName = str(attrs, "tool_name", "gen_ai.tool.name") ?? "unknown";
  const { kind, weight } = toolKind(toolName);
  const out: Touch[] = [];
  const seen = new Set<string>();
  const cwd = repoRoot ?? process.cwd();

  const add = (rawPath: string, w: number, k: ToolKind, name: string) => {
    if (!rawPath || w <= 0) return;
    const normalized = repoRoot
      ? normalizePath(rawPath, cwd, repoRoot)
      : normalizeLoose(rawPath);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({
      path: normalized,
      tool: k,
      toolName: name,
      weight: w,
    });
  };

  const filePath = str(attrs, "file_path");
  if (filePath) {
    add(
      filePath,
      weight || 0.5,
      kind === "other" ? "read" : kind,
      toolName,
    );
  }

  // tool_input / tool_parameters are JSON strings when OTEL_LOG_TOOL_DETAILS=1.
  for (const key of ["tool_input", "tool_parameters"] as const) {
    const raw = str(attrs, key);
    if (!raw) continue;
    let obj: Record<string, unknown> | null = null;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const fp = obj.file_path ?? obj.filePath;
    if (typeof fp === "string") add(fp, weight || 0.5, kind, toolName);
    if (typeof obj.path === "string" && (toolName === "Grep" || toolName === "Glob" || toolName === "Read")) {
      add(obj.path, weight || TOOL_WEIGHTS.Grep?.weight || 0.2, kind === "other" ? "search" : kind, toolName);
    }
    const cmd =
      (typeof obj.full_command === "string" && obj.full_command) ||
      (typeof obj.bash_command === "string" && obj.bash_command) ||
      (typeof obj.command === "string" && obj.command) ||
      "";
    if (cmd) {
      for (const p of extractPathsFromCommand(cmd)) {
        add(p, TOOL_WEIGHTS.Bash?.weight ?? 0.3, "shell", toolName);
      }
    }
  }

  const prompt = str(attrs, "prompt", "user_prompt");
  if (prompt && prompt !== "<redacted>" && !prompt.startsWith("<")) {
    for (const p of extractPathsFromText(prompt)) {
      add(p, PROMPT_WEIGHT, "prompt", PROMPT_TOOL_NAME);
    }
  }

  return out;
}

/** When no repo root is known, accept already-relative POSIX paths only. */
function normalizeLoose(raw: string): string | null {
  const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  if (p.includes("\0") || p.includes("://")) return null;
  return p;
}

function mergeTouches(into: Touch[], more: Touch[]): void {
  const seen = new Set(into.map((t) => `${t.path}|${t.toolName}`));
  for (const t of more) {
    const k = `${t.path}|${t.toolName}`;
    if (seen.has(k)) continue;
    seen.add(k);
    into.push(t);
  }
}

// ---------------------------------------------------------------------------
// ResourceLogs / ResourceSpans ingest
// ---------------------------------------------------------------------------

function ingestResourceLogs(
  payload: unknown,
  sessions: Map<string, SessionBuilder>,
  opts: OtelCollectOptions,
): { events: number; skipped: number } {
  let events = 0;
  let skipped = 0;
  const root = payload as {
    resourceLogs?: unknown[];
    resource_logs?: unknown[];
  };
  const bundles = root.resourceLogs ?? root.resource_logs ?? [];
  if (!Array.isArray(bundles)) return { events, skipped };

  for (const bundle of bundles) {
    const b = bundle as {
      scopeLogs?: unknown[];
      scope_logs?: unknown[];
    };
    const scopes = b.scopeLogs ?? b.scope_logs ?? [];
    for (const scope of scopes) {
      const s = scope as {
        logRecords?: unknown[];
        log_records?: unknown[];
      };
      const records = s.logRecords ?? s.log_records ?? [];
      for (const rec of records) {
        events++;
        const r = rec as {
          timeUnixNano?: unknown;
          time_unix_nano?: unknown;
          observedTimeUnixNano?: unknown;
          attributes?: Array<{ key?: string; value?: unknown }>;
          body?: unknown;
        };
        const attrs = attrsToMap(r.attributes);
        // Body may be a kvlist carrying the event payload.
        const bodyVal = anyValue(r.body);
        if (bodyVal && typeof bodyVal === "object" && !Array.isArray(bodyVal)) {
          Object.assign(attrs, bodyVal as AttrMap);
        }
        const name = eventName(attrs);
        const sessionId = str(attrs, "session.id", "session_id");
        if (!sessionId || !name) {
          skipped++;
          continue;
        }
        const ts =
          str(attrs, "event.timestamp") ??
          nanoToIso(r.timeUnixNano ?? r.time_unix_nano) ??
          nanoToIso(r.observedTimeUnixNano) ??
          new Date().toISOString();
        if (opts.since && ts < opts.since) {
          skipped++;
          continue;
        }
        const sess = ensureSession(sessions, sessionId);
        if (name === "api_request") {
          sess.addApiRequest(attrs, ts, opts);
        } else if (name === "tool_result" || name === "tool_decision") {
          if (name === "tool_decision" && str(attrs, "decision") === "reject") {
            // Still useful for path evidence of intent.
          }
          sess.addToolEvidence(attrs, ts, opts);
        } else {
          skipped++;
        }
      }
    }
  }
  return { events, skipped };
}

function ingestResourceSpans(
  payload: unknown,
  sessions: Map<string, SessionBuilder>,
  opts: OtelCollectOptions,
): { spans: number; skipped: number } {
  let spans = 0;
  let skipped = 0;
  const root = payload as {
    resourceSpans?: unknown[];
    resource_spans?: unknown[];
  };
  const bundles = root.resourceSpans ?? root.resource_spans ?? [];
  if (!Array.isArray(bundles)) return { spans, skipped };

  for (const bundle of bundles) {
    const b = bundle as {
      scopeSpans?: unknown[];
      scope_spans?: unknown[];
    };
    const scopes = b.scopeSpans ?? b.scope_spans ?? [];
    for (const scope of scopes) {
      const s = scope as { spans?: unknown[] };
      for (const sp of s.spans ?? []) {
        spans++;
        const span = sp as {
          name?: string;
          startTimeUnixNano?: unknown;
          start_time_unix_nano?: unknown;
          endTimeUnixNano?: unknown;
          attributes?: Array<{ key?: string; value?: unknown }>;
        };
        const attrs = attrsToMap(span.attributes);
        const name = spanName(span.name);
        const sessionId = str(attrs, "session.id", "session_id");
        if (!sessionId) {
          skipped++;
          continue;
        }
        const ts =
          nanoToIso(span.endTimeUnixNano) ??
          nanoToIso(span.startTimeUnixNano ?? span.start_time_unix_nano) ??
          new Date().toISOString();
        if (opts.since && ts < opts.since) {
          skipped++;
          continue;
        }
        const sess = ensureSession(sessions, sessionId);
        if (
          name === "claude_code.llm_request" ||
          name.endsWith(".llm_request") ||
          (num(attrs, "input_tokens", "gen_ai.usage.input_tokens") > 0 &&
            str(attrs, "model", "gen_ai.request.model"))
        ) {
          sess.addApiRequest(attrs, ts, opts);
        } else if (
          name === "claude_code.tool" ||
          name.endsWith(".tool") ||
          str(attrs, "tool_name")
        ) {
          sess.addToolEvidence(attrs, ts, opts);
        } else {
          skipped++;
        }
      }
    }
  }
  return { spans, skipped };
}

/**
 * Codex rollout collector.
 *
 * Reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Codex records one
 * `token_count` event after each model response. The event contains cumulative
 * usage for the thread and `last_token_usage` for just that response; only the
 * latter is billable as a turn. Tool calls appear immediately before their
 * corresponding usage event and are accumulated as that turn's file evidence.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { priceTurn } from "../pricing/cost.ts";
import {
  emptyUsage,
  type ModelPrice,
  type Session,
  type ToolKind,
  type Touch,
  type Turn,
  type Usage,
} from "../types.ts";
import {
  extractPathsFromCommand,
  extractPathsFromText,
  normalizePath,
} from "./paths.ts";
import {
  PROMPT_TOOL_NAME,
  PROMPT_WEIGHT,
  type CollectResult,
} from "./claude-code.ts";

export interface CodexCollectOptions {
  since?: string;
  repoRoot?: string;
  onlyThisRepo?: boolean;
  /** Override `~/.codex/sessions` (primarily for tests). */
  transcriptsDir?: string;
  priceOpts?: { at?: Date; overrides?: Record<string, ModelPrice> };
}

export const DEFAULT_CODEX_SESSIONS_DIR = (): string =>
  path.join(os.homedir(), ".codex", "sessions");

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

/**
 * Codex follows OpenAI usage semantics: cached and cache-write tokens are
 * subsets of `input_tokens`, not additional categories. Split them out so the
 * shared pricing function does not double count them.
 */
export function parseCodexUsage(raw: unknown): Usage {
  const value = asObject(raw);
  const usage = emptyUsage();
  if (!value) return usage;

  const cached = num(value["cached_input_tokens"]);
  const cacheWrite = num(value["cache_write_input_tokens"]);
  const totalInput = num(value["input_tokens"]);
  usage.input = Math.max(0, totalInput - cached - cacheWrite);
  usage.cacheRead = cached;
  // GPT-5.6 cache writes use the same 1.25x multiplier as the shared 5m bucket.
  usage.cacheWrite5m = cacheWrite;
  usage.output = num(value["output_tokens"]);
  // `reasoning_output_tokens` is already included in output_tokens.
  return usage;
}

interface RawTouch {
  raw: string;
  cwd: string;
  tool: ToolKind;
  toolName: string;
  weight: number;
  inferred: boolean;
}

function addRaw(
  out: RawTouch[],
  raw: unknown,
  cwd: string,
  tool: ToolKind,
  toolName: string,
  weight: number,
  inferred = false,
): void {
  if (typeof raw !== "string" || !raw.trim()) return;
  out.push({ raw: raw.trim(), cwd, tool, toolName, weight, inferred });
}

function parseArguments(raw: unknown): Json {
  if (asObject(raw)) return asObject(raw)!;
  if (typeof raw !== "string") return {};
  try {
    return asObject(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

function patchPaths(text: string): string[] {
  const out: string[] = [];
  // `exec` often embeds the patch inside a JavaScript string, so line breaks
  // may be present as the two characters `\\n` rather than literal newlines.
  text = text.replace(/\\n/g, "\n");
  const re = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

/** Recover quoted structured paths from Codex's JavaScript `exec` wrapper. */
function embeddedPaths(text: string): string[] {
  const out: string[] = [];
  const re = /["'](?:file_path|notebook_path|path)["']\s*:\s*["']([^"']+)["']/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    if (match[1]) out.push(match[1].replace(/\\\\/g, "\\"));
  }
  return out;
}

function touchesFromCall(payload: Json, cwd: string): RawTouch[] {
  const name = asString(payload["name"]);
  if (!name) return [];
  const rawInput = payload["arguments"] ?? payload["input"];
  const input = parseArguments(rawInput);
  const text = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput ?? "");
  const out: RawTouch[] = [];

  const direct = (
    raw: unknown,
    tool: ToolKind,
    weight: number,
    inferred = false,
  ): void => addRaw(out, raw, cwd, tool, name, weight, inferred);

  switch (name) {
    case "apply_patch":
      for (const p of patchPaths(text)) direct(p, "edit", 1);
      break;
    case "view_image":
      direct(input["path"], "read", 0.5);
      break;
    case "smart_outline":
    case "smart_unfold":
      direct(input["file_path"], "read", 0.5);
      break;
    case "smart_search":
      direct(input["path"], "search", 0.2);
      break;
    case "shell_command": {
      const command = asString(input["command"]);
      if (command) {
        for (const p of extractPathsFromCommand(command)) {
          direct(p, "shell", 0.3, true);
        }
      }
      break;
    }
    case "exec": {
      // `exec` is a JS orchestration wrapper. Prefer explicitly named and patch
      // paths, then use the conservative command lexer for remaining strings.
      for (const p of patchPaths(text)) direct(p, "edit", 1);
      for (const p of embeddedPaths(text)) direct(p, "read", 0.5);
      for (const p of extractPathsFromCommand(text)) {
        direct(p, "shell", 0.3, true);
      }
      for (const p of extractPathsFromText(text)) {
        direct(p, "shell", 0.3, true);
      }
      break;
    }
    default: {
      // MCP and future native tools generally expose a structured path. Keep
      // this low-confidence unless a known editing field is present.
      const filePath = input["file_path"] ?? input["notebook_path"];
      if (filePath) direct(filePath, "read", 0.5);
      else if (input["path"]) direct(input["path"], "search", 0.2);
      break;
    }
  }
  return out;
}

function pathExists(abs: string, cache: Map<string, boolean>): boolean {
  const key = process.platform === "win32" ? abs.toLowerCase() : abs;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let exists = false;
  try {
    exists = fs.existsSync(abs);
  } catch {
    exists = false;
  }
  cache.set(key, exists);
  return exists;
}

function materializeTouches(
  raws: RawTouch[],
  repoRoot: string | null,
  existsCache: Map<string, boolean>,
): Touch[] {
  const best = new Map<string, Touch>();
  for (const raw of raws) {
    const rel = normalizePath(raw.raw, raw.cwd, repoRoot);
    if (!rel) continue;
    if (repoRoot && raw.inferred && !pathExists(path.join(repoRoot, rel), existsCache)) {
      continue;
    }
    const key = `${raw.tool}:${rel}`;
    const current = best.get(key);
    if (!current || raw.weight > current.weight) {
      best.set(key, {
        path: rel,
        tool: raw.tool,
        toolName: raw.toolName,
        weight: raw.weight,
      });
    }
  }
  return [...best.values()];
}

function hasGitDir(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

function gitRootOf(cwd: string): string {
  let dir = cwd;
  for (let i = 0; i < 64; i++) {
    if (hasGitDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return cwd;
}

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  return /^[a-z]:/.test(resolved)
    ? resolved[0]!.toUpperCase() + resolved.slice(1)
    : resolved;
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32"
    ? canonicalRoot(a).toLowerCase() === canonicalRoot(b).toLowerCase()
    : canonicalRoot(a) === canonicalRoot(b);
}

function listRollouts(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  visit(root);
  return files.sort();
}

interface PendingTurn {
  ts: string;
  tsMs: number;
  model: string;
  priority: boolean;
  usage: Usage;
  raws: RawTouch[];
  snapshot: string;
}

interface ParsedRollout {
  rolloutId: string;
  sessionId: string;
  cwd: string;
  branch: string | null;
  turns: PendingTurn[];
  linesRead: number;
  linesSkipped: number;
  duplicateSnapshots: number;
}

function usageSignature(raw: unknown): string {
  const u = asObject(raw) ?? {};
  return [
    num(u["input_tokens"]),
    num(u["cached_input_tokens"]),
    num(u["cache_write_input_tokens"]),
    num(u["output_tokens"]),
    num(u["reasoning_output_tokens"]),
    num(u["total_tokens"]),
  ].join(":");
}

function parseRollout(file: string): ParsedRollout | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const records: Json[] = [];
  let linesRead = 0;
  let linesSkipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    linesRead++;
    try {
      const record = asObject(JSON.parse(line));
      if (record) records.push(record);
      else linesSkipped++;
    } catch {
      linesSkipped++;
    }
  }

  let sessionId = path.basename(file, ".jsonl");
  let cwd = "";
  let branch: string | null = null;
  let defaultModel = "";
  for (const record of records) {
    const payload = asObject(record["payload"]);
    if (record["type"] === "session_meta" && payload) {
      sessionId = asString(payload["session_id"]) ?? asString(payload["id"]) ?? sessionId;
      cwd = asString(payload["cwd"]) ?? cwd;
      branch = asString(asObject(payload["git"])?.["branch"]) ?? branch;
    }
    if (payload?.["type"] === "thread_settings_applied") {
      const settings = asObject(payload["thread_settings"]);
      defaultModel = defaultModel || asString(settings?.["model"]) || "";
    }
  }

  let model = defaultModel;
  let priority = false;
  const pending: RawTouch[] = [];
  const turns: PendingTurn[] = [];
  const seenSnapshots = new Set<string>();
  let duplicateSnapshots = 0;

  for (const record of records) {
    const payload = asObject(record["payload"]);
    if (!payload) continue;
    const type = asString(payload["type"]);

    if (record["type"] === "session_meta") {
      cwd = asString(payload["cwd"]) ?? cwd;
      branch = asString(asObject(payload["git"])?.["branch"]) ?? branch;
      continue;
    }
    if (type === "thread_settings_applied") {
      const settings = asObject(payload["thread_settings"]);
      model = asString(settings?.["model"]) ?? model;
      priority = asString(settings?.["service_tier"]) === "priority";
      continue;
    }
    if (type === "user_message") {
      const message = asString(payload["message"]);
      if (message) {
        for (const p of extractPathsFromText(message)) {
          addRaw(
            pending,
            p,
            cwd,
            "prompt",
            PROMPT_TOOL_NAME,
            PROMPT_WEIGHT,
            true,
          );
        }
      }
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      pending.push(...touchesFromCall(payload, cwd));
      continue;
    }
    if (type !== "token_count") continue;

    const info = asObject(payload["info"]);
    const last = asObject(info?.["last_token_usage"]);
    const total = asObject(info?.["total_token_usage"]);
    if (!last) continue;
    const snapshot = usageSignature(total ?? last);
    if (seenSnapshots.has(snapshot)) {
      duplicateSnapshots++;
      continue;
    }
    seenSnapshots.add(snapshot);

    const usage = parseCodexUsage(last);
    const volume =
      usage.input + usage.cacheRead + usage.cacheWrite5m + usage.output;
    if (volume === 0) continue;

    const ts = asString(record["timestamp"]) ?? "";
    const parsedTs = ts ? Date.parse(ts) : Number.NaN;
    turns.push({
      ts,
      tsMs: Number.isNaN(parsedTs) ? Number.POSITIVE_INFINITY : parsedTs,
      model,
      priority,
      usage,
      raws: pending.splice(0),
      snapshot,
    });
  }

  return {
    rolloutId: path.basename(file, ".jsonl"),
    sessionId,
    cwd,
    branch,
    turns,
    linesRead,
    linesSkipped,
    duplicateSnapshots,
  };
}

export function collectCodex(opts: CodexCollectOptions = {}): CollectResult {
  const root = opts.transcriptsDir ?? DEFAULT_CODEX_SESSIONS_DIR();
  const files = listRollouts(root);
  const sinceMs = opts.since ? Date.parse(opts.since) : Number.NaN;
  const hasSince = !Number.isNaN(sinceMs);
  const existsCache = new Map<string, boolean>();
  const sessions: Session[] = [];
  let linesRead = 0;
  let linesSkipped = 0;
  let duplicateSnapshots = 0;
  let matchedFiles = 0;

  for (const file of files) {
    const parsed = parseRollout(file);
    if (!parsed) continue;
    linesRead += parsed.linesRead;
    linesSkipped += parsed.linesSkipped;
    duplicateSnapshots += parsed.duplicateSnapshots;

    const discoveredRoot = parsed.cwd ? canonicalRoot(gitRootOf(parsed.cwd)) : null;
    const repoRoot = opts.onlyThisRepo && opts.repoRoot
      ? canonicalRoot(opts.repoRoot)
      : discoveredRoot ?? (opts.repoRoot ? canonicalRoot(opts.repoRoot) : null);
    if (
      opts.onlyThisRepo &&
      opts.repoRoot &&
      (!discoveredRoot || !samePath(discoveredRoot, opts.repoRoot))
    ) {
      continue;
    }
    matchedFiles++;

    const pending = parsed.turns
      .filter((turn) => !hasSince || !(turn.tsMs < sinceMs))
      .sort((a, b) => a.tsMs - b.tsMs);
    if (pending.length === 0) continue;

    // Auto-review and the main agent may share the logical session id while
    // writing separate rollout files. The filename UUID is the unique stream
    // identity and prevents one from replacing the other in SQLite.
    const prefixedSessionId = `codex:${parsed.rolloutId}`;
    const turns: Turn[] = pending.map((turn, seq) => {
      const priced = priceTurn(turn.model, turn.usage, {
        fast: turn.priority,
        at: opts.priceOpts?.at,
        overrides: opts.priceOpts?.overrides,
      });
      return {
        id: `${prefixedSessionId}:${turn.snapshot}`,
        sessionId: prefixedSessionId,
        seq,
        ts: turn.ts,
        model: turn.model,
        isSidechain: false,
        sidechainKey: null,
        usage: turn.usage,
        costUsd: priced.costUsd,
        priced: priced.priced,
        touches: materializeTouches(turn.raws, repoRoot, existsCache),
      };
    });

    const stamps = turns.map((turn) => turn.ts).filter(Boolean);
    sessions.push({
      id: prefixedSessionId,
      source: "codex",
      projectSlug: parsed.cwd || path.basename(file, ".jsonl"),
      repoRoot,
      gitBranch: parsed.branch,
      startedAt: stamps[0] ?? "",
      endedAt: stamps[stamps.length - 1] ?? "",
      turns,
    });
  }

  return {
    sessions,
    stats: {
      files: matchedFiles,
      linesRead,
      linesSkipped,
      turns: sessions.reduce((sum, session) => sum + session.turns.length, 0),
      sessions: sessions.length,
      duplicateLines: duplicateSnapshots,
    },
  };
}

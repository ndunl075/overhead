/**
 * Claude Code transcript collector.
 *
 * Reads `~/.claude/projects/<project-slug>/<session-uuid>.jsonl` and turns it
 * into priced `Session[]` carrying file evidence. Transcripts are an append-only
 * log written by a live process, so they are treated as hostile input:
 * truncated lines, unknown record types and replayed messages are all normal
 * and none of them may throw.
 */

import fs from "node:fs";
import os from "node:os";
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
  literalGlobPrefix,
  normalizePath,
} from "./paths.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CollectOptions {
  /** Only include turns at/after this ISO timestamp. */
  since?: string;
  /** Absolute repo root to attribute against. */
  repoRoot?: string;
  /** If set, only scan project dirs whose decoded path matches this repo root. */
  onlyThisRepo?: boolean;
  /** Override the transcripts root (for tests). */
  transcriptsDir?: string;
  priceOpts?: { at?: Date; overrides?: Record<string, ModelPrice> };
}

export interface CollectResult {
  sessions: Session[];
  stats: {
    files: number;
    linesRead: number;
    linesSkipped: number;
    turns: number;
    sessions: number;
    /**
     * Assistant lines folded into an already-seen `sessionId:messageId`.
     * Large by design — see the dedupe note below — not an error signal.
     */
    duplicateLines?: number;
  };
}

/**
 * Tool name -> evidence category and strength.
 *
 * Duplicated (not imported) from `src/attribute/weights.ts` on purpose: the
 * collector must not take a build-order dependency on the attribution stage.
 * Re-exported so a consumer can assert the two tables agree.
 */
export const TOOL_WEIGHTS: Record<string, { kind: ToolKind; weight: number }> = {
  Write: { kind: "write", weight: 1.0 },
  NotebookEdit: { kind: "write", weight: 1.0 },
  Edit: { kind: "edit", weight: 1.0 },
  Read: { kind: "read", weight: 0.5 },
  Grep: { kind: "search", weight: 0.2 },
  Glob: { kind: "search", weight: 0.2 },
  Bash: { kind: "shell", weight: 0.3 },
  PowerShell: { kind: "shell", weight: 0.3 },
};

/** Evidence strength of a path mentioned in a user's prompt. */
export const PROMPT_WEIGHT = 0.4;
export const PROMPT_TOOL_NAME = "prompt";

export const DEFAULT_TRANSCRIPTS_DIR = (): string =>
  path.join(os.homedir(), ".claude", "projects");

// ---------------------------------------------------------------------------
// Project directories
// ---------------------------------------------------------------------------

/**
 * Best-effort inverse of Claude Code's slug encoding, which replaces `\`, `/`
 * and `:` with `-`. Lossy: a literal `-` in a folder name is indistinguishable
 * from a separator, so this is only a last resort — `cwd` from the transcript
 * lines is always preferred.
 */
export function decodeProjectSlug(slug: string): string {
  if (!slug) return "";
  const drive = /^([A-Za-z])--(.*)$/.exec(slug);
  if (drive) {
    return `${drive[1]!.toUpperCase()}:\\${drive[2]!.replace(/-/g, "\\")}`;
  }
  if (slug.startsWith("-")) return slug.replace(/-/g, "/");
  return slug.replace(/-/g, "/");
}

/** Forward encoding, used to match a repo root against a directory slug. */
function encodeProjectSlug(absPath: string): string {
  return absPath.replace(/[\\/:]/g, "-");
}

export function listProjectDirs(
  transcriptsDir?: string,
): { slug: string; dir: string; decodedPath: string }[] {
  const root = transcriptsDir ?? DEFAULT_TRANSCRIPTS_DIR();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({
      slug: e.name,
      dir: path.join(root, e.name),
      decodedPath: decodeProjectSlug(e.name),
    }));
}

// ---------------------------------------------------------------------------
// Raw line handling
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Json)
    : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Map a transcript `usage` block onto the billing categories.
 *
 * The 5m/1h split is the whole point: they price at 1.25x and 2.00x input, and
 * agent harnesses lean on the 1h TTL, so collapsing them understates cost. When
 * `cache_creation` is missing we can only see the flat total, and we bank it as
 * 5m — the cheaper of the two — so an unknown never inflates the bill.
 *
 * `iterations[]` is deliberately ignored: it restates the same totals per
 * attempt, and summing it double counts.
 */
export function parseUsage(raw: unknown): Usage {
  const usage = emptyUsage();
  const u = asObject(raw);
  if (!u) return usage;

  usage.input = num(u["input_tokens"]);
  usage.cacheRead = num(u["cache_read_input_tokens"]);
  usage.output = num(u["output_tokens"]);

  const flatWrite = num(u["cache_creation_input_tokens"]);
  const cc = asObject(u["cache_creation"]);
  if (cc) {
    usage.cacheWrite5m = num(cc["ephemeral_5m_input_tokens"]);
    usage.cacheWrite1h = num(cc["ephemeral_1h_input_tokens"]);
    // Defensive: an empty split alongside a nonzero flat total would silently
    // drop billed tokens. Fall back to the conservative bucket.
    if (usage.cacheWrite5m + usage.cacheWrite1h === 0 && flatWrite > 0) {
      usage.cacheWrite5m = flatWrite;
    }
  } else {
    usage.cacheWrite5m = flatWrite;
  }

  const serverTools = asObject(u["server_tool_use"]);
  if (serverTools) {
    usage.webSearches = num(serverTools["web_search_requests"]);
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** A path as it appeared, plus the cwd needed to resolve it later. */
interface RawTouch {
  raw: string;
  cwd: string;
  tool: ToolKind;
  toolName: string;
  weight: number;
}

function pushRaw(
  out: RawTouch[],
  raw: string | null | undefined,
  cwd: string,
  tool: ToolKind,
  toolName: string,
  weight: number,
): void {
  if (typeof raw !== "string" || !raw.trim()) return;
  out.push({ raw, cwd, tool, toolName, weight });
}

/**
 * Pull file evidence out of one `tool_use` block.
 *
 * Grep's `pattern` is a *regular expression*, not a glob — feeding it to the
 * glob-prefix lexer would mint paths like `function\s+`. So `Grep` only ever
 * consults its `glob` filter, while `Glob`'s `pattern` is the glob itself.
 */
function touchesFromToolUse(block: Json, cwd: string): RawTouch[] {
  const name = asString(block["name"]);
  if (!name) return [];
  const spec = TOOL_WEIGHTS[name];
  if (!spec) return [];

  const input = asObject(block["input"]) ?? {};
  const out: RawTouch[] = [];
  const add = (raw: string | null | undefined): void =>
    pushRaw(out, raw, cwd, spec.kind, name, spec.weight);

  switch (name) {
    case "Write":
    case "Edit":
      add(asString(input["file_path"]));
      break;
    case "NotebookEdit":
      add(asString(input["notebook_path"]) ?? asString(input["file_path"]));
      break;
    case "Read":
      add(asString(input["file_path"]));
      break;
    case "Grep": {
      add(asString(input["path"]));
      add(literalGlobPrefix(asString(input["glob"])));
      break;
    }
    case "Glob": {
      add(asString(input["path"]));
      add(literalGlobPrefix(asString(input["pattern"]) ?? asString(input["glob"])));
      break;
    }
    case "Bash":
    case "PowerShell": {
      const command = asString(input["command"]);
      if (command) for (const p of extractPathsFromCommand(command)) add(p);
      break;
    }
    default:
      break;
  }
  return out;
}

/** Flatten a user `message.content` into prompt text, or null if it is a tool result. */
function promptTextOf(message: Json): string | null {
  const content = message["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const item of content) {
    const block = asObject(item);
    if (!block) continue;
    const type = asString(block["type"]);
    // A tool_result line is the harness echoing output back to the model; it
    // carries no human intent, so it contributes no prompt evidence.
    if (type === "tool_result") return null;
    if (type === "text") {
      const text = block["text"];
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Evidence kinds that are *inferred* rather than *declared*.
 *
 * `write`/`edit`/`read`/`search` paths arrive as a structured `file_path`
 * argument — the agent named the file, so it is trusted verbatim. Shell and
 * prompt paths are lexed out of prose and command lines, where git refs, npm
 * tarball members and shell variables all wear a path's clothes. Those get
 * checked against the filesystem before they are allowed to cost anyone money.
 */
const INFERRED_KINDS = new Set<ToolKind>(["shell", "prompt"]);

/**
 * Existence test with a run-wide cache — a long session mentions the same
 * handful of files thousands of times, and each miss is a syscall.
 */
function pathExists(abs: string, cache: Map<string, boolean>): boolean {
  const key = process.platform === "win32" ? abs.toLowerCase() : abs;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    ok = fs.existsSync(abs);
  } catch {
    // Permission error, bad surrogate in the name, path too long — all "no".
    ok = false;
  }
  cache.set(key, ok);
  return ok;
}

/**
 * Resolve raw evidence against a repo root, dropping anything outside it and
 * any inferred path that does not exist on disk.
 *
 * Tradeoff: a file deleted or renamed since the session was recorded loses its
 * shell and prompt evidence. That is the right way to be wrong — it only
 * touches the two lowest-weight signal classes, and a *fabricated* directory
 * (`origin/`, `package/`) appearing as a line item in a spend report does far
 * more damage to trust than a slightly under-counted deleted file.
 */
function materializeTouches(
  raws: RawTouch[],
  repoRoot: string | null,
  existsCache: Map<string, boolean>,
): Touch[] {
  // Same (path, tool) keeps the strongest weight — never summed, or a loop that
  // reads one file ten times would outweigh a write.
  const best = new Map<string, Touch>();
  for (const r of raws) {
    const rel = normalizePath(r.raw, r.cwd, repoRoot);
    if (!rel) continue;
    // Without a repo root there is nothing to stat against, so inferred paths
    // pass through unverified rather than being dropped wholesale.
    if (repoRoot && INFERRED_KINDS.has(r.tool)) {
      if (!pathExists(path.join(repoRoot, rel), existsCache)) continue;
    }
    // Tool kinds are a closed set of colon-free words, so this prefix
    // makes (path, tool) unambiguous even for paths containing spaces.
    const key = `${r.tool}:${rel}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, {
        path: rel,
        tool: r.tool,
        toolName: r.toolName,
        weight: r.weight,
      });
    } else if (r.weight > existing.weight) {
      existing.weight = r.weight;
      existing.toolName = r.toolName;
    }
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface PendingTurn {
  id: string;
  sessionId: string;
  messageId: string;
  ts: string;
  tsMs: number;
  model: string;
  fast: boolean;
  isSidechain: boolean;
  sidechainKey: string | null;
  cwd: string;
  gitBranch: string | null;
  usage: Usage;
  raws: RawTouch[];
  order: number;
}

interface SessionAccum {
  id: string;
  slug: string;
  turns: Map<string, PendingTurn>;
  cwdCounts: Map<string, number>;
  branchCounts: Map<string, number>;
}

function bump(counts: Map<string, number>, key: string | null): void {
  if (!key) return;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function mostCommon(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

interface FileStats {
  linesRead: number;
  linesSkipped: number;
  duplicateLines: number;
}

/**
 * Parse one transcript file into the shared session accumulator.
 *
 * Two behaviours worth knowing about:
 *
 * 1. **Dedupe / block merging.** A single assistant message is written across
 *    several lines — one per content block — each restating the *same* `usage`.
 *    In real transcripts ~44% of message ids appear more than once, and the
 *    `tool_use` block (i.e. all the file evidence) is on the *later* line while
 *    the first line holds only `text`/`thinking`. So the first line wins for
 *    usage, cost, model and timestamp (summing would double the bill), but
 *    touches from every line sharing an id are merged in. Dropping the later
 *    lines outright would discard nearly all evidence.
 *
 * 2. **Sidechain keys.** Sidechain lines are grouped by walking `parentUuid`:
 *    a sidechain line inherits its parent's key, and starts a new run keyed on
 *    its own uuid when the parent is unknown or on the main thread. This keeps
 *    concurrently interleaved subagents in separate evidence windows, which a
 *    "contiguous run" heuristic would merge. Main-thread turns get `null`.
 */
function parseFile(
  file: string,
  slug: string,
  sessions: Map<string, SessionAccum>,
  stats: FileStats,
  orderRef: { n: number },
): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }

  const fallbackSessionId = path.basename(file, ".jsonl");
  // uuid -> sidechain key, file-scoped (uuids are only unique within a file).
  const sidechainKeys = new Map<string, string>();
  // "<sessionId>|<sidechainKey|main>" -> prompt evidence awaiting the next turn.
  const pendingPrompts = new Map<string, RawTouch[]>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    stats.linesRead++;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Truncated tail or a partially flushed write. Expected; just count it.
      stats.linesSkipped++;
      continue;
    }

    const rec = asObject(parsed);
    if (!rec) {
      stats.linesSkipped++;
      continue;
    }

    const type = asString(rec["type"]);
    if (type !== "assistant" && type !== "user") continue;

    const sessionId = asString(rec["sessionId"]) ?? fallbackSessionId;
    const uuid = asString(rec["uuid"]);
    const parentUuid = asString(rec["parentUuid"]);
    const isSidechain = rec["isSidechain"] === true;

    let sidechainKey: string | null = null;
    if (isSidechain) {
      const inherited = parentUuid ? sidechainKeys.get(parentUuid) : undefined;
      sidechainKey = inherited ?? (uuid ? `sc:${uuid}` : `sc:${sessionId}`);
      if (uuid) sidechainKeys.set(uuid, sidechainKey);
    }

    const cwd = asString(rec["cwd"]) ?? "";
    const message = asObject(rec["message"]);
    if (!message) continue;

    const bucket = `${sessionId}|${sidechainKey ?? "main"}`;

    if (type === "user") {
      const promptText = promptTextOf(message);
      if (!promptText) continue;
      const raws = pendingPrompts.get(bucket) ?? [];
      for (const p of extractPathsFromText(promptText)) {
        pushRaw(raws, p, cwd, "prompt", PROMPT_TOOL_NAME, PROMPT_WEIGHT);
      }
      if (raws.length > 0) pendingPrompts.set(bucket, raws);
      continue;
    }

    // --- assistant ---------------------------------------------------------
    const messageId = asString(message["id"]);
    if (!messageId) continue;
    const id = `${sessionId}:${messageId}`;

    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        slug,
        turns: new Map(),
        cwdCounts: new Map(),
        branchCounts: new Map(),
      };
      sessions.set(sessionId, session);
    }
    bump(session.cwdCounts, cwd || null);
    bump(session.branchCounts, asString(rec["gitBranch"]));

    const blockTouches: RawTouch[] = [];
    for (const item of asArray(message["content"])) {
      const block = asObject(item);
      if (!block) continue;
      if (asString(block["type"]) !== "tool_use") continue;
      blockTouches.push(...touchesFromToolUse(block, cwd));
    }

    const existing = session.turns.get(id);
    if (existing) {
      // Same message, later content block: keep the first line's usage/cost,
      // merge the evidence. See the note on this function.
      stats.duplicateLines++;
      existing.raws.push(...blockTouches);
      const pending = pendingPrompts.get(bucket);
      if (pending) {
        existing.raws.push(...pending);
        pendingPrompts.delete(bucket);
      }
      continue;
    }

    const usageRaw = asObject(message["usage"]);
    const ts = asString(rec["timestamp"]) ?? "";
    const tsMs = ts ? Date.parse(ts) : Number.NaN;

    const raws: RawTouch[] = [];
    const pending = pendingPrompts.get(bucket);
    if (pending) {
      raws.push(...pending);
      pendingPrompts.delete(bucket);
    }
    raws.push(...blockTouches);

    session.turns.set(id, {
      id,
      sessionId,
      messageId,
      ts,
      tsMs: Number.isNaN(tsMs) ? Number.POSITIVE_INFINITY : tsMs,
      model: asString(message["model"]) ?? "",
      fast: asString(usageRaw?.["speed"]) === "fast",
      isSidechain,
      sidechainKey,
      cwd,
      gitBranch: asString(rec["gitBranch"]),
      usage: parseUsage(usageRaw),
      raws,
      order: orderRef.n++,
    });
  }
}

// ---------------------------------------------------------------------------
// Repo root resolution
// ---------------------------------------------------------------------------

function hasGitDir(dir: string): boolean {
  try {
    // A worktree/submodule uses a `.git` *file*, so existence is the test.
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

/** Nearest ancestor of `cwd` containing `.git`, else `cwd` itself. */
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

/**
 * Prefer the session's own `cwd` (exact, written by the process) and walk up to
 * the git root. Slug decoding is only a fallback because it cannot tell a
 * separator from a literal `-` in a folder name.
 */
function resolveRepoRoot(session: SessionAccum, override?: string): string | null {
  if (override) return canonicalRoot(path.resolve(override));
  const cwd = mostCommon(session.cwdCounts);
  if (cwd) return canonicalRoot(gitRootOf(cwd));
  const decoded = decodeProjectSlug(session.slug);
  return decoded ? canonicalRoot(decoded) : null;
}

/**
 * Transcripts record whatever drive-letter casing the shell used, so the same
 * repo shows up as both `c:\...` and `C:\...`. Path matching is already
 * case-insensitive, but the root is also a grouping key downstream, so pin it.
 */
function canonicalRoot(root: string): string {
  return /^[a-z]:/.test(root) ? root[0]!.toUpperCase() + root.slice(1) : root;
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

function matchesRepo(
  entry: { slug: string; decodedPath: string },
  repoRoot: string,
): boolean {
  const wantSlug = encodeProjectSlug(path.resolve(repoRoot)).toLowerCase();
  if (entry.slug.toLowerCase() === wantSlug) return true;
  return (
    entry.decodedPath.toLowerCase() === path.resolve(repoRoot).toLowerCase()
  );
}

export function collectClaudeCode(opts: CollectOptions = {}): CollectResult {
  const stats: FileStats = { linesRead: 0, linesSkipped: 0, duplicateLines: 0 };
  let files = 0;

  let dirs = listProjectDirs(opts.transcriptsDir);
  if (opts.onlyThisRepo && opts.repoRoot) {
    const root = opts.repoRoot;
    dirs = dirs.filter((d) => matchesRepo(d, root));
  }

  const sinceMs = opts.since ? Date.parse(opts.since) : Number.NaN;
  const hasSince = !Number.isNaN(sinceMs);

  const sessions: Session[] = [];
  const orderRef = { n: 0 };
  // Shared across every session: the same files are referenced over and over.
  const existsCache = new Map<string, boolean>();

  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir.dir);
    } catch {
      continue;
    }

    const accum = new Map<string, SessionAccum>();
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      files++;
      parseFile(path.join(dir.dir, name), dir.slug, accum, stats, orderRef);
    }

    for (const acc of accum.values()) {
      const repoRoot = resolveRepoRoot(acc, opts.repoRoot);

      const pending = [...acc.turns.values()]
        .filter((t) => !hasSince || !(t.tsMs < sinceMs))
        // Stable: timestamp first, original file order breaks ties.
        .sort((a, b) => a.tsMs - b.tsMs || a.order - b.order);

      if (pending.length === 0) continue;

      const turns: Turn[] = pending.map((p, i) => {
        const priced = priceTurn(p.model, p.usage, {
          fast: p.fast,
          at: opts.priceOpts?.at,
          overrides: opts.priceOpts?.overrides,
        });
        return {
          id: p.id,
          sessionId: p.sessionId,
          seq: i,
          ts: p.ts,
          model: p.model,
          isSidechain: p.isSidechain,
          sidechainKey: p.sidechainKey,
          usage: p.usage,
          costUsd: priced.costUsd,
          priced: priced.priced,
          touches: materializeTouches(p.raws, repoRoot, existsCache),
        };
      });

      const stamps = turns.map((t) => t.ts).filter((t) => t.length > 0);
      sessions.push({
        id: acc.id,
        source: "claude-code",
        projectSlug: acc.slug,
        repoRoot,
        gitBranch: mostCommon(acc.branchCounts),
        startedAt: stamps[0] ?? "",
        endedAt: stamps[stamps.length - 1] ?? "",
        turns,
      });
    }
  }

  const turnCount = sessions.reduce((n, s) => n + s.turns.length, 0);
  return {
    sessions,
    stats: {
      files,
      linesRead: stats.linesRead,
      linesSkipped: stats.linesSkipped,
      turns: turnCount,
      sessions: sessions.length,
      duplicateLines: stats.duplicateLines,
    },
  };
}

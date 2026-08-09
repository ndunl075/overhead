/**
 * Shared contract for every stage of the Overhead pipeline.
 * collect -> price -> attribute -> rollup -> store -> report
 */

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

/** Tools we can extract file evidence from. `other` is anything unrecognized. */
export type ToolKind =
  | "write"
  | "edit"
  | "read"
  | "search"
  | "shell"
  | "prompt"
  | "other";

/** One piece of evidence that a turn engaged with a path. */
export interface Touch {
  /** Repo-relative POSIX path, e.g. "packages/checkout/src/cart.ts". */
  path: string;
  /** Normalized tool category that produced this evidence. */
  tool: ToolKind;
  /** Raw tool name as it appeared in the transcript (for debugging). */
  toolName: string;
  /** Evidence strength, see WEIGHTS in src/attribute/weights.ts. */
  weight: number;
}

/** Token counts for a single assistant turn, split by billing category. */
export interface Usage {
  input: number;
  /** cache_creation.ephemeral_5m_input_tokens — billed at 1.25x input. */
  cacheWrite5m: number;
  /** cache_creation.ephemeral_1h_input_tokens — billed at 2.00x input. */
  cacheWrite1h: number;
  /** cache_read_input_tokens — billed at 0.10x input. */
  cacheRead: number;
  output: number;
  /** Server-side web search requests, billed per-request not per-token. */
  webSearches: number;
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    webSearches: 0,
  };
}

/** One priced, evidence-carrying assistant turn. The atom of attribution. */
export interface Turn {
  /** Stable dedupe key: `${sessionId}:${messageId}`. */
  id: string;
  sessionId: string;
  /** Monotonic index within the session (0-based, in timestamp order). */
  seq: number;
  /** ISO-8601 timestamp. */
  ts: string;
  /** Model id exactly as reported, e.g. "claude-opus-5". */
  model: string;
  /** Subagent turns run in their own evidence window. */
  isSidechain: boolean;
  /** Groups sidechain turns; null for the main thread. */
  sidechainKey: string | null;
  usage: Usage;
  /** USD, computed by the pricing stage. */
  costUsd: number;
  /** False when the model id had no price entry — surfaced, never silently 0. */
  priced: boolean;
  /** File evidence gathered from this turn's tool calls (and preceding prompt). */
  touches: Touch[];
}

export interface Session {
  id: string;
  /** Where the data came from, e.g. "claude-code". */
  source: string;
  /** Transcript directory slug, e.g. "C--Users-x-Documents-repo". */
  projectSlug: string;
  /** Absolute repo root the paths are relative to, if resolvable. */
  repoRoot: string | null;
  gitBranch: string | null;
  startedAt: string;
  endedAt: string;
  turns: Turn[];
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** List price per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Optional promotional pricing that expires on a date (ISO yyyy-mm-dd). */
  intro?: { input: number; output: number; until: string };
}

export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;
export const CACHE_READ_MULTIPLIER = 0.1;
/** USD per web search request. */
export const WEB_SEARCH_COST = 10 / 1000;

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/** Bucket for turns with no file evidence (planning, chat, research). */
export const UNATTRIBUTED = "__unattributed__";

export interface AttributionConfig {
  /** Per-turn decay applied to older evidence. 0 < lambda <= 1. */
  lambda: number;
  /** How many turns back evidence stays in the active set. */
  window: number;
}

export const DEFAULT_ATTRIBUTION: AttributionConfig = {
  lambda: 0.85,
  window: 20,
};

/** A slice of one turn's cost assigned to one path. Shares sum to 1 per turn. */
export interface Attribution {
  turnId: string;
  /** Repo-relative path, or UNATTRIBUTED. */
  path: string;
  share: number;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

export type UnitKind = "dir" | "package" | "team" | "feature" | "file";

/**
 * What a report groups by. `model` and `session` are not path rollups — they
 * aggregate turns directly — but they share the same row/total shape.
 */
export type ReportGroupBy = UnitKind | "model" | "session";

/** Maps a repo-relative path to a reporting unit key, or null if unmapped. */
export interface Rollup {
  kind: UnitKind;
  label: string;
  map(path: string): string | null;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ReportRow {
  unit: string;
  costUsd: number;
  /** Fraction of total attributed cost, 0..1. */
  share: number;
  /** Sum of per-turn shares — a fractional "how many turns were about this". */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface ReportTotals {
  /** Cost we could tie to a path. */
  attributedUsd: number;
  /** Cost from turns with no file evidence. */
  unattributedUsd: number;
  /** Cost from turns whose model had no price entry (always 0 USD, but counted). */
  unpricedTurns: number;
  totalUsd: number;
  turns: number;
  sessions: number;
  /** Present only after `overhead reconcile`. */
  invoicedUsd?: number;
  /** modeled / invoiced — how much of the real bill these transcripts explain. */
  coverage?: number;
}

export interface Report {
  by: ReportGroupBy;
  since: string | null;
  rows: ReportRow[];
  totals: ReportTotals;
  config: AttributionConfig;
  generatedAt: string;
}

import { DEFAULT_ATTRIBUTION } from "../types.ts";
import type { AttributionConfig, ToolKind } from "../types.ts";

/**
 * Evidence strength per tool category.
 *
 * These are the only hand-tuned magic numbers in the attribution engine, so
 * each one is justified rather than asserted. The scale is "how much does this
 * tool call prove the turn was *about* that file?", with 1.0 meaning proof.
 *
 * | kind     | w   | why |
 * |----------|-----|-----|
 * | `write`  | 1.0 | The turn produced the file's contents. There is no stronger evidence available; the model spent its output tokens on exactly this path. |
 * | `edit`   | 1.0 | Same as write. An Edit is direct proof the turn was about that file — the agent read it, reasoned about it, and changed it. |
 * | `read`   | 0.5 | Strong but not conclusive. Agents read a file to understand it, and much of that reading is context-gathering for work that lands elsewhere. Half of a write. |
 * | `search` | 0.2 | A Grep/Glob hit is weak proof: the path was returned by a query, not chosen. Broad searches spray dozens of paths per call, so a low weight keeps a single `rg` from drowning out the file actually being edited. |
 * | `shell`  | 0.3 | Paths lexed out of a command line. Real intent (`npm test packages/x`, `git diff src/y.ts`) but noisy — the lexer also catches config files, lockfiles and incidental arguments. Above search, below read. |
 * | `prompt` | 0.4 | The human named a path. Genuinely high-signal about intent, but a mention is not engagement, and prompt text carries typos and stale references. Below read, above shell. |
 * | `other`  | 0   | Unrecognized tool. Contributes no score; it may still be recorded as a touch for debugging, and a turn whose evidence is exclusively `other` falls through to UNATTRIBUTED rather than being attributed on a guess. |
 *
 * Ratios, not absolutes, are what matter: only relative weights survive the
 * per-turn normalization in the engine. Two reads (0.5) outweigh one edit
 * only when the edit is old enough for decay to have halved it.
 */
export const WEIGHTS: Record<ToolKind, number> = {
  write: 1.0,
  edit: 1.0,
  read: 0.5,
  search: 0.2,
  shell: 0.3,
  prompt: 0.4,
  other: 0,
};

/** Weight for a tool kind, defaulting to `other` (0) for anything unknown. */
export function weightFor(kind: ToolKind): number {
  return WEIGHTS[kind] ?? WEIGHTS.other;
}

/**
 * Default decay knobs, re-exported here so callers configuring attribution
 * have one import site for "the tuning surface".
 *
 * `lambda = 0.85`: evidence keeps ~85% of its strength per turn of distance,
 * so a file falls to half strength after ~4 turns and to ~4% by the window
 * edge. That tracks how prompt caching actually bills — turn t is paying to
 * re-read the context turns t-1..t-k established.
 *
 * `window = 20`: past ~20 turns, lambda^d is small enough that the evidence is
 * noise, and bounding the window is what keeps the engine O(n * window).
 */
export const DEFAULT_CONFIG: AttributionConfig = DEFAULT_ATTRIBUTION;

/**
 * Formatting primitives shared by the table / html / csv renderers.
 * Zero dependencies — everything here is hand-rolled on purpose.
 */

import type { Report, ReportRow } from "../types.ts";
import { UNATTRIBUTED } from "../types.ts";

/** Human label used wherever the raw UNATTRIBUTED key would be noise. */
export const UNATTRIBUTED_LABEL = "(unattributed)";

/** Above this share of total spend, attribution is not trustworthy. */
export const UNATTRIBUTED_WARN_THRESHOLD = 0.25;

/** Below this coverage, the transcripts do not explain the invoice. */
export const COVERAGE_WARN_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

function group(intPart: string): string {
  // 1234567 -> 1,234,567
  let out = "";
  for (let i = 0; i < intPart.length; i++) {
    if (i > 0 && (intPart.length - i) % 3 === 0) out += ",";
    out += intPart[i];
  }
  return out;
}

/**
 * `$1,234.56`. Under $1 we widen the decimals so sub-cent units are not all
 * flattened to `$0.00` — the long tail is exactly what people come here to see.
 */
export function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return "$—";
  const neg = n < 0;
  const abs = Math.abs(n);
  if (abs === 0) return "$0.00";

  let dp = 2;
  if (abs < 1) {
    dp = 4;
    if (abs < 1e-4) dp = 6;
    if (abs < 1e-6) dp = 8;
  }

  const fixed = abs.toFixed(dp);
  if (Number(fixed) === 0) {
    // Smaller than we are willing to print: say so rather than lying with 0.
    return `${neg ? "-" : ""}<$0.${"0".repeat(dp - 1)}1`;
  }
  const dot = fixed.indexOf(".");
  const intPart = dot === -1 ? fixed : fixed.slice(0, dot);
  const frac = dot === -1 ? "" : fixed.slice(dot);
  return `${neg ? "-" : ""}$${group(intPart)}${frac}`;
}

/** Full precision, no grouping, no currency symbol — for CSV/spreadsheets. */
export function formatMoneyRaw(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "0";
  // Avoid exponent notation, which spreadsheets import inconsistently.
  if (Math.abs(n) < 1e-6) return n.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  return String(n);
}

const TOKEN_UNITS = ["", "k", "M", "B", "T"] as const;

/** `1.2M`, `847k`, `912`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const neg = n < 0;
  let v = Math.abs(n);
  let unit = 0;
  while (v >= 1000 && unit < TOKEN_UNITS.length - 1) {
    v /= 1000;
    unit++;
  }
  let s: string;
  if (unit === 0) {
    s = String(Math.round(v));
  } else {
    s = v < 10 ? v.toFixed(1) : String(Math.round(v));
    // 999_999 -> 1000.0k; promote instead of printing a nonsense magnitude.
    if (Number(s) >= 1000 && unit < TOKEN_UNITS.length - 1) {
      v /= 1000;
      unit++;
      s = v < 10 ? v.toFixed(1) : String(Math.round(v));
    }
    if (s.endsWith(".0")) s = s.slice(0, -2);
  }
  return `${neg ? "-" : ""}${s}${TOKEN_UNITS[unit]}`;
}

/** `12.3%`, with a floor so a nonzero share never reads as exactly zero. */
export function formatPercent(fraction: number, dp = 1): string {
  if (!Number.isFinite(fraction)) return "—";
  const pct = fraction * 100;
  const floor = Math.pow(10, -dp);
  if (pct > 0 && pct < floor) return `<${floor.toFixed(dp)}%`;
  return `${pct.toFixed(dp)}%`;
}

/** Fractional turn counts round to a single decimal; whole numbers stay whole. */
export function formatTurns(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/**
 * Truncate from the LEFT with a leading ellipsis: for paths the tail carries
 * the information (`…checkout/src/cart.ts`).
 *
 * A separator left dangling right after the ellipsis is dropped — `…/checkout`
 * reads as an absolute path, which it is not. Result is at most `max` chars
 * (sometimes max-1); callers pad, so alignment is unaffected.
 */
export function truncateLeft(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max === 1) return "…";
  let tail = s.slice(s.length - (max - 1));
  if (tail.startsWith("/") && tail.length > 1) tail = tail.slice(1);
  return "…" + tail;
}

const BLOCK_FULL = "█";
/** Eighth-width partial cells, ascending: 1/8 … 7/8. */
const BLOCK_PARTIAL = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/** Inline bar of `cells` columns filled to `fraction` (0..1), eighth precision. */
export function bar(fraction: number, cells: number): string {
  if (cells <= 0) return "";
  const f = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
  const eighths = Math.round(f * cells * 8);
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  let out = BLOCK_FULL.repeat(Math.min(full, cells));
  if (rem > 0 && full < cells) out += BLOCK_PARTIAL[rem - 1] ?? "";
  // A nonzero value should never render as an empty bar.
  if (out.length === 0 && f > 0) out = BLOCK_PARTIAL[0] ?? "";
  return out;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

export function isUnattributed(row: ReportRow): boolean {
  return row.unit === UNATTRIBUTED;
}

/** Display name for a unit key. */
export function unitLabel(unit: string): string {
  return unit === UNATTRIBUTED ? UNATTRIBUTED_LABEL : unit;
}

/**
 * Split rows into the ordinary rows (input order preserved — the rollup stage
 * already sorted them) and the unattributed row, which every renderer pins last.
 */
export function partitionRows(rows: readonly ReportRow[]): {
  normal: ReportRow[];
  unattributed: ReportRow | null;
} {
  const normal: ReportRow[] = [];
  let unattributed: ReportRow | null = null;
  for (const r of rows) {
    if (isUnattributed(r)) unattributed = r;
    else normal.push(r);
  }
  return { normal, unattributed };
}

/** Unattributed share of *total* spend (the honesty metric). */
export function unattributedShare(report: Report): number {
  const { totalUsd, unattributedUsd } = report.totals;
  if (totalUsd > 0) return unattributedUsd / totalUsd;
  const { unattributed } = partitionRows(report.rows);
  return unattributed?.share ?? 0;
}

export function coverageOf(report: Report): number | null {
  const { invoicedUsd, coverage, totalUsd } = report.totals;
  if (typeof coverage === "number" && Number.isFinite(coverage)) return coverage;
  if (typeof invoicedUsd === "number" && invoicedUsd > 0) return totalUsd / invoicedUsd;
  return null;
}

/** Human summary of the window this report covers. */
export function periodLabel(report: Report): string {
  return report.since ? `since ${report.since}` : "all time";
}

export function maxCost(rows: readonly ReportRow[]): number {
  let m = 0;
  for (const r of rows) if (r.costUsd > m) m = r.costUsd;
  return m;
}

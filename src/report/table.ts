/**
 * Terminal renderer. Hand-rolled table + inline bars + a tiny ANSI helper;
 * no dependencies, and every width is computed on the *uncolored* string so
 * escape codes can never break alignment.
 */

import type { Report, ReportRow } from "../types.ts";
import {
  COVERAGE_WARN_THRESHOLD,
  UNATTRIBUTED_LABEL,
  UNATTRIBUTED_WARN_THRESHOLD,
  bar,
  coverageOf,
  formatMoney,
  formatPercent,
  formatTokens,
  formatTurns,
  maxCost,
  partitionRows,
  periodLabel,
  truncateLeft,
  unattributedShare,
} from "./format.ts";

export interface TableOptions {
  /** Render at most this many attributed rows; the rest are summarized. */
  top?: number;
  /** Force ANSI on/off. Default: `process.stdout.isTTY`. NO_COLOR always wins. */
  color?: boolean;
  /** Terminal width. Default: `process.stdout.columns ?? 100`. */
  width?: number;
}

// ---------------------------------------------------------------------------
// Tiny ANSI helper
// ---------------------------------------------------------------------------

interface Ink {
  readonly enabled: boolean;
  dim(s: string): string;
  bold(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
}

function makeInk(enabled: boolean): Ink {
  const wrap = (open: string) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[0m` : s);
  return {
    enabled,
    dim: wrap("2"),
    bold: wrap("1"),
    yellow: wrap("33"),
    red: wrap("31"),
    cyan: wrap("36"),
  };
}

/** NO_COLOR (any non-empty value) disables color unconditionally. */
export function colorEnabled(opt?: boolean): boolean {
  const noColor = process.env["NO_COLOR"];
  if (typeof noColor === "string" && noColor !== "") return false;
  if (typeof opt === "boolean") return opt;
  return Boolean(process.stdout?.isTTY);
}

const MIN_WIDTH = 56;
const MAX_WIDTH = 200;

function resolveWidth(opt?: number): number {
  const raw = opt ?? process.stdout?.columns ?? 100;
  if (!Number.isFinite(raw)) return 100;
  return Math.min(Math.max(Math.floor(raw), MIN_WIDTH), MAX_WIDTH);
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

interface Cells {
  unit: string;
  cost: string;
  share: string;
  turns: string;
  tin: string;
  tcache: string;
  tout: string;
  /** 0..1, relative to the largest row. */
  barFrac: number;
}

function cellsFor(row: ReportRow, scale: number, label?: string): Cells {
  return {
    unit: label ?? row.unit,
    cost: formatMoney(row.costUsd),
    share: formatPercent(row.share),
    turns: formatTurns(row.turns),
    tin: formatTokens(row.inputTokens),
    tcache: formatTokens(row.cacheReadTokens),
    tout: formatTokens(row.outputTokens),
    barFrac: scale > 0 ? row.costUsd / scale : 0,
  };
}

const SEP = "  ";
const H_UNIT = "unit";
const H_COST = "cost";
const H_SHARE = "share";
const H_TURNS = "turns";
/** Fresh (uncached) input. */
const H_IN = "tok in";
/** Cache reads — the dominant input category in agent workloads, billed at 0.1x. */
const H_CACHE = "cached";
const H_OUT = "tok out";

export function renderTable(report: Report, opts: TableOptions = {}): string {
  const ink = makeInk(colorEnabled(opts.color));
  const width = resolveWidth(opts.width);
  const { totals, config } = report;

  const { normal, unattributed } = partitionRows(report.rows);
  const limit =
    typeof opts.top === "number" && opts.top >= 0 ? Math.floor(opts.top) : normal.length;
  const shown = normal.slice(0, limit);
  const omitted = normal.slice(limit);

  const scale = maxCost(report.rows);

  const bodyCells: Cells[] = shown.map((r) => cellsFor(r, scale));

  // "… and N more" summary — rows are never silently dropped.
  let moreCells: Cells | null = null;
  if (omitted.length > 0) {
    const cost = omitted.reduce((a, r) => a + r.costUsd, 0);
    const share = omitted.reduce((a, r) => a + r.share, 0);
    const turns = omitted.reduce((a, r) => a + r.turns, 0);
    const tin = omitted.reduce((a, r) => a + r.inputTokens, 0);
    const tcache = omitted.reduce((a, r) => a + r.cacheReadTokens, 0);
    const tout = omitted.reduce((a, r) => a + r.outputTokens, 0);
    moreCells = {
      unit: `… and ${omitted.length} more`,
      cost: formatMoney(cost),
      share: formatPercent(share),
      turns: formatTurns(turns),
      tin: formatTokens(tin),
      tcache: formatTokens(tcache),
      tout: formatTokens(tout),
      barFrac: 0,
    };
  }

  const unattrShare = unattributedShare(report);
  const unattrHot = unattrShare > UNATTRIBUTED_WARN_THRESHOLD;
  const unattrCells = unattributed
    ? cellsFor(unattributed, scale, UNATTRIBUTED_LABEL)
    : null;

  // --- column widths, measured on plain text -------------------------------
  const all: Cells[] = [...bodyCells];
  if (moreCells) all.push(moreCells);
  if (unattrCells) all.push(unattrCells);

  const w = (header: string, pick: (c: Cells) => string) =>
    all.reduce((m, c) => Math.max(m, pick(c).length), header.length);

  const costW = w(H_COST, (c) => c.cost);
  const shareW = w(H_SHARE, (c) => c.share);
  const turnsW = w(H_TURNS, (c) => c.turns);
  const inW = w(H_IN, (c) => c.tin);
  const cacheW = w(H_CACHE, (c) => c.tcache);
  const outW = w(H_OUT, (c) => c.tout);

  const numeric = costW + shareW + turnsW + inW + cacheW + outW + SEP.length * 7;
  let barW = Math.min(Math.max(Math.floor(width * 0.18), 8), 22);
  let unitW = width - numeric - barW;
  if (unitW < 16) {
    barW = Math.max(6, barW - (16 - unitW));
    unitW = width - numeric - barW;
  }
  unitW = Math.max(unitW, 10);

  const lineWidth = unitW + barW + numeric;

  const rowLine = (c: Cells, paint: (s: string) => string = (s) => s, showBar = true) => {
    const unit = truncateLeft(c.unit, unitW).padEnd(unitW);
    const cost = c.cost.padStart(costW);
    const share = c.share.padStart(shareW);
    const b = (showBar ? bar(c.barFrac, barW) : "").padEnd(barW);
    const turns = c.turns.padStart(turnsW);
    const tin = c.tin.padStart(inW);
    const tcache = c.tcache.padStart(cacheW);
    const tout = c.tout.padStart(outW);
    return [
      paint(unit),
      paint(cost),
      paint(share),
      paint(b),
      ink.dim(turns),
      ink.dim(tin),
      ink.dim(tcache),
      ink.dim(tout),
    ].join(SEP);
  };

  const out: string[] = [];

  // --- title ---------------------------------------------------------------
  const scope = `${report.by} · ${periodLabel(report)}`;
  out.push(ink.bold(`Overhead — spend by ${report.by}`));
  out.push(
    ink.dim(
      `${scope} · ${totals.sessions} session${totals.sessions === 1 ? "" : "s"}, ` +
        `${totals.turns} turn${totals.turns === 1 ? "" : "s"} · generated ${report.generatedAt}`,
    ),
  );
  out.push("");

  // --- header --------------------------------------------------------------
  const header = [
    H_UNIT.padEnd(unitW),
    H_COST.padStart(costW),
    H_SHARE.padStart(shareW),
    "".padEnd(barW),
    H_TURNS.padStart(turnsW),
    H_IN.padStart(inW),
    H_CACHE.padStart(cacheW),
    H_OUT.padStart(outW),
  ].join(SEP);
  out.push(ink.dim(header));
  out.push(ink.dim("─".repeat(lineWidth)));

  if (bodyCells.length === 0 && !unattrCells) {
    out.push(ink.dim("(no attributed spend in this period)".padEnd(lineWidth)));
  }
  for (const c of bodyCells) out.push(rowLine(c));
  if (moreCells) out.push(rowLine(moreCells, ink.dim, false));
  if (unattrCells) {
    out.push(rowLine(unattrCells, unattrHot ? ink.yellow : ink.dim));
  }

  // --- footer --------------------------------------------------------------
  out.push(ink.dim("─".repeat(lineWidth)));
  const attributedShare = totals.totalUsd > 0 ? totals.attributedUsd / totals.totalUsd : 0;
  out.push(
    `${ink.bold("total")}  ${ink.bold(formatMoney(totals.totalUsd))}   ` +
      ink.dim(
        `attributed ${formatMoney(totals.attributedUsd)} (${formatPercent(attributedShare)})` +
          `  ·  unattributed ${formatMoney(totals.unattributedUsd)} (${formatPercent(unattrShare)})`,
      ),
  );

  const coverage = coverageOf(report);
  if (typeof totals.invoicedUsd === "number") {
    const pct = coverage === null ? "—" : formatPercent(coverage);
    const low = coverage !== null && coverage < COVERAGE_WARN_THRESHOLD;
    const text =
      `coverage  ${formatMoney(totals.totalUsd)} modeled / ${formatMoney(totals.invoicedUsd)} invoiced = ${pct}`;
    out.push(low ? ink.red(text) : ink.dim(text));
  }

  out.push(
    ink.dim(
      `config    λ=${config.lambda}  window=${config.window} turns` +
        (report.since ? `  ·  since ${report.since}` : ""),
    ),
  );
  out.push(
    ink.dim(
      "columns   tok in = fresh input  ·  cached = cache reads (billed 0.1×, dominates volume)  ·  tok out = output",
    ),
  );

  // --- warnings ------------------------------------------------------------
  const warnings: string[] = [];
  if (unattrHot) {
    warnings.push(
      `${formatPercent(unattrShare)} of spend is ${UNATTRIBUTED_LABEL} — attribution confidence is LOW. ` +
        `Treat the ranking as directional, not exact.`,
    );
  }
  if (totals.unpricedTurns > 0) {
    warnings.push(
      `${totals.unpricedTurns} turn${totals.unpricedTurns === 1 ? "" : "s"} used a model with no price entry ` +
        `and ${totals.unpricedTurns === 1 ? "is" : "are"} counted as $0. Real spend is higher than shown.`,
    );
  }
  if (coverage !== null && coverage < COVERAGE_WARN_THRESHOLD) {
    warnings.push(
      `Coverage is ${formatPercent(coverage)} — these transcripts explain less than ` +
        `${formatPercent(COVERAGE_WARN_THRESHOLD, 0)} of the invoice. Transcripts are likely missing.`,
    );
  }
  if (warnings.length > 0) {
    out.push("");
    for (const wmsg of warnings) {
      const low = coverage !== null && coverage < COVERAGE_WARN_THRESHOLD;
      const paint = low && wmsg.startsWith("Coverage") ? ink.red : ink.yellow;
      out.push(paint(`!  ${wrapText(wmsg, Math.max(lineWidth - 3, 30), "   ")}`));
    }
  }

  return out.join("\n") + "\n";
}

/** Soft-wrap on spaces; continuation lines get `indent`. */
function wrapText(s: string, width: number, indent: string): string {
  const words = s.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (cur.length === 0) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines.join(`\n${indent}`);
}

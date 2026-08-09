import type { Store } from "./db/db.ts";
import {
  UNATTRIBUTED,
  type AttributionConfig,
  type Report,
  type ReportGroupBy,
  type ReportRow,
  type ReportTotals,
  type Rollup,
} from "./types.ts";

interface RawRow {
  key: string;
  costUsd: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface QueryOptions {
  since?: string | null;
  until?: string | null;
  config: AttributionConfig;
  /** Required for path-based groupings; ignored for model/session. */
  rollup?: Rollup;
  /** Label for paths the rollup returns null for. */
  unmappedLabel?: string;
  invoicedUsd?: number;
}

/**
 * Aggregate materialized attributions into a report.
 *
 * Token columns are apportioned by the same share as cost, so a row's tokens
 * describe "the tokens spent on this unit" rather than "the tokens of turns
 * that mentioned this unit" — the latter would sum to far more than the total.
 */
export function buildReport(
  store: Store,
  by: ReportGroupBy,
  opts: QueryOptions,
): Report {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.since) {
    where.push("t.ts >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    where.push("t.ts <= ?");
    params.push(opts.until);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const raw =
    by === "model" || by === "session"
      ? queryTurnGrouped(store, by, clause, params)
      : queryPathGrouped(store, clause, params);

  // Fold paths into units. Done in JS rather than SQL because the rollups are
  // glob/ownership rules, not expressible as GROUP BY.
  const rows = by === "model" || by === "session"
    ? raw
    : foldByRollup(raw, opts.rollup!, opts.unmappedLabel ?? "(unmapped)");

  const totals = queryTotals(store, clause, params);

  const attributed = rows
    .filter((r) => r.key !== UNATTRIBUTED)
    .reduce((s, r) => s + r.costUsd, 0);
  const unattributed = rows
    .filter((r) => r.key === UNATTRIBUTED)
    .reduce((s, r) => s + r.costUsd, 0);
  const total = attributed + unattributed;

  rows.sort((a, b) => b.costUsd - a.costUsd);

  const reportRows: ReportRow[] = rows.map((r) => ({
    unit: r.key,
    costUsd: r.costUsd,
    share: total > 0 ? r.costUsd / total : 0,
    turns: r.turns,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
  }));

  const reportTotals: ReportTotals = {
    attributedUsd: attributed,
    unattributedUsd: unattributed,
    unpricedTurns: totals.unpricedTurns,
    totalUsd: total,
    turns: totals.turns,
    sessions: totals.sessions,
  };
  if (opts.invoicedUsd !== undefined) {
    reportTotals.invoicedUsd = opts.invoicedUsd;
    reportTotals.coverage =
      opts.invoicedUsd > 0 ? total / opts.invoicedUsd : undefined;
  }

  return {
    by,
    since: opts.since ?? null,
    rows: reportRows,
    totals: reportTotals,
    config: opts.config,
    generatedAt: new Date().toISOString(),
  };
}

function queryPathGrouped(
  store: Store,
  clause: string,
  params: string[],
): RawRow[] {
  const sql = `
    SELECT a.path AS key,
           SUM(a.cost_usd)             AS cost,
           SUM(a.share)                AS turns,
           SUM(a.share * t.in_tok)     AS in_tok,
           SUM(a.share * t.out_tok)    AS out_tok,
           SUM(a.share * t.cache_read) AS cache_read
    FROM attributions a
    JOIN turns t ON t.id = a.turn_id
    ${clause}
    GROUP BY a.path`;
  return (store.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(
    toRawRow,
  );
}

function queryTurnGrouped(
  store: Store,
  by: "model" | "session",
  clause: string,
  params: string[],
): RawRow[] {
  const keyExpr = by === "model" ? "t.model" : "t.session_id";
  const sql = `
    SELECT ${keyExpr}       AS key,
           SUM(t.cost_usd)  AS cost,
           COUNT(*)         AS turns,
           SUM(t.in_tok)    AS in_tok,
           SUM(t.out_tok)   AS out_tok,
           SUM(t.cache_read) AS cache_read
    FROM turns t
    ${clause}
    GROUP BY ${keyExpr}`;
  return (store.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(
    toRawRow,
  );
}

function toRawRow(r: Record<string, unknown>): RawRow {
  return {
    key: String(r.key ?? ""),
    costUsd: Number(r.cost ?? 0),
    turns: Number(r.turns ?? 0),
    inputTokens: Number(r.in_tok ?? 0),
    outputTokens: Number(r.out_tok ?? 0),
    cacheReadTokens: Number(r.cache_read ?? 0),
  };
}

function foldByRollup(
  raw: RawRow[],
  rollup: Rollup,
  unmappedLabel: string,
): RawRow[] {
  const acc = new Map<string, RawRow>();
  for (const r of raw) {
    // UNATTRIBUTED is never a real path — it must survive every rollup intact.
    const unit =
      r.key === UNATTRIBUTED ? UNATTRIBUTED : rollup.map(r.key) ?? unmappedLabel;
    let cur = acc.get(unit);
    if (!cur) {
      cur = {
        key: unit,
        costUsd: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      };
      acc.set(unit, cur);
    }
    cur.costUsd += r.costUsd;
    cur.turns += r.turns;
    cur.inputTokens += r.inputTokens;
    cur.outputTokens += r.outputTokens;
    cur.cacheReadTokens += r.cacheReadTokens;
  }
  return [...acc.values()];
}

function queryTotals(
  store: Store,
  clause: string,
  params: string[],
): { turns: number; sessions: number; unpricedTurns: number } {
  const row = store.db
    .prepare(
      // An unpriced turn only represents missing spend if it actually consumed
      // tokens. Zero-token pseudo-model turns are free, and counting them would
      // warn that "real spend is higher" when it isn't.
      `SELECT COUNT(*) AS turns,
              COUNT(DISTINCT t.session_id) AS sessions,
              SUM(CASE WHEN t.priced = 0
                        AND (t.in_tok + t.cache_w5m + t.cache_w1h
                             + t.cache_read + t.out_tok) > 0
                       THEN 1 ELSE 0 END) AS unpriced
       FROM turns t ${clause}`,
    )
    .get(...params) as Record<string, unknown>;
  return {
    turns: Number(row?.turns ?? 0),
    sessions: Number(row?.sessions ?? 0),
    unpricedTurns: Number(row?.unpriced ?? 0),
  };
}

/** Parse `30d`, `12h`, `8w`, or an ISO date, into an ISO timestamp. */
export function parseSince(input: string | undefined): string | null {
  if (!input) return null;
  const rel = /^(\d+)([hdwm])$/.exec(input.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unitMs: Record<string, number> = {
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
      m: 2_592_000_000, // 30 days
    };
    return new Date(Date.now() - n * unitMs[rel[2]!]!).toISOString();
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Cannot parse --since "${input}" (try 7d, 24h, or 2026-07-01)`);
  }
  return d.toISOString();
}

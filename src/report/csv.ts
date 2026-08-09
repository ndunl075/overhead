/**
 * RFC 4180 CSV. CRLF terminators, minimal quoting, doubled quotes.
 * Cost is emitted at full precision — this feeds spreadsheets, and rounding
 * here would make every downstream SUM() disagree with the report.
 */

import type { Report, ReportRow } from "../types.ts";
import { formatMoneyRaw, partitionRows } from "./format.ts";

const CRLF = "\r\n";

/** Column order matches the terminal table and the HTML table. */
export const CSV_HEADER = [
  "unit",
  "cost_usd",
  "share",
  "turns",
  "input_tokens",
  "cache_read_tokens",
  "output_tokens",
] as const;

/** Quote only when required: comma, double quote, CR or LF. */
export function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvLine(fields: readonly string[]): string {
  return fields.map(csvField).join(",");
}

function num(n: number): string {
  return Number.isFinite(n) ? String(n) : "";
}

function rowFields(row: ReportRow): string[] {
  return [
    row.unit,
    formatMoneyRaw(row.costUsd),
    num(row.share),
    num(row.turns),
    num(row.inputTokens),
    num(row.cacheReadTokens),
    num(row.outputTokens),
  ];
}

export function renderCsv(report: Report): string {
  const { normal, unattributed } = partitionRows(report.rows);
  const lines: string[] = [csvLine(CSV_HEADER)];
  for (const row of normal) lines.push(csvLine(rowFields(row)));
  // Pinned last, exactly as in the table and HTML renderers.
  if (unattributed) lines.push(csvLine(rowFields(unattributed)));
  return lines.join(CRLF) + CRLF;
}

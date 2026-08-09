/**
 * Single-file HTML report. No external CSS/JS/fonts/CDN — it must open from
 * file:// on a laptop with no network and still be forwardable to finance.
 *
 * Every interpolated value goes through esc(): unit names come from the
 * filesystem and can legally contain <, &, and quotes.
 */

import type { Report, ReportRow } from "../types.ts";
import {
  COVERAGE_WARN_THRESHOLD,
  UNATTRIBUTED_LABEL,
  UNATTRIBUTED_WARN_THRESHOLD,
  coverageOf,
  formatMoney,
  formatPercent,
  formatTokens,
  formatTurns,
  partitionRows,
  periodLabel,
  truncateLeft,
  unattributedShare,
} from "./format.ts";

/** How many units get a bar in the chart. The table always shows everything. */
const CHART_ROWS = 25;

// ---------------------------------------------------------------------------
// Escaping — one helper, used for text nodes and attribute values alike.
// ---------------------------------------------------------------------------

export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const VB_W = 900;
const LABEL_W = 236;
const BAR_X = 248;
const BAR_MAX = 452; // bar track; leaves ~200px for the value label
const ROW_H = 26;
const BAR_H = 14;
const RADIUS = 4;

/** Bar anchored square at the baseline, rounded at the data end. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, h / 2);
  if (w <= r) return `M${x} ${y}h${round(Math.max(w, 1))}v${h}h${-round(Math.max(w, 1))}z`;
  const x1 = round(x + w);
  return (
    `M${x} ${y}` +
    `H${round(x1 - r)}` +
    `a${r} ${r} 0 0 1 ${r} ${r}` +
    `V${round(y + h - r)}` +
    `a${r} ${r} 0 0 1 ${-r} ${r}` +
    `H${x}` +
    `z`
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function renderHtml(report: Report): string {
  const { config } = report;
  const { normal, unattributed } = partitionRows(report.rows);
  const unattrShare = unattributedShare(report);
  const unattrHot = unattrShare > UNATTRIBUTED_WARN_THRESHOLD;
  const coverage = coverageOf(report);
  const coverageLow = coverage !== null && coverage < COVERAGE_WARN_THRESHOLD;

  const title = `Overhead — AI spend by ${report.by}`;

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    '<main class="wrap">',
    renderHeader(report, title),
    renderStats(report, unattrShare, coverage),
    renderHonesty(report, unattrShare, unattrHot),
    renderWarnings(report, coverage, coverageLow),
    renderChart(normal, unattributed, unattrHot),
    renderTable(report, normal, unattributed),
    renderFooter(report, config),
    "</main>",
    `<script>${SCRIPT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderHeader(report: Report, title: string): string {
  const { totals } = report;
  return `<header class="head">
  <p class="eyebrow">Overhead · token cost attribution</p>
  <h1>${esc(title)}</h1>
  <p class="sub">${esc(periodLabel(report))} · ${esc(String(totals.sessions))} session${
    totals.sessions === 1 ? "" : "s"
  } · ${esc(String(totals.turns))} turn${totals.turns === 1 ? "" : "s"} · generated ${esc(
    report.generatedAt,
  )}</p>
</header>`;
}

function statTile(label: string, value: string, note: string, cls = ""): string {
  return `<div class="tile${cls ? " " + cls : ""}">
    <p class="tile-label">${esc(label)}</p>
    <p class="tile-value">${esc(value)}</p>
    <p class="tile-note">${esc(note)}</p>
  </div>`;
}

function renderStats(report: Report, unattrShare: number, coverage: number | null): string {
  const { totals } = report;
  const attributedShare = totals.totalUsd > 0 ? totals.attributedUsd / totals.totalUsd : 0;
  // The unattributed bucket is not a unit — don't inflate the count with it.
  const unitCount = partitionRows(report.rows).normal.length;
  const tiles = [
    statTile("Total modeled spend", formatMoney(totals.totalUsd), periodLabel(report), "hero"),
    statTile(
      "Attributed",
      formatMoney(totals.attributedUsd),
      `${formatPercent(attributedShare)} of total · ${unitCount} unit${unitCount === 1 ? "" : "s"}`,
    ),
    statTile(
      "Unattributed",
      formatMoney(totals.unattributedUsd),
      `${formatPercent(unattrShare)} of total`,
      unattrShare > UNATTRIBUTED_WARN_THRESHOLD ? "warn" : "",
    ),
  ];
  if (typeof totals.invoicedUsd === "number") {
    tiles.push(
      statTile(
        "Coverage",
        coverage === null ? "—" : formatPercent(coverage),
        `${formatMoney(totals.totalUsd)} modeled / ${formatMoney(totals.invoicedUsd)} invoiced`,
        coverage !== null && coverage < COVERAGE_WARN_THRESHOLD ? "bad" : "",
      ),
    );
  }
  return `<section class="tiles">${tiles.join("\n")}</section>`;
}

/** The unattributed share is the honesty metric — it leads, it does not hide. */
function renderHonesty(report: Report, unattrShare: number, hot: boolean): string {
  const attributedPct = Math.max(0, Math.min(1, 1 - unattrShare)) * 100;
  const headline = hot
    ? "Attribution confidence: LOW"
    : unattrShare > 0.1
      ? "Attribution confidence: fair"
      : "Attribution confidence: good";
  const body = hot
    ? `More than ${esc(formatPercent(UNATTRIBUTED_WARN_THRESHOLD, 0))} of spend came from turns with no file evidence — planning, chat, and research. Read the ranking below as directional, not as an invoice split.`
    : `Turns with no file evidence (planning, chat, research) cannot be tied to a unit. This share is reported, never redistributed onto the units below.`;
  return `<section class="honesty${hot ? " hot" : ""}" aria-label="Attribution confidence">
  <div class="honesty-head">
    <h2>${esc(headline)}</h2>
    <p class="honesty-num">${esc(formatPercent(unattrShare))} unattributed</p>
  </div>
  <div class="meter" role="img" aria-label="${esc(
    `${formatPercent(1 - unattrShare)} attributed, ${formatPercent(unattrShare)} unattributed`,
  )}">
    <span class="meter-fill" style="width:${esc(round(attributedPct))}%"></span>
  </div>
  <p class="meter-legend"><span class="key key-attr"></span>attributed ${esc(
    formatMoney(report.totals.attributedUsd),
  )} <span class="key key-unattr"></span>unattributed ${esc(
    formatMoney(report.totals.unattributedUsd),
  )}</p>
  <p class="honesty-body">${body}</p>
</section>`;
}

function renderWarnings(report: Report, coverage: number | null, coverageLow: boolean): string {
  const items: string[] = [];
  if (report.totals.unpricedTurns > 0) {
    const n = report.totals.unpricedTurns;
    items.push(
      `<li><strong>${esc(String(n))} turn${n === 1 ? "" : "s"} had no price entry</strong> for ${
        n === 1 ? "its" : "their"
      } model and ${n === 1 ? "is" : "are"} counted as $0. Real spend is higher than shown.</li>`,
    );
  }
  if (coverageLow && coverage !== null) {
    items.push(
      `<li><strong>Coverage is ${esc(formatPercent(coverage))}.</strong> These transcripts explain less than ${esc(
        formatPercent(COVERAGE_WARN_THRESHOLD, 0),
      )} of the invoice — machines or CI agents are probably missing from the scan.</li>`,
    );
  }
  if (items.length === 0) return "";
  return `<section class="warnings" aria-label="Warnings">
  <h2>Caveats</h2>
  <ul>${items.join("\n")}</ul>
</section>`;
}

function renderChart(
  normal: readonly ReportRow[],
  unattributed: ReportRow | null,
  unattrHot: boolean,
): string {
  const top = normal.slice(0, CHART_ROWS);
  const rows: Array<{ row: ReportRow; pinned: boolean }> = top.map((row) => ({
    row,
    pinned: false,
  }));
  if (unattributed) rows.push({ row: unattributed, pinned: true });
  if (rows.length === 0) {
    return `<section class="card"><h2>Top units</h2><p class="empty">No attributed spend in this period.</p></section>`;
  }

  const scale = rows.reduce((m, r) => Math.max(m, r.row.costUsd), 0);
  const padTop = 14;
  const height = padTop * 2 + rows.length * ROW_H;

  const parts: string[] = [];
  parts.push(
    `<line class="axis" x1="${BAR_X - 6}" y1="${padTop - 4}" x2="${BAR_X - 6}" y2="${
      height - padTop + 4
    }" />`,
  );

  rows.forEach(({ row, pinned }, i) => {
    const y = padTop + i * ROW_H;
    const barY = y + (ROW_H - BAR_H) / 2;
    const w = scale > 0 ? (row.costUsd / scale) * BAR_MAX : 0;
    const label = pinned ? UNATTRIBUTED_LABEL : row.unit;
    const shown = truncateLeft(label, 34);
    const value = `${formatMoney(row.costUsd)}`;
    const pct = formatPercent(row.share);
    const cls = pinned ? (unattrHot ? "bar bar-hot" : "bar bar-muted") : "bar";
    parts.push(
      `<g class="row">` +
        `<title>${esc(`${label} — ${value} (${pct} of total), ${formatTurns(row.turns)} turns`)}</title>` +
        `<text class="cat" x="${LABEL_W}" y="${y + ROW_H / 2}" text-anchor="end" dominant-baseline="middle">${esc(
          shown,
        )}</text>` +
        `<path class="${cls}" d="${barPath(BAR_X, barY, w, BAR_H)}" />` +
        `<text class="val" x="${round(BAR_X + w + 10)}" y="${
          y + ROW_H / 2
        }" dominant-baseline="middle">${esc(value)}<tspan class="valpct" dx="8">${esc(
          pct,
        )}</tspan></text>` +
        `</g>`,
    );
  });

  const caption =
    normal.length > CHART_ROWS
      ? `Top ${CHART_ROWS} of ${normal.length} units by modeled cost. Full list in the table below.`
      : `All ${normal.length} unit${normal.length === 1 ? "" : "s"} by modeled cost.`;

  return `<section class="card">
  <h2>Where the money went</h2>
  <p class="caption">${esc(caption)}</p>
  <div class="scroll">
    <svg class="chart" viewBox="0 0 ${VB_W} ${height}" width="100%" height="${height}" role="img" preserveAspectRatio="xMinYMin meet">
      <title>${esc(caption)}</title>
      ${parts.join("\n      ")}
    </svg>
  </div>
</section>`;
}

function td(text: string, sortValue: number | string, cls = ""): string {
  return `<td${cls ? ` class="${esc(cls)}"` : ""} data-v="${esc(sortValue)}">${esc(text)}</td>`;
}

function tableRow(row: ReportRow, pinned: boolean): string {
  const label = pinned ? UNATTRIBUTED_LABEL : row.unit;
  return (
    `<tr${pinned ? ' data-pin="1" class="pinned"' : ""}>` +
    `<td class="unit" data-v="${esc(label.toLowerCase())}"><span title="${esc(
      label,
    )}">${esc(label)}</span></td>` +
    td(formatMoney(row.costUsd), row.costUsd, "num") +
    td(formatPercent(row.share), row.share, "num") +
    td(formatTurns(row.turns), row.turns, "num") +
    td(formatTokens(row.inputTokens), row.inputTokens, "num") +
    td(formatTokens(row.cacheReadTokens), row.cacheReadTokens, "num") +
    td(formatTokens(row.outputTokens), row.outputTokens, "num") +
    `</tr>`
  );
}

function renderTable(
  report: Report,
  normal: readonly ReportRow[],
  unattributed: ReportRow | null,
): string {
  const headers: Array<[string, string]> = [
    ["unit", "text"],
    ["cost", "num"],
    ["share", "num"],
    ["turns", "num"],
    ["tok in", "num"],
    ["cached", "num"],
    ["tok out", "num"],
  ];
  const thead = headers
    .map(
      ([label, type], i) =>
        `<th scope="col" tabindex="0" role="columnheader" data-type="${esc(type)}"${
          type === "num" ? ' class="num"' : ""
        } aria-sort="none" title="${esc(`Sort by ${label}`)}">${esc(label)}</th>`,
    )
    .join("");

  const body = normal.map((r) => tableRow(r, false)).join("\n");
  const pinned = unattributed ? "\n" + tableRow(unattributed, true) : "";

  return `<section class="card">
  <h2>All units</h2>
  <p class="caption">Click a column heading to sort. ${esc(
    UNATTRIBUTED_LABEL,
  )} stays pinned to the bottom. <strong>tok in</strong> is fresh input; <strong>cached</strong> is cache reads, which dominate agent volume and bill at 0.1&times; input.</p>
  <div class="scroll">
    <table id="rows">
      <thead><tr>${thead}</tr></thead>
      <tbody>${body}${pinned}</tbody>
    </table>
  </div>
</section>`;
}

function renderFooter(report: Report, config: { lambda: number; window: number }): string {
  return `<footer class="foot">
  <p><strong>How these numbers were made.</strong> Each assistant turn's cost is split across the files that turn was demonstrably about, with older evidence decayed by <code>λ = ${esc(
    String(config.lambda),
  )}</code> over a <code>${esc(
    String(config.window),
  )}</code>-turn window, then rolled up by <code>${esc(report.by)}</code>. Turns with no file evidence go to ${esc(
    UNATTRIBUTED_LABEL,
  )} rather than being spread across units.</p>
  <p class="dim">Generated ${esc(report.generatedAt)} · ${esc(periodLabel(report))} · no message content leaves the machine, only paths and token counts.</p>
</footer>`;
}

// ---------------------------------------------------------------------------
// Style — complete light palette on :root, dark overrides tokens only.
// ---------------------------------------------------------------------------

const STYLE = `
:root {
  color-scheme: light;
  --plane: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --line: #e1e0d9;
  --axis: #c3c2b7;
  --series: #2a78d6;
  --series-soft: #cde2fb;
  --warn: #fab219;
  --warn-ink: #7a4a00;
  --warn-bg: #fdf4e0;
  --bad: #d03b3b;
  --bad-bg: #fbeceb;
  --ring: rgba(11, 11, 11, 0.10);
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --plane: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --line: #2c2c2a;
    --axis: #383835;
    --series: #3987e5;
    --series-soft: #184f95;
    --warn: #fab219;
    --warn-ink: #f3c46a;
    --warn-bg: #2a2113;
    --bad: #e66767;
    --bad-bg: #2c1717;
    --ring: rgba(255, 255, 255, 0.10);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--plane);
  color: var(--ink);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  overflow-x: hidden;
}
.wrap { max-width: 1040px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: clamp(22px, 3.2vw, 30px); line-height: 1.2; margin: 4px 0 6px; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 0 0 2px; letter-spacing: 0.01em; }
p { margin: 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }

.head { padding-bottom: 20px; border-bottom: 1px solid var(--line); margin-bottom: 24px; }
.eyebrow { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.sub { color: var(--ink-2); font-size: 13px; }

.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
.tile { background: var(--surface); border: 1px solid var(--ring); border-radius: var(--radius); padding: 14px 16px; }
.tile-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.tile-value { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; margin: 2px 0 2px; }
.tile.hero .tile-value { font-size: 34px; }
.tile-note { font-size: 12px; color: var(--ink-2); }
.tile.warn { border-color: var(--warn); background: var(--warn-bg); }
.tile.warn .tile-value { color: var(--warn-ink); }
.tile.bad { border-color: var(--bad); background: var(--bad-bg); }
.tile.bad .tile-value { color: var(--bad); }

.honesty { background: var(--surface); border: 1px solid var(--ring); border-left: 3px solid var(--series); border-radius: var(--radius); padding: 16px; margin-bottom: 20px; }
.honesty.hot { border-left-color: var(--warn); background: var(--warn-bg); }
.honesty-head { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: baseline; }
.honesty-num { font-weight: 650; font-variant-numeric: tabular-nums; }
.honesty.hot .honesty-num { color: var(--warn-ink); }
.honesty-body { font-size: 13px; color: var(--ink-2); margin-top: 8px; max-width: 72ch; }
.meter { position: relative; height: 12px; border-radius: 6px; background: var(--axis); overflow: hidden; margin: 10px 0 6px; }
.meter-fill { position: absolute; inset: 0 auto 0 0; background: var(--series); border-radius: 6px 0 0 6px; }
.meter-legend { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.key { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin: 0 5px 0 12px; vertical-align: baseline; }
.meter-legend .key:first-child { margin-left: 0; }
.key-attr { background: var(--series); }
.key-unattr { background: var(--axis); }

.warnings { border: 1px solid var(--warn); background: var(--warn-bg); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 20px; }
.warnings h2 { color: var(--warn-ink); }
.warnings ul { margin: 6px 0 0; padding-left: 18px; font-size: 13px; color: var(--ink-2); }
.warnings li + li { margin-top: 4px; }

.card { background: var(--surface); border: 1px solid var(--ring); border-radius: var(--radius); padding: 16px; margin-bottom: 20px; }
.caption { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
.empty { font-size: 13px; color: var(--muted); }
.scroll { overflow-x: auto; max-width: 100%; }

/* height:auto lets the viewBox aspect ratio drive height, so a narrow viewport
   scales the chart instead of leaving a gap under it. */
.chart { display: block; min-width: 720px; height: auto; }
.chart .cat { fill: var(--ink-2); font-size: 12px; font-family: inherit; }
.chart .val { fill: var(--ink); font-size: 12px; font-family: inherit; font-variant-numeric: tabular-nums; }
.chart .valpct { fill: var(--muted); }
.chart .bar { fill: var(--series); }
.chart .bar-muted { fill: var(--axis); }
.chart .bar-hot { fill: var(--warn); }
.chart .axis { stroke: var(--axis); stroke-width: 1; }

table { border-collapse: collapse; width: 100%; min-width: 640px; font-variant-numeric: tabular-nums; }
th, td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--line); font-size: 13px; }
th { position: sticky; top: 0; background: var(--surface); color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; user-select: none; white-space: nowrap; }
th:hover, th:focus-visible { color: var(--ink); }
th[aria-sort="ascending"]::after { content: " \\2191"; }
th[aria-sort="descending"]::after { content: " \\2193"; }
td.num, th.num { text-align: right; }
td.unit { max-width: 380px; overflow-wrap: anywhere; }
tbody tr:hover { background: color-mix(in srgb, var(--series) 7%, transparent); }
tr.pinned td { border-top: 2px solid var(--axis); color: var(--ink-2); font-style: italic; }

.foot { font-size: 13px; color: var(--ink-2); border-top: 1px solid var(--line); padding-top: 16px; max-width: 78ch; }
.foot p + p { margin-top: 8px; }
.foot .dim { color: var(--muted); font-size: 12px; }
@media (max-width: 560px) {
  .wrap { padding: 20px 14px 48px; }
  .tile.hero .tile-value { font-size: 28px; }
}
`;

// ---------------------------------------------------------------------------
// Click-to-sort — vanilla DOM, no libraries.
// ---------------------------------------------------------------------------

const SCRIPT = `
(function () {
  var table = document.getElementById("rows");
  if (!table || !table.tHead) return;
  var headers = table.tHead.rows[0].cells;
  var body = table.tBodies[0];
  var state = { col: -1, dir: 0 };

  function sortBy(index) {
    var type = headers[index].getAttribute("data-type");
    var dir;
    if (state.col === index) dir = -state.dir;
    else dir = type === "num" ? -1 : 1;
    state = { col: index, dir: dir };

    var rows = [];
    var pinned = [];
    for (var i = 0; i < body.rows.length; i++) {
      var r = body.rows[i];
      if (r.getAttribute("data-pin")) pinned.push(r);
      else rows.push(r);
    }
    rows.sort(function (a, b) {
      var av = a.cells[index].getAttribute("data-v");
      var bv = b.cells[index].getAttribute("data-v");
      if (type === "num") return (parseFloat(av) - parseFloat(bv)) * dir;
      return av.localeCompare(bv) * dir;
    });
    var frag = document.createDocumentFragment();
    rows.forEach(function (r) { frag.appendChild(r); });
    pinned.forEach(function (r) { frag.appendChild(r); });
    body.appendChild(frag);

    for (var j = 0; j < headers.length; j++) {
      headers[j].setAttribute(
        "aria-sort",
        j === index ? (dir === 1 ? "ascending" : "descending") : "none"
      );
    }
  }

  for (var i = 0; i < headers.length; i++) {
    (function (index) {
      var th = headers[index];
      th.addEventListener("click", function () { sortBy(index); });
      th.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sortBy(index); }
      });
    })(i);
  }
})();
`;

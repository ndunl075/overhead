import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { Report, ReportRow, ReportTotals } from "../src/types.ts";
import { UNATTRIBUTED, DEFAULT_ATTRIBUTION } from "../src/types.ts";
import { renderTable } from "../src/report/table.ts";
import { renderHtml } from "../src/report/html.ts";
import { renderCsv } from "../src/report/csv.ts";
import {
  bar,
  formatMoney,
  formatPercent,
  formatTokens,
  truncateLeft,
} from "../src/report/format.ts";

// ---------------------------------------------------------------------------
// Fixtures (in-code; the report stage never touches the database)
// ---------------------------------------------------------------------------

const ANSI_RE = new RegExp("\u001b\\[[0-9;]*m");
const RULE_RE = /^─+$/;

function row(
  unit: string,
  costUsd: number,
  share: number,
  over: Partial<ReportRow> = {},
): ReportRow {
  return {
    unit,
    costUsd,
    share,
    turns: 10,
    inputTokens: 1_000_000,
    outputTokens: 50_000,
    cacheReadTokens: 4_000_000,
    ...over,
  };
}

function makeReport(rows: ReportRow[], totals: Partial<ReportTotals> = {}): Report {
  const attributed = rows
    .filter((r) => r.unit !== UNATTRIBUTED)
    .reduce((a, r) => a + r.costUsd, 0);
  const unattributed = rows
    .filter((r) => r.unit === UNATTRIBUTED)
    .reduce((a, r) => a + r.costUsd, 0);
  return {
    by: "dir",
    since: "2026-07-01",
    rows,
    totals: {
      attributedUsd: attributed,
      unattributedUsd: unattributed,
      unpricedTurns: 0,
      totalUsd: attributed + unattributed,
      turns: 431,
      sessions: 12,
      ...totals,
    },
    config: DEFAULT_ATTRIBUTION,
    generatedAt: "2026-08-08T12:00:00.000Z",
  };
}

const BASIC = makeReport([
  row("packages/checkout", 412.19, 0.412),
  row("apps/admin", 210.5, 0.21),
  row("services/billing", 105.25, 0.105),
  row(UNATTRIBUTED, 92.0, 0.092, { turns: 40 }),
]);

/** Table body lines: everything between the two horizontal rules. */
function bodyLines(out: string): string[] {
  const lines = out.split("\n");
  const rules: number[] = [];
  lines.forEach((l, i) => {
    if (RULE_RE.test(l)) rules.push(i);
  });
  assert.ok(rules.length >= 2, "expected two horizontal rules in table output");
  return lines.slice((rules[0] ?? 0) + 1, rules[1] ?? lines.length);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

describe("renderCsv", () => {
  test("RFC 4180 quoting and escaping", () => {
    const nasty = 'packages/we"ird, name/src';
    const csv = renderCsv(makeReport([row(nasty, 1.5, 0.5), row("plain/dir", 1.5, 0.5)]));
    const lines = csv.split("\r\n");

    assert.equal(
      lines[0],
      "unit,cost_usd,share,turns,input_tokens,cache_read_tokens,output_tokens",
    );
    assert.ok(lines[1]?.startsWith('"packages/we""ird, name/src",'), `quoting failed: ${lines[1]}`);
    // Plain fields are not quoted.
    assert.ok(lines[2]?.startsWith("plain/dir,"), `over-quoted: ${lines[2]}`);
    // CRLF terminated, trailing newline included, no bare LF anywhere.
    assert.ok(csv.endsWith("\r\n"));
    assert.equal(csv.replace(/\r\n/g, "").includes("\n"), false);
  });

  test("newline inside a unit name is quoted, not emitted raw", () => {
    const csv = renderCsv(makeReport([row("weird\nname", 1, 1)]));
    assert.ok(csv.includes('"weird\nname"'));
    assert.equal(csv.split("\r\n").filter((l) => l.length > 0).length, 2);
  });

  test("cost keeps full precision (no pre-rounding to 2dp)", () => {
    const csv = renderCsv(makeReport([row("a/b", 0.123456789, 1)]));
    assert.ok(csv.includes("0.123456789"), csv);
  });

  test("unattributed row is pinned last", () => {
    const csv = renderCsv(BASIC).trimEnd();
    const last = csv.split("\r\n").at(-1) ?? "";
    assert.ok(last.startsWith(UNATTRIBUTED), last);
  });
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

describe("renderHtml", () => {
  const hostile = '<script>alert("x")</script> & "quotes" & <b>';
  const html = renderHtml(
    makeReport([row(hostile, 10, 0.5), row("apps/admin", 5, 0.25), row(UNATTRIBUTED, 5, 0.25)]),
  );

  test("escapes hostile unit names everywhere", () => {
    assert.equal(html.includes("<script>alert"), false, "raw <script> survived");
    assert.equal(html.includes("<b>"), false, "raw <b> survived");
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("&amp;"));
    // No stray raw ampersand (would mean an unescaped interpolation).
    assert.equal(/&\s/.test(html.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, "")), false);
  });

  test("only our own <script> tag exists", () => {
    const opens = html.match(/<script/g) ?? [];
    assert.equal(opens.length, 1);
  });

  test("is self-contained: no external references", () => {
    for (const needle of ["http://", "https://", "//cdn", "<link", "@import", "src="]) {
      assert.equal(html.includes(needle), false, `found external reference: ${needle}`);
    }
  });

  test("has the structural pieces a reader needs", () => {
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("prefers-color-scheme: dark"));
    assert.ok(html.includes("overflow-x: auto"));
    assert.ok(html.includes("<svg"));
    assert.ok(html.includes("</svg>"));
    assert.ok(html.includes("(unattributed)"));
    assert.ok(html.includes("0.85"), "lambda missing from footer");
    // Value labels are baked into the SVG, not hover-only.
    assert.ok(html.includes('class="val"'));
    assert.ok(html.includes("<title>"));
  });

  test("unattributed row is pinned last in the table", () => {
    const tbody = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    const rows = tbody.split("<tr");
    assert.ok((rows.at(-1) ?? "").includes('data-pin="1"'));
  });

  test("balanced tags for the elements we generate", () => {
    for (const tag of ["section", "table", "tbody", "svg", "g", "text"]) {
      const open = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) ?? []).length;
      const close = (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      assert.equal(open, close, `unbalanced <${tag}>`);
    }
  });
});

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

describe("renderTable", () => {
  test("columns stay aligned with a very long unit name", () => {
    const long = "packages/checkout/src/components/cart/really/deeply/nested/thing.tsx";
    const out = renderTable(
      makeReport([
        row(long, 900.5, 0.6),
        row("a", 100, 0.2),
        row("packages/x", 1.25, 0.1),
        row(UNATTRIBUTED, 10, 0.1),
      ]),
      { color: false, width: 100 },
    );
    const lines = bodyLines(out);
    assert.ok(lines.length >= 4);
    const widths = new Set(lines.map((l) => l.length));
    assert.equal(widths.size, 1, `ragged rows: ${[...widths].join(",")}`);
    // Header row and rule agree with the body.
    const all = out.split("\n");
    const ruleIdx = all.findIndex((l) => RULE_RE.test(l));
    assert.equal((all[ruleIdx] ?? "").length, lines[0]?.length);
    assert.equal((all[ruleIdx - 1] ?? "").length, lines[0]?.length);
    // Long name truncated from the LEFT: tail preserved, head elided.
    assert.ok(out.includes("…"));
    assert.ok(out.includes("nested/thing.tsx"), "informative tail was lost");
    assert.equal(out.includes("packages/checkout/src/components"), false);
  });

  test("no ANSI when color: false", () => {
    const out = renderTable(BASIC, { color: false, width: 100 });
    assert.equal(ANSI_RE.test(out), false);
  });

  test("emits ANSI when color: true", () => {
    const prev = process.env["NO_COLOR"];
    delete process.env["NO_COLOR"];
    try {
      const out = renderTable(BASIC, { color: true, width: 100 });
      assert.equal(ANSI_RE.test(out), true);
    } finally {
      if (prev !== undefined) process.env["NO_COLOR"] = prev;
    }
  });

  test("NO_COLOR overrides color: true", () => {
    const prev = process.env["NO_COLOR"];
    process.env["NO_COLOR"] = "1";
    try {
      const out = renderTable(BASIC, { color: true, width: 100 });
      assert.equal(ANSI_RE.test(out), false);
    } finally {
      if (prev === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = prev;
    }
  });

  test("unattributed is pinned last regardless of input order", () => {
    const report = makeReport([
      row(UNATTRIBUTED, 5, 0.05),
      row("apps/admin", 50, 0.5),
      row("services/billing", 45, 0.45),
    ]);
    const lines = bodyLines(renderTable(report, { color: false, width: 100 }));
    assert.ok((lines.at(-1) ?? "").includes("(unattributed)"));
    assert.equal(lines.filter((l) => l.includes("(unattributed)")).length, 1);
    assert.equal(lines[0]?.includes("apps/admin"), true);
  });

  test("warns loudly when unattributed exceeds 25%", () => {
    const hot = makeReport([row("apps/admin", 60, 0.6), row(UNATTRIBUTED, 40, 0.4)]);
    const out = renderTable(hot, { color: false, width: 100 });
    assert.ok(/confidence is LOW/i.test(out), out);
    assert.ok(out.includes("40.0%"));

    const cool = makeReport([row("apps/admin", 95, 0.95), row(UNATTRIBUTED, 5, 0.05)]);
    assert.equal(/confidence is LOW/i.test(renderTable(cool, { color: false, width: 100 })), false);
  });

  test("top truncation summarizes the remainder instead of dropping it", () => {
    const rows = [
      row("a", 100, 0.4),
      row("b", 50, 0.2),
      row("c", 30, 0.12),
      row("d", 20, 0.08),
      row("e", 10, 0.04),
      row(UNATTRIBUTED, 40, 0.16),
    ];
    const out = renderTable(makeReport(rows), { color: false, width: 100, top: 2 });
    const lines = bodyLines(out);
    // 2 shown + summary + pinned unattributed
    assert.equal(lines.length, 4);
    const summary = lines[2] ?? "";
    assert.ok(summary.includes("and 3 more"), summary);
    // 30 + 20 + 10 = 60 omitted; shares 0.12 + 0.08 + 0.04 = 0.24
    assert.ok(summary.includes("$60.00"), summary);
    assert.ok(summary.includes("24.0%"), summary);
    assert.ok((lines.at(-1) ?? "").includes("(unattributed)"));
    assert.equal(
      lines.some((l) => l.startsWith("c ")),
      false,
      "omitted row leaked into the body",
    );
  });

  test("coverage line and low-coverage warning", () => {
    const report = makeReport([row("a", 100, 1)], { invoicedUsd: 400, coverage: 0.25 });
    const out = renderTable(report, { color: false, width: 100 });
    assert.ok(out.includes("coverage"), out);
    assert.ok(out.includes("$400.00"));
    assert.ok(out.includes("25.0%"));
    assert.ok(/Coverage is 25\.0%/.test(out));

    const ok = makeReport([row("a", 100, 1)], { invoicedUsd: 105, coverage: 100 / 105 });
    const okOut = renderTable(ok, { color: false, width: 100 });
    assert.ok(okOut.includes("coverage"));
    assert.equal(/transcripts explain less than/i.test(okOut), false);
  });

  test("unpriced turns are surfaced, never silently zeroed", () => {
    const out = renderTable(makeReport([row("a", 10, 1)], { unpricedTurns: 7 }), {
      color: false,
      width: 100,
    });
    assert.ok(/7 turns used a model with no price entry/.test(out), out);
    assert.ok(/counted as \$0/.test(out));
  });

  test("reports the attribution config used", () => {
    const out = renderTable(BASIC, { color: false, width: 100 });
    assert.ok(out.includes("λ=0.85"), out);
    assert.ok(out.includes("window=20 turns"));
  });

  test("cache reads are visible in every renderer", () => {
    // Real agent shape: tiny fresh input, huge cache reads. Hiding the cache
    // column made input look ~100x smaller than it is.
    const report = makeReport([
      row("src", 144.83, 0.458, {
        turns: 729.1,
        inputTokens: 5_000,
        cacheReadTokens: 60_000_000,
        outputTokens: 508_000,
      }),
    ]);
    const table = renderTable(report, { color: false, width: 100 });
    assert.ok(table.includes("cached"), "no cached column header");
    assert.ok(table.includes("60M"), "cache reads missing from table body");

    const csv = renderCsv(report);
    assert.ok(csv.includes("cache_read_tokens"));
    assert.ok(csv.includes("60000000"));

    const html = renderHtml(report);
    assert.ok(html.includes(">cached<"));
    assert.ok(html.includes('data-v="60000000"'));
  });

  test("survives an empty report", () => {
    const out = renderTable(makeReport([]), { color: false, width: 100 });
    assert.ok(out.includes("no attributed spend"));
  });

  test("width option is respected and clamped to a sane minimum", () => {
    const wide = bodyLines(renderTable(BASIC, { color: false, width: 140 }));
    assert.equal(wide[0]?.length, 140);
    const narrow = bodyLines(renderTable(BASIC, { color: false, width: 10 }));
    assert.ok((narrow[0]?.length ?? 0) >= 56);
  });
});

// ---------------------------------------------------------------------------
// Formatting primitives
// ---------------------------------------------------------------------------

describe("formatting", () => {
  test("money", () => {
    assert.equal(formatMoney(0), "$0.00");
    assert.equal(formatMoney(0.0001), "$0.0001");
    assert.equal(formatMoney(0.0042), "$0.0042");
    assert.equal(formatMoney(1234.5), "$1,234.50");
    assert.equal(formatMoney(1234567.891), "$1,234,567.89");
    assert.equal(formatMoney(0.999), "$0.9990");
    assert.equal(formatMoney(1), "$1.00");
    assert.equal(formatMoney(-12.5), "-$12.50");
    // Sub-cent values never collapse to a misleading $0.00.
    assert.notEqual(formatMoney(0.0001), "$0.00");
    assert.ok(formatMoney(1e-9).startsWith("<$0."));
  });

  test("tokens", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(912), "912");
    assert.equal(formatTokens(847_000), "847k");
    assert.equal(formatTokens(1_200_000), "1.2M");
    assert.equal(formatTokens(1_500_000), "1.5M");
    assert.equal(formatTokens(999_999), "1M");
    assert.equal(formatTokens(2_400_000_000), "2.4B");
    assert.equal(formatTokens(1234), "1.2k");
  });

  test("percent", () => {
    assert.equal(formatPercent(0), "0.0%");
    assert.equal(formatPercent(0.412), "41.2%");
    assert.equal(formatPercent(1), "100.0%");
    assert.equal(formatPercent(0.0000001), "<0.1%");
  });

  test("left truncation keeps the informative tail", () => {
    assert.equal(truncateLeft("packages/checkout/src/cart.ts", 21), "…checkout/src/cart.ts");
    // A separator left dangling after the ellipsis is dropped: never "…/checkout".
    assert.equal(truncateLeft("packages/checkout/src/cart.ts", 22), "…checkout/src/cart.ts");
    assert.equal(truncateLeft("short", 22), "short");
    assert.equal(truncateLeft("abcdef", 6).length, 6);
    assert.equal(truncateLeft("abcdef", 4), "…def");
    for (const max of [5, 8, 13, 21, 40]) {
      assert.ok(truncateLeft("packages/checkout/src/cart.ts", max).length <= max);
    }
  });

  test("bar uses block characters and partial cells", () => {
    assert.equal(bar(1, 10), "█".repeat(10));
    assert.equal(bar(0, 10), "");
    assert.equal(bar(0.5, 10).length, 5);
    assert.ok(/[▏▎▍▌▋▊▉]/.test(bar(0.55, 10)));
    // Any nonzero value is visible.
    assert.equal(bar(0.0001, 10).length, 1);
    assert.ok(bar(0.73, 20).length <= 20);
  });
});

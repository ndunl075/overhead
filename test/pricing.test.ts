import { test } from "node:test";
import assert from "node:assert/strict";

import { priceTurn, totalTokens } from "../src/pricing/cost.ts";
import { lookupPrice, PRICES } from "../src/pricing/models.ts";
import { emptyUsage, type Usage } from "../src/types.ts";

function usage(u: Partial<Usage>): Usage {
  return { ...emptyUsage(), ...u };
}

test("prices fresh input and output at list rate", () => {
  // Opus 5: $5/MTok in, $25/MTok out.
  const { costUsd, priced } = priceTurn(
    "claude-opus-5",
    usage({ input: 1_000_000, output: 1_000_000 }),
  );
  assert.equal(priced, true);
  assert.equal(costUsd, 30);
});

test("applies the three distinct cache multipliers", () => {
  const p = PRICES["claude-opus-5"]!;
  const cases: [keyof Usage, number][] = [
    ["cacheWrite5m", 1.25],
    ["cacheWrite1h", 2.0],
    ["cacheRead", 0.1],
  ];
  for (const [field, mult] of cases) {
    const { costUsd } = priceTurn("claude-opus-5", usage({ [field]: 1_000_000 }));
    assert.equal(costUsd, p.input * mult, `${field} should bill at ${mult}x input`);
  }
});

test("1h cache writes cost more than 5m — the split must not be collapsed", () => {
  const short = priceTurn("claude-opus-5", usage({ cacheWrite5m: 500_000 })).costUsd;
  const long = priceTurn("claude-opus-5", usage({ cacheWrite1h: 500_000 })).costUsd;
  assert.ok(long > short);
  assert.equal(long / short, 2.0 / 1.25);
});

test("unknown models are flagged, never silently zero-costed", () => {
  const res = priceTurn("some-future-model", usage({ input: 1_000_000 }));
  assert.equal(res.priced, false);
  assert.equal(res.costUsd, 0);
});

test("resolves date-suffixed and Bedrock-prefixed model ids", () => {
  assert.deepEqual(lookupPrice("claude-haiku-4-5-20251001"), { input: 1, output: 5 });
  assert.deepEqual(lookupPrice("anthropic.claude-opus-5"), { input: 5, output: 25 });
});

test("longest-prefix match does not confuse 4-6 with 4-6-something-else", () => {
  // "claude-opus-4-8" must not be resolved via the shorter "claude-opus-4-..."
  assert.deepEqual(lookupPrice("claude-opus-4-8"), { input: 5, output: 25 });
  assert.deepEqual(lookupPrice("claude-opus-4-1"), { input: 15, output: 75 });
});

test("intro pricing applies before its expiry and lapses after", () => {
  const before = lookupPrice("claude-sonnet-5", { at: new Date("2026-08-01") });
  const after = lookupPrice("claude-sonnet-5", { at: new Date("2026-09-01") });
  assert.deepEqual(before, { input: 2, output: 10 });
  assert.deepEqual(after, { input: 3, output: 15 });
});

test("intro pricing is inclusive of its final day", () => {
  const last = lookupPrice("claude-sonnet-5", { at: new Date("2026-08-31T23:00:00Z") });
  assert.deepEqual(last, { input: 2, output: 10 });
});

test("fast mode is priced at the premium rate", () => {
  const std = priceTurn("claude-opus-5", usage({ output: 1_000_000 })).costUsd;
  const fast = priceTurn("claude-opus-5", usage({ output: 1_000_000 }), {
    fast: true,
  }).costUsd;
  assert.equal(std, 25);
  assert.equal(fast, 50);
});

test("batch requests are halved", () => {
  const std = priceTurn("claude-opus-5", usage({ input: 1_000_000 })).costUsd;
  const batch = priceTurn("claude-opus-5", usage({ input: 1_000_000 }), {
    batch: true,
  }).costUsd;
  assert.equal(batch, std / 2);
});

test("web searches bill per request, outside the token multipliers", () => {
  const { costUsd } = priceTurn("claude-opus-5", usage({ webSearches: 250 }));
  assert.equal(costUsd, 2.5); // $10 per 1000
});

test("config overrides beat the built-in table", () => {
  const { costUsd } = priceTurn("claude-opus-5", usage({ input: 1_000_000 }), {
    overrides: { "claude-opus-5": { input: 4, output: 20 } },
  });
  assert.equal(costUsd, 4);
});

test("a realistic cached agent turn prices correctly", () => {
  // Numbers taken from a real Claude Code transcript line.
  const { costUsd } = priceTurn(
    "claude-opus-5",
    usage({ input: 2, cacheWrite1h: 12_417, cacheRead: 18_044, output: 283 }),
  );
  const expected =
    ((2 + 12_417 * 2.0 + 18_044 * 0.1) * 5 + 283 * 25) / 1_000_000;
  assert.ok(Math.abs(costUsd - expected) < 1e-12);
  // Sanity: cache-heavy turns are cheap but not free.
  assert.ok(costUsd > 0.1 && costUsd < 0.2);
});

test("totalTokens sums every billable category", () => {
  assert.equal(
    totalTokens(
      usage({ input: 1, cacheWrite5m: 2, cacheWrite1h: 3, cacheRead: 4, output: 5 }),
    ),
    15,
  );
});

test("harness pseudo-models are free, not unknown", () => {
  // Claude Code writes `<synthetic>` for locally-generated messages. Marking
  // them unpriced would warn that real spend is higher when it is not.
  const res = priceTurn("<synthetic>", usage({}));
  assert.equal(res.priced, true);
  assert.equal(res.costUsd, 0);
});

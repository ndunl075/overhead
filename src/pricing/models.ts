import type { ModelPrice } from "../types.ts";

/**
 * Anthropic list prices, USD per million tokens.
 * Source: platform.claude.com pricing, captured 2026-06-24.
 *
 * These are first-party API rates. They also apply to Microsoft Foundry.
 * Bedrock and Vertex are partner-operated with separate pricing — override
 * via `overhead.config.json` -> `prices` if you bill through those.
 */
export const PRICE_TABLE_VERSION = "2026-06-24";

export const PRICES: Record<string, ModelPrice> = {
  // Fable / Mythos tier
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-mythos-preview": { input: 10, output: 50 },

  // Opus tier
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4-0": { input: 15, output: 75 },

  // Sonnet tier
  "claude-sonnet-5": {
    input: 3,
    output: 15,
    intro: { input: 2, output: 10, until: "2026-08-31" },
  },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-0": { input: 3, output: 15 },

  // Haiku tier
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Fast mode runs the same model at premium pricing. The transcript reports
 * `usage.speed`, so we key the surcharge separately rather than forking ids.
 */
export const FAST_MODE_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 10, output: 50 },
};

/** Batch API is billed at half of standard rates. */
export const BATCH_MULTIPLIER = 0.5;

/**
 * Pseudo-models that never hit the API. Claude Code writes `<synthetic>` for
 * locally-generated messages (interrupts, harness errors). They carry no
 * tokens and cost nothing — treating them as "unknown model" would fire the
 * unpriced-spend warning on turns that are genuinely free.
 */
export const NON_BILLABLE_MODELS = new Set(["<synthetic>"]);

/**
 * Resolve a price entry. Handles date-suffixed ids (`claude-haiku-4-5-20251001`)
 * and Bedrock's `anthropic.` prefix by falling back to the longest known
 * id that the given id starts with.
 */
export function lookupPrice(
  model: string,
  opts: { fast?: boolean; at?: Date; overrides?: Record<string, ModelPrice> } = {},
): ModelPrice | null {
  const id = model.replace(/^anthropic\./, "");
  const table = opts.fast ? { ...PRICES, ...FAST_MODE_PRICES } : PRICES;
  const merged = { ...table, ...(opts.overrides ?? {}) };

  let entry = merged[id];
  if (!entry) {
    // Longest-prefix match covers date-suffixed snapshot ids.
    let best = "";
    for (const key of Object.keys(merged)) {
      if (id.startsWith(key) && key.length > best.length) best = key;
    }
    if (!best) return null;
    entry = merged[best]!;
  }

  if (entry.intro) {
    const now = opts.at ?? new Date();
    // `until` is an inclusive last day; compare against end-of-day UTC.
    if (now <= new Date(`${entry.intro.until}T23:59:59.999Z`)) {
      return { input: entry.intro.input, output: entry.intro.output };
    }
  }
  return { input: entry.input, output: entry.output };
}

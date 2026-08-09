import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  WEB_SEARCH_COST,
  type ModelPrice,
  type Usage,
} from "../types.ts";
import { BATCH_MULTIPLIER, NON_BILLABLE_MODELS, lookupPrice } from "./models.ts";

export interface PricedResult {
  costUsd: number;
  /** False when the model id is unknown — cost is 0 and must be surfaced. */
  priced: boolean;
}

export interface PriceOpts {
  fast?: boolean;
  batch?: boolean;
  at?: Date;
  overrides?: Record<string, ModelPrice>;
}

/**
 * Price one turn.
 *
 * Every input-side category is a multiple of the model's input rate:
 *   fresh input   1.00x
 *   5m cache write 1.25x   (writing a 5-minute cache entry)
 *   1h cache write 2.00x   (writing a 1-hour cache entry)
 *   cache read     0.10x
 *
 * Conflating the two cache-write TTLs — or using the flat
 * `cache_creation_input_tokens` field — understates long-session agent cost,
 * because agent harnesses lean on the 1h TTL.
 */
export function priceTurn(
  model: string,
  usage: Usage,
  opts: PriceOpts = {},
): PricedResult {
  // Harness pseudo-models never reached the API. They are genuinely free, not
  // unknown — flagging them would fire the "real spend is higher" warning on
  // turns that cost nothing.
  if (NON_BILLABLE_MODELS.has(model)) return { costUsd: 0, priced: true };

  const price = lookupPrice(model, opts);
  if (!price) return { costUsd: 0, priced: false };

  const inputUnits =
    usage.input +
    usage.cacheWrite5m * CACHE_WRITE_5M_MULTIPLIER +
    usage.cacheWrite1h * CACHE_WRITE_1H_MULTIPLIER +
    usage.cacheRead * CACHE_READ_MULTIPLIER;

  let cost =
    (inputUnits * price.input + usage.output * price.output) / 1_000_000;

  if (opts.batch) cost *= BATCH_MULTIPLIER;

  // Server-tool usage is billed per request, outside the token multipliers.
  cost += usage.webSearches * WEB_SEARCH_COST;

  return { costUsd: cost, priced: true };
}

/** Total billable token volume, for reporting alongside dollars. */
export function totalTokens(u: Usage): number {
  return u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead + u.output;
}

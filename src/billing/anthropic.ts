/**
 * Anthropic Admin API cost adapter.
 *
 * GET /v1/organizations/cost_report
 * Auth: Admin API key (`sk-ant-admin…`) via `x-api-key`.
 * Amounts arrive as decimal strings in lowest currency units (cents for USD):
 * `"123.45"` → $1.2345.
 *
 * Docs: https://platform.claude.com/docs/en/api/admin/cost_report/retrieve
 */

import type { BillingAdapter, InvoicePeriod, InvoiceTotal } from "./types.ts";

export const ANTHROPIC_ADMIN_API_BASE =
  "https://api.anthropic.com/v1/organizations";
export const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicCostResult {
  amount: string;
  currency?: string | null;
  cost_type?: string | null;
  description?: string | null;
  model?: string | null;
  workspace_id?: string | null;
}

export interface AnthropicCostBucket {
  starting_at: string;
  ending_at: string;
  results: AnthropicCostResult[];
}

export interface AnthropicCostReport {
  data: AnthropicCostBucket[];
  has_more: boolean;
  next_page: string | null;
}

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

export interface AnthropicFetchOpts {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/** Resolve Admin API key from opts or environment. */
export function resolveAnthropicAdminKey(explicit?: string): string {
  const key =
    explicit?.trim() ||
    process.env.ANTHROPIC_ADMIN_API_KEY?.trim() ||
    process.env.ANTHROPIC_ADMIN_KEY?.trim() ||
    "";
  if (!key) {
    throw new Error(
      "Anthropic Admin API key required. Set ANTHROPIC_ADMIN_API_KEY " +
        "(or ANTHROPIC_ADMIN_KEY), or pass --api-key.",
    );
  }
  if (!key.startsWith("sk-ant-admin")) {
    throw new Error(
      "Expected an Admin API key (sk-ant-admin…), not a standard API key.",
    );
  }
  return key;
}

/**
 * Convert a cost_report `amount` string to USD.
 * Anthropic reports lowest currency units (cents); `"123.45"` → $1.2345.
 */
export function amountToUsd(amount: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid cost amount "${amount}"`);
  }
  return n / 100;
}

/** Sum every result across every bucket. */
export function sumCostReportUsd(report: AnthropicCostReport): {
  totalUsd: number;
  buckets: number;
  currency: string;
} {
  let totalUsd = 0;
  let currency = "USD";
  for (const bucket of report.data) {
    for (const row of bucket.results) {
      totalUsd += amountToUsd(row.amount);
      if (row.currency) currency = row.currency;
    }
  }
  return { totalUsd, buckets: report.data.length, currency };
}

function buildUrl(
  baseUrl: string,
  period: InvoicePeriod,
  page: string | null,
): string {
  const u = new URL(`${baseUrl.replace(/\/$/, "")}/cost_report`);
  u.searchParams.set("starting_at", period.startingAt);
  u.searchParams.set("ending_at", period.endingAt);
  u.searchParams.set("bucket_width", "1d");
  // Up to ~31 daily buckets per request; a calendar month fits.
  u.searchParams.set("limit", "31");
  if (page) u.searchParams.set("page", page);
  return u.toString();
}

/**
 * Fetch and page through the cost report for a period, returning the USD total.
 * Injectable `fetchImpl` keeps unit tests offline.
 */
export async function fetchAnthropicCostReport(
  period: InvoicePeriod,
  opts: AnthropicFetchOpts = {},
): Promise<InvoiceTotal> {
  const apiKey = resolveAnthropicAdminKey(opts.apiKey);
  const baseUrl = opts.baseUrl ?? ANTHROPIC_ADMIN_API_BASE;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);

  const merged: AnthropicCostReport = {
    data: [],
    has_more: false,
    next_page: null,
  };

  let page: string | null = null;
  let guard = 0;
  do {
    const url = buildUrl(baseUrl, period, page);
    const res = await fetchImpl(url, {
      headers: {
        "anthropic-version": ANTHROPIC_VERSION,
        "x-api-key": apiKey,
        accept: "application/json",
      },
    });
    const body = await res.text();
    if (!res.ok) {
      let detail = body.slice(0, 400);
      try {
        const j = JSON.parse(body) as { error?: { message?: string } };
        if (j.error?.message) detail = j.error.message;
      } catch {
        /* keep raw */
      }
      throw new Error(
        `Anthropic cost_report failed (${res.status} ${res.statusText}): ${detail}`,
      );
    }
    let parsed: AnthropicCostReport;
    try {
      parsed = JSON.parse(body) as AnthropicCostReport;
    } catch (err) {
      throw new Error(
        `Anthropic cost_report returned non-JSON: ${(err as Error).message}`,
      );
    }
    merged.data.push(...(parsed.data ?? []));
    page = parsed.has_more ? parsed.next_page : null;
    if (++guard > 64) {
      throw new Error("Anthropic cost_report pagination exceeded 64 pages");
    }
  } while (page);

  const { totalUsd, buckets, currency } = sumCostReportUsd(merged);
  return {
    provider: "anthropic",
    period,
    totalUsd,
    currency,
    buckets,
    fetchedAt: new Date().toISOString(),
  };
}

export const anthropicBillingAdapter: BillingAdapter = {
  id: "anthropic",
  label: "Anthropic Admin API (cost_report)",
  fetchInvoice(period, opts) {
    return fetchAnthropicCostReport(period, opts);
  },
};

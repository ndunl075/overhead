/**
 * Provider billing adapters — pull authoritative invoice totals so
 * `overhead reconcile` can scale modeled spend without hand-entering the bill.
 */

export interface InvoicePeriod {
  /** Inclusive start, RFC 3339 / ISO-8601. */
  startingAt: string;
  /** Exclusive end, RFC 3339 / ISO-8601. */
  endingAt: string;
  /** Calendar month label when the window is a whole month, else undefined. */
  label?: string;
}

export interface InvoiceTotal {
  provider: string;
  period: InvoicePeriod;
  /** Summed spend in USD. */
  totalUsd: number;
  currency: string;
  /** How many daily buckets were summed. */
  buckets: number;
  fetchedAt: string;
}

export interface BillingAdapter {
  readonly id: string;
  readonly label: string;
  fetchInvoice(period: InvoicePeriod, opts?: { apiKey?: string }): Promise<InvoiceTotal>;
}

/** Parse `YYYY-MM` into a UTC month window `[start, nextMonth)`. */
export function periodFromMonth(ym: string): InvoicePeriod {
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    throw new Error(`period must look like 2026-07; got "${ym}"`);
  }
  const [y, m] = ym.split("-").map(Number);
  const startingAt = new Date(Date.UTC(y!, m! - 1, 1)).toISOString();
  const endingAt = new Date(Date.UTC(y!, m!, 1)).toISOString();
  return { startingAt, endingAt, label: ym };
}

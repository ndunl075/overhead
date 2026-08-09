import { anthropicBillingAdapter } from "./anthropic.ts";
import type { BillingAdapter } from "./types.ts";

export {
  amountToUsd,
  fetchAnthropicCostReport,
  resolveAnthropicAdminKey,
  sumCostReportUsd,
} from "./anthropic.ts";
export {
  periodFromMonth,
  type BillingAdapter,
  type InvoicePeriod,
  type InvoiceTotal,
} from "./types.ts";

const ADAPTERS: Record<string, BillingAdapter> = {
  anthropic: anthropicBillingAdapter,
};

export function listBillingAdapters(): BillingAdapter[] {
  return Object.values(ADAPTERS);
}

export function getBillingAdapter(id: string): BillingAdapter {
  const key = id.trim().toLowerCase();
  const adapter = ADAPTERS[key];
  if (!adapter) {
    const known = Object.keys(ADAPTERS).join(", ");
    throw new Error(
      `Unknown billing provider "${id}". Known: ${known || "(none)"}`,
    );
  }
  return adapter;
}

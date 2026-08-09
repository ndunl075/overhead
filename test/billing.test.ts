import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  amountToUsd,
  fetchAnthropicCostReport,
  resolveAnthropicAdminKey,
  sumCostReportUsd,
} from "../src/billing/anthropic.ts";
import {
  getBillingAdapter,
  periodFromMonth,
} from "../src/billing/index.ts";
import type { AnthropicCostReport } from "../src/billing/anthropic.ts";

describe("periodFromMonth", () => {
  it("builds a UTC [start, nextMonth) window", () => {
    const p = periodFromMonth("2026-07");
    assert.equal(p.label, "2026-07");
    assert.equal(p.startingAt, "2026-07-01T00:00:00.000Z");
    assert.equal(p.endingAt, "2026-08-01T00:00:00.000Z");
  });

  it("rejects malformed labels", () => {
    assert.throws(() => periodFromMonth("2026-7"), /period must look like/);
  });
});

describe("amountToUsd", () => {
  it("treats amounts as cents", () => {
    assert.equal(amountToUsd("123.45"), 1.2345);
    assert.equal(amountToUsd("100"), 1);
  });
});

describe("sumCostReportUsd", () => {
  it("sums every result across buckets", () => {
    const report: AnthropicCostReport = {
      data: [
        {
          starting_at: "2026-07-01T00:00:00Z",
          ending_at: "2026-07-02T00:00:00Z",
          results: [
            { amount: "10000", currency: "USD" }, // $100
            { amount: "2500.50", currency: "USD" }, // $25.005
          ],
        },
        {
          starting_at: "2026-07-02T00:00:00Z",
          ending_at: "2026-07-03T00:00:00Z",
          results: [{ amount: "500", currency: "USD" }], // $5
        },
      ],
      has_more: false,
      next_page: null,
    };
    const sum = sumCostReportUsd(report);
    assert.equal(sum.buckets, 2);
    assert.equal(sum.currency, "USD");
    assert.ok(Math.abs(sum.totalUsd - 130.005) < 1e-9);
  });
});

describe("resolveAnthropicAdminKey", () => {
  it("requires an admin-prefixed key", () => {
    assert.throws(
      () => resolveAnthropicAdminKey("sk-ant-api03-nope"),
      /Admin API key/,
    );
  });

  it("accepts an explicit admin key", () => {
    assert.equal(
      resolveAnthropicAdminKey("sk-ant-admin01-test"),
      "sk-ant-admin01-test",
    );
  });
});

describe("fetchAnthropicCostReport", () => {
  it("pages and totals via injected fetch", async () => {
    const pages: AnthropicCostReport[] = [
      {
        data: [
          {
            starting_at: "2026-07-01T00:00:00Z",
            ending_at: "2026-07-02T00:00:00Z",
            results: [{ amount: "10000", currency: "USD" }],
          },
        ],
        has_more: true,
        next_page: "page_two",
      },
      {
        data: [
          {
            starting_at: "2026-07-02T00:00:00Z",
            ending_at: "2026-07-03T00:00:00Z",
            results: [{ amount: "20000", currency: "USD" }],
          },
        ],
        has_more: false,
        next_page: null,
      },
    ];
    let calls = 0;
    const fetchImpl = async (url: string) => {
      calls++;
      if (calls === 1) assert.match(url, /starting_at=/);
      if (calls === 2) assert.match(url, /page=page_two/);
      const body = JSON.stringify(pages[calls - 1]);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => body,
      };
    };

    const invoice = await fetchAnthropicCostReport(periodFromMonth("2026-07"), {
      apiKey: "sk-ant-admin01-test",
      fetchImpl,
    });
    assert.equal(calls, 2);
    assert.equal(invoice.provider, "anthropic");
    assert.equal(invoice.totalUsd, 300);
    assert.equal(invoice.buckets, 2);
  });

  it("surfaces HTTP errors", async () => {
    await assert.rejects(
      () =>
        fetchAnthropicCostReport(periodFromMonth("2026-07"), {
          apiKey: "sk-ant-admin01-test",
          fetchImpl: async () => ({
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            text: async () =>
              JSON.stringify({ error: { message: "invalid key" } }),
          }),
        }),
      /invalid key/,
    );
  });
});

describe("getBillingAdapter", () => {
  it("resolves anthropic", () => {
    assert.equal(getBillingAdapter("anthropic").id, "anthropic");
  });

  it("rejects unknown providers", () => {
    assert.throws(() => getBillingAdapter("acme"), /Unknown billing provider/);
  });
});

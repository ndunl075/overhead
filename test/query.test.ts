import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/db/db.ts";
import { buildReport, parseSince } from "../src/query.ts";
import {
  DEFAULT_ATTRIBUTION,
  UNATTRIBUTED,
  emptyUsage,
  type Attribution,
  type Rollup,
  type Session,
  type Turn,
} from "../src/types.ts";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "overhead-test-"));
  const store = new Store(join(dir, "test.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function turn(over: Partial<Turn> & { id: string; seq: number }): Turn {
  return {
    sessionId: "s1",
    ts: `2026-07-0${(over.seq % 9) + 1}T12:00:00.000Z`,
    model: "claude-opus-5",
    isSidechain: false,
    sidechainKey: null,
    usage: { ...emptyUsage(), input: 1000, output: 100 },
    costUsd: 1,
    priced: true,
    touches: [],
    ...over,
  };
}

function session(turns: Turn[], over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    source: "claude-code",
    projectSlug: "test",
    repoRoot: "/repo",
    gitBranch: "main",
    startedAt: turns[0]!.ts,
    endedAt: turns.at(-1)!.ts,
    turns,
    ...over,
  };
}

/** Rollup that takes the first path segment. */
const firstSegment: Rollup = {
  kind: "dir",
  label: "dir",
  map: (p) => p.split("/")[0] ?? null,
};

test("round-trips a session through storage", () => {
  withStore((store) => {
    const t = turn({
      id: "s1:m1",
      seq: 0,
      touches: [
        { path: "packages/a/x.ts", tool: "edit", toolName: "Edit", weight: 1 },
      ],
    });
    store.putSession(session([t]));

    const loaded = store.loadTurnsForAttribution();
    assert.equal(loaded.size, 1);
    const turns = loaded.get("s1")!;
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.id, "s1:m1");
    assert.equal(turns[0]!.usage.input, 1000);
    assert.deepEqual(turns[0]!.touches, t.touches);
  });
});

test("re-scanning a session replaces rather than duplicates its turns", () => {
  withStore((store) => {
    store.putSession(session([turn({ id: "s1:m1", seq: 0 })]));
    store.putSession(
      session([turn({ id: "s1:m1", seq: 0 }), turn({ id: "s1:m2", seq: 1 })]),
    );
    const turns = store.loadTurnsForAttribution().get("s1")!;
    assert.equal(turns.length, 2, "second scan must not duplicate turn m1");
  });
});

test("aggregates attributions into report rows and totals", () => {
  withStore((store) => {
    const turns = [
      turn({ id: "s1:m1", seq: 0, costUsd: 10 }),
      turn({ id: "s1:m2", seq: 1, costUsd: 6 }),
    ];
    store.putSession(session(turns));
    const attrs: Attribution[] = [
      { turnId: "s1:m1", path: "packages/a/x.ts", share: 0.5, costUsd: 5 },
      { turnId: "s1:m1", path: "packages/b/y.ts", share: 0.5, costUsd: 5 },
      { turnId: "s1:m2", path: "packages/a/z.ts", share: 1, costUsd: 6 },
    ];
    store.replaceAttributions(["s1:m1", "s1:m2"], attrs);

    const report = buildReport(store, "dir", {
      config: DEFAULT_ATTRIBUTION,
      rollup: firstSegment,
    });

    assert.equal(report.totals.totalUsd, 16);
    assert.equal(report.totals.turns, 2);
    assert.equal(report.totals.sessions, 1);
    // "packages" is the first segment of every path, so one row.
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0]!.unit, "packages");
    assert.equal(report.rows[0]!.costUsd, 16);
    assert.equal(report.rows[0]!.share, 1);
  });
});

test("rows are sorted by cost descending and shares sum to 1", () => {
  withStore((store) => {
    store.putSession(session([turn({ id: "s1:m1", seq: 0, costUsd: 10 })]));
    store.replaceAttributions(
      ["s1:m1"],
      [
        { turnId: "s1:m1", path: "small/a.ts", share: 0.2, costUsd: 2 },
        { turnId: "s1:m1", path: "big/b.ts", share: 0.8, costUsd: 8 },
      ],
    );
    const report = buildReport(store, "dir", {
      config: DEFAULT_ATTRIBUTION,
      rollup: firstSegment,
    });
    assert.deepEqual(
      report.rows.map((r) => r.unit),
      ["big", "small"],
    );
    const shareSum = report.rows.reduce((s, r) => s + r.share, 0);
    assert.ok(Math.abs(shareSum - 1) < 1e-9);
  });
});

test("UNATTRIBUTED survives rollup and is split out of totals", () => {
  withStore((store) => {
    store.putSession(
      session([
        turn({ id: "s1:m1", seq: 0, costUsd: 8 }),
        turn({ id: "s1:m2", seq: 1, costUsd: 2 }),
      ]),
    );
    store.replaceAttributions(
      ["s1:m1", "s1:m2"],
      [
        { turnId: "s1:m1", path: "packages/a.ts", share: 1, costUsd: 8 },
        { turnId: "s1:m2", path: UNATTRIBUTED, share: 1, costUsd: 2 },
      ],
    );
    const report = buildReport(store, "dir", {
      config: DEFAULT_ATTRIBUTION,
      rollup: firstSegment,
    });
    assert.equal(report.totals.attributedUsd, 8);
    assert.equal(report.totals.unattributedUsd, 2);
    assert.equal(report.totals.totalUsd, 10);
    assert.ok(
      report.rows.some((r) => r.unit === UNATTRIBUTED),
      "unattributed must not be folded into a directory",
    );
  });
});

test("paths the rollup cannot map land in a labelled bucket", () => {
  withStore((store) => {
    store.putSession(session([turn({ id: "s1:m1", seq: 0, costUsd: 5 })]));
    store.replaceAttributions(
      ["s1:m1"],
      [{ turnId: "s1:m1", path: "vendor/thing.ts", share: 1, costUsd: 5 }],
    );
    const nullRollup: Rollup = { kind: "package", label: "pkg", map: () => null };
    const report = buildReport(store, "package", {
      config: DEFAULT_ATTRIBUTION,
      rollup: nullRollup,
      unmappedLabel: "(outside packages)",
    });
    assert.equal(report.rows[0]!.unit, "(outside packages)");
  });
});

test("token columns are apportioned by share, not double counted", () => {
  withStore((store) => {
    const t = turn({ id: "s1:m1", seq: 0, costUsd: 10 });
    t.usage.input = 1000;
    t.usage.output = 200;
    store.putSession(session([t]));
    store.replaceAttributions(
      ["s1:m1"],
      [
        { turnId: "s1:m1", path: "a/x.ts", share: 0.75, costUsd: 7.5 },
        { turnId: "s1:m1", path: "b/y.ts", share: 0.25, costUsd: 2.5 },
      ],
    );
    const report = buildReport(store, "dir", {
      config: DEFAULT_ATTRIBUTION,
      rollup: firstSegment,
    });
    const totalIn = report.rows.reduce((s, r) => s + r.inputTokens, 0);
    assert.equal(totalIn, 1000, "apportioned tokens must sum to the turn's tokens");
    const a = report.rows.find((r) => r.unit === "a")!;
    assert.equal(a.inputTokens, 750);
    assert.equal(a.outputTokens, 150);
  });
});

test("--since filters turns out of the report", () => {
  withStore((store) => {
    const old = turn({ id: "s1:m1", seq: 0, costUsd: 5 });
    old.ts = "2026-01-01T00:00:00.000Z";
    const recent = turn({ id: "s1:m2", seq: 1, costUsd: 7 });
    recent.ts = "2026-07-01T00:00:00.000Z";
    store.putSession(session([old, recent]));
    store.replaceAttributions(
      ["s1:m1", "s1:m2"],
      [
        { turnId: "s1:m1", path: "a/x.ts", share: 1, costUsd: 5 },
        { turnId: "s1:m2", path: "a/x.ts", share: 1, costUsd: 7 },
      ],
    );
    const report = buildReport(store, "dir", {
      since: "2026-06-01T00:00:00.000Z",
      config: DEFAULT_ATTRIBUTION,
      rollup: firstSegment,
    });
    assert.equal(report.totals.totalUsd, 7);
    assert.equal(report.totals.turns, 1);
  });
});

test("grouping by model bypasses the rollup", () => {
  withStore((store) => {
    const a = turn({ id: "s1:m1", seq: 0, costUsd: 9 });
    const b = turn({ id: "s1:m2", seq: 1, costUsd: 1, model: "claude-haiku-4-5" });
    store.putSession(session([a, b]));
    store.replaceAttributions([], []);
    const report = buildReport(store, "model", { config: DEFAULT_ATTRIBUTION });
    assert.deepEqual(
      report.rows.map((r) => r.unit),
      ["claude-opus-5", "claude-haiku-4-5"],
    );
    assert.equal(report.rows[0]!.costUsd, 9);
  });
});

test("unpriced turns are counted so they can be surfaced", () => {
  withStore((store) => {
    const t = turn({ id: "s1:m1", seq: 0, costUsd: 0, priced: false });
    store.putSession(session([t]));
    store.replaceAttributions([], []);
    const report = buildReport(store, "model", { config: DEFAULT_ATTRIBUTION });
    assert.equal(report.totals.unpricedTurns, 1);
  });
});

test("reconciliation computes coverage against the invoice", () => {
  withStore((store) => {
    store.putSession(session([turn({ id: "s1:m1", seq: 0, costUsd: 80 })]));
    store.replaceAttributions(
      ["s1:m1"],
      [{ turnId: "s1:m1", path: "a/x.ts", share: 1, costUsd: 80 }],
    );
    const report = buildReport(store, "dir", {
      config: DEFAULT_ATTRIBUTION,
      rollup: firstSegment,
      invoicedUsd: 100,
    });
    assert.equal(report.totals.invoicedUsd, 100);
    assert.ok(Math.abs(report.totals.coverage! - 0.8) < 1e-9);
  });
});

test("meta round-trips and upserts", () => {
  withStore((store) => {
    assert.equal(store.getMeta("nope"), null);
    store.setMeta("k", "1");
    store.setMeta("k", "2");
    assert.equal(store.getMeta("k"), "2");
  });
});

test("parseSince understands relative and absolute forms", () => {
  assert.equal(parseSince(undefined), null);
  const sevenDays = parseSince("7d")!;
  const delta = Date.now() - new Date(sevenDays).getTime();
  assert.ok(Math.abs(delta - 7 * 86_400_000) < 5000);
  assert.equal(parseSince("2026-07-01"), new Date("2026-07-01").toISOString());
  assert.throws(() => parseSince("last tuesday"), /Cannot parse/);
});

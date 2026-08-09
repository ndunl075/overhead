import test from "node:test";
import assert from "node:assert/strict";
import { UNATTRIBUTED, emptyUsage } from "../src/types.ts";
import type { Attribution, Touch, ToolKind, Turn } from "../src/types.ts";
import { WEIGHTS } from "../src/attribute/weights.ts";
import {
  attributeAll,
  attributeSession,
  recomputeAttributions,
} from "../src/attribute/engine.ts";
import { Store } from "../src/db/db.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function touch(path: string, tool: ToolKind = "edit"): Touch {
  return { path, tool, toolName: tool, weight: WEIGHTS[tool] };
}

function turn(
  seq: number,
  paths: (string | Touch)[],
  opts: { cost?: number; sidechainKey?: string | null; session?: string } = {},
): Turn {
  const session = opts.session ?? "s1";
  return {
    id: `${session}:m${seq}`,
    sessionId: session,
    seq,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    model: "claude-opus-5",
    isSidechain: opts.sidechainKey != null,
    sidechainKey: opts.sidechainKey ?? null,
    usage: emptyUsage(),
    costUsd: opts.cost ?? 1,
    priced: true,
    touches: paths.map((p) => (typeof p === "string" ? touch(p) : p)),
  };
}

function byTurn(rows: Attribution[]): Map<string, Attribution[]> {
  const m = new Map<string, Attribution[]>();
  for (const r of rows) {
    let list = m.get(r.turnId);
    if (!list) m.set(r.turnId, (list = []));
    list.push(r);
  }
  return m;
}

function shareOf(rows: Attribution[], path: string): number {
  return rows.find((r) => r.path === path)?.share ?? 0;
}

/** Asserts `got` reconciles with `want` to within 1e-12 relative (spec: 1e-9). */
function assertReconciles(got: number, want: number, what: string): void {
  const err = Math.abs(got - want) / Math.max(1, Math.abs(want));
  assert.ok(err < 1e-12, `${what}: got ${got}, want ${want} (rel err ${err})`);
}

// ---------------------------------------------------------------------------

test("shares sum to 1 and costs sum exactly to the turn cost", () => {
  const turns = [
    turn(0, ["a.ts", "b/c.ts"], { cost: 3.3333333 }),
    turn(1, ["b/c.ts", "d/e/f.ts", "a.ts"], { cost: 0.0000001 }),
    turn(2, ["g.ts"], { cost: 12345.6789 }),
    turn(3, [], { cost: 7 }),
  ];
  const rows = attributeSession(turns);
  const grouped = byTurn(rows);

  assert.equal(grouped.size, turns.length);
  for (const t of turns) {
    const got = grouped.get(t.id)!;
    const shareSum = got.reduce((s, r) => s + r.share, 0);
    assert.ok(
      Math.abs(shareSum - 1) < 1e-9,
      `shares for ${t.id} summed to ${shareSum}`,
    );
    // The residual is pushed onto the largest share so totals reconcile.
    const costSum = got.reduce((s, r) => s + r.costUsd, 0);
    assertReconciles(costSum, t.costUsd, `costs for ${t.id}`);
  }
});

test("zero-cost turns still emit attributions (the `turns` column needs them)", () => {
  const rows = attributeSession([turn(0, ["a.ts", "b.ts"], { cost: 0 })]);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((s, r) => s + r.share, 0), 1);
  for (const r of rows) assert.equal(r.costUsd, 0);
});

test("decay actually decays: old evidence scores below fresh evidence", () => {
  // old.ts touched at seq 0; new.ts touched at seq 10 (the turn under test).
  const turns: Turn[] = [turn(0, ["old.ts"])];
  for (let i = 1; i < 10; i++) turns.push(turn(i, []));
  turns.push(turn(10, ["new.ts"]));

  const rows = byTurn(attributeSession(turns)).get("s1:m10")!;
  const oldShare = shareOf(rows, "old.ts");
  const newShare = shareOf(rows, "new.ts");

  assert.ok(oldShare > 0, "old evidence should still be inside the window");
  assert.ok(newShare > oldShare, `expected ${newShare} > ${oldShare}`);
  // lambda^10 = 0.85^10 ~= 0.1969; share ratio must match exactly.
  const expectedRatio = Math.pow(0.85, 10);
  assert.ok(Math.abs(oldShare / newShare - expectedRatio) < 1e-9);
});

test("decay is monotonic across successive turns", () => {
  const turns = [turn(0, ["a.ts"]), turn(1, ["b.ts"]), turn(2, ["c.ts"])];
  const rows = byTurn(attributeSession(turns)).get("s1:m2")!;
  assert.ok(shareOf(rows, "c.ts") > shareOf(rows, "b.ts"));
  assert.ok(shareOf(rows, "b.ts") > shareOf(rows, "a.ts"));
});

test("window cutoff drops evidence beyond `window` turns", () => {
  const turns: Turn[] = [turn(0, ["old.ts"])];
  for (let i = 1; i <= 5; i++) turns.push(turn(i, ["new.ts"]));

  const inWindow = byTurn(attributeSession(turns, { lambda: 0.9, window: 6 })).get(
    "s1:m5",
  )!;
  assert.ok(shareOf(inWindow, "old.ts") > 0, "distance 5 with window 6 is inside");

  const outOfWindow = byTurn(attributeSession(turns, { lambda: 0.9, window: 5 })).get(
    "s1:m5",
  )!;
  assert.equal(
    shareOf(outOfWindow, "old.ts"),
    0,
    "distance 5 with window 5 must be excluded",
  );
  assert.equal(outOfWindow.length, 1);
  assert.equal(outOfWindow[0]!.path, "new.ts");
});

test("window=1 attributes purely to the current turn's own touches", () => {
  const turns = [turn(0, ["a.ts"]), turn(1, ["b.ts"])];
  const rows = byTurn(attributeSession(turns, { lambda: 0.85, window: 1 })).get(
    "s1:m1",
  )!;
  assert.deepEqual(
    rows.map((r) => r.path),
    ["b.ts"],
  );
});

test("sidechain evidence never leaks into the main thread (or back)", () => {
  const turns = [
    turn(0, ["main.ts"]),
    turn(1, ["subagent.ts"], { sidechainKey: "sc1" }),
    turn(2, ["sub2.ts"], { sidechainKey: "sc1" }),
    turn(3, [], { sidechainKey: "sc2" }), // a different subagent, no evidence
    turn(4, []), // main thread, empty own evidence
  ];
  const grouped = byTurn(attributeSession(turns));

  // Main thread turn 4 sees only main-thread evidence.
  const main4 = grouped.get("s1:m4")!;
  assert.deepEqual(
    main4.map((r) => r.path),
    ["main.ts"],
  );
  assert.equal(main4[0]!.share, 1);

  // Sidechain turn 2 sees only its own sidechain's evidence.
  const sc2 = grouped.get("s1:m2")!;
  assert.deepEqual(
    new Set(sc2.map((r) => r.path)),
    new Set(["subagent.ts", "sub2.ts"]),
  );
  assert.ok(!sc2.some((r) => r.path === "main.ts"));

  // A sidechain with no evidence of its own is unattributed, not borrowed.
  const sc2empty = grouped.get("s1:m3")!;
  assert.deepEqual(sc2empty.map((r) => r.path), [UNATTRIBUTED]);
});

test("distance is positional within a sidechain, not a seq difference", () => {
  // Two sidechain turns separated by 30 main-thread turns. If distance used
  // raw seq they would be outside the default window of 20 and decayed apart.
  const turns: Turn[] = [turn(0, ["sub.ts"], { sidechainKey: "sc" })];
  for (let i = 1; i <= 30; i++) turns.push(turn(i, ["main.ts"]));
  turns.push(turn(31, ["sub2.ts"], { sidechainKey: "sc" }));

  const rows = byTurn(attributeSession(turns)).get("s1:m31")!;
  const older = shareOf(rows, "sub.ts");
  const newer = shareOf(rows, "sub2.ts");
  assert.ok(older > 0, "the earlier sidechain turn must still be adjacent");
  // Positionally adjacent -> exactly one step of decay.
  assert.ok(Math.abs(older / newer - 0.85) < 1e-9, `ratio was ${older / newer}`);
});

test("empty evidence goes 100% to UNATTRIBUTED", () => {
  const rows = attributeSession([turn(0, [], { cost: 4.25 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.path, UNATTRIBUTED);
  assert.equal(rows[0]!.share, 1);
  assert.equal(rows[0]!.costUsd, 4.25);
});

test("zero-weight (`other`) touches do not create attributions", () => {
  const t = turn(0, [touch("mystery.ts", "other")]);
  const rows = attributeSession([t]);
  assert.deepEqual(rows.map((r) => r.path), [UNATTRIBUTED]);
});

test("weights drive relative shares within a turn", () => {
  const t = turn(0, [touch("edited.ts", "edit"), touch("found.ts", "search")]);
  const rows = attributeSession([t]);
  const edited = shareOf(rows, "edited.ts");
  const found = shareOf(rows, "found.ts");
  assert.ok(Math.abs(edited - 1.0 / 1.2) < 1e-12);
  assert.ok(Math.abs(found - 0.2 / 1.2) < 1e-12);
});

test("duplicate touches of the same path in one turn accumulate", () => {
  const t = turn(0, [touch("a.ts", "edit"), touch("a.ts", "edit"), touch("b.ts", "edit")]);
  const rows = attributeSession([t]);
  assert.ok(Math.abs(shareOf(rows, "a.ts") - 2 / 3) < 1e-12);
});

test("turns are sorted by seq regardless of input order", () => {
  const unordered = [turn(2, ["c.ts"]), turn(0, ["a.ts"]), turn(1, ["b.ts"])];
  const rows = byTurn(attributeSession(unordered)).get("s1:m0")!;
  assert.deepEqual(rows.map((r) => r.path), ["a.ts"]);
});

test("attributeAll keeps sessions independent", () => {
  const bySession = new Map<string, Turn[]>([
    ["s1", [turn(0, ["a.ts"], { session: "s1" })]],
    ["s2", [turn(0, [], { session: "s2" })]],
  ]);
  const grouped = byTurn(attributeAll(bySession));
  assert.deepEqual(grouped.get("s1:m0")!.map((r) => r.path), ["a.ts"]);
  assert.deepEqual(grouped.get("s2:m0")!.map((r) => r.path), [UNATTRIBUTED]);
});

test("bad config degrades to defaults instead of producing NaN", () => {
  const turns = [turn(0, ["a.ts"]), turn(1, ["b.ts"])];
  for (const cfg of [
    { lambda: 0, window: 20 },
    { lambda: Number.NaN, window: Number.NaN },
    { lambda: 5, window: -3 },
  ]) {
    const rows = attributeSession(turns, cfg);
    for (const r of rows) {
      assert.ok(Number.isFinite(r.share) && r.share >= 0 && r.share <= 1);
    }
  }
});

test("recomputeAttributions round-trips through the store and records config", () => {
  const store = new Store(":memory:");
  try {
    store.putSession({
      id: "s1",
      source: "claude-code",
      projectSlug: "p",
      repoRoot: null,
      gitBranch: null,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:02Z",
      turns: [
        turn(0, ["a0.ts"], { cost: 1 }),
        turn(1, ["a1.ts"], { cost: 2 }),
        turn(2, [], { cost: 3 }),
      ],
    });

    const first = recomputeAttributions(store, { lambda: 0.5, window: 3 });
    assert.equal(first.turns, 3);
    assert.equal(first.rows, 5); // 1 + 2 + 2 (turn 2 inherits both via decay)
    assert.equal(store.getMeta("attr.lambda"), "0.5");
    assert.equal(store.getMeta("attr.window"), "3");

    const stored = store.db
      .prepare("SELECT turn_id, path, share, cost_usd FROM attributions")
      .all() as { turn_id: string; path: string; share: number; cost_usd: number }[];
    assert.equal(stored.length, 5);
    assertReconciles(
      stored.reduce((s, r) => s + r.cost_usd, 0),
      6,
      "total cost after recompute",
    );

    // Recomputing with a tighter window replaces rather than appends.
    const second = recomputeAttributions(store, { lambda: 0.5, window: 1 });
    assert.equal(second.rows, 3); // turn 2 now has no evidence -> UNATTRIBUTED
    const after = store.db
      .prepare("SELECT path FROM attributions")
      .all() as { path: string }[];
    assert.equal(after.length, 3);
    assert.ok(after.some((r) => r.path === UNATTRIBUTED));
    assert.equal(store.getMeta("attr.window"), "1");
  } finally {
    store.close();
  }
});

test("5000-turn session attributes well under 2s (guards the O(n^2) trap)", () => {
  const N = 5000;
  const turns: Turn[] = [];
  for (let i = 0; i < N; i++) {
    turns.push(
      turn(
        i,
        [
          `packages/p${i % 40}/src/file${i % 7}.ts`,
          touch(`packages/p${(i + 3) % 40}/README.md`, "read"),
          touch(`apps/a${i % 5}/main.ts`, "search"),
        ],
        { cost: (i % 13) * 0.001, sidechainKey: i % 9 === 0 ? `sc${i % 4}` : null },
      ),
    );
  }

  const started = process.hrtime.bigint();
  const rows = attributeSession(turns);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(byTurn(rows).size, N);
  // Spot-check reconciliation on the hot path too.
  const grouped = byTurn(rows);
  for (const t of turns.slice(0, 200)) {
    const got = grouped.get(t.id)!;
    assert.ok(Math.abs(got.reduce((s, r) => s + r.share, 0) - 1) < 1e-9);
    assertReconciles(got.reduce((s, r) => s + r.costUsd, 0), t.costUsd, t.id);
  }

  console.log(`  5000-turn attribution: ${ms.toFixed(1)}ms, ${rows.length} rows`);
  assert.ok(ms < 2000, `attribution took ${ms}ms, expected < 2000ms`);
});

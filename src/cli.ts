#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { CONFIG_FILENAME, SAMPLE_CONFIG, loadConfig } from "./config.ts";
import { Store } from "./db/db.ts";
import { buildReport, parseSince } from "./query.ts";
import { PRICE_TABLE_VERSION } from "./pricing/models.ts";
import type { Report, ReportGroupBy, Rollup } from "./types.ts";

import { collectClaudeCode } from "./collect/claude-code.ts";
import { recomputeAttributions } from "./attribute/engine.ts";
import { detectPackages } from "./rollup/workspace.ts";
import { makeCodeownersRollup } from "./rollup/codeowners.ts";
import {
  dirRollup,
  featureRollup,
  fileRollup,
  packageRollup,
} from "./rollup/units.ts";
import { renderTable } from "./report/table.ts";
import { renderHtml } from "./report/html.ts";
import { renderCsv } from "./report/csv.ts";

const USAGE = `overhead — token cost attribution across a monorepo

USAGE
  overhead <command> [options]

COMMANDS
  scan                  Ingest agent transcripts and attribute their cost
  report                Show attributed spend
  reconcile             Scale modeled spend against an actual invoice total
  export                Emit the report as JSON or CSV
  html                  Write a shareable HTML report
  config init           Write a starter ${CONFIG_FILENAME}

COMMON OPTIONS
  --repo <path>         Repo root (default: cwd, walked up to nearest .git)
  --since <spec>        7d | 24h | 4w | 2026-07-01   (default: all history)
  --help

scan
  --all-projects        Scan every project's transcripts, not just this repo
  --reattribute         Recompute attribution from stored evidence only (no re-read)

report
  --by <kind>           dir | package | team | feature | file | model | session
                        (default: package if a workspace is detected, else dir)
  --depth <n>           Directory depth for --by dir (default: 2)
  --top <n>             Show only the N largest units (default: 25)
  --no-color

reconcile
  --actual <usd>        The invoiced total for the period
  --period <YYYY-MM>    Restrict to a calendar month

export
  --format json|csv     (default: json)

html
  -o, --out <path>      Output file (default: overhead-report.html)
`;

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

function dbPath(repoRoot: string): string {
  const dir = join(repoRoot, ".overhead");
  mkdirSync(dir, { recursive: true });
  return join(dir, "overhead.db");
}

function pickRollup(
  by: ReportGroupBy,
  repoRoot: string,
  cfg: ReturnType<typeof loadConfig>,
  depth: number,
): { rollup: Rollup | undefined; unmapped: string } {
  switch (by) {
    case "file":
      return { rollup: fileRollup(), unmapped: "(unmapped)" };
    case "dir":
      return { rollup: dirRollup(depth), unmapped: "(root)" };
    case "package": {
      const pkgs = detectPackages(repoRoot);
      if (pkgs.length === 0) {
        console.error(
          "No workspace packages detected — falling back to --by dir.\n" +
            "  (looked for pnpm-workspace.yaml, package.json#workspaces, go.work, Cargo.toml, nx.json)",
        );
        return { rollup: dirRollup(depth), unmapped: "(root)" };
      }
      return { rollup: packageRollup(pkgs), unmapped: "(outside packages)" };
    }
    case "team": {
      const rollup = makeCodeownersRollup(repoRoot);
      if (!rollup) {
        throw new Error(
          "No CODEOWNERS file found (looked in ./, .github/, docs/).\n" +
            "Add one to attribute spend to teams.",
        );
      }
      return { rollup, unmapped: "(unowned)" };
    }
    case "feature": {
      if (Object.keys(cfg.features).length === 0) {
        throw new Error(
          `No features defined. Add a "features" map to ${CONFIG_FILENAME} ` +
            `(run \`overhead config init\` for a template).`,
        );
      }
      return { rollup: featureRollup(cfg.features), unmapped: "(no feature)" };
    }
    default:
      return { rollup: undefined, unmapped: "(unmapped)" };
  }
}

function invoiceKey(period?: string): string {
  return period ? `invoice.${period}` : "invoice.all";
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const sub = argv[1];
  const rest = argv.slice(command === "config" ? 2 : 1);

  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      since: { type: "string" },
      by: { type: "string" },
      depth: { type: "string" },
      top: { type: "string" },
      format: { type: "string" },
      out: { type: "string", short: "o" },
      actual: { type: "string" },
      period: { type: "string" },
      "all-projects": { type: "boolean" },
      reattribute: { type: "boolean" },
      "no-color": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const repoRoot = findRepoRoot(values.repo ?? process.cwd());

  if (command === "config") {
    if (sub !== "init") throw new Error("Usage: overhead config init");
    const target = join(repoRoot, CONFIG_FILENAME);
    if (existsSync(target)) {
      console.error(`${CONFIG_FILENAME} already exists — leaving it alone.`);
      return 1;
    }
    writeFileSync(target, SAMPLE_CONFIG);
    console.log(`Wrote ${target}`);
    return 0;
  }

  const cfg = loadConfig(repoRoot);
  const since = parseSince(values.since);
  const store = new Store(dbPath(repoRoot));

  try {
    if (command === "scan") {
      if (!values.reattribute) {
        const t0 = Date.now();
        const { sessions, stats } = collectClaudeCode({
          since: since ?? undefined,
          repoRoot,
          onlyThisRepo: !values["all-projects"],
          priceOpts: { overrides: cfg.prices },
        });
        for (const s of sessions) store.putSession(s);
        console.log(
          `Ingested ${stats.turns} turns across ${stats.sessions} sessions ` +
            `from ${stats.files} transcripts (${Date.now() - t0}ms)` +
            (stats.linesSkipped
              ? `\n  ${stats.linesSkipped} malformed lines skipped`
              : ""),
        );
        if (stats.sessions === 0) {
          console.error(
            "\nNo sessions matched this repo. Try --all-projects, or --repo <path>.",
          );
        }
      }

      const res = recomputeAttributions(store, cfg.attribution);
      store.setMeta("prices.version", PRICE_TABLE_VERSION);
      console.log(
        `Attributed ${res.turns} turns into ${res.rows} path assignments ` +
          `(lambda=${cfg.attribution.lambda}, window=${cfg.attribution.window})`,
      );
      return 0;
    }

    // Everything below renders a report.
    const detected = detectPackages(repoRoot);
    const by = (values.by ??
      (detected.length > 0 ? "package" : "dir")) as ReportGroupBy;
    const valid: ReportGroupBy[] = [
      "dir", "package", "team", "feature", "file", "model", "session",
    ];
    if (!valid.includes(by)) {
      throw new Error(`Unknown --by "${by}". Expected one of: ${valid.join(", ")}`);
    }

    const depth = values.depth ? Number(values.depth) : cfg.depth;
    if (!Number.isInteger(depth) || depth < 1) {
      throw new Error(`--depth must be a positive integer; got "${values.depth}"`);
    }
    const { rollup, unmapped } = pickRollup(by, repoRoot, cfg, depth);

    let sinceIso = since;
    let untilIso: string | null = null;
    if (values.period) {
      if (!/^\d{4}-\d{2}$/.test(values.period)) {
        throw new Error(`--period must look like 2026-07; got "${values.period}"`);
      }
      sinceIso = new Date(`${values.period}-01T00:00:00.000Z`).toISOString();
      const [y, m] = values.period.split("-").map(Number);
      untilIso = new Date(Date.UTC(y!, m!, 1) - 1).toISOString();
    }

    let invoiced: number | undefined;
    if (command === "reconcile") {
      if (values.actual === undefined) {
        throw new Error("reconcile needs --actual <usd> (the invoiced total)");
      }
      invoiced = Number(values.actual.replace(/[$,]/g, ""));
      if (!Number.isFinite(invoiced) || invoiced < 0) {
        throw new Error(`--actual must be a non-negative number; got "${values.actual}"`);
      }
      store.setMeta(invoiceKey(values.period), String(invoiced));
    } else {
      const stored = store.getMeta(invoiceKey(values.period));
      if (stored !== null) invoiced = Number(stored);
    }

    const report: Report = buildReport(store, by, {
      since: sinceIso,
      until: untilIso,
      config: cfg.attribution,
      rollup,
      unmappedLabel: unmapped,
      invoicedUsd: invoiced,
    });

    if (report.totals.turns === 0) {
      console.error("No data yet — run `overhead scan` first.");
      return 1;
    }

    switch (command) {
      case "report":
      case "reconcile": {
        const top = values.top ? Number(values.top) : 25;
        process.stdout.write(
          renderTable(report, { top, color: !values["no-color"] }),
        );
        return 0;
      }
      case "export": {
        const format = values.format ?? "json";
        if (format === "csv") process.stdout.write(renderCsv(report));
        else if (format === "json")
          process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        else throw new Error(`--format must be json or csv; got "${format}"`);
        return 0;
      }
      case "html": {
        const out = resolve(values.out ?? "overhead-report.html");
        writeFileSync(out, renderHtml(report));
        console.log(`Wrote ${out}`);
        return 0;
      }
      default:
        console.error(`Unknown command "${command}"\n`);
        process.stdout.write(USAGE);
        return 1;
    }
  } finally {
    store.close();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`overhead: ${(err as Error).message}`);
    process.exit(1);
  });

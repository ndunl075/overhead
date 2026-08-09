import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNATTRIBUTED } from "../src/types.ts";
import { globToRegExp } from "../src/rollup/glob.ts";
import {
  findCodeowners,
  makeCodeownersRollup,
  ownerFor,
  parseCodeowners,
} from "../src/rollup/codeowners.ts";
import {
  ROOT_UNIT,
  dirRollup,
  featureRollup,
  fileRollup,
  packageRollup,
  resolveRollup,
} from "../src/rollup/units.ts";
import {
  detectPackages,
  expandGlob,
  parseCargoWorkspace,
  parseGoWork,
  parsePackageJsonWorkspaces,
  parsePnpmWorkspace,
} from "../src/rollup/workspace.ts";

// ---------------------------------------------------------------------------
// scratch repo helpers
// ---------------------------------------------------------------------------

const scratches: string[] = [];

function makeRepo(files: Record<string, string>, dirs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "overhead-rollup-"));
  scratches.push(root);
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

test.after(() => {
  for (const dir of scratches) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

test("glob: `*` does not cross `/`", () => {
  const re = globToRegExp("/src/*.ts");
  assert.ok(re.test("src/a.ts"));
  assert.ok(!re.test("src/nested/a.ts"));
  assert.ok(!re.test("other/src/a.ts"), "leading / anchors to repo root");
});

test("glob: `**` crosses `/`", () => {
  const re = globToRegExp("/src/**/*.ts");
  assert.ok(re.test("src/a.ts"));
  assert.ok(re.test("src/deep/nested/a.ts"));
  assert.ok(!re.test("lib/a.ts"));

  const trailing = globToRegExp("apps/**");
  assert.ok(trailing.test("apps/web/src/index.ts"));
  assert.ok(!trailing.test("libs/web/index.ts"));
});

test("glob: unanchored directory pattern matches at any depth", () => {
  const re = globToRegExp("docs/");
  assert.ok(re.test("docs/readme.md"));
  assert.ok(re.test("packages/checkout/docs/api.md"));
  assert.ok(!re.test("packages/docsite/index.ts"));
});

test("glob: a pattern containing a slash is anchored even without a leading /", () => {
  const re = globToRegExp("src/api/");
  assert.ok(re.test("src/api/handler.ts"));
  assert.ok(!re.test("packages/x/src/api/handler.ts"));
});

test("glob: literal regex metacharacters are escaped", () => {
  const re = globToRegExp("/a.b+c/x.ts");
  assert.ok(re.test("a.b+c/x.ts"));
  assert.ok(!re.test("axbxc/x.ts"));
});

test("glob: `?` matches exactly one non-slash character", () => {
  const re = globToRegExp("/src/a?.ts");
  assert.ok(re.test("src/ab.ts"));
  assert.ok(!re.test("src/abc.ts"));
  assert.ok(!re.test("src/a/.ts"));
});

// ---------------------------------------------------------------------------
// CODEOWNERS
// ---------------------------------------------------------------------------

const SAMPLE = `
# Default owner for everything in the repo
*                       @org/everyone

# Frontend
/apps/web/              @org/web @alice
docs/                   @org/docs

# JS anywhere
*.ts                    @org/typescript

# Most specific wins because it comes LAST
/apps/web/src/pay.ts    @org/payments

# A line with no owner removes ownership
/apps/web/secrets.env
`;

test("codeowners: parses patterns, owners and comments", () => {
  const rules = parseCodeowners(SAMPLE);
  assert.equal(rules.length, 6);
  assert.equal(rules[0]!.pattern, "*");
  assert.deepEqual(rules[0]!.owners, ["@org/everyone"]);
  assert.deepEqual(rules[1]!.owners, ["@org/web", "@alice"]);
  assert.deepEqual(rules[5]!.owners, []);
});

test("codeowners: LAST matching rule wins (GitHub semantics, not gitignore)", () => {
  const rules = parseCodeowners(SAMPLE);
  // `*.ts` comes after `/apps/web/`, so it wins for a .ts file there...
  assert.equal(ownerFor(rules, "apps/web/src/app.ts"), "@org/typescript");
  // ...but `/apps/web/src/pay.ts` comes after `*.ts`, so it wins for that file.
  assert.equal(ownerFor(rules, "apps/web/src/pay.ts"), "@org/payments");
  // Non-.ts files under apps/web still belong to the web team.
  assert.equal(ownerFor(rules, "apps/web/index.html"), "@org/web, @alice");
  // Nothing more specific matches -> the catch-all default.
  assert.equal(ownerFor(rules, "scripts/deploy.sh"), "@org/everyone");
});

test("codeowners: multiple owners join with ', '", () => {
  const rules = parseCodeowners("/x/ @a @b @c\n");
  assert.equal(ownerFor(rules, "x/y.ts"), "@a, @b, @c");
});

test("codeowners: an owner-less last match clears ownership", () => {
  const rules = parseCodeowners(SAMPLE);
  assert.equal(ownerFor(rules, "apps/web/secrets.env"), null);
});

test("codeowners: `/`-anchoring and directory patterns", () => {
  const rules = parseCodeowners("/build/ @root-build\nbuild/ @any-build\n");
  // last-match-wins means the unanchored rule takes both here
  assert.equal(ownerFor(rules, "packages/x/build/out.js"), "@any-build");

  const anchored = parseCodeowners("/build/ @root-build\n");
  assert.equal(ownerFor(anchored, "build/out.js"), "@root-build");
  assert.equal(ownerFor(anchored, "packages/x/build/out.js"), null);
});

test("codeowners: `*` does not cross `/`, `**` does", () => {
  const rules = parseCodeowners("/apps/*/config.json @flat\n/libs/**/config.json @deep\n");
  assert.equal(ownerFor(rules, "apps/web/config.json"), "@flat");
  assert.equal(ownerFor(rules, "apps/web/nested/config.json"), null);
  assert.equal(ownerFor(rules, "libs/a/b/c/config.json"), "@deep");
});

test("codeowners: unmatched paths map to null so the caller buckets them", () => {
  const rules = parseCodeowners("/apps/ @web\n");
  assert.equal(ownerFor(rules, "services/api/main.go"), null);
});

test("codeowners: findCodeowners checks all three locations", () => {
  assert.equal(findCodeowners(makeRepo({}, ["src"])), null);

  const rootRepo = makeRepo({ CODEOWNERS: "* @a\n" });
  assert.equal(findCodeowners(rootRepo), join(rootRepo, "CODEOWNERS"));

  const ghRepo = makeRepo({ ".github/CODEOWNERS": "* @a\n" });
  assert.equal(findCodeowners(ghRepo), join(ghRepo, ".github", "CODEOWNERS"));

  const docsRepo = makeRepo({ "docs/CODEOWNERS": "* @a\n" });
  assert.equal(findCodeowners(docsRepo), join(docsRepo, "docs", "CODEOWNERS"));
});

test("codeowners rollup: maps paths, passes UNATTRIBUTED through, null when absent", () => {
  const repo = makeRepo({ ".github/CODEOWNERS": SAMPLE });
  const rollup = makeCodeownersRollup(repo)!;
  assert.ok(rollup);
  assert.equal(rollup.kind, "team");
  assert.equal(rollup.map("apps/web/src/pay.ts"), "@org/payments");
  assert.equal(rollup.map(UNATTRIBUTED), UNATTRIBUTED);
  // cache path (second lookup) must agree
  assert.equal(rollup.map("apps/web/src/pay.ts"), "@org/payments");

  assert.equal(makeCodeownersRollup(makeRepo({})), null);
});

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

test("dirRollup: depth behaviour", () => {
  const d2 = dirRollup(2);
  assert.equal(d2.map("a/b/c/d.ts"), "a/b");
  assert.equal(d2.map("a/b.ts"), "a");
  assert.equal(d2.map("d.ts"), ROOT_UNIT);

  assert.equal(dirRollup(1).map("a/b/c/d.ts"), "a");
  assert.equal(dirRollup(3).map("a/b/c/d.ts"), "a/b/c");
  // deeper than the path -> the whole directory chain
  assert.equal(dirRollup(9).map("a/b/c/d.ts"), "a/b/c");
  // degenerate depths clamp to 1 rather than producing ""
  assert.equal(dirRollup(0).map("a/b/c.ts"), "a");
});

test("dirRollup: UNATTRIBUTED passes through unchanged", () => {
  for (const depth of [1, 2, 5]) {
    assert.equal(dirRollup(depth).map(UNATTRIBUTED), UNATTRIBUTED);
  }
});

test("fileRollup is the identity, including for UNATTRIBUTED", () => {
  const f = fileRollup();
  assert.equal(f.kind, "file");
  assert.equal(f.map("a/b/c.ts"), "a/b/c.ts");
  assert.equal(f.map(UNATTRIBUTED), UNATTRIBUTED);
});

test("packageRollup: longest-prefix match, unmatched -> null", () => {
  const r = packageRollup(["packages/checkout", "packages/checkout/api", "apps/web"]);
  assert.equal(r.map("packages/checkout/src/cart.ts"), "packages/checkout");
  assert.equal(r.map("packages/checkout/api/routes.ts"), "packages/checkout/api");
  assert.equal(r.map("apps/web/index.tsx"), "apps/web");
  assert.equal(r.map("README.md"), null);
  assert.equal(r.map("packages/checkout-legacy/x.ts"), null, "no partial-name match");
  assert.equal(r.map(UNATTRIBUTED), UNATTRIBUTED);
});

test("featureRollup: first matching feature wins, UNATTRIBUTED passes through", () => {
  const r = featureRollup({
    payments: ["packages/checkout/**", "**/pay*.ts"],
    frontend: ["apps/web/**"],
    everything: ["**"],
  });
  assert.equal(r.map("packages/checkout/src/cart.ts"), "payments");
  assert.equal(r.map("apps/web/src/pay.ts"), "payments", "declaration order decides");
  assert.equal(r.map("apps/web/src/home.ts"), "frontend");
  assert.equal(r.map("scripts/x.sh"), "everything");
  assert.equal(r.map(UNATTRIBUTED), UNATTRIBUTED);

  assert.equal(featureRollup({ a: ["libs/**"] }).map("apps/x.ts"), null);
});

test("resolveRollup dispatches and falls back to dir when data is missing", () => {
  assert.equal(resolveRollup("file").kind, "file");
  assert.equal(resolveRollup("dir", { depth: 3 }).map("a/b/c/d.ts"), "a/b/c");

  const pkg = resolveRollup("package", { packages: ["apps/web"] });
  assert.equal(pkg.kind, "package");
  assert.equal(pkg.map("apps/web/x.ts"), "apps/web");

  // No packages and no repoRoot -> dir fallback, and it says so via `kind`.
  assert.equal(resolveRollup("package", { depth: 2 }).kind, "dir");
  // No CODEOWNERS -> dir fallback.
  assert.equal(resolveRollup("team", { repoRoot: makeRepo({}) }).kind, "dir");
  // With CODEOWNERS -> the real thing.
  const teamRepo = makeRepo({ CODEOWNERS: "/apps/ @web\n" });
  const team = resolveRollup("team", { repoRoot: teamRepo });
  assert.equal(team.kind, "team");
  assert.equal(team.map("apps/a.ts"), "@web");

  assert.equal(resolveRollup("feature", {}).kind, "dir");
  assert.equal(
    resolveRollup("feature", { features: { pay: ["apps/**"] } }).map("apps/a.ts"),
    "pay",
  );
});

// ---------------------------------------------------------------------------
// workspace detection
// ---------------------------------------------------------------------------

test("parsePnpmWorkspace handles quoted, unquoted, flow and comment forms", () => {
  assert.deepEqual(
    parsePnpmWorkspace(
      "packages:\n  - 'packages/*'\n  - \"apps/*\"\n  - libs/*  # tools\n\nother: 1\n",
    ),
    ["packages/*", "apps/*", "libs/*"],
  );
  // list at the same indentation as the key
  assert.deepEqual(parsePnpmWorkspace("packages:\n- a/*\n- b/*\n"), ["a/*", "b/*"]);
  // flow sequence
  assert.deepEqual(parsePnpmWorkspace("packages: ['a/*', \"b/*\"]\n"), ["a/*", "b/*"]);
  // a following key must end the list
  assert.deepEqual(parsePnpmWorkspace("packages:\n  - a/*\nshamefully-hoist: true\n"), [
    "a/*",
  ]);
});

test("parsePackageJsonWorkspaces handles both array and object forms", () => {
  assert.deepEqual(parsePackageJsonWorkspaces('{"workspaces":["packages/*"]}'), [
    "packages/*",
  ]);
  assert.deepEqual(
    parsePackageJsonWorkspaces('{"workspaces":{"packages":["apps/*"],"nohoist":[]}}'),
    ["apps/*"],
  );
  assert.deepEqual(parsePackageJsonWorkspaces("{}"), []);
  assert.deepEqual(parsePackageJsonWorkspaces("not json"), []);
});

test("parseGoWork handles block and single-line use", () => {
  assert.deepEqual(
    parseGoWork("go 1.22\n\nuse (\n\t./services/a\n\t./services/b // note\n)\n\nuse ./tools\n"),
    ["./services/a", "./services/b", "./tools"],
  );
});

test("parseCargoWorkspace reads members from the [workspace] table", () => {
  assert.deepEqual(
    parseCargoWorkspace(
      '[package]\nname = "x"\nmembers = ["not-this"]\n\n[workspace]\nmembers = [\n  "crates/a",\n  # "crates/skipped",\n  "crates/b",\n]\n',
    ),
    ["crates/a", "crates/b"],
  );
  assert.deepEqual(parseCargoWorkspace('[package]\nname = "x"\n'), []);
});

test("expandGlob only yields directories that exist", () => {
  const repo = makeRepo({}, [
    "packages/a/src",
    "packages/b",
    "apps/web",
    "node_modules/junk",
  ]);
  assert.deepEqual(expandGlob(repo, "packages/*").sort(), ["packages/a", "packages/b"]);
  assert.deepEqual(expandGlob(repo, "apps/web"), ["apps/web"]);
  assert.deepEqual(expandGlob(repo, "apps/nope"), []);
  assert.deepEqual(expandGlob(repo, "services/*"), []);
  assert.ok(!expandGlob(repo, "*").includes("node_modules"), "node_modules is skipped");
});

test("detectPackages unions every manifest, dedupes, sorts longest-first", () => {
  const repo = makeRepo(
    {
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - 'apps/*'\n",
      "package.json": '{"name":"root","workspaces":["packages/*","tools/cli"]}',
      "go.work": "go 1.22\nuse (\n\t./services/api\n)\n",
      "Cargo.toml": '[workspace]\nmembers = ["crates/engine"]\n',
    },
    [
      "packages/checkout",
      "packages/checkout/api",
      "apps/web",
      "tools/cli",
      "services/api",
      "crates/engine",
      "docs",
    ],
  );

  const pkgs = detectPackages(repo);
  assert.deepEqual(new Set(pkgs), new Set([
    "packages/checkout",
    "apps/web",
    "tools/cli",
    "services/api",
    "crates/engine",
  ]));
  // `packages/*` is a single-segment wildcard, so the nested api dir is not one
  assert.ok(!pkgs.includes("packages/checkout/api"));
  assert.ok(!pkgs.includes("docs"), "undeclared dirs are not packages");

  // sorted longest-first
  for (let i = 1; i < pkgs.length; i++) {
    assert.ok(pkgs[i - 1]!.length >= pkgs[i]!.length);
  }
});

test("detectPackages picks up nx conventions and returns [] with no manifests", () => {
  const nx = makeRepo({ "nx.json": "{}" }, ["apps/a", "libs/b", "packages/c"]);
  assert.deepEqual(new Set(detectPackages(nx)), new Set(["apps/a", "libs/b", "packages/c"]));

  assert.deepEqual(detectPackages(makeRepo({ "README.md": "hi" }, ["src"])), []);
});

test("detected packages feed packageRollup end-to-end", () => {
  const repo = makeRepo({ "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n" }, [
    "packages/checkout/src",
    "packages/admin",
  ]);
  const rollup = packageRollup(detectPackages(repo));
  assert.equal(rollup.map("packages/checkout/src/cart.ts"), "packages/checkout");
  assert.equal(rollup.map("packages/admin/index.ts"), "packages/admin");
  assert.equal(rollup.map("tsconfig.json"), null);
  assert.equal(rollup.map(UNATTRIBUTED), UNATTRIBUTED);
});

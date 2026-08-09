/**
 * Monorepo package-root detection (ARCHITECTURE.md §6, `package` unit kind).
 *
 * Reads whatever workspace manifests happen to be present and unions their
 * declared package globs, then expands those globs against the real
 * filesystem. Nothing is inferred that isn't declared, and a directory only
 * counts if it actually exists — a stale `packages/*` entry pointing at a
 * deleted package must not create a phantom reporting unit.
 *
 * Deliberately dependency-free: the YAML/TOML/go.work parsing here is
 * hand-rolled and intentionally narrow. It understands the shapes these files
 * take in practice, not the full grammars.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directories never worth descending into when expanding a `**` glob. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
]);

/** Depth cap for `**` expansion, so a huge repo can't turn into a full walk. */
const MAX_GLOBSTAR_DEPTH = 4;

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Strip surrounding quotes and any trailing `#` comment from a scalar. */
function unquote(raw: string): string {
  let s = raw.trim();
  const hash = s.indexOf(" #");
  if (hash !== -1) s = s.slice(0, hash).trim();
  if (s.length >= 2) {
    const first = s[0]!;
    const last = s[s.length - 1]!;
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1);
    }
  }
  return s.trim();
}

/** Normalize a declared package glob to a repo-relative POSIX form. */
function normalizeGlob(raw: string): string | null {
  let g = raw.replace(/\\/g, "/").trim();
  if (g === "" || g.startsWith("!")) return null; // exclusions are ignored
  while (g.startsWith("./")) g = g.slice(2);
  while (g.startsWith("/")) g = g.slice(1);
  while (g.endsWith("/")) g = g.slice(0, -1);
  if (g === "" || g === "." || g === "..") return null;
  return g;
}

/** Split a bracketed list body (`"a", "b",`) into its scalar items. */
function splitListBody(body: string): string[] {
  return body
    .split(",")
    .map((s) => unquote(s.replace(/[\r\n]/g, " ")))
    .filter((s) => s !== "");
}

// ---------------------------------------------------------------------------
// Per-manifest extractors — each returns raw (unexpanded) globs.
// ---------------------------------------------------------------------------

/**
 * pnpm-workspace.yaml:
 *
 *   packages:
 *     - 'packages/*'
 *     - "apps/*"
 *     - libs/*
 *
 * Also accepts the list at the same indentation as the key, and the YAML flow
 * form `packages: ['a/*', 'b/*']`.
 */
export function parsePnpmWorkspace(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(\s*)packages\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const inline = m[2]!.trim();

    if (inline.startsWith("[")) {
      const end = inline.lastIndexOf("]");
      out.push(...splitListBody(inline.slice(1, end === -1 ? undefined : end)));
      continue;
    }
    if (inline !== "" && !inline.startsWith("#")) {
      // `packages: something` — a scalar, not a list.
      out.push(unquote(inline));
      continue;
    }

    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j]!;
      const trimmed = raw.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith("-")) break; // next key ends the list
      out.push(unquote(trimmed.slice(1)));
    }
  }
  return out;
}

/** package.json: `workspaces: [...]` or `workspaces: { packages: [...] }`. */
export function parsePackageJsonWorkspaces(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const ws = (parsed as { workspaces?: unknown }).workspaces;
  if (Array.isArray(ws)) return ws.filter((x): x is string => typeof x === "string");
  if (typeof ws === "object" && ws !== null) {
    const pkgs = (ws as { packages?: unknown }).packages;
    if (Array.isArray(pkgs)) return pkgs.filter((x): x is string => typeof x === "string");
  }
  return [];
}

/**
 * go.work:
 *
 *   use (
 *       ./a
 *       ./b
 *   )
 *   use ./c
 */
export function parseGoWork(text: string): string[] {
  const out: string[] = [];

  const blocks = text.matchAll(/\buse\s*\(([^)]*)\)/g);
  for (const b of blocks) {
    for (const raw of b[1]!.split(/\r?\n/)) {
      const item = unquote(raw.replace(/\/\/.*$/, ""));
      if (item !== "") out.push(item);
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*use\s+([^\s(]\S*)\s*$/.exec(line.replace(/\/\/.*$/, ""));
    if (m) out.push(unquote(m[1]!));
  }
  return out;
}

/** Cargo.toml: `[workspace]` -> `members = [ ... ]` (possibly multi-line). */
export function parseCargoWorkspace(text: string): string[] {
  const wsIdx = text.search(/^\s*\[workspace\]\s*$/m);
  if (wsIdx === -1) return [];
  const rest = text.slice(wsIdx);
  const m = /^\s*members\s*=\s*\[([\s\S]*?)\]/m.exec(rest);
  if (!m) return [];
  // Drop `#` comments before splitting so a commented-out member is ignored.
  const body = m[1]!.replace(/#[^\n]*/g, "");
  return splitListBody(body);
}

// ---------------------------------------------------------------------------
// Glob expansion
// ---------------------------------------------------------------------------

/**
 * Expand one declared glob into existing repo-relative directories.
 *
 * Supported: literal segments, a whole-segment `*`, and `**` (bounded
 * recursive descent). That covers every form these manifests use in practice;
 * full glob support is explicitly out of scope.
 */
export function expandGlob(repoRoot: string, glob: string): string[] {
  const segments = glob.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return [];

  let current: string[] = [""]; // repo-relative dirs, "" === repo root

  for (const seg of segments) {
    const next: string[] = [];
    if (seg === "**") {
      // Zero or more levels: keep the current dirs, plus their descendants.
      const seen = new Set<string>();
      const push = (rel: string) => {
        if (!seen.has(rel)) {
          seen.add(rel);
          next.push(rel);
        }
      };
      for (const base of current) {
        push(base);
        let frontier = [base];
        for (let depth = 0; depth < MAX_GLOBSTAR_DEPTH; depth++) {
          const deeper: string[] = [];
          for (const dir of frontier) {
            for (const name of listDirs(join(repoRoot, dir))) {
              const rel = dir === "" ? name : `${dir}/${name}`;
              push(rel);
              deeper.push(rel);
            }
          }
          if (deeper.length === 0) break;
          frontier = deeper;
        }
      }
    } else if (seg.includes("*")) {
      // A single-segment wildcard. `*` alone is the common case; a partial
      // wildcard like `pkg-*` is matched with a segment-local regex.
      const re =
        seg === "*"
          ? null
          : new RegExp(
              "^" +
                seg
                  .split("*")
                  .map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                  .join("[^/]*") +
                "$",
            );
      for (const base of current) {
        for (const name of listDirs(join(repoRoot, base))) {
          if (re && !re.test(name)) continue;
          next.push(base === "" ? name : `${base}/${name}`);
        }
      }
    } else {
      for (const base of current) {
        const rel = base === "" ? seg : `${base}/${seg}`;
        if (isDir(join(repoRoot, rel))) next.push(rel);
      }
    }
    current = next;
    if (current.length === 0) return [];
  }

  return current.filter((rel) => rel !== "" && isDir(join(repoRoot, rel)));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect monorepo package roots under `repoRoot`.
 *
 * @returns repo-relative POSIX directories, deduped and sorted longest-first
 *   so a caller doing prefix matching hits the most specific package. Returns
 *   `[]` when no workspace manifest is present — the caller should fall back
 *   to `dir` rollup rather than reporting a single bucket.
 */
export function detectPackages(repoRoot: string): string[] {
  const globs: string[] = [];

  const pnpm =
    readIfPresent(join(repoRoot, "pnpm-workspace.yaml")) ??
    readIfPresent(join(repoRoot, "pnpm-workspace.yml"));
  if (pnpm) globs.push(...parsePnpmWorkspace(pnpm));

  const pkgJson = readIfPresent(join(repoRoot, "package.json"));
  if (pkgJson) globs.push(...parsePackageJsonWorkspaces(pkgJson));

  const goWork = readIfPresent(join(repoRoot, "go.work"));
  if (goWork) globs.push(...parseGoWork(goWork));

  const cargo = readIfPresent(join(repoRoot, "Cargo.toml"));
  if (cargo) globs.push(...parseCargoWorkspace(cargo));

  // Nx does not declare package roots in a parseable list, so its presence is
  // taken as permission to assume the conventional layout.
  if (exists(join(repoRoot, "nx.json"))) {
    globs.push("apps/*", "libs/*", "packages/*");
  }

  const dirs = new Set<string>();
  const seenGlobs = new Set<string>();
  for (const raw of globs) {
    const g = normalizeGlob(raw);
    if (g === null || seenGlobs.has(g)) continue;
    seenGlobs.add(g);
    for (const dir of expandGlob(repoRoot, g)) dirs.add(dir);
  }

  // Longest-first: `packages/checkout/api` must win over `packages/checkout`.
  return [...dirs].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

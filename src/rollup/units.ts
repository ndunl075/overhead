/**
 * Reporting units (ARCHITECTURE.md §6). Every unit kind is a pure function
 * from a repo-relative path to a bucket key, derived from the same file-level
 * attribution table — so `--by dir`, `--by package` and `--by team` are three
 * views of one number, never three different pipelines.
 *
 * Invariant honoured by every rollup here: `UNATTRIBUTED` passes through
 * unchanged. It is not a path, and folding it into `(root)` or a package would
 * quietly launder the honesty metric §5.3 exists to expose.
 */

import { UNATTRIBUTED } from "../types.ts";
import type { Rollup, UnitKind } from "../types.ts";
import { globToRegExp } from "./glob.ts";
import { makeCodeownersRollup } from "./codeowners.ts";
import { detectPackages } from "./workspace.ts";

/** Bucket for files that live directly in the repo root. */
export const ROOT_UNIT = "(root)";

/**
 * Prefix rollup at a fixed depth: `a/b/c/d.ts` @2 -> `a/b`, `a/b.ts` @2 -> `a`,
 * `d.ts` -> `(root)`. Depth counts *directory* segments, so the filename never
 * becomes a bucket.
 */
export function dirRollup(depth: number): Rollup {
  const d = Number.isFinite(depth) ? Math.max(1, Math.floor(depth)) : 1;
  return {
    kind: "dir",
    label: `dir(depth=${d})`,
    map(path: string): string | null {
      if (path === UNATTRIBUTED) return UNATTRIBUTED;
      const parts = path.split("/");
      const dirs = parts.slice(0, -1); // drop the filename
      if (dirs.length === 0) return ROOT_UNIT;
      return dirs.slice(0, d).join("/");
    },
  };
}

/** Identity rollup — one row per file. */
export function fileRollup(): Rollup {
  return {
    kind: "file",
    label: "file",
    map(path: string): string | null {
      return path;
    },
  };
}

/**
 * Map paths to workspace package roots by longest-prefix match.
 *
 * Unmatched paths return null (root-level configs, scripts, docs outside any
 * package) so the caller can bucket them explicitly instead of attaching them
 * to an arbitrary package.
 */
export function packageRollup(packages: string[]): Rollup {
  // Longest-first so `packages/checkout/api` beats `packages/checkout`.
  const sorted = packages
    .map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((p) => p !== "")
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));

  const cache = new Map<string, string | null>();

  return {
    kind: "package",
    label: "package",
    map(path: string): string | null {
      if (path === UNATTRIBUTED) return UNATTRIBUTED;
      const hit = cache.get(path);
      if (hit !== undefined) return hit;
      let found: string | null = null;
      for (const pkg of sorted) {
        if (path === pkg || path.startsWith(pkg + "/")) {
          found = pkg;
          break;
        }
      }
      cache.set(path, found);
      return found;
    },
  };
}

/**
 * User-defined features: a name mapped to a list of globs.
 *
 * First matching feature wins, in declaration order — unlike CODEOWNERS, this
 * config is authored as a priority list, and object key order is what the user
 * sees in their `overhead.config.json`.
 */
export function featureRollup(features: Record<string, string[]>): Rollup {
  const compiled = Object.entries(features).map(([name, globs]) => ({
    name,
    tests: (globs ?? []).map(globToRegExp),
  }));

  const cache = new Map<string, string | null>();

  return {
    kind: "feature",
    label: "feature",
    map(path: string): string | null {
      if (path === UNATTRIBUTED) return UNATTRIBUTED;
      const hit = cache.get(path);
      if (hit !== undefined) return hit;
      let found: string | null = null;
      outer: for (const feature of compiled) {
        for (const test of feature.tests) {
          if (test.test(path)) {
            found = feature.name;
            break outer;
          }
        }
      }
      cache.set(path, found);
      return found;
    },
  };
}

export interface ResolveRollupOptions {
  /** Directory depth for `dir`, and for the fallbacks below. Default 2. */
  depth?: number;
  /** Repo root — required for `package` auto-detection and for `team`. */
  repoRoot?: string | null;
  /** Explicit package roots; when omitted they are detected from repoRoot. */
  packages?: string[];
  /** Feature name -> globs, from overhead.config.json. */
  features?: Record<string, string[]>;
}

/**
 * Dispatcher used by the CLI's `--by` flag.
 *
 * Fallback policy, kept here so it is stated once: `package` with no detected
 * workspace and `team` with no CODEOWNERS both degrade to `dir` rollup at the
 * requested depth. A degraded rollup keeps its `dir` kind and label, so the
 * report can tell the user it did not get what it asked for instead of showing
 * an empty table.
 */
export function resolveRollup(kind: UnitKind, opts: ResolveRollupOptions = {}): Rollup {
  const depth = opts.depth ?? 2;

  switch (kind) {
    case "file":
      return fileRollup();

    case "dir":
      return dirRollup(depth);

    case "package": {
      let packages = opts.packages;
      if ((!packages || packages.length === 0) && opts.repoRoot) {
        packages = detectPackages(opts.repoRoot);
      }
      if (!packages || packages.length === 0) return dirRollup(depth);
      return packageRollup(packages);
    }

    case "team": {
      const rollup = opts.repoRoot ? makeCodeownersRollup(opts.repoRoot) : null;
      return rollup ?? dirRollup(depth);
    }

    case "feature": {
      const features = opts.features;
      if (!features || Object.keys(features).length === 0) return dirRollup(depth);
      return featureRollup(features);
    }

    default:
      return dirRollup(depth);
  }
}

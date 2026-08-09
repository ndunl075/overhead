/**
 * CODEOWNERS parsing and the `team` rollup (ARCHITECTURE.md §6).
 *
 * ## Correction to ARCHITECTURE.md
 *
 * §6 says CODEOWNERS is "first matching glob wins, gitignore-style
 * semantics". That is half right and the wrong half is load-bearing.
 * Gitignore is first-match-wins; **GitHub's CODEOWNERS is LAST-match-wins** —
 * the later, more specific line in the file overrides the earlier catch-all.
 * That is exactly why real CODEOWNERS files open with a `*  @org/everyone`
 * default and then narrow it. Implementing first-match would assign the entire
 * repo to that first line and the team report would be a single row.
 *
 * This module implements GitHub semantics: patterns are gitignore-*style* (see
 * `glob.ts`) but resolution is last-match-wins.
 *
 * ## Multiple owners
 *
 * A line may list several owners. We join them with ", " to form one unit
 * label ("@org/web, @alice") rather than picking the first. Rationale: the
 * question the team report answers is "whose budget is this?", and a jointly
 * owned path genuinely belongs to both parties; silently dropping the second
 * owner would under-report their spend and make the rows not reconcile with
 * anyone's mental model of the file. The cost is that joint ownership forms
 * its own bucket instead of being split — splitting would require inventing a
 * division rule that CODEOWNERS does not specify.
 */

import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNATTRIBUTED } from "../types.ts";
import type { Rollup } from "../types.ts";
import { globToRegExp } from "./glob.ts";

/** Bucket label for paths no CODEOWNERS rule claims. */
export const UNOWNED = "(unowned)";

/** Locations GitHub searches, in precedence order. */
const CODEOWNERS_LOCATIONS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

export interface CodeownersRule {
  /** The pattern exactly as written in the file. */
  pattern: string;
  /** Owners as written (`@user`, `@org/team`, `a@b.com`). May be empty. */
  owners: string[];
  /** 1-based line number in the source file, for diagnostics. */
  line: number;
  /** Compiled matcher for repo-relative POSIX paths. */
  test: RegExp;
}

/**
 * Locate a repo's CODEOWNERS file.
 *
 * @returns absolute path, or null when the repo has none.
 */
export function findCodeowners(repoRoot: string): string | null {
  for (const rel of CODEOWNERS_LOCATIONS) {
    const p = join(repoRoot, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Parse CODEOWNERS text into rules, in file order.
 *
 * A rule with zero owners is kept: GitHub treats such a line as removing
 * ownership for the paths it matches, and since resolution is last-match-wins
 * dropping it would wrongly leave an earlier owner in place.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;

    // `#` starts a comment anywhere on the line unless escaped.
    const hash = findComment(line);
    if (hash !== -1) line = line.slice(0, hash);

    const tokens = line.trim().split(/\s+/).filter((t) => t !== "");
    if (tokens.length === 0) continue;

    const pattern = tokens[0]!.replace(/\\#/g, "#");
    rules.push({
      pattern,
      owners: tokens.slice(1),
      line: i + 1,
      test: globToRegExp(pattern),
    });
  }
  return rules;
}

/** Index of the first unescaped `#`, or -1. */
function findComment(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "#" && line[i - 1] !== "\\") return i;
  }
  return -1;
}

/**
 * Resolve a repo-relative path to its owner label.
 *
 * LAST matching rule wins (GitHub semantics), so we scan backwards and stop at
 * the first hit.
 *
 * @returns the joined owner label, or null when unowned.
 */
export function ownerFor(rules: CodeownersRule[], path: string): string | null {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (!rule.test.test(path)) continue;
    return rule.owners.length === 0 ? null : rule.owners.join(", ");
  }
  return null;
}

/**
 * Build the `team` rollup for a repo.
 *
 * @returns null when the repo has no CODEOWNERS file, so the caller can say so
 *   rather than silently reporting one empty bucket.
 */
export function makeCodeownersRollup(repoRoot: string): Rollup | null {
  const file = findCodeowners(repoRoot);
  if (file === null) return null;

  let rules: CodeownersRule[];
  try {
    rules = parseCodeowners(readFileSync(file, "utf8"));
  } catch {
    return null;
  }

  // Path -> owner is pure and hit repeatedly across thousands of attributions.
  const cache = new Map<string, string | null>();

  return {
    kind: "team",
    label: "team",
    map(path: string): string | null {
      // The unattributed bucket is not a file and must never be owned.
      if (path === UNATTRIBUTED) return UNATTRIBUTED;
      const hit = cache.get(path);
      if (hit !== undefined) return hit;
      const owner = ownerFor(rules, path);
      cache.set(path, owner);
      return owner;
    },
  };
}

/**
 * Minimal gitignore/CODEOWNERS-style glob -> RegExp compiler.
 *
 * Shared by `codeowners.ts` (team rollup) and `units.ts` (feature rollup) so
 * both dialects behave identically. Deliberately dependency-free.
 *
 * Semantics implemented (matching git's pathspec rules, which GitHub's
 * CODEOWNERS documentation defers to):
 *
 *   - a leading `/` anchors the pattern to the repo root
 *   - a pattern containing a `/` anywhere other than its end is also anchored
 *     (so `src/*.ts` is rooted, but a bare `docs/` matches at any depth)
 *   - a trailing `/` means "this directory and everything under it"
 *   - `*` matches any run of characters but never crosses a `/`
 *   - `**` crosses `/` (`a/**\/b` matches `a/b` and `a/x/y/b`)
 *   - `?` matches exactly one non-`/` character
 *   - `[abc]` / `[!abc]` character classes are passed through
 *   - every other character is escaped and matched literally
 *
 * Matching is performed against repo-relative POSIX paths with no leading
 * slash, e.g. "packages/checkout/src/cart.ts".
 */

const REGEX_META = /[.*+?^${}()|[\]\\]/;

function escapeChar(c: string): string {
  return REGEX_META.test(c) ? "\\" + c : c;
}

/** Compile one path segment (no `/` inside) to a regex fragment. */
function compileSegment(seg: string): string {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === "*") {
      // `**` inside a segment (e.g. `a**b`) degrades to a single-segment `*`.
      while (seg[i + 1] === "*") i++;
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const close = seg.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
      } else {
        let cls = seg.slice(i + 1, close);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        // Only `\` and `]` need care inside a class; `]` cannot appear here
        // because we stopped at the first one.
        out += "[" + cls.replace(/\\/g, "\\\\") + "]";
        i = close;
      }
    } else {
      out += escapeChar(c);
    }
  }
  return out;
}

/** Convert a whole (already anchor-stripped) pattern body to a regex body. */
function compileBody(pattern: string): string {
  const parts = pattern.split("/");
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    const isLast = i === parts.length - 1;
    if (seg === "**") {
      // A trailing `**` swallows the rest of the path; an interior one
      // swallows zero or more whole segments (including its own separator).
      out += isLast ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    out += compileSegment(seg);
    if (!isLast) out += "/";
  }
  return out;
}

/**
 * Compile a gitignore-style glob into an anchored RegExp that tests whole
 * repo-relative paths.
 */
export function globToRegExp(rawPattern: string): RegExp {
  let pattern = rawPattern.trim();
  if (pattern === "") return /$^/; // matches nothing

  // A trailing `/` marks a directory pattern.
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);

  // Anchoring is decided *before* the leading slash is stripped.
  const anchored = rawPattern.startsWith("/") || pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  if (pattern === "") return /$^/;

  const prefix = anchored ? "^" : "^(?:.*/)?";
  const body = compileBody(pattern);
  // `(?:/.*)?` lets a pattern that names a directory also own everything
  // beneath it — which is what both gitignore and CODEOWNERS mean.
  const suffix = "(?:/.*)?$";

  return new RegExp(prefix + body + suffix);
}

/** Compile a list of globs into a single "does any of these match" predicate. */
export function globMatcher(patterns: string[]): (path: string) => boolean {
  const res = patterns.map(globToRegExp);
  return (path: string) => {
    for (const re of res) if (re.test(path)) return true;
    return false;
  };
}

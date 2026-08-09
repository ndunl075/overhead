/**
 * Path normalization and extraction.
 *
 * Everything downstream keys on repo-relative POSIX paths, so this module is
 * the single place where Windows separators, drive letters, `..` segments and
 * shell quoting get flattened out.
 *
 * The extraction helpers are deliberately conservative: a false positive is a
 * path that never existed soaking up real dollars in the report, which is worse
 * than a missed touch (attribution is a weighted average over many turns, so
 * one missing read barely moves a number, but a phantom `origin/main` "file"
 * shows up as a line item someone has to explain).
 */

import os from "node:os";

const WIN_DRIVE = /^[A-Za-z]:/;
const WIN_DRIVE_ROOTED = /^[A-Za-z]:[/\\]/;

/** Extensions we recognize as "this token is a file" without any other signal. */
const SOURCE_EXTENSIONS = new Set([
  // js/ts
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "jsonc",
  "vue", "svelte", "astro", "map",
  // docs / config
  "md", "mdx", "txt", "rst", "adoc", "yml", "yaml", "toml", "ini", "cfg",
  "conf", "env", "lock", "properties", "editorconfig", "gitignore",
  "npmrc", "nvmrc", "dockerfile", "gradle", "bazel", "bzl",
  // web
  "html", "htm", "css", "scss", "sass", "less", "svg", "xml", "xsl",
  // languages
  "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h",
  "cc", "cpp", "cxx", "hpp", "hh", "cs", "php", "sh", "bash", "zsh", "fish",
  "ps1", "psm1", "psd1", "bat", "cmd", "sql", "pl", "pm", "lua", "r",
  "scala", "clj", "cljs", "ex", "exs", "erl", "hrl", "hs", "ml", "mli",
  "dart", "zig", "nim", "v", "sol", "tf", "tfvars", "proto", "graphql",
  "gql", "ipynb", "m", "mm", "f90", "jl", "groovy", "sbt", "cmake",
  // data
  "csv", "tsv", "ndjson", "jsonl", "parquet",
]);

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function isAbsoluteish(p: string): boolean {
  // `p` is already POSIX-ified, so UNC `\\srv\share` arrives as `//srv/share`.
  return p.startsWith("/") || WIN_DRIVE.test(p);
}

/** Collapse `.`/`..` and duplicate separators without touching the filesystem. */
function cleanSegments(posixPath: string): string {
  const hasDrive = WIN_DRIVE.test(posixPath);
  const drive = hasDrive ? posixPath.slice(0, 2) : "";
  const rest = hasDrive ? posixPath.slice(2) : posixPath;
  const rooted = rest.startsWith("/");

  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== "..") out.pop();
      else if (!rooted && !hasDrive) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return drive + (rooted ? "/" : "") + out.join("/");
}

function stripTrailingSlash(p: string): string {
  let end = p.length;
  while (end > 1 && p[end - 1] === "/") end--;
  return p.slice(0, end);
}

/** Remove one layer of matching surrounding quotes/backticks. */
export function stripQuotes(token: string): string {
  let s = token;
  while (s.length >= 2) {
    const first = s[0]!;
    const last = s[s.length - 1]!;
    if ((first === '"' || first === "'" || first === "`") && first === last) {
      s = s.slice(1, -1);
    } else break;
  }
  return s;
}

/**
 * Resolve `raw` (absolute or relative to `cwd`) into a repo-relative POSIX
 * path, or `null` when it does not live under `repoRoot`.
 *
 * Case handling: on win32 — or whenever either side carries a drive letter, so
 * that Windows-captured transcripts analyze identically on a Linux CI box —
 * the containment check is case-insensitive, but the returned string is sliced
 * out of the original so the real on-disk casing survives.
 */
export function normalizePath(
  raw: string,
  cwd: string,
  repoRoot: string | null,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = stripQuotes(raw.trim());
  if (!trimmed) return null;

  // `~/.claude/x.json` must resolve to the home directory, not to a literal
  // `~` folder inside the repo — otherwise every home-dir reference in a shell
  // command is attributed to the repo it was typed in.
  const expanded = /^~[/\\]/.test(trimmed)
    ? `${stripTrailingSlash(toPosix(os.homedir()))}/${toPosix(trimmed).slice(2)}`
    : trimmed;

  const posix = toPosix(expanded);

  if (repoRoot === null || repoRoot === "") {
    // No root to relativize against: an absolute path cannot be placed inside
    // the repo, and a relative one is already as repo-relative as it will get.
    if (isAbsoluteish(posix)) return null;
    const rel = stripTrailingSlash(cleanSegments(posix));
    if (!rel || rel === ".." || rel.startsWith("../")) return null;
    return rel;
  }

  const abs = isAbsoluteish(posix)
    ? cleanSegments(posix)
    : cleanSegments(`${toPosix(cwd ?? "")}/${posix}`);

  const root = stripTrailingSlash(cleanSegments(toPosix(repoRoot)));
  if (!root) return null;

  const caseInsensitive =
    process.platform === "win32" || WIN_DRIVE.test(root) || WIN_DRIVE.test(abs);
  const a = caseInsensitive ? abs.toLowerCase() : abs;
  const r = caseInsensitive ? root.toLowerCase() : root;

  // The repo root itself is not a file touch.
  if (a === r) return null;
  const prefix = r.endsWith("/") ? r : `${r}/`;
  if (!a.startsWith(prefix)) return null;

  const rel = stripTrailingSlash(abs.slice(prefix.length));
  return rel || null;
}

// ---------------------------------------------------------------------------
// Shape tests
// ---------------------------------------------------------------------------

/** Lowercased extension of the last segment, or null. Handles `.env`. */
function extensionOf(token: string): string | null {
  const sepAt = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  const base = token.slice(sepAt + 1);
  if (!base) return null;
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return null;
  // `.env`, `.gitignore` — the whole name after the dot is the "extension".
  const ext = dot === 0 ? base.slice(1) : base.slice(dot + 1);
  return /^[A-Za-z0-9_]{1,12}$/.test(ext) ? ext.toLowerCase() : null;
}

function hasSeparator(token: string): boolean {
  return token.includes("/") || token.includes("\\");
}

function isUrlish(token: string): boolean {
  return token.includes("://") || /^(www\.|mailto:)/i.test(token);
}

function isAnchored(token: string): boolean {
  return (
    /^\.{1,2}[/\\]/.test(token) ||
    /^[/\\]/.test(token) ||
    /^~[/\\]/.test(token) ||
    WIN_DRIVE_ROOTED.test(token)
  );
}

/**
 * "Could this token be a file?" — the branch structure the collector spec
 * asks for: a known source extension on its own is enough; a bare separator is
 * not (that would swallow `origin/main`, `feature/foo`, `and/or`) and needs a
 * corroborating signal: an anchor, a trailing slash, or a dotted last segment.
 */
function looksLikePath(token: string): boolean {
  if (token.length < 2) return false;
  if (isUrlish(token)) return false;
  const ext = extensionOf(token);
  if (ext !== null && SOURCE_EXTENSIONS.has(ext)) return true;
  if (!hasSeparator(token)) return false;
  if (isAnchored(token)) return true;
  if (/[/\\]$/.test(token)) return true;
  return ext !== null;
}

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

const GLOB_META = /[*?[\]{}]/;

/**
 * Longest leading run of literal directory segments in a glob.
 *
 *   packages/[star]/src/[starstar].ts -> "packages"
 *   [starstar]/[star].ts              -> null
 *
 * A glob with no metacharacters is entirely literal and comes back unchanged.
 */
export function literalGlobPrefix(glob: string | null | undefined): string | null {
  if (typeof glob !== "string") return null;
  const s = stripQuotes(glob.trim());
  if (!s) return null;
  const posix = toPosix(s);

  const literal: string[] = [];
  for (const seg of posix.split("/")) {
    if (GLOB_META.test(seg)) break;
    if (seg === "" || seg === "." || seg === "..") {
      // Leading `/`, `./` and `../` carry no information about which directory
      // the glob is rooted at; keep scanning but do not emit a segment.
      if (literal.length === 0) continue;
      break;
    }
    literal.push(seg);
  }
  if (literal.length === 0) return null;
  return literal.join("/");
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Upper bound on paths pulled from one shell command (heredocs get long). */
const MAX_COMMAND_PATHS = 50;
/** Spec-mandated cap on paths pulled from one free-text prompt. */
const MAX_TEXT_PATHS = 20;

function pushUnique(out: string[], value: string, cap: number): void {
  if (out.length >= cap) return;
  if (!out.includes(value)) out.push(value);
}

/** Split a shell command into tokens, honouring quotes. */
function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s"'`]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const value = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (value) tokens.push(value);
  }
  return tokens;
}

/** Peel shell punctuation off a token without eating drive colons or dots. */
function trimShellPunctuation(token: string): string {
  let s = token;
  // `$` and `%` are deliberately NOT stripped: `$APPDATA/x.json` must be
  // rejected as an unresolvable env-var expansion, not silently rewritten into
  // the repo-relative path `APPDATA/x.json`.
  s = s.replace(/^[(){}[\];|&<>!]+/, "");
  s = s.replace(/[)(};|&,:!?]+$/, "");
  return s;
}

/**
 * A colon is only legal as a Windows drive separator. Anything else is a shell
 * or PowerShell construct (`env:APPDATA`, `ref:name`, a sed address).
 */
function hasStrayColon(token: string): boolean {
  const first = token.indexOf(":");
  if (first < 0) return false;
  const driveOk = first === 1 && WIN_DRIVE.test(token);
  if (!driveOk) return true;
  return token.indexOf(":", first + 1) >= 0;
}

/**
 * Git ref and refspec shapes. These share a syntax with paths (`origin/main`,
 * `refs/heads/x`) and appear constantly in shell commands, so they are rejected
 * structurally rather than left to the existence check — the collector must
 * still behave when the repo root cannot be resolved.
 */
const GIT_REF = /^(refs\/|HEAD([~^]|$)|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD)/;
/** A `..` range separator (`main..main`, `HEAD~1..HEAD`) — as opposed to the
 * `../` parent segment of a genuine relative path. */
const RANGE_DOTS = /[^/\\]\.\.[^/\\]/;

function isGitRefish(token: string): boolean {
  return GIT_REF.test(token) || RANGE_DOTS.test(token) || token.includes("@{");
}

/** `git push|pull|fetch <remote> <ref>` — the ref is not a path. */
const GIT_TRANSFER = /\bgit\s+(?:-\S+\s+)*(?:push|pull|fetch)\b/;
const REMOTE_NAMES = new Set(["origin", "upstream", "fork"]);

/**
 * A token with whitespace is only a path when it is unambiguously one: it must
 * have both a separator and a known source extension. This is what separates
 * the real quoted path `"src/a b/c.ts"` from `echo "patched app.js"` and from
 * `sed 's/.*name: //'`, both of which otherwise look path-shaped.
 */
function whitespaceIsAcceptable(token: string): boolean {
  if (!/\s/.test(token)) return true;
  const ext = extensionOf(token);
  return hasSeparator(token) && ext !== null && SOURCE_EXTENSIONS.has(ext);
}

/**
 * Characters that never appear in a path we care about but are everywhere in
 * inline scripts. Without this, `node -e "const x=require('./src/a')"` donates
 * fragments like `require('./src` to the report — verified against real
 * transcripts, where inline scripts were the single largest source of junk.
 */
const SHELL_SYNTAX = /['"`;$&|<>^#()\n\r\t]/;
/** Beyond this a "token" is a script body, not a filename. */
const MAX_TOKEN_LENGTH = 260;

/**
 * Lex plausible file paths out of a shell command string.
 *
 * Skips flags (but keeps `--out=src/x.ts` style values), URLs, and shell
 * variables. Tokens containing glob metacharacters collapse to their literal
 * directory prefix, and only when the original token had a separator — that
 * keeps "src/[star].ts" -> "src" while dropping a bare "[star].ts".
 */
export function extractPathsFromCommand(cmd: string): string[] {
  if (typeof cmd !== "string" || !cmd) return [];
  const out: string[] = [];
  const isTransfer = GIT_TRANSFER.test(cmd);
  let prevToken = "";

  for (const rawToken of tokenizeCommand(cmd)) {
    if (out.length >= MAX_COMMAND_PATHS) break;

    let token = stripQuotes(trimShellPunctuation(stripQuotes(rawToken)));
    const previous = prevToken;
    prevToken = token;
    if (!token) continue;

    // `git push origin <branch>` — the argument after a remote is a ref.
    if (isTransfer && REMOTE_NAMES.has(previous)) continue;
    if (isGitRefish(token)) continue;

    if (token.startsWith("-")) {
      // `--out=dist/x.js` carries a path; a bare `-r` or `--force` does not.
      const eq = token.indexOf("=");
      if (eq < 0) continue;
      token = stripQuotes(token.slice(eq + 1));
    } else {
      const eq = token.indexOf("=");
      if (eq > 0 && !hasSeparator(token.slice(0, eq))) {
        // `FILE=src/a.ts` — the assignment target is not a path.
        const rhs = stripQuotes(token.slice(eq + 1));
        if (rhs) token = rhs;
      }
    }
    if (!token || token.startsWith("-") || isUrlish(token)) continue;
    if (token.startsWith("$") || token.includes("%")) continue;
    if (token.length > MAX_TOKEN_LENGTH || SHELL_SYNTAX.test(token)) continue;
    if (hasStrayColon(token) || !whitespaceIsAcceptable(token)) continue;

    if (GLOB_META.test(token)) {
      if (!hasSeparator(token)) continue;
      const prefix = literalGlobPrefix(token);
      // A one-character prefix is almost always a regex address (`s/.../.../`)
      // rather than a directory anyone reports on.
      if (!prefix || prefix.length < 2) continue;
      pushUnique(out, prefix, MAX_COMMAND_PATHS);
      continue;
    }

    if (looksLikePath(token)) pushUnique(out, token, MAX_COMMAND_PATHS);
  }

  return out;
}

/**
 * Find path-shaped tokens in free text (user prompts). Precision matters more
 * here than anywhere else — prose is full of slashes ("and/or", "24/7") — so a
 * token must carry a separator *and* an extension, or end in a slash.
 */
export function extractPathsFromText(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const out: string[] = [];

  for (const rawToken of text.split(/[\s,;<>()[\]{}"'`|]+/)) {
    if (out.length >= MAX_TEXT_PATHS) break;
    let token = rawToken.replace(/^[#@*_~]+/, "").replace(/[.,:;!?*_~]+$/, "");
    token = stripQuotes(token);
    if (!token || token.length < 3) continue;
    if (isUrlish(token) || token.startsWith("-")) continue;
    if (GLOB_META.test(token)) continue;
    if (!hasSeparator(token)) continue;

    if (/[/\\]$/.test(token) || extensionOf(token) !== null) {
      pushUnique(out, token, MAX_TEXT_PATHS);
    }
  }

  return out;
}

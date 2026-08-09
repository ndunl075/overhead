import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  collectClaudeCode,
  decodeProjectSlug,
  listProjectDirs,
  parseUsage,
  TOOL_WEIGHTS,
} from "../src/collect/claude-code.ts";
import {
  extractPathsFromCommand,
  extractPathsFromText,
  literalGlobPrefix,
  normalizePath,
} from "../src/collect/paths.ts";
import type { Session, Touch } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixture scaffolding
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];

after(() => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

interface Fixture {
  tmp: string;
  repoDir: string;
  outsideDir: string;
  transcriptsDir: string;
  projectDir: string;
  slug: string;
}

function makeFixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overhead-collect-"));
  tmpRoots.push(tmp);

  const repoDir = path.join(tmp, "repo");
  // A real `.git` marker so repo-root resolution walks up to here from cwd.
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  const outsideDir = path.join(tmp, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });

  const slug = repoDir.replace(/[\\/:]/g, "-");
  const transcriptsDir = path.join(tmp, "projects");
  const projectDir = path.join(transcriptsDir, slug);
  fs.mkdirSync(projectDir, { recursive: true });

  return { tmp, repoDir, outsideDir, transcriptsDir, projectDir, slug };
}

/**
 * Create a real file in the fixture repo. Shell- and prompt-derived evidence is
 * verified against disk, so fixtures exercising those paths must materialize
 * them (declared write/edit/read paths need no such thing).
 */
function touchFile(fx: Fixture, rel: string): void {
  const abs = path.join(fx.repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "// fixture\n", "utf8");
}

function writeTranscript(fx: Fixture, name: string, lines: string[]): void {
  fs.writeFileSync(path.join(fx.projectDir, name), lines.join("\n"), "utf8");
}

let clock = 0;
function nextTs(): string {
  clock += 1000;
  return new Date(Date.UTC(2026, 6, 1, 0, 0, 0) + clock).toISOString();
}

interface AssistantOpts {
  sessionId: string;
  messageId: string;
  cwd: string;
  uuid?: string;
  parentUuid?: string | null;
  model?: string;
  usage?: Record<string, unknown>;
  content?: unknown[];
  isSidechain?: boolean;
  ts?: string;
}

function assistantLine(o: AssistantOpts): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: o.sessionId,
    uuid: o.uuid ?? `u-${o.messageId}-${Math.random().toString(36).slice(2, 8)}`,
    parentUuid: o.parentUuid ?? null,
    timestamp: o.ts ?? nextTs(),
    cwd: o.cwd,
    gitBranch: "main",
    isSidechain: o.isSidechain ?? false,
    requestId: `req_${o.messageId}`,
    message: {
      id: o.messageId,
      model: o.model ?? "claude-opus-5",
      content: o.content ?? [{ type: "text", text: "ok" }],
      usage: o.usage ?? {
        input_tokens: 1,
        cache_read_input_tokens: 0,
        output_tokens: 1,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
        },
      },
    },
  });
}

function userLine(
  sessionId: string,
  cwd: string,
  content: unknown,
  extra: { uuid?: string; isSidechain?: boolean } = {},
): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    uuid: extra.uuid ?? `uu-${Math.random().toString(36).slice(2, 10)}`,
    parentUuid: null,
    timestamp: nextTs(),
    cwd,
    isSidechain: extra.isSidechain ?? false,
    message: { role: "user", content },
  });
}

function toolUse(name: string, input: Record<string, unknown>): unknown {
  return { type: "tool_use", id: `tu-${name}`, name, input };
}

function onlySession(sessions: Session[]): Session {
  assert.equal(sessions.length, 1, "expected exactly one session");
  return sessions[0]!;
}

function touchFor(touches: Touch[], p: string): Touch {
  const found = touches.find((t) => t.path === p);
  assert.ok(found, `expected a touch for ${p}, got ${JSON.stringify(touches)}`);
  return found;
}

// ---------------------------------------------------------------------------
// paths.ts
// ---------------------------------------------------------------------------

describe("normalizePath", () => {
  it("resolves relative paths against cwd", () => {
    assert.equal(
      normalizePath("src/a.ts", "C:\\repo\\pkg", "C:\\repo"),
      "pkg/src/a.ts",
    );
  });

  it("converts Windows separators and collapses dot segments", () => {
    assert.equal(
      normalizePath("..\\lib\\b.ts", "C:\\repo\\pkg", "C:\\repo"),
      "lib/b.ts",
    );
  });

  it("compares drive-letter paths case-insensitively but keeps casing", () => {
    assert.equal(
      normalizePath("c:\\Repo\\Src\\App.ts", "c:\\repo", "C:\\repo"),
      "Src/App.ts",
    );
  });

  it("drops paths that escape the repo root", () => {
    assert.equal(normalizePath("C:\\other\\x.ts", "C:\\repo", "C:\\repo"), null);
    assert.equal(normalizePath("../../x.ts", "C:\\repo\\a", "C:\\repo"), null);
    // A sibling with a shared prefix must not count as inside.
    assert.equal(
      normalizePath("C:\\repo-two\\x.ts", "C:\\repo", "C:\\repo"),
      null,
    );
  });

  it("returns null for the repo root itself", () => {
    assert.equal(normalizePath("C:\\repo", "C:\\repo", "C:\\repo"), null);
  });

  it("expands a leading ~ to the home directory, not a repo folder", () => {
    // Must not become the repo-relative path "~/.claude/history.jsonl".
    assert.equal(
      normalizePath("~/.claude/history.jsonl", "C:\\repo", "C:\\repo"),
      null,
    );
    assert.equal(
      normalizePath("~/x.ts", os.homedir(), os.homedir()),
      "x.ts",
    );
  });

  it("handles a null repo root", () => {
    assert.equal(normalizePath("src/a.ts", "C:\\repo", null), "src/a.ts");
    assert.equal(normalizePath("C:\\repo\\a.ts", "C:\\repo", null), null);
  });
});

describe("literalGlobPrefix", () => {
  it("returns the leading literal segments", () => {
    assert.equal(literalGlobPrefix("packages/*/src/**.ts"), "packages");
    assert.equal(literalGlobPrefix("a/b/*.ts"), "a/b");
    assert.equal(literalGlobPrefix("src/**/*.tsx"), "src");
  });

  it("returns null with no literal prefix", () => {
    assert.equal(literalGlobPrefix("**/*.ts"), null);
    assert.equal(literalGlobPrefix("*.ts"), null);
    assert.equal(literalGlobPrefix(""), null);
    assert.equal(literalGlobPrefix(null), null);
  });

  it("passes through a metacharacter-free glob", () => {
    assert.equal(literalGlobPrefix("src/index.ts"), "src/index.ts");
  });
});

describe("extractPathsFromCommand", () => {
  it("finds paths and strips quotes", () => {
    const got = extractPathsFromCommand(
      'node scripts/build.js --out=dist/app.js "src/a b/c.ts"',
    );
    assert.deepEqual(got, ["scripts/build.js", "dist/app.js", "src/a b/c.ts"]);
  });

  it("skips flags, URLs and bare globs", () => {
    const got = extractPathsFromCommand(
      "curl -sL https://example.com/x.ts | rg -n --color=never TODO",
    );
    assert.deepEqual(got, []);
  });

  it("reduces a glob to its literal prefix", () => {
    assert.deepEqual(extractPathsFromCommand("rm -rf build/*.map"), ["build"]);
    assert.deepEqual(extractPathsFromCommand("ls *.ts"), []);
  });

  it("does not mistake refs and branches for paths", () => {
    const got = extractPathsFromCommand("git merge origin/main feature/login");
    assert.deepEqual(got, []);
  });

  it("keeps Windows absolute paths", () => {
    const got = extractPathsFromCommand("type C:\\repo\\src\\main.ts");
    assert.deepEqual(got, ["C:\\repo\\src\\main.ts"]);
  });

  // The following four all came from real transcripts, where they polluted
  // attribution with paths that never existed.
  it("does not lex fragments out of inline scripts", () => {
    const got = extractPathsFromCommand(
      `node -e "const x = require('./src/a.js'); console.log(x)"`,
    );
    assert.deepEqual(got, [], "inline script bodies are not paths");
  });

  it("rejects sed expressions", () => {
    const got = extractPathsFromCommand(`grep -o 'name' x.ts | sed 's/.*name: //'`);
    assert.deepEqual(got, ["x.ts"]);
  });

  it("rejects unresolvable env-var expansions", () => {
    assert.deepEqual(
      extractPathsFromCommand('rm -f "$APPDATA/app/state.json"'),
      [],
    );
    assert.deepEqual(extractPathsFromCommand("del %TEMP%\\a.json"), []);
    assert.deepEqual(
      extractPathsFromCommand("Remove-Item $env:APPDATA/app/state.json"),
      [],
    );
  });

  it("rejects git refs, ranges and refspecs", () => {
    assert.deepEqual(extractPathsFromCommand("git push origin claude"), []);
    assert.deepEqual(extractPathsFromCommand("git diff origin/main..main"), []);
    assert.deepEqual(extractPathsFromCommand("git log HEAD~1..HEAD"), []);
    assert.deepEqual(extractPathsFromCommand("git diff refs/heads/x"), []);
    assert.deepEqual(extractPathsFromCommand("git log main@{upstream}"), []);
    assert.deepEqual(extractPathsFromCommand("git fetch upstream release/2.x"), []);
    // A real relative path must survive the `..` range rule.
    assert.deepEqual(extractPathsFromCommand("cat ../sibling/a.ts"), [
      "../sibling/a.ts",
    ]);
    assert.deepEqual(extractPathsFromCommand("git diff -- src/a.ts"), [
      "src/a.ts",
    ]);
  });

  it("does not strip the sigil off a shell variable", () => {
    // Real transcript: `$W/src/mcp.ts` was becoming the fabricated repo path
    // `W/src/mcp.ts`, inventing a top-level `W/` directory in the report.
    const cmd =
      `W="C:/Users/dev/Documents/proj/.claude/worktrees/agent-a4ea"; ` +
      `grep -c '^    name: "' "$W/src/mcp.ts"`;
    const got = extractPathsFromCommand(cmd);
    assert.ok(
      !got.some((p) => p.startsWith("W/")),
      `no fabricated W/ path, got ${JSON.stringify(got)}`,
    );
    assert.deepEqual(got, [
      "C:/Users/dev/Documents/proj/.claude/worktrees/agent-a4ea",
    ]);
  });

  it("still accepts genuine build paths", () => {
    assert.deepEqual(
      extractPathsFromCommand(
        "node scripts/build-binary.mjs && ls build/atrium.cjs build/sea-prep.blob",
      ),
      ["scripts/build-binary.mjs", "build/atrium.cjs", "build/sea-prep.blob"],
    );
  });

  it("rejects prose with an extension but no separator", () => {
    assert.deepEqual(extractPathsFromCommand('echo "patched app.js"'), []);
    // ...but a genuine quoted path with a space still survives.
    assert.deepEqual(extractPathsFromCommand('cat "my dir/app.js"'), [
      "my dir/app.js",
    ]);
  });
});

describe("extractPathsFromText", () => {
  it("requires a separator plus an extension, or a trailing slash", () => {
    const got = extractPathsFromText(
      "please fix `src/app/main.ts` and look under docs/ — 24/7 and and/or are not paths",
    );
    assert.deepEqual(got, ["src/app/main.ts", "docs/"]);
  });

  it("caps at 20 matches", () => {
    const text = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`).join(" ");
    assert.equal(extractPathsFromText(text).length, 20);
  });
});

// ---------------------------------------------------------------------------
// Usage parsing
// ---------------------------------------------------------------------------

describe("parseUsage", () => {
  it("splits 5m and 1h cache writes", () => {
    const u = parseUsage({
      input_tokens: 2,
      cache_creation_input_tokens: 12417,
      cache_read_input_tokens: 18044,
      output_tokens: 283,
      server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 },
      cache_creation: {
        ephemeral_1h_input_tokens: 12000,
        ephemeral_5m_input_tokens: 417,
      },
      iterations: [
        { input_tokens: 2, output_tokens: 283, cache_read_input_tokens: 18044 },
      ],
    });
    assert.deepEqual(u, {
      input: 2,
      cacheWrite5m: 417,
      cacheWrite1h: 12000,
      cacheRead: 18044,
      output: 283,
      webSearches: 3,
    });
  });

  it("banks the flat total as 5m when cache_creation is absent", () => {
    const u = parseUsage({
      input_tokens: 5,
      cache_creation_input_tokens: 900,
      cache_read_input_tokens: 10,
      output_tokens: 20,
    });
    assert.equal(u.cacheWrite5m, 900);
    assert.equal(u.cacheWrite1h, 0);
    // The flat field must not be added on top of the split — that is a 2x bug.
    assert.equal(u.cacheWrite5m + u.cacheWrite1h, 900);
  });

  it("survives garbage", () => {
    assert.deepEqual(parseUsage(null), {
      input: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 0,
      webSearches: 0,
    });
    assert.equal(parseUsage({ input_tokens: "lots" }).input, 0);
  });
});

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

describe("collectClaudeCode", () => {
  it("prices a turn from the 5m/1h split", () => {
    const fx = makeFixture();
    writeTranscript(fx, "s1.jsonl", [
      assistantLine({
        sessionId: "s1",
        messageId: "msg_a",
        cwd: fx.repoDir,
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 12417,
          cache_read_input_tokens: 18044,
          output_tokens: 283,
          cache_creation: {
            ephemeral_1h_input_tokens: 12417,
            ephemeral_5m_input_tokens: 0,
          },
        },
      }),
    ]);

    const { sessions, stats } = collectClaudeCode({
      transcriptsDir: fx.transcriptsDir,
    });
    const session = onlySession(sessions);
    const turn = session.turns[0]!;

    assert.equal(stats.turns, 1);
    assert.equal(session.source, "claude-code");
    assert.equal(session.repoRoot, fx.repoDir);
    assert.equal(session.gitBranch, "main");
    assert.equal(turn.id, "s1:msg_a");
    assert.equal(turn.seq, 0);
    assert.equal(turn.priced, true);
    assert.equal(turn.usage.cacheWrite1h, 12417);
    assert.equal(turn.usage.cacheWrite5m, 0);

    // (2 + 12417*2.00 + 18044*0.10) * 5/1e6 + 283 * 25/1e6
    const expected = (2 + 12417 * 2 + 18044 * 0.1) * 5e-6 + 283 * 25e-6;
    assert.ok(
      Math.abs(turn.costUsd - expected) < 1e-9,
      `cost ${turn.costUsd} != ${expected}`,
    );
  });

  it("flags an unknown model as unpriced instead of silently zeroing", () => {
    const fx = makeFixture();
    writeTranscript(fx, "s1.jsonl", [
      assistantLine({
        sessionId: "s1",
        messageId: "msg_a",
        cwd: fx.repoDir,
        model: "some-other-vendor-model",
      }),
    ]);
    const turn = onlySession(
      collectClaudeCode({ transcriptsDir: fx.transcriptsDir }).sessions,
    ).turns[0]!;
    assert.equal(turn.priced, false);
    assert.equal(turn.costUsd, 0);
  });

  it("dedupes a repeated message id without double counting usage", () => {
    const fx = makeFixture();
    const usage = {
      input_tokens: 10,
      cache_read_input_tokens: 100,
      output_tokens: 50,
      cache_creation: {
        ephemeral_5m_input_tokens: 20,
        ephemeral_1h_input_tokens: 0,
      },
    };
    writeTranscript(fx, "s1.jsonl", [
      // Real transcripts split one message across lines, restating usage each
      // time; the tool_use block lands on the *later* line.
      assistantLine({
        sessionId: "s1",
        messageId: "msg_dup",
        cwd: fx.repoDir,
        usage,
        uuid: "u1",
        content: [{ type: "thinking", thinking: "hmm" }],
      }),
      assistantLine({
        sessionId: "s1",
        messageId: "msg_dup",
        cwd: fx.repoDir,
        usage,
        uuid: "u2",
        parentUuid: "u1",
        content: [toolUse("Write", { file_path: "src/new.ts", content: "x" })],
      }),
    ]);

    const session = onlySession(
      collectClaudeCode({ transcriptsDir: fx.transcriptsDir }).sessions,
    );
    assert.equal(session.turns.length, 1);
    const turn = session.turns[0]!;
    assert.equal(turn.usage.input, 10);
    assert.equal(turn.usage.output, 50);
    assert.equal(turn.usage.cacheWrite5m, 20);
    // Evidence from the later line must survive the dedupe.
    assert.equal(touchFor(turn.touches, "src/new.ts").tool, "write");
  });

  it("extracts touches and weights for Write / Read / Grep / Bash", () => {
    const fx = makeFixture();
    touchFile(fx, "scripts/build.js");
    touchFile(fx, "dist/a.js");
    writeTranscript(fx, "s1.jsonl", [
      assistantLine({
        sessionId: "s1",
        messageId: "msg_tools",
        cwd: fx.repoDir,
        content: [
          toolUse("Write", { file_path: "src/write.ts", content: "x" }),
          toolUse("Read", { file_path: path.join(fx.repoDir, "src/read.ts") }),
          toolUse("Grep", {
            pattern: "function\\s+\\w+",
            path: "src/lib",
            glob: "packages/*/x.ts",
          }),
          toolUse("Bash", { command: "node scripts/build.js --out=dist/a.js" }),
          toolUse("AskUserQuestion", { question: "src/ignored.ts?" }),
        ],
      }),
    ]);

    const turn = onlySession(
      collectClaudeCode({ transcriptsDir: fx.transcriptsDir }).sessions,
    ).turns[0]!;

    assert.equal(touchFor(turn.touches, "src/write.ts").weight, 1.0);
    assert.equal(touchFor(turn.touches, "src/write.ts").tool, "write");
    assert.equal(touchFor(turn.touches, "src/read.ts").weight, 0.5);
    assert.equal(touchFor(turn.touches, "src/read.ts").tool, "read");
    assert.equal(touchFor(turn.touches, "src/lib").weight, 0.2);
    assert.equal(touchFor(turn.touches, "packages").tool, "search");
    assert.equal(touchFor(turn.touches, "scripts/build.js").weight, 0.3);
    assert.equal(touchFor(turn.touches, "dist/a.js").tool, "shell");

    // Grep's `pattern` is a regex, never a glob — it must not become a path.
    assert.ok(!turn.touches.some((t) => t.path.includes("function")));
    // Unmapped tools contribute nothing.
    assert.ok(!turn.touches.some((t) => t.path === "src/ignored.ts"));
    assert.equal(TOOL_WEIGHTS["Edit"]?.weight, 1.0);
  });

  it("keeps the max weight for a repeated (path, tool) pair", () => {
    const fx = makeFixture();
    touchFile(fx, "src/a.ts");
    writeTranscript(fx, "s1.jsonl", [
      assistantLine({
        sessionId: "s1",
        messageId: "msg_x",
        cwd: fx.repoDir,
        content: [
          toolUse("Bash", { command: "cat src/a.ts" }),
          toolUse("Bash", { command: "wc -l src/a.ts" }),
          toolUse("Write", { file_path: "src/a.ts", content: "y" }),
        ],
      }),
    ]);
    const turn = onlySession(
      collectClaudeCode({ transcriptsDir: fx.transcriptsDir }).sessions,
    ).turns[0]!;
    const shell = turn.touches.filter(
      (t) => t.path === "src/a.ts" && t.tool === "shell",
    );
    assert.equal(shell.length, 1, "shell evidence must not be summed");
    assert.equal(shell[0]!.weight, 0.3);
    // write and shell are distinct evidence kinds and both survive.
    assert.equal(
      turn.touches.filter((t) => t.path === "src/a.ts").length,
      2,
    );
  });

  it("attaches prompt-text paths to the next assistant turn only", () => {
    const fx = makeFixture();
    touchFile(fx, "src/prompted.ts");
    writeTranscript(fx, "s1.jsonl", [
      userLine("s1", fx.repoDir, "please fix src/prompted.ts for me"),
      assistantLine({
        sessionId: "s1",
        messageId: "msg_1",
        cwd: fx.repoDir,
        content: [toolUse("Read", { file_path: "src/prompted.ts" })],
      }),
      // A tool_result carries no human intent and must not seed evidence.
      userLine("s1", fx.repoDir, [
        { type: "tool_result", tool_use_id: "tu-Read", content: "src/leak.ts" },
      ]),
      assistantLine({
        sessionId: "s1",
        messageId: "msg_2",
        cwd: fx.repoDir,
        content: [{ type: "text", text: "done" }],
      }),
    ]);

    const session = onlySession(
      collectClaudeCode({ transcriptsDir: fx.transcriptsDir }).sessions,
    );
    assert.equal(session.turns.length, 2);
    const [first, second] = session.turns as [(typeof session.turns)[0], (typeof session.turns)[0]];

    // Prompt and tool evidence for the same path are distinct kinds and both
    // survive — only same (path, tool) collapses.
    const read = first.touches.find(
      (t) => t.path === "src/prompted.ts" && t.tool === "read",
    );
    assert.ok(read, `expected a read touch: ${JSON.stringify(first.touches)}`);
    assert.equal(read.weight, 0.5);
    const promptTouch = first.touches.find((t) => t.tool === "prompt");
    assert.ok(promptTouch, "expected a prompt touch on the first turn");
    assert.equal(promptTouch.path, "src/prompted.ts");
    assert.equal(promptTouch.weight, 0.4);
    assert.equal(promptTouch.toolName, "prompt");

    // The prompt is consumed by the first turn, not re-applied to later ones.
    assert.deepEqual(second.touches, []);
    assert.ok(!session.turns.some((t) => t.touches.some((x) => x.path === "src/leak.ts")));
  });

  it("skips malformed lines and counts them", () => {
    const fx = makeFixture();
    writeTranscript(fx, "s1.jsonl", [
      assistantLine({ sessionId: "s1", messageId: "msg_1", cwd: fx.repoDir }),
      "{ this is not json",
      '{"type":"assistant","sessionId":"s1","message":{"id":"trunc"',
      "",
      "   ",
      JSON.stringify({ type: "summary", summary: "x" }),
      JSON.stringify({ type: "file-history-snapshot" }),
      "[1,2,3]",
      assistantLine({ sessionId: "s1", messageId: "msg_2", cwd: fx.repoDir }),
    ]);

    const { sessions, stats } = collectClaudeCode({
      transcriptsDir: fx.transcriptsDir,
    });
    assert.equal(stats.linesSkipped, 3, "2 unparseable + 1 non-object");
    assert.equal(stats.linesRead, 7, "blank lines are not counted");
    assert.equal(stats.files, 1);
    assert.equal(onlySession(sessions).turns.length, 2);
  });

  it("drops paths outside the repo root", () => {
    const fx = makeFixture();
    const outside = path.join(fx.outsideDir, "secret.ts");
    writeTranscript(fx, "s1.jsonl", [
      assistantLine({
        sessionId: "s1",
        messageId: "msg_1",
        cwd: fx.repoDir,
        content: [
          toolUse("Read", { file_path: outside }),
          toolUse("Write", { file_path: "../outside/other.ts", content: "x" }),
          toolUse("Read", { file_path: "src/inside.ts" }),
        ],
      }),
    ]);

    const turn = onlySession(
      collectClaudeCode({ transcriptsDir: fx.transcriptsDir }).sessions,
    ).turns[0]!;
    assert.deepEqual(
      turn.touches.map((t) => t.path),
      ["src/inside.ts"],
    );
  });

  it("verifies inferred paths against disk but trusts declared ones", () => {
    const fx = makeFixture();
    fs.mkdirSync(path.join(fx.repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(fx.repoDir, "src", "real.ts"), "x", "utf8");

    writeTranscript(fx, "s1.jsonl", [
      userLine("s1", fx.repoDir, "compare src/real.ts with src/ghost.ts"),
      assistantLine({
        sessionId: "s1",
        messageId: "m1",
        cwd: fx.repoDir,
        content: [
          // shell: inferred, so only the file that exists survives.
          toolUse("Bash", { command: "diff src/real.ts package/dist/http.js" }),
          // write/read: declared by the agent, trusted even though the file is
          // not on disk (it may have been deleted or renamed since).
          toolUse("Write", { file_path: "src/deleted-later.ts", content: "x" }),
          toolUse("Read", { file_path: "src/also-gone.ts" }),
        ],
      }),
    ]);

    const turn = onlySession(
      collectClaudeCode({ transcriptsDir: fx.transcriptsDir }).sessions,
    ).turns[0]!;
    const paths = (kind: string): string[] =>
      turn.touches.filter((t) => t.tool === kind).map((t) => t.path).sort();

    assert.deepEqual(paths("shell"), ["src/real.ts"], "npm tarball member dropped");
    assert.deepEqual(paths("prompt"), ["src/real.ts"], "ghost prompt path dropped");
    assert.deepEqual(paths("write"), ["src/deleted-later.ts"]);
    assert.deepEqual(paths("read"), ["src/also-gone.ts"]);
  });

  it("falls back to slug decoding when no cwd is present", () => {
    const fx = makeFixture();
    // Slug decoding is lossy, so this is a last resort. A line with no cwd
    // still yields a (best-effort) root rather than losing the session.
    writeTranscript(fx, "s1.jsonl", [
      JSON.stringify({
        type: "assistant",
        sessionId: "s1",
        uuid: "u1",
        timestamp: "2026-07-01T00:00:00.000Z",
        isSidechain: false,
        message: {
          id: "m1",
          model: "claude-opus-5",
          content: [toolUse("Read", { file_path: "src/whatever.ts" })],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ]);
    const session = onlySession(
      collectClaudeCode({ transcriptsDir: fx.transcriptsDir }).sessions,
    );
    assert.equal(session.repoRoot, decodeProjectSlug(fx.slug));
    // The turn is still collected and priced — cost is never lost just because
    // the evidence could not be placed.
    assert.equal(session.turns.length, 1);
    assert.equal(session.turns[0]!.priced, true);
    // With no cwd, a relative path cannot be resolved, so it is dropped rather
    // than guessed at.
    assert.deepEqual(session.turns[0]!.touches, []);
  });

  it("orders seq by timestamp and honours `since`", () => {
    const fx = makeFixture();
    writeTranscript(fx, "s1.jsonl", [
      assistantLine({
        sessionId: "s1",
        messageId: "late",
        cwd: fx.repoDir,
        ts: "2026-07-05T00:00:00.000Z",
      }),
      assistantLine({
        sessionId: "s1",
        messageId: "early",
        cwd: fx.repoDir,
        ts: "2026-07-01T00:00:00.000Z",
      }),
      assistantLine({
        sessionId: "s1",
        messageId: "mid",
        cwd: fx.repoDir,
        ts: "2026-07-03T00:00:00.000Z",
      }),
    ]);

    const all = onlySession(
      collectClaudeCode({ transcriptsDir: fx.transcriptsDir }).sessions,
    );
    assert.deepEqual(
      all.turns.map((t) => t.id),
      ["s1:early", "s1:mid", "s1:late"],
    );
    assert.deepEqual(
      all.turns.map((t) => t.seq),
      [0, 1, 2],
    );
    assert.equal(all.startedAt, "2026-07-01T00:00:00.000Z");
    assert.equal(all.endedAt, "2026-07-05T00:00:00.000Z");

    const recent = onlySession(
      collectClaudeCode({
        transcriptsDir: fx.transcriptsDir,
        since: "2026-07-03T00:00:00.000Z",
      }).sessions,
    );
    assert.deepEqual(
      recent.turns.map((t) => t.id),
      ["s1:mid", "s1:late"],
    );
    assert.deepEqual(
      recent.turns.map((t) => t.seq),
      [0, 1],
      "seq is renumbered over the filtered window",
    );
  });

  it("groups sidechain turns and leaves the main thread null", () => {
    const fx = makeFixture();
    touchFile(fx, "lib/a.ts");
    touchFile(fx, "lib/b.ts");
    writeTranscript(fx, "s1.jsonl", [
      assistantLine({
        sessionId: "s1",
        messageId: "main_1",
        cwd: fx.repoDir,
        uuid: "m1",
      }),
      // Two concurrent subagents, interleaved.
      userLine("s1", fx.repoDir, "check lib/a.ts", {
        uuid: "a0",
        isSidechain: true,
      }),
      userLine("s1", fx.repoDir, "check lib/b.ts", {
        uuid: "b0",
        isSidechain: true,
      }),
      assistantLine({
        sessionId: "s1",
        messageId: "sc_a1",
        cwd: fx.repoDir,
        uuid: "a1",
        parentUuid: "a0",
        isSidechain: true,
      }),
      assistantLine({
        sessionId: "s1",
        messageId: "sc_b1",
        cwd: fx.repoDir,
        uuid: "b1",
        parentUuid: "b0",
        isSidechain: true,
      }),
      assistantLine({
        sessionId: "s1",
        messageId: "sc_a2",
        cwd: fx.repoDir,
        uuid: "a2",
        parentUuid: "a1",
        isSidechain: true,
      }),
      assistantLine({
        sessionId: "s1",
        messageId: "main_2",
        cwd: fx.repoDir,
        uuid: "m2",
        parentUuid: "m1",
      }),
    ]);

    const session = onlySession(
      collectClaudeCode({ transcriptsDir: fx.transcriptsDir }).sessions,
    );
    const byId = new Map(session.turns.map((t) => [t.id, t]));
    assert.equal(byId.get("s1:main_1")!.sidechainKey, null);
    assert.equal(byId.get("s1:main_1")!.isSidechain, false);
    assert.equal(byId.get("s1:main_2")!.sidechainKey, null);

    const a1 = byId.get("s1:sc_a1")!;
    const a2 = byId.get("s1:sc_a2")!;
    const b1 = byId.get("s1:sc_b1")!;
    assert.equal(a1.isSidechain, true);
    assert.equal(a1.sidechainKey, "sc:a0");
    assert.equal(a2.sidechainKey, "sc:a0", "chained through parentUuid");
    assert.equal(b1.sidechainKey, "sc:b0");
    assert.notEqual(a1.sidechainKey, b1.sidechainKey);

    // Each subagent's prompt evidence stays in its own window.
    assert.deepEqual(
      a1.touches.map((t) => t.path),
      ["lib/a.ts"],
    );
    assert.deepEqual(
      b1.touches.map((t) => t.path),
      ["lib/b.ts"],
    );
  });

  it("separates sessions that share a file", () => {
    const fx = makeFixture();
    writeTranscript(fx, "resumed.jsonl", [
      assistantLine({ sessionId: "old", messageId: "m1", cwd: fx.repoDir }),
      assistantLine({ sessionId: "new", messageId: "m2", cwd: fx.repoDir }),
    ]);
    const { sessions } = collectClaudeCode({
      transcriptsDir: fx.transcriptsDir,
    });
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map((s) => s.id).sort(), ["new", "old"]);
    // Same message id in two sessions is two distinct turns.
    assert.deepEqual(
      sessions.flatMap((s) => s.turns.map((t) => t.id)).sort(),
      ["new:m2", "old:m1"],
    );
  });

  it("honours an explicit repoRoot override", () => {
    const fx = makeFixture();
    const nested = path.join(fx.repoDir, "pkg");
    writeTranscript(fx, "s1.jsonl", [
      assistantLine({
        sessionId: "s1",
        messageId: "m1",
        cwd: nested,
        content: [toolUse("Read", { file_path: "src/a.ts" })],
      }),
    ]);
    const session = onlySession(
      collectClaudeCode({
        transcriptsDir: fx.transcriptsDir,
        repoRoot: fx.repoDir,
      }).sessions,
    );
    assert.equal(session.repoRoot, fx.repoDir);
    assert.deepEqual(
      session.turns[0]!.touches.map((t) => t.path),
      ["pkg/src/a.ts"],
    );
  });

  it("filters project dirs with onlyThisRepo", () => {
    const fx = makeFixture();
    writeTranscript(fx, "s1.jsonl", [
      assistantLine({ sessionId: "s1", messageId: "m1", cwd: fx.repoDir }),
    ]);
    const otherDir = path.join(fx.transcriptsDir, "C--nope-elsewhere");
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(
      path.join(otherDir, "s2.jsonl"),
      assistantLine({ sessionId: "s2", messageId: "m2", cwd: "C:\\nope\\elsewhere" }),
      "utf8",
    );

    const all = collectClaudeCode({ transcriptsDir: fx.transcriptsDir });
    assert.equal(all.sessions.length, 2);

    const scoped = collectClaudeCode({
      transcriptsDir: fx.transcriptsDir,
      repoRoot: fx.repoDir,
      onlyThisRepo: true,
    });
    assert.equal(scoped.sessions.length, 1);
    assert.equal(scoped.sessions[0]!.id, "s1");
  });

  it("returns empty for a missing transcripts dir", () => {
    const result = collectClaudeCode({
      transcriptsDir: path.join(os.tmpdir(), "overhead-does-not-exist-xyz"),
    });
    assert.deepEqual(result.sessions, []);
    assert.equal(result.stats.files, 0);
  });
});

describe("project dirs", () => {
  it("lists directories with decoded paths", () => {
    const fx = makeFixture();
    const dirs = listProjectDirs(fx.transcriptsDir);
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0]!.slug, fx.slug);
    assert.equal(dirs[0]!.dir, fx.projectDir);
  });

  it("decodes a Windows slug best-effort", () => {
    assert.equal(
      decodeProjectSlug("C--Users-dev-Documents-proj"),
      "C:\\Users\\dev\\Documents\\proj",
    );
    assert.equal(decodeProjectSlug("-home-me-proj"), "/home/me/proj");
  });
});

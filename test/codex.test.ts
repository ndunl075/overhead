import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  collectCodex,
  parseCodexUsage,
} from "../src/collect/codex.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRepo(): { repo: string; sessions: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "overhead-codex-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  const sessions = path.join(root, "sessions");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(sessions, "2026", "08", "08"), { recursive: true });
  writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(path.join(repo, "src", "prompt.ts"), "export {};\n");
  return { repo, sessions };
}

function event(timestamp: string, type: string, payload: Record<string, unknown>) {
  return JSON.stringify({ timestamp, type, payload });
}

function token(
  timestamp: string,
  total: Record<string, number>,
  last: Record<string, number>,
) {
  return event(timestamp, "event_msg", {
    type: "token_count",
    info: { total_token_usage: total, last_token_usage: last },
  });
}

test("parseCodexUsage splits cached and cache-write tokens out of input", () => {
  assert.deepEqual(
    parseCodexUsage({
      input_tokens: 100,
      cached_input_tokens: 40,
      cache_write_input_tokens: 10,
      output_tokens: 20,
      reasoning_output_tokens: 7,
    }),
    {
      input: 50,
      cacheWrite5m: 10,
      cacheWrite1h: 0,
      cacheRead: 40,
      output: 20,
      webSearches: 0,
    },
  );
});

test("collectCodex joins prompts and tool calls to per-response usage", () => {
  const { repo, sessions } = tempRepo();
  const file = path.join(sessions, "2026", "08", "08", "rollout-test.jsonl");
  const firstTotal = {
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 10,
    output_tokens: 20,
    reasoning_output_tokens: 7,
    total_tokens: 120,
  };

  writeFileSync(
    file,
    [
      event("2026-08-08T12:00:00Z", "session_meta", {
        session_id: "session-1",
        cwd: repo,
        git: { branch: "feature/codex" },
      }),
      event("2026-08-08T12:00:01Z", "event_msg", {
        type: "thread_settings_applied",
        thread_settings: {
          model: "gpt-5.6-sol",
          service_tier: "default",
        },
      }),
      event("2026-08-08T12:00:02Z", "event_msg", {
        type: "user_message",
        message: "Please compare src/prompt.ts before changing it",
      }),
      event("2026-08-08T12:00:03Z", "response_item", {
        type: "function_call",
        name: "shell_command",
        arguments: JSON.stringify({ command: "Get-Content src/a.ts", workdir: repo }),
      }),
      token("2026-08-08T12:00:04Z", firstTotal, firstTotal),
      // A resumed thread can replay the last cumulative snapshot. It is not a
      // second billable response.
      token("2026-08-08T12:00:05Z", firstTotal, firstTotal),
      event("2026-08-08T12:00:06Z", "response_item", {
        type: "custom_tool_call",
        name: "exec",
        input: 'const patch = "*** Begin Patch\\n*** Update File: src/b.ts\\n";',
      }),
      event("2026-08-08T12:00:07Z", "event_msg", {
        type: "thread_settings_applied",
        thread_settings: {
          model: "gpt-5.6-sol",
          service_tier: "priority",
        },
      }),
      token(
        "2026-08-08T12:00:08Z",
        {
          input_tokens: 180,
          cached_input_tokens: 60,
          cache_write_input_tokens: 10,
          output_tokens: 30,
          reasoning_output_tokens: 9,
          total_tokens: 210,
        },
        {
          input_tokens: 80,
          cached_input_tokens: 20,
          cache_write_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 2,
          total_tokens: 90,
        },
      ),
      "{truncated",
    ].join("\n"),
  );

  const result = collectCodex({
    transcriptsDir: sessions,
    repoRoot: repo,
    onlyThisRepo: true,
  });

  assert.equal(result.stats.files, 1);
  assert.equal(result.stats.sessions, 1);
  assert.equal(result.stats.turns, 2);
  assert.equal(result.stats.duplicateLines, 1);
  assert.equal(result.stats.linesSkipped, 1);

  const session = result.sessions[0]!;
  assert.equal(session.id, "codex:rollout-test");
  assert.equal(session.source, "codex");
  assert.equal(session.gitBranch, "feature/codex");
  assert.equal(session.repoRoot, path.resolve(repo));

  const first = session.turns[0]!;
  assert.deepEqual(first.usage, {
    input: 50,
    cacheWrite5m: 10,
    cacheWrite1h: 0,
    cacheRead: 40,
    output: 20,
    webSearches: 0,
  });
  assert.equal(first.model, "gpt-5.6-sol");
  assert.equal(first.priced, true);
  assert.ok(first.costUsd > 0);
  assert.ok(first.touches.some((touch) => touch.path === "src/a.ts"));
  assert.ok(first.touches.some((touch) => touch.path === "src/prompt.ts"));

  const second = session.turns[1]!;
  assert.ok(second.touches.some((touch) =>
    touch.path === "src/b.ts" && touch.tool === "edit" && touch.weight === 1
  ));
  // Priority processing uses the premium OpenAI rate.
  assert.ok(second.costUsd > 0);
});

test("collectCodex recursively scans rollouts and filters by repo", () => {
  const { repo, sessions } = tempRepo();
  const other = path.join(path.dirname(repo), "other");
  mkdirSync(path.join(other, ".git"), { recursive: true });

  const writeRollout = (name: string, cwd: string): void => {
    const dir = path.join(sessions, "2026", "08", "09");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, name),
      [
        event("2026-08-09T00:00:00Z", "session_meta", {
          session_id: name,
          cwd,
        }),
        event("2026-08-09T00:00:01Z", "event_msg", {
          type: "thread_settings_applied",
          thread_settings: { model: "gpt-5.6-luna", service_tier: "default" },
        }),
        token(
          "2026-08-09T00:00:02Z",
          { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
          { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        ),
      ].join("\n"),
    );
  };

  writeRollout("wanted.jsonl", repo);
  writeRollout("other.jsonl", other);

  const result = collectCodex({
    transcriptsDir: sessions,
    repoRoot: repo,
    onlyThisRepo: true,
  });
  assert.equal(result.stats.files, 1);
  assert.equal(result.stats.sessions, 1);
  assert.equal(result.sessions[0]!.id, "codex:wanted");

  const all = collectCodex({
    transcriptsDir: sessions,
    repoRoot: repo,
    onlyThisRepo: false,
  });
  assert.equal(all.stats.sessions, 2);
  assert.deepEqual(
    new Set(all.sessions.map((session) => session.repoRoot)),
    new Set([path.resolve(repo), path.resolve(other)]),
  );
});

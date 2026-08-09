import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  attrsToMap,
  collectOtel,
  touchesFromToolAttrs,
  usageFromAttrs,
} from "../src/collect/otel.ts";

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

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "overhead-otel-"));
  tmpRoots.push(d);
  return d;
}

function attr(key: string, value: string | number) {
  if (typeof value === "number") {
    return { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

describe("attrsToMap / usageFromAttrs", () => {
  it("reads flat Claude Code token fields", () => {
    const attrs = attrsToMap([
      attr("input_tokens", 100),
      attr("output_tokens", 20),
      attr("cache_read_tokens", 50),
      attr("cache_creation_tokens", 30),
    ]);
    const u = usageFromAttrs(attrs);
    assert.equal(u.input, 100);
    assert.equal(u.output, 20);
    assert.equal(u.cacheRead, 50);
    assert.equal(u.cacheWrite5m, 30);
    assert.equal(u.cacheWrite1h, 0);
  });

  it("accepts GenAI semconv names", () => {
    const attrs = attrsToMap([
      attr("gen_ai.usage.input_tokens", 10),
      attr("gen_ai.usage.output_tokens", 4),
    ]);
    const u = usageFromAttrs(attrs);
    assert.equal(u.input, 10);
    assert.equal(u.output, 4);
  });
});

describe("touchesFromToolAttrs", () => {
  it("extracts file_path from tool spans", () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, "packages", "checkout"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "packages", "checkout", "cart.ts"),
      "export {}\n",
    );
    const touches = touchesFromToolAttrs(
      attrsToMap([
        attr("tool_name", "Edit"),
        attr("file_path", path.join(repo, "packages", "checkout", "cart.ts")),
      ]),
      repo,
    );
    assert.equal(touches.length, 1);
    assert.equal(touches[0]!.path, "packages/checkout/cart.ts");
    assert.equal(touches[0]!.tool, "edit");
  });

  it("parses tool_input JSON for Write", () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "x\n");
    const touches = touchesFromToolAttrs(
      attrsToMap([
        attr("tool_name", "Write"),
        attr(
          "tool_input",
          JSON.stringify({ file_path: path.join(repo, "src", "a.ts") }),
        ),
      ]),
      repo,
    );
    assert.equal(touches[0]!.path, "src/a.ts");
    assert.equal(touches[0]!.weight, 1);
  });
});

describe("collectOtel", () => {
  it("builds sessions from api_request + tool_result events", () => {
    const root = tmpDir();
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, "pkg", "x.ts"), "export {}\n");

    const exportPath = path.join(root, "dump.json");
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1700000000000000000",
                  attributes: [
                    attr("event.name", "tool_result"),
                    attr("session.id", "sess-1"),
                    attr("prompt.id", "prompt-1"),
                    attr("tool_name", "Edit"),
                    attr("event.timestamp", "2026-07-15T12:00:00.000Z"),
                    attr(
                      "tool_input",
                      JSON.stringify({
                        file_path: path.join(repo, "pkg", "x.ts"),
                      }),
                    ),
                  ],
                },
                {
                  timeUnixNano: "1700000001000000000",
                  attributes: [
                    attr("event.name", "api_request"),
                    attr("session.id", "sess-1"),
                    attr("prompt.id", "prompt-1"),
                    attr("model", "claude-sonnet-4-6"),
                    attr("request_id", "req_abc"),
                    attr("input_tokens", 1000),
                    attr("output_tokens", 100),
                    attr("cache_read_tokens", 0),
                    attr("cache_creation_tokens", 0),
                    attr("cost_usd", 0.0045),
                    attr("event.timestamp", "2026-07-15T12:00:01.000Z"),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    fs.writeFileSync(exportPath, JSON.stringify(payload), "utf8");

    const result = collectOtel({ input: exportPath, repoRoot: repo });
    assert.equal(result.stats.sessions, 1);
    assert.equal(result.stats.turns, 1);
    const session = result.sessions[0]!;
    assert.equal(session.source, "otel");
    assert.equal(session.id, "otel:sess-1");
    const turn = session.turns[0]!;
    assert.equal(turn.model, "claude-sonnet-4-6");
    assert.equal(turn.costUsd, 0.0045);
    assert.equal(turn.priced, true);
    assert.equal(turn.usage.input, 1000);
    assert.equal(turn.usage.output, 100);
    assert.ok(turn.touches.some((t) => t.path === "pkg/x.ts"));
  });

  it("ingests llm_request spans as a fallback", () => {
    const root = tmpDir();
    const exportPath = path.join(root, "spans.json");
    fs.writeFileSync(
      exportPath,
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    name: "claude_code.llm_request",
                    endTimeUnixNano: "1700000002000000000",
                    attributes: [
                      attr("session.id", "span-sess"),
                      attr("model", "claude-haiku-4-5"),
                      attr("request_id", "req_span"),
                      attr("input_tokens", 200),
                      attr("output_tokens", 50),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    const result = collectOtel({ input: exportPath, repoRoot: root });
    assert.equal(result.stats.turns, 1);
    assert.equal(result.sessions[0]!.turns[0]!.model, "claude-haiku-4-5");
    assert.equal(result.sessions[0]!.turns[0]!.usage.input, 200);
  });
});

# Overhead — Architecture

Token cost attribution across a monorepo. Answers: *which part of the codebase is our AI bill actually going to?*

## 0. Problem

A team runs agents across a big repo. The invoice is one number. Nobody can say whether it's `packages/checkout` or `apps/admin`, or which team should own the spend. Global usage dashboards stop at "you spent $41k in March."

Overhead attributes spend to **directories, packages, teams, and features** by mining the evidence agents leave behind: every turn's token usage sits next to the file paths that turn touched.

## 1. Core insight

```
A session's cost is known exactly.  (usage block, per assistant turn)
A session's subject is inferable.   (file paths in tool calls)
=> Distribute each turn's cost across the paths that turn was demonstrably about.
```

Not session-level — **turn-level**, with decayed evidence. A 400-turn session that spent 90% of its turns in `services/billing` and 10% in `docs/` splits 90/10, not 100/0 to whatever the session was titled.

## 2. Pipeline

```
collect → normalize → price → attribute → rollup → store → report
                                                      ↓
                                              reconcile (invoice truth)
```

| Stage | In | Out | Module |
|---|---|---|---|
| collect | JSONL transcripts, OTel exports, Admin API (invoice) | raw events / invoice totals | `src/collect/`, `src/billing/` |
| normalize | raw events | `Turn[]`, `Touch[]` | `src/collect/` |
| price | Turn.usage + model | `cost_usd` | `src/pricing/` |
| attribute | Turn + Touch history | `(turn, path, share)` | `src/attribute/` |
| rollup | path shares | dir / package / team / feature | `src/rollup/` |
| store | all of it | SQLite | `src/db/` |
| report | SQLite | table / JSON / CSV / HTML | `src/report/` |

## 3. Data sources

| Source | Gives | Status |
|---|---|---|
| `~/.claude/projects/<slug>/*.jsonl` | per-turn usage + model + tool calls w/ file paths + `cwd` + `gitBranch` + sidechains | **v1** |
| `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | per-response usage + model settings + native/custom tool calls + `cwd` + branch | **v1** |
| Anthropic Admin API usage/cost report | authoritative org totals by API key / workspace | **v2** (billing adapter) |
| OTel metrics/events/traces export | same usage, fleet-wide, no local files | **v2** |

Transcript schema facts (verified against real files):

```jsonc
{ "type":"assistant", "sessionId", "uuid", "parentUuid", "timestamp",
  "cwd", "gitBranch", "isSidechain", "requestId",
  "message": { "id", "model":"claude-opus-5", "content":[ {"type":"tool_use","name":"Edit","input":{"file_path":…}} ],
    "usage": { "input_tokens", "output_tokens", "cache_read_input_tokens",
               "cache_creation_input_tokens",
               "cache_creation": { "ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens" } } } }
```

`cache_creation` splits 5m vs 1h — **they price differently (1.25× vs 2×)**. Do not use the flat `cache_creation_input_tokens`.

Codex rollout facts verified against real files:

- `event_msg/token_count.info.last_token_usage` is the per-response usage; `total_token_usage` is cumulative and is used only as a replay-dedupe key.
- `cached_input_tokens` and `cache_write_input_tokens` are included inside `input_tokens`, so both are subtracted before mapping the remaining fresh input.
- `response_item/function_call` and `custom_tool_call` records precede the `token_count` event they belong to. Codex's `exec` custom call wraps nested tools in JavaScript, so the collector extracts structured paths, patch headers, and conservative command/prose paths from that wrapper.
- Main and auto-review rollouts can share a logical session id. The unique rollout filename keys storage so one stream cannot replace the other.

## 4. Cost model

```
cost = ( in·P_in
       + w5m·P_in·1.25
       + w1h·P_in·2.00
       + read·P_in·0.10
       + out·P_out ) / 1e6
```

Per-MTok list prices (`src/pricing/models.ts`, dated + overridable):

| Model | In | Out |
|---|---|---|
| `gpt-5.6-sol` / `gpt-5.6` | 5 | 30 |
| `gpt-5.6-terra` | 2.5 | 15 |
| `gpt-5.6-luna` | 1 | 6 |
| GPT-5.6 @ Priority processing | 2× standard | 2× standard |
| GPT-5.6 with >272K input tokens | 2× standard input | 1.5× standard output |
| `claude-fable-5`, `claude-mythos-5` | 10 | 50 |
| `claude-opus-5`, `claude-opus-4-8/4-7/4-6` | 5 | 25 |
| `claude-opus-5` @ `speed:fast` | 10 | 50 |
| `claude-sonnet-5` | 3 (intro 2 → 2026-08-31) | 15 (intro 10) |
| `claude-sonnet-4-6` | 3 | 15 |
| `claude-haiku-4-5` | 1 | 5 |

Modifiers: Batch API ×0.5. Web search $10/1k requests.

Unknown model id → priced at 0 and counted in an `unpriced` bucket surfaced in every report, so a new model release shows up as a visible gap rather than a silently shrinking bill. Two things must not trip that warning: harness pseudo-models (`<synthetic>`, which never reached the API) are *free*, not unknown; and the warning only fires for unpriced turns that actually consumed tokens.

## 5. Attribution engine — the actual IP

### 5.1 Evidence

Every tool call emits `Touch{ turnSeq, path, tool, weight }`. Path extraction per tool:

| Tool | Path source | Weight |
|---|---|---|
| `Write`, `Edit`, `NotebookEdit` | `input.file_path` | **1.0** |
| `Read` | `input.file_path` | 0.5 |
| `Grep`, `Glob` | `input.path`, literal prefix of `input.glob`/`pattern` | 0.2 |
| `Bash`, `PowerShell` | paths lexed out of `input.command` | 0.3 |
| user prompt text | path-shaped tokens (`a/b.ts`, `src/foo/`) | 0.4 |
| `Agent` | — (sidechain turns carry their own touches) | — |

Paths are resolved against the turn's `cwd`, normalized to repo-relative POSIX, and dropped if outside the repo root.

### 5.2 Decay

Turn *t*'s cost is attributed to the *active file set* — recent touches matter more:

```
score(p, t) = Σ_{u ≤ t, t-u < W}  weight(touch)·λ^(t-u)
share(p, t) = score(p,t) / Σ_q score(q,t)
cost(p, t)  = cost(t) · share(p, t)
```

Defaults `λ = 0.85`, window `W = 20` turns. Rationale: prompt caching means turn *t* is literally paying to re-read the context established by turns *t-1…t-k*; the cost is genuinely shared backwards. Both tunable in config; both reported in output metadata so numbers are reproducible.

### 5.3 Unattributable

A turn with an empty evidence set (pure conversation, planning, web research) goes to `__unattributed__`. **This bucket is reported, never hidden.** Its size is the honesty metric — if it's 60%, the attribution isn't trustworthy yet and the report says so.

### 5.4 Sidechains

`isSidechain: true` turns are real cost with their own file evidence. Included; evidence windows are keyed per-sidechain so a subagent's reads don't pollute the parent's active set.

### 5.5 Dedupe — split the key's two jobs

Key on `(sessionId, message.id)`. Double counting usage is the easiest way to be wrong by 2×.

But **"keep the first line, drop the rest" destroys the evidence.** Claude Code writes *one transcript line per content block*, each restating the identical `usage` object — and the `tool_use` block lands on a *later* line than the `text`/`thinking` block. In one real transcript, 162 of 372 message ids spanned multiple lines. Dropping duplicates wholesale discards nearly every file path in the corpus.

So the two concerns are separated:

| Field | Rule |
|---|---|
| usage, cost, model, timestamp | **first line wins** — never summed |
| touches | **merged across every line sharing the id** |

Same for `usage.iterations`: it is a per-attempt breakdown that re-states the same totals, so summing it double counts. Read the top-level fields only.

Codex has the analogous replay hazard when a thread resumes: it may emit the previous cumulative `total_token_usage` snapshot again. The collector deduplicates that snapshot while always pricing `last_token_usage`; this avoids billing a previous response twice.

### 5.6 Declared vs inferred evidence

Paths arrive two ways, and they do not deserve equal trust:

- **Declared** — a structured `file_path` argument (`Write`, `Edit`, `Read`, `Grep`). The agent named the file.
- **Inferred** — lexed out of a shell command or prompt prose. A guess.

Inferred paths must **resolve to something that exists** under the repo root; declared paths are trusted as-is. Without this gate, real transcripts produce fabricated top-level units: `origin/claude` from `git push origin claude`, `package/dist/*` from npm tarball syntax, and `$W/src/mcp.ts` from an unexpanded shell variable whose `$` was stripped. On one repo the gate cut distinct paths 193 → 41 while leaving the top-10 weighted paths and the total cost **byte-identical** — all noise, no signal.

Cost of the gate: a file deleted or renamed since the session loses its weakest evidence. Correct trade — a fabricated directory in a spend report destroys trust in every other row.

## 6. Rollup

File shares → units. Four unit kinds, all from the same file-level table:

| Kind | Derivation |
|---|---|
| `dir` | prefix at configurable depth (`--depth 2`) |
| `package` | auto-detected workspace roots: `pnpm-workspace.yaml`, `package.json#workspaces`, `go.work`, `Cargo.toml#workspace.members`, `nx.json` |
| `team` | **CODEOWNERS** — gitignore-style globs, **last** matching rule wins (GitHub semantics, not gitignore's first-match) |
| `feature` | user-defined globs in `overhead.config.json` |

CODEOWNERS support is the feature that turns "which folder" into "which team's budget" — the question that actually gets asked.

Last-match-wins is load-bearing: real CODEOWNERS files open with a catch-all (`* @org/everyone`) and then narrow. First-match would assign the whole repo to that first line and collapse the team report to a single row. Lines with no owner are kept as rules — GitHub uses them to *remove* ownership, and dropping them would leave a stale earlier owner in place. Multiple owners on one line form a joint bucket (`@a, @b`) rather than being split, because CODEOWNERS specifies no division rule.

## 7. Reconciliation

Local transcripts give *relative* attribution. The invoice gives *absolute* truth. They disagree (other machines, CI agents, non-Claude-Code API traffic).

```
scale = invoiced_total / local_total
```

Report shows both `modeled` and `reconciled` columns plus `coverage = local_total / invoiced_total`. Low coverage means transcripts are missing — say so loudly rather than presenting a confident wrong number.

Invoice totals arrive two ways:

1. **Manual** — `overhead reconcile --actual <usd> [--period YYYY-MM]`
2. **Billing adapter** — `overhead reconcile --from anthropic --period YYYY-MM` pulls `/v1/organizations/cost_report` with an Admin API key (`ANTHROPIC_ADMIN_API_KEY`). Amounts are cents-as-decimal-strings; the adapter converts to USD and pages through the month.

## 8. Storage

SQLite (`node:sqlite`, no native deps). Idempotent ingest keyed on message id.

```sql
sessions(id PK, source, project_slug, repo_root, git_branch, started_at, ended_at)
turns(id PK, session_id, seq, ts, model, message_id UNIQUE, is_sidechain,
      in_tok, cache_w5m, cache_w1h, cache_read, out_tok, cost_usd, priced INT)
touches(turn_id, path, tool, weight)
attributions(turn_id, path, share, cost_usd)
meta(key, value)          -- config hash, lambda, window, price table version
```

`attributions` is materialized at ingest so reports are pure SQL aggregation. Re-running with different `λ`/`W` recomputes that one table.

## 9. CLI

```
overhead scan     [--since 30d] [--repo .] [--all-projects] [--otel <path>] [--otel-only]
overhead report   [--by dir|package|team|file|model|session] [--depth 2] [--since 7d] [--top 20]
overhead reconcile --actual 12345.67 [--period 2026-07]
overhead reconcile --from anthropic --period 2026-07 [--api-key …]
overhead export   [--format json|csv]
overhead html     [-o overhead-report.html]
overhead config   init
```

## 10. Implementation status and build order

| # | Deliverable | Depends on | Status |
|---|---|---|---|
| 1 | types, schema, db | — | Shipped in v0.1 |
| 2 | pricing + cost engine | 1 | Shipped in v0.1 |
| 3 | transcript collector + path extraction | 1 | Shipped in v0.1 |
| 4 | attribution engine | 1,2,3 | Shipped in v0.1 |
| 5 | rollup (workspace + CODEOWNERS) | 1 | Shipped in v0.1 |
| 6 | CLI + table report | all | Shipped in v0.1 |
| 7 | HTML report | 6 | Shipped in v0.1 |
| 8 | manual reconcile via `--actual` | 6 | Shipped in v0.1 |
| 9 | Anthropic Admin API billing adapter | 8 | Shipped in v0.2 |
| 10 | OTel ingest for fleet-wide collection | 3,6 | Shipped in v0.2 |

## 11. Non-goals (v1)

Real-time interception. Per-developer surveillance framing — units are code, not people. Prompt content storage (paths and token counts only; no message bodies leave the machine).

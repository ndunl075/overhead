<p align="center">
  <img src="assets/overhead-mascot.png" alt="Overhead mascot: a smiling cloud sprite encircled by a blue orbital arrow" width="320">
</p>

<h1 align="center">Overhead</h1>

<p align="center"><em>A friendly view from above.</em></p>

<p align="center">
  Token cost attribution across a monorepo — find out which <strong>part of the codebase</strong> your AI bill is actually going to.
</p>

---

## The problem

Your team runs agents across a big repo. The invoice arrives as one number. Somebody asks the obvious question:

> "$41,000. On *what*?"

Provider dashboards stop at the org, the workspace, or the API key. None of them know that `services/billing` ate 38% of it while `docs/` cost almost nothing.

## What Overhead does

Agents leave a trail. Every assistant turn records exactly what it cost — and, right next to it, the files that turn touched. Overhead joins those two facts and distributes each turn's cost across the code it was demonstrably about.

```
$ overhead report --by package

  UNIT                        COST      SHARE                    TURNS    IN     OUT
  packages/checkout        $412.80      31.2%  ████████████▌      1,204   8.1M   241k
  services/billing         $288.14      21.8%  ████████▊            902   5.9M   178k
  packages/ui              $196.55      14.9%  ██████               701   3.8M   119k
  apps/admin               $151.02      11.4%  ████▌                544   2.9M    88k
  packages/auth             $88.31       6.7%  ██▋                  310   1.7M    52k
  (unattributed)           $185.44      14.0%  █████▌               612   3.6M   109k

  Total $1,322.26 · 4,273 turns · 61 sessions · lambda 0.85 / window 20
```

Swap the axis and ask a different question:

```
overhead report --by team      # via CODEOWNERS — whose budget is this?
overhead report --by dir --depth 3
overhead report --by feature   # your own globs
overhead report --by model     # is Opus doing work Haiku could?
```

## Install

Requires **Node 22.18+**. No build step, no native dependencies — TypeScript runs directly via Node's type stripping, and storage is the built-in `node:sqlite`.

```bash
git clone https://github.com/ndunl075/overhead && cd overhead
npm install          # dev-only: typescript + @types/node
npm link             # optional, puts `overhead` on your PATH
```

## Use

```bash
cd ~/code/your-monorepo

overhead scan                    # ingest agent transcripts, attribute the cost
overhead report --by package
overhead html -o spend.html      # shareable single-file report
```

Nothing leaves your machine. Overhead reads Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) transcripts, then stores **paths and token counts only** — never message content.

### Reconcile against the real invoice

Local transcripts give you *relative* attribution. Your invoice is the *absolute* truth, and they will differ — CI agents, other developers' machines, non-agent API traffic.

```bash
overhead reconcile --actual 41203.55 --period 2026-07
```

This reports `coverage` — what fraction of the real bill these transcripts explain. **Low coverage is reported loudly rather than hidden.** A confident number computed from 30% of the data is worse than no number.

## How attribution works

The naive approach assigns a whole session to one folder. That's wrong: a 400-turn session that spent most of its time in `services/billing` and a few turns in `docs/` is not 100% billing work.

Overhead works **per turn**, with decaying evidence:

```
score(path, t) = Σ  weight(touch) · λ^(turns ago)      over the last W turns
share(path, t) = score(path) / Σ all scores
cost(path, t)  = cost(turn t) · share(path, t)
```

**Evidence weights** — not every mention is equal proof:

| Signal | Weight | Why |
|---|---|---|
| `Edit` / `Write` | 1.0 | Direct proof the turn was about this file |
| `Read` | 0.5 | Strong, but reading is often reconnaissance |
| `Bash` path arguments | 0.3 | Suggestive; commands mention paths incidentally |
| Paths named in your prompt | 0.4 | You said it was about this |
| `Grep` / `Glob` scope | 0.2 | Weakest — a search touches a lot it doesn't care about |

**Why decay?** Prompt caching means turn *t* is literally paying to re-read the context that turns *t−1…t−k* established. That cost is genuinely shared backwards. `λ = 0.85` over a 20-turn window; both are configurable and both are printed on every report so any number is reproducible.

**Subagents** get their own evidence window, so a subagent's file reads never pollute the parent thread's attribution.

### The unattributed bucket

Turns with no file evidence — planning, discussion, web research — go to `(unattributed)`. This bucket is **always shown, never hidden or redistributed**. Its size is the honesty metric: if it's 60%, the attribution isn't trustworthy yet, and the report says so instead of quietly spreading that cost over your directories.

## Cost model

Every input-side token category is a multiple of the model's input rate:

| Category | Multiplier |
|---|---|
| Fresh input | 1.00× |
| Cache write, 5-minute TTL | 1.25× |
| Cache write, 1-hour TTL | **2.00×** |
| Cache read | 0.10× |

The 5m/1h split matters for Claude Code. Agent harnesses lean on the 1-hour TTL, so collapsing the two — or using the flat `cache_creation_input_tokens` field — materially understates long-session cost. Codex records a single cache-write category plus cached reads; Overhead splits both out of `input_tokens` before pricing so they are not double counted.

Built-in OpenAI rates cover the GPT-5.6 Sol, Terra, and Luna family, including Priority processing. Codex's internal `codex-auto-review` model has no public list price, so those turns are deliberately surfaced as unpriced unless you provide an override.

Unknown model IDs are priced at zero **and reported as unpriced**, so a new model release shows up as a visible gap rather than a silently shrinking bill. Override any rate in `overhead.config.json` if you're on partner or negotiated pricing.

## Configuration

```bash
overhead config init
```

```jsonc
{
  "attribution": { "lambda": 0.85, "window": 20 },
  "depth": 2,
  "features": {
    "checkout": ["packages/checkout/**", "apps/web/src/checkout/**"],
    "auth": ["packages/auth/**", "services/identity/**"]
  },
  "prices": {}
}
```

Changing `lambda` or `window` doesn't require a re-scan — raw evidence is kept, so `overhead scan --reattribute` recomputes from what's already stored.

## Commands

| Command | Does |
|---|---|
| `overhead scan` | Ingest transcripts, price turns, attribute cost |
| `overhead report` | Table output, grouped by `--by` |
| `overhead reconcile --actual <usd>` | Compare modeled spend to the invoice |
| `overhead export --format json\|csv` | Machine-readable output |
| `overhead html -o <file>` | Self-contained shareable report |
| `overhead config init` | Starter config file |

## Design notes

Full design rationale, data model, and pipeline detail: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

**Units are code, not people.** Overhead deliberately attributes to directories, packages, and ownership units — never to individual developers. It's a budgeting tool, not a surveillance tool.

## Status

v1 reads Claude Code and Codex transcripts. Planned: provider billing API adapters for automatic reconciliation, and OTel ingest for fleet-wide collection without touching individual machines.

## License

MIT

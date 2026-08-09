-- Overhead storage. SQLite via node:sqlite (no native dependency).
-- Ingest is idempotent: turns are keyed on `${sessionId}:${messageId}`.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  repo_root    TEXT,
  git_branch   TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  ts            TEXT NOT NULL,
  model         TEXT NOT NULL,
  is_sidechain  INTEGER NOT NULL DEFAULT 0,
  sidechain_key TEXT,
  in_tok        INTEGER NOT NULL DEFAULT 0,
  cache_w5m     INTEGER NOT NULL DEFAULT 0,
  cache_w1h     INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  out_tok       INTEGER NOT NULL DEFAULT 0,
  web_searches  INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  priced        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_turns_ts      ON turns(ts);
CREATE INDEX IF NOT EXISTS idx_turns_model   ON turns(model);

-- Raw evidence, retained so attribution can be recomputed with new
-- lambda/window settings without re-reading transcripts.
CREATE TABLE IF NOT EXISTS touches (
  turn_id   TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  path      TEXT NOT NULL,
  tool      TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  weight    REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_touches_turn ON touches(turn_id);
CREATE INDEX IF NOT EXISTS idx_touches_path ON touches(path);

-- Materialized attribution. Rebuilt by `overhead scan` and whenever
-- attribution config changes. Reports are pure aggregation over this table.
CREATE TABLE IF NOT EXISTS attributions (
  turn_id  TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  share    REAL NOT NULL,
  cost_usd REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attr_turn ON attributions(turn_id);
CREATE INDEX IF NOT EXISTS idx_attr_path ON attributions(path);

-- Config fingerprint + price table version, so a report can state exactly
-- which parameters produced its numbers.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

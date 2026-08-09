import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Attribution, Session, Turn } from "../types.ts";

const here = dirname(fileURLToPath(import.meta.url));

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  }

  close(): void {
    this.db.close();
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /**
   * Upsert a session and all of its turns/touches. Idempotent — re-scanning
   * the same transcript replaces rather than duplicates, so a session that
   * grew since the last scan is picked up correctly.
   */
  putSession(session: Session): void {
    const db = this.db;
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO sessions(id, source, project_slug, repo_root, git_branch, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           repo_root = excluded.repo_root,
           git_branch = excluded.git_branch,
           started_at = MIN(sessions.started_at, excluded.started_at),
           ended_at = MAX(sessions.ended_at, excluded.ended_at)`,
      ).run(
        session.id,
        session.source,
        session.projectSlug,
        session.repoRoot,
        session.gitBranch,
        session.startedAt,
        session.endedAt,
      );

      // Replacing the session's turns wholesale keeps `seq` contiguous when a
      // transcript is appended to between scans.
      db.prepare("DELETE FROM turns WHERE session_id = ?").run(session.id);

      const insTurn = db.prepare(
        `INSERT INTO turns(id, session_id, seq, ts, model, is_sidechain, sidechain_key,
                           in_tok, cache_w5m, cache_w1h, cache_read, out_tok,
                           web_searches, cost_usd, priced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insTouch = db.prepare(
        "INSERT INTO touches(turn_id, path, tool, tool_name, weight) VALUES (?, ?, ?, ?, ?)",
      );

      for (const t of session.turns) {
        insTurn.run(
          t.id,
          t.sessionId,
          t.seq,
          t.ts,
          t.model,
          t.isSidechain ? 1 : 0,
          t.sidechainKey,
          t.usage.input,
          t.usage.cacheWrite5m,
          t.usage.cacheWrite1h,
          t.usage.cacheRead,
          t.usage.output,
          t.usage.webSearches,
          t.costUsd,
          t.priced ? 1 : 0,
        );
        for (const touch of t.touches) {
          insTouch.run(t.id, touch.path, touch.tool, touch.toolName, touch.weight);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  replaceAttributions(turnIds: string[], rows: Attribution[]): void {
    const db = this.db;
    db.exec("BEGIN");
    try {
      const del = db.prepare("DELETE FROM attributions WHERE turn_id = ?");
      for (const id of turnIds) del.run(id);
      const ins = db.prepare(
        "INSERT INTO attributions(turn_id, path, share, cost_usd) VALUES (?, ?, ?, ?)",
      );
      for (const r of rows) ins.run(r.turnId, r.path, r.share, r.costUsd);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** All turns with their touches, ordered for attribution replay. */
  loadTurnsForAttribution(): Map<string, Turn[]> {
    const turnRows = this.db
      .prepare("SELECT * FROM turns ORDER BY session_id, seq")
      .all() as Record<string, unknown>[];

    const touchRows = this.db
      .prepare("SELECT * FROM touches")
      .all() as Record<string, unknown>[];

    const touchesByTurn = new Map<string, Turn["touches"]>();
    for (const r of touchRows) {
      const id = r.turn_id as string;
      let list = touchesByTurn.get(id);
      if (!list) touchesByTurn.set(id, (list = []));
      list.push({
        path: r.path as string,
        tool: r.tool as Turn["touches"][number]["tool"],
        toolName: r.tool_name as string,
        weight: r.weight as number,
      });
    }

    const bySession = new Map<string, Turn[]>();
    for (const r of turnRows) {
      const sid = r.session_id as string;
      let list = bySession.get(sid);
      if (!list) bySession.set(sid, (list = []));
      list.push({
        id: r.id as string,
        sessionId: sid,
        seq: r.seq as number,
        ts: r.ts as string,
        model: r.model as string,
        isSidechain: !!(r.is_sidechain as number),
        sidechainKey: (r.sidechain_key as string | null) ?? null,
        usage: {
          input: r.in_tok as number,
          cacheWrite5m: r.cache_w5m as number,
          cacheWrite1h: r.cache_w1h as number,
          cacheRead: r.cache_read as number,
          output: r.out_tok as number,
          webSearches: r.web_searches as number,
        },
        costUsd: r.cost_usd as number,
        priced: !!(r.priced as number),
        touches: touchesByTurn.get(r.id as string) ?? [],
      });
    }
    return bySession;
  }
}

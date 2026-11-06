import { DatabaseSync } from "node:sqlite";
import type { PastComment } from "./types.js";

/**
 * Local knowledge base of past review comments (SQLite, zero setup).
 * Indexed by (repo, path) so one instance can serve many repos; the interface is small
 * enough to swap for Postgres + pgvector when the history grows past one machine.
 */
export class CommentStore {
  private db: DatabaseSync;

  constructor(file = ":memory:") {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL, path TEXT NOT NULL, pr INTEGER NOT NULL,
        reviewer TEXT NOT NULL, body TEXT NOT NULL, diff_hunk TEXT NOT NULL,
        line INTEGER, created_at TEXT NOT NULL, url TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comments_file ON comments(repo, path);
      CREATE TABLE IF NOT EXISTS synced_prs (
        repo TEXT NOT NULL, path TEXT NOT NULL, pr INTEGER NOT NULL,
        PRIMARY KEY (repo, path, pr)
      );
    `);
  }

  upsert(comments: PastComment[], prs: number[], repo: string, path: string): void {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO comments (id, repo, path, pr, reviewer, body, diff_hunk, line, created_at, url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const mark = this.db.prepare(`INSERT OR IGNORE INTO synced_prs (repo, path, pr) VALUES (?, ?, ?)`);
    this.db.exec("BEGIN");
    try {
      for (const c of comments) {
        ins.run(c.id, c.repo, c.path, c.prNumber, c.reviewer, c.body, c.diffHunk, c.line, c.createdAt, c.url);
      }
      for (const pr of prs) mark.run(repo, path, pr);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  knownPrs(repo: string, path: string): Set<number> {
    const rows = this.db.prepare(`SELECT pr FROM synced_prs WHERE repo = ? AND path = ?`).all(repo, path) as { pr: number }[];
    return new Set(rows.map((r) => r.pr));
  }

  forFile(repo: string, path: string): PastComment[] {
    const rows = this.db
      .prepare(`SELECT * FROM comments WHERE repo = ? AND path = ? ORDER BY created_at DESC`)
      .all(repo, path) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      repo: r.repo as string,
      path: r.path as string,
      prNumber: r.pr as number,
      reviewer: r.reviewer as string,
      body: r.body as string,
      diffHunk: r.diff_hunk as string,
      line: (r.line as number | null) ?? null,
      createdAt: r.created_at as string,
      url: r.url as string,
    }));
  }

  close(): void {
    this.db.close();
  }
}

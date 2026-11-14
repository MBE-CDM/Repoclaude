import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Stockage applicatif : collections de documents JSON dans SQLite,
 * plus des tables dédiées pour l'audit (requêtables).
 */
export class Store {
  readonly db: Database.Database;

  constructor(dataDir: string, file = 'testhub.db') {
    this.db = new Database(file === ':memory:' ? ':memory:' : path.join(dataDir, file));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id));
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
        environment TEXT, kind TEXT NOT NULL, target TEXT, detail TEXT, outcome TEXT NOT NULL,
        execution_id TEXT);
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
    `);
  }

  list<T>(collection: string): (T & { id: string })[] {
    return this.db.prepare('SELECT id, data FROM docs WHERE collection = ? ORDER BY created_at')
      .all(collection)
      .map((r: any) => ({ ...JSON.parse(r.data), id: r.id }));
  }

  get<T>(collection: string, id: string): (T & { id: string }) | undefined {
    const r: any = this.db.prepare('SELECT data FROM docs WHERE collection = ? AND id = ?').get(collection, id);
    return r ? { ...JSON.parse(r.data), id } : undefined;
  }

  put<T extends object>(collection: string, data: T & { id?: string }): T & { id: string } {
    const id = data.id ?? randomUUID();
    const now = new Date().toISOString();
    const doc = { ...data, id };
    this.db.prepare(`INSERT INTO docs (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .run(collection, id, JSON.stringify(doc), now, now);
    return doc;
  }

  delete(collection: string, id: string): boolean {
    return this.db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(collection, id).changes > 0;
  }
}

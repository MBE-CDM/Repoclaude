import type { Store } from '../core/store.js';
import type { Masker } from './masking.js';

export type AuditKind = 'sql' | 'script' | 'batch' | 'api' | 'ui' | 'file' | 'connection-test' | 'execution' | 'approval' | 'config';

export interface AuditEntry {
  actor: string;
  environment?: string;
  kind: AuditKind;
  target?: string;
  detail?: unknown;
  outcome: 'success' | 'failure' | 'blocked' | 'pending';
  executionId?: string;
}

/** Journal append-only : qui, quand, sur quel environnement, quoi, quel résultat. Le détail est masqué. */
export class AuditLog {
  constructor(private store: Store, private masker: Masker) {}

  record(e: AuditEntry, masker: Masker = this.masker) {
    const detail = e.detail === undefined ? null : JSON.stringify(masker.value(e.detail));
    this.store.db.prepare(`INSERT INTO audit (at, actor, environment, kind, target, detail, outcome, execution_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(new Date().toISOString(), e.actor, e.environment ?? null, e.kind,
      e.target ? masker.text(e.target) : null, detail, e.outcome, e.executionId ?? null);
  }

  query(f: { environment?: string; kind?: string; actor?: string; executionId?: string; limit?: number } = {}) {
    const where: string[] = []; const args: unknown[] = [];
    if (f.environment) { where.push('environment = ?'); args.push(f.environment); }
    if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
    if (f.actor) { where.push('actor = ?'); args.push(f.actor); }
    if (f.executionId) { where.push('execution_id = ?'); args.push(f.executionId); }
    args.push(Math.min(f.limit ?? 200, 2000));
    return this.store.db.prepare(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args).map((r: any) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }
}

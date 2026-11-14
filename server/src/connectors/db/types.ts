import type { DbEngine } from '../../environments/model.js';

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  affected?: number;
  durationMs: number;
}

export interface SchemaColumn { name: string; type: string; nullable?: boolean }
export interface SchemaTable { schema?: string; name: string; type: 'table' | 'view' | 'collection'; columns: SchemaColumn[] }
export interface SchemaInfo { tables: SchemaTable[] }

export type PlaceholderStyle = 'dollar' | 'question' | 'at' | 'colon';

export const PLACEHOLDER: Record<DbEngine, PlaceholderStyle> = {
  postgres: 'dollar', mysql: 'question', mariadb: 'question', sqlite: 'question', db2: 'question',
  mssql: 'at', oracle: 'colon', mongodb: 'question',
};

export function placeholder(style: PlaceholderStyle, index: number): string {
  switch (style) {
    case 'dollar': return `$${index}`;
    case 'question': return '?';
    case 'at': return `@p${index}`;
    case 'colon': return `:p${index}`;
  }
}

/** Session ouverte sur une base. Une même session est réutilisée par toutes les étapes d'un cas (transactions). */
export interface DbSession {
  readonly engine: DbEngine;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  savepoint(name: string): Promise<void>;
  rollbackTo(name: string): Promise<void>;
  schema(): Promise<SchemaInfo>;
  /** Vérification de connexion légère. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function normalizeRow(r: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    o[k] = typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString())
      : v instanceof Date ? v.toISOString()
      : Buffer.isBuffer(v) ? `0x${v.toString('hex').slice(0, 512)}`
      : v;
  }
  return o;
}

export function assertIdentifier(name: string): string {
  if (!/^[A-Za-z_][\w$#]{0,127}(\.[A-Za-z_][\w$#]{0,127})?$/.test(name)) throw new Error(`Identifiant SQL invalide : ${name}`);
  return name;
}

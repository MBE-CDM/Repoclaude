import { JSONPath } from 'jsonpath-plus';
import type { QueryResult } from '../connectors/db/types.js';

export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'notContains' | 'matches' | 'in' | 'exists' | 'notExists';

export interface AssertionResult { assertion: string; ok: boolean; expected?: unknown; actual?: unknown; message?: string }

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return String(a) === String(b);
}

export function compare(actual: unknown, op: Op, expected: unknown): boolean {
  switch (op) {
    case 'eq': return looseEq(actual, expected);
    case 'ne': return !looseEq(actual, expected);
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'contains': return Array.isArray(actual) ? actual.some(x => looseEq(x, expected)) : String(actual ?? '').includes(String(expected));
    case 'notContains': return !compare(actual, 'contains', expected);
    case 'matches': return new RegExp(String(expected)).test(String(actual ?? ''));
    case 'in': return Array.isArray(expected) && expected.some(x => looseEq(actual, x));
    case 'exists': return actual !== undefined && actual !== null;
    case 'notExists': return actual === undefined || actual === null;
  }
}

/* ---------------- Assertions SQL ---------------- */
export type SqlAssertion =
  | { type: 'value'; column?: string; row?: number; op?: Op; value: unknown }
  | { type: 'rowCount'; op?: Op; value: number }
  | { type: 'exists' }
  | { type: 'notExists' }
  | { type: 'reference'; rows: Record<string, unknown>[]; ignoreOrder?: boolean; columns?: string[] }
  | { type: 'range'; column: string; min?: number | string; max?: number | string; allRows?: boolean }
  | { type: 'regex'; column: string; pattern: string; allRows?: boolean };

function cell(r: QueryResult, column: string | undefined, row = 0): unknown {
  const rec = r.rows[row];
  if (!rec) return undefined;
  const col = column ?? r.columns[0] ?? Object.keys(rec)[0];
  if (col in rec) return rec[col];
  const k = Object.keys(rec).find(x => x.toLowerCase() === col.toLowerCase()); // Oracle/DB2 : majuscules
  return k ? rec[k] : undefined;
}

function colValues(r: QueryResult, column: string, all?: boolean): unknown[] {
  return (all === false ? r.rows.slice(0, 1) : r.rows).map((_, i) => cell(r, column, i));
}

export function checkSql(a: SqlAssertion, r: QueryResult): AssertionResult {
  switch (a.type) {
    case 'value': {
      const actual = cell(r, a.column, a.row ?? 0);
      const op = a.op ?? 'eq';
      return { assertion: `valeur ${a.column ?? '(1re colonne)'} ${op} ${JSON.stringify(a.value)}`, ok: compare(actual, op, a.value), expected: a.value, actual };
    }
    case 'rowCount': {
      const op = a.op ?? 'eq';
      return { assertion: `nombre de lignes ${op} ${a.value}`, ok: compare(r.rowCount, op, a.value), expected: a.value, actual: r.rowCount };
    }
    case 'exists': return { assertion: 'au moins une ligne', ok: r.rowCount > 0, actual: r.rowCount };
    case 'notExists': return { assertion: 'aucune ligne', ok: r.rowCount === 0, actual: r.rowCount };
    case 'reference': {
      const cols = a.columns ?? Object.keys(a.rows[0] ?? {});
      const project = (rows: Record<string, unknown>[]) => rows.map(x => cols.map(c => {
        const k = Object.keys(x).find(y => y.toLowerCase() === c.toLowerCase());
        const v = k ? x[k] : undefined;
        return v == null ? null : String(v);
      }));
      let act = project(r.rows), exp = project(a.rows);
      if (a.ignoreOrder !== false) { const s = (m: unknown[][]) => m.map(x => JSON.stringify(x)).sort(); act = s(act) as any; exp = s(exp) as any; }
      const ok = JSON.stringify(act) === JSON.stringify(exp);
      return { assertion: `résultat identique à la référence (${a.rows.length} lignes)`, ok, expected: a.rows, actual: r.rows, message: ok ? undefined : 'Le résultat diffère de la référence' };
    }
    case 'range': {
      const vals = colValues(r, a.column, a.allRows);
      const bad = vals.filter(v => (a.min !== undefined && !(compare(v, 'gte', a.min))) || (a.max !== undefined && !compare(v, 'lte', a.max)));
      return { assertion: `${a.column} ∈ [${a.min ?? '-∞'} ; ${a.max ?? '+∞'}]`, ok: vals.length > 0 && bad.length === 0, expected: { min: a.min, max: a.max }, actual: bad.length ? bad.slice(0, 10) : vals.slice(0, 10) };
    }
    case 'regex': {
      const re = new RegExp(a.pattern);
      const vals = colValues(r, a.column, a.allRows);
      const bad = vals.filter(v => !re.test(String(v ?? '')));
      return { assertion: `${a.column} correspond à /${a.pattern}/`, ok: vals.length > 0 && bad.length === 0, expected: a.pattern, actual: bad.length ? bad.slice(0, 10) : vals.slice(0, 10) };
    }
  }
}

/* ---------------- Diff avant / après ---------------- */
export interface RowsDiff { added: Record<string, unknown>[]; removed: Record<string, unknown>[]; changed: { key: unknown; before: Record<string, unknown>; after: Record<string, unknown>; columns: string[] }[] }

export function diffRows(before: Record<string, unknown>[], after: Record<string, unknown>[], key: string[]): RowsDiff {
  const k = (r: Record<string, unknown>) => JSON.stringify(key.map(c => r[c] ?? r[Object.keys(r).find(x => x.toLowerCase() === c.toLowerCase()) ?? c]));
  const b = new Map(before.map(r => [k(r), r])), a = new Map(after.map(r => [k(r), r]));
  const d: RowsDiff = { added: [], removed: [], changed: [] };
  for (const [id, r] of a) if (!b.has(id)) d.added.push(r);
  for (const [id, r] of b) {
    const n = a.get(id);
    if (!n) { d.removed.push(r); continue; }
    const cols = [...new Set([...Object.keys(r), ...Object.keys(n)])].filter(c => !looseEq(r[c], n[c]));
    if (cols.length) d.changed.push({ key: JSON.parse(id), before: r, after: n, columns: cols });
  }
  return d;
}

export interface DiffExpectation { added?: number; removed?: number; changed?: number; changedColumns?: string[] }

export function checkDiff(d: RowsDiff, e: DiffExpectation): AssertionResult[] {
  const out: AssertionResult[] = [];
  for (const k of ['added', 'removed', 'changed'] as const) {
    if (e[k] !== undefined) out.push({ assertion: `diff : lignes ${k === 'added' ? 'ajoutées' : k === 'removed' ? 'supprimées' : 'modifiées'} = ${e[k]}`, ok: d[k].length === e[k], expected: e[k], actual: d[k].length });
  }
  if (e.changedColumns) {
    const actual = [...new Set(d.changed.flatMap(c => c.columns))].sort();
    const exp = [...e.changedColumns].sort();
    out.push({ assertion: `diff : colonnes modifiées = ${exp.join(', ')}`, ok: JSON.stringify(actual.map(x => x.toLowerCase())) === JSON.stringify(exp.map(x => x.toLowerCase())), expected: exp, actual });
  }
  return out;
}

/* ---------------- Assertions API ---------------- */
export type ApiAssertion =
  | { type: 'status'; value?: number; in?: number[] }
  | { type: 'jsonpath'; path: string; op?: Op; value?: unknown }
  | { type: 'responseTime'; maxMs: number }
  | { type: 'header'; name: string; op?: Op; value?: unknown }
  | { type: 'body'; op?: Op; value: string };

export interface ApiResponseView { status: number; headers: Record<string, string>; bodyText: string; json?: unknown; durationMs: number }

export function jsonPathValue(json: unknown, path: string): unknown {
  const res = JSONPath({ path, json: json as any, wrap: true });
  return Array.isArray(res) ? (res.length === 1 ? res[0] : res.length === 0 ? undefined : res) : res;
}

export function checkApi(a: ApiAssertion, r: ApiResponseView): AssertionResult {
  switch (a.type) {
    case 'status': {
      const ok = a.in ? a.in.includes(r.status) : r.status === (a.value ?? 200);
      return { assertion: `code HTTP ${a.in ? 'dans ' + a.in.join('/') : '= ' + (a.value ?? 200)}`, ok, expected: a.in ?? a.value ?? 200, actual: r.status };
    }
    case 'jsonpath': {
      const actual = r.json === undefined ? undefined : jsonPathValue(r.json, a.path);
      const op = a.op ?? (a.value === undefined ? 'exists' : 'eq');
      return { assertion: `${a.path} ${op}${a.value !== undefined ? ' ' + JSON.stringify(a.value) : ''}`, ok: compare(actual, op, a.value), expected: a.value, actual };
    }
    case 'responseTime':
      return { assertion: `temps de réponse ≤ ${a.maxMs} ms`, ok: r.durationMs <= a.maxMs, expected: a.maxMs, actual: r.durationMs };
    case 'header': {
      const actual = r.headers[a.name.toLowerCase()];
      const op = a.op ?? (a.value === undefined ? 'exists' : 'eq');
      return { assertion: `en-tête ${a.name} ${op} ${a.value ?? ''}`.trim(), ok: compare(actual, op, a.value), expected: a.value, actual };
    }
    case 'body': {
      const op = a.op ?? 'contains';
      return { assertion: `corps ${op} ${JSON.stringify(a.value)}`, ok: compare(r.bodyText, op, a.value), expected: a.value, actual: r.bodyText.slice(0, 500) };
    }
  }
}

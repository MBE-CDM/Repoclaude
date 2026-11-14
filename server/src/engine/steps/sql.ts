import type { ExecContext } from '../context.js';
import type { IntegrityCheck, SqlStep } from '../model.js';
import { renderMongo, renderSql, renderDeep } from '../template.js';
import { checkDiff, checkSql, compare, diffRows, type AssertionResult } from '../assertions.js';
import { assertIdentifier, PLACEHOLDER, placeholder, type QueryResult } from '../../connectors/db/types.js';
import { splitStatements } from '../../connectors/db/sqlGuard.js';
import type { GuardedDb } from '../../connectors/db/index.js';
import type { DbEngine } from '../../environments/model.js';

function prepare(ctx: ExecContext, db: GuardedDb, query: string) {
  if (db.config.engine === 'mongodb') return { sql: renderMongo(query, ctx.vars), params: [] as unknown[] };
  return renderSql(query, ctx.vars, PLACEHOLDER[db.config.engine]);
}

/** Exécute une requête gardée, l'audite et joint le résultat (masqué) comme preuve. */
export async function runQuery(ctx: ExecContext, database: string, query: string, opts: { allowDestructive?: boolean; label?: string; evidenceRows?: number } = {}): Promise<QueryResult> {
  const db = await ctx.db(database);
  const { sql, params } = prepare(ctx, db, query);
  ctx.log(`[${database}] ${sql.replace(/\s+/g, ' ').slice(0, 500)}${params.length ? '  -- paramètres : ' + JSON.stringify(params) : ''}`);
  try {
    const r = await db.query(sql, params, { allowDestructive: opts.allowDestructive });
    ctx.log(`→ ${r.affected !== undefined ? r.affected + ' ligne(s) affectée(s)' : r.rowCount + ' ligne(s)'} en ${r.durationMs} ms`);
    ctx.audit({ kind: 'sql', target: `${database}: ${sql.slice(0, 1000)}`, outcome: 'success', detail: { params, rowCount: r.rowCount, affected: r.affected, durationMs: r.durationMs } });
    const max = opts.evidenceRows ?? 200;
    ctx.addEvidence({ type: 'table', name: opts.label ?? `résultat ${database}`, data: { query: sql, params, columns: r.columns, rows: r.rows.slice(0, max), rowCount: r.rowCount, truncated: r.rowCount > max, affected: r.affected } });
    return r;
  } catch (e: any) {
    ctx.audit({ kind: 'sql', target: `${database}: ${sql.slice(0, 1000)}`, outcome: e.name === 'SqlGuardError' || e.constructor?.name === 'SqlGuardError' ? 'blocked' : 'failure', detail: { params, error: e.message } });
    throw e;
  }
}

/** Script multi-instructions (setup / teardown), chaque instruction est paramétrée et contrôlée. */
export async function runScript(ctx: ExecContext, database: string, script: string, allowDestructive?: boolean) {
  const db = await ctx.db(database);
  if (db.config.engine === 'mongodb') {
    const r = await db.script(renderMongo(script, ctx.vars), { allowDestructive });
    ctx.audit({ kind: 'sql', target: `${database}: script MongoDB`, outcome: 'success', detail: { statements: r.statements } });
    return r.statements;
  }
  const stmts = splitStatements(script).map(s => renderSql(s, ctx.vars, PLACEHOLDER[db.config.engine]));
  // Contrôle global d'abord (aucune exécution partielle si une instruction est interdite).
  const { analyzeStatement, enforce } = await import('../../connectors/db/sqlGuard.js');
  for (const s of stmts) {
    try { enforce(analyzeStatement(s.sql), db.policy(allowDestructive)); }
    catch (e: any) { ctx.audit({ kind: 'sql', target: `${database}: ${s.sql.slice(0, 1000)}`, outcome: 'blocked', detail: { error: e.message } }); throw e; }
  }
  for (const s of stmts) {
    ctx.log(`[${database}] ${s.sql.replace(/\s+/g, ' ').slice(0, 300)}`);
    await db.session.query(s.sql, s.params);
  }
  ctx.audit({ kind: 'sql', target: `${database}: script (${stmts.length} instructions)`, outcome: 'success', detail: { statements: stmts.map(s => s.sql.slice(0, 300)) } });
  ctx.log(`→ script exécuté (${stmts.length} instructions)`);
  return stmts.length;
}

function integrityQuery(engine: DbEngine, c: IntegrityCheck): { label: string; sql: string } {
  const id = assertIdentifier;
  const where = (w?: string) => (w ? ` AND (${w})` : '');
  if ('where' in c && c.where && /;/.test(c.where)) throw new Error('Clause where d\'intégrité invalide');
  switch (c.kind) {
    case 'foreignKey':
      return {
        label: `clé étrangère ${c.table}.${c.column} → ${c.refTable}.${c.refColumn}`,
        sql: `SELECT t.${id(c.column)} AS valeur_orpheline, COUNT(*) AS occurrences FROM ${id(c.table)} t LEFT JOIN ${id(c.refTable)} r ON r.${id(c.refColumn)} = t.${id(c.column)} WHERE t.${id(c.column)} IS NOT NULL AND r.${id(c.refColumn)} IS NULL${where(c.where)} GROUP BY t.${id(c.column)}`,
      };
    case 'duplicates': {
      const cols = c.columns.map(id).join(', ');
      return { label: `doublons ${c.table} (${c.columns.join(', ')})`, sql: `SELECT ${cols}, COUNT(*) AS occurrences FROM ${id(c.table)} WHERE 1=1${where(c.where)} GROUP BY ${cols} HAVING COUNT(*) > 1` };
    }
    case 'notNull': {
      const cond = c.columns.map(x => `${id(x)} IS NULL`).join(' OR ');
      return { label: `champs obligatoires ${c.table} (${c.columns.join(', ')})`, sql: `SELECT * FROM ${id(c.table)} WHERE (${cond})${where(c.where)}` };
    }
    case 'query':
      return { label: c.name ?? 'contrôle personnalisé (0 ligne attendue)', sql: c.sql };
    case 'consistency':
      return { label: c.name ?? 'cohérence entre tables', sql: '' };
  }
  void engine;
}

export async function runSql(ctx: ExecContext, step: SqlStep): Promise<{ assertions: AssertionResult[]; result?: QueryResult }> {
  const mode = step.mode ?? 'query';
  const assertions: AssertionResult[] = [];
  const db = await ctx.db(step.database);
  switch (mode) {
    case 'query': {
      if (!step.query) throw new Error('Contrôle SQL : requête obligatoire');
      const r = await runQuery(ctx, step.database, step.query, { allowDestructive: step.allowDestructive, evidenceRows: step.evidenceRows });
      for (const a of step.assertions ?? []) assertions.push(checkSql(renderDeep(a, ctx.vars), r));
      return { assertions, result: r };
    }
    case 'script': {
      if (!step.query) throw new Error('Script SQL : contenu obligatoire');
      await runScript(ctx, step.database, step.query, step.allowDestructive);
      return { assertions };
    }
    case 'snapshot': {
      if (!step.query || !step.snapshot) throw new Error('Snapshot : query et snapshot (nom) obligatoires');
      const { sql, params } = prepare(ctx, db, step.query);
      const r = await runQuery(ctx, step.database, step.query, { label: `snapshot « ${step.snapshot} »`, evidenceRows: step.evidenceRows });
      ctx.snapshots.set(step.snapshot, { query: sql, params, database: step.database, rows: r.rows });
      ctx.log(`Snapshot « ${step.snapshot} » : ${r.rowCount} ligne(s) mémorisée(s)`);
      return { assertions, result: r };
    }
    case 'diff': {
      if (!step.diff) throw new Error('Diff : champ diff obligatoire');
      const snap = ctx.snapshots.get(step.diff.snapshot);
      if (!snap) throw new Error(`Snapshot « ${step.diff.snapshot} » inconnu (étape snapshot manquante ?)`);
      const sdb = await ctx.db(snap.database);
      const after = await sdb.query(snap.query, snap.params);
      ctx.audit({ kind: 'sql', target: `${snap.database}: ${snap.query.slice(0, 1000)}`, outcome: 'success', detail: { diff: step.diff.snapshot } });
      const d = diffRows(snap.rows, after.rows, step.diff.key);
      ctx.log(`Diff « ${step.diff.snapshot} » : +${d.added.length} / -${d.removed.length} / ~${d.changed.length}`);
      ctx.addEvidence({ type: 'diff', name: `diff avant/après « ${step.diff.snapshot} »`, data: d });
      assertions.push(...checkDiff(d, step.diff.expect));
      return { assertions, result: after };
    }
    case 'integrity': {
      for (const c of step.integrity ?? []) {
        if (c.kind === 'consistency') {
          const l = await runQuery(ctx, step.database, c.left, { label: `${c.name ?? 'cohérence'} (gauche)` });
          const r = await runQuery(ctx, step.database, c.right, { label: `${c.name ?? 'cohérence'} (droite)` });
          const lv = l.rows[0] ? Object.values(l.rows[0])[0] : undefined, rv = r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
          assertions.push({ assertion: `${c.name ?? 'cohérence'} : gauche ${c.op ?? 'eq'} droite`, ok: compare(lv, c.op ?? 'eq', rv), expected: rv, actual: lv });
          continue;
        }
        const q = integrityQuery(db.config.engine, c);
        const r = await runQuery(ctx, step.database, q.sql, { label: q.label, evidenceRows: 50 });
        assertions.push({ assertion: `intégrité : ${q.label}`, ok: r.rowCount === 0, expected: 0, actual: r.rowCount, message: r.rowCount ? `${r.rowCount} anomalie(s)` : undefined });
      }
      return { assertions };
    }
    case 'savepoint': case 'rollbackTo': {
      const name = step.savepoint ?? 'testhub_sp';
      if (mode === 'savepoint') await db.session.savepoint(name); else await db.session.rollbackTo(name);
      ctx.log(`${mode === 'savepoint' ? 'Point de restauration créé' : 'Retour au point de restauration'} : ${name}`);
      ctx.audit({ kind: 'sql', target: `${step.database}: ${mode} ${name}`, outcome: 'success' });
      return { assertions };
    }
    case 'procedure': {
      if (!step.procedure) throw new Error('Procédure : champ procedure obligatoire');
      const name = assertIdentifier(step.procedure.name);
      const args = renderDeep(step.procedure.args ?? [], ctx.vars);
      const style = PLACEHOLDER[db.config.engine];
      const ph = args.map((_, i) => placeholder(style, i + 1)).join(', ');
      const sql = db.config.engine === 'mssql' ? `EXEC ${name} ${ph}`
        : db.config.engine === 'oracle' ? `BEGIN ${name}(${ph}); END;`
        : `CALL ${name}(${ph})`;
      ctx.log(`[${step.database}] ${sql} ${JSON.stringify(args)}`);
      try {
        const r = await db.query(sql, args, { allowDestructive: step.allowDestructive });
        ctx.audit({ kind: 'sql', target: `${step.database}: ${sql}`, outcome: 'success', detail: { args } });
        ctx.addEvidence({ type: 'table', name: `procédure ${name}`, data: { query: sql, params: args, columns: r.columns, rows: r.rows.slice(0, 200), rowCount: r.rowCount } });
        for (const a of step.assertions ?? []) assertions.push(checkSql(renderDeep(a, ctx.vars), r));
        return { assertions, result: r };
      } catch (e: any) {
        ctx.audit({ kind: 'sql', target: `${step.database}: ${sql}`, outcome: 'failure', detail: { args, error: e.message } });
        throw e;
      }
    }
  }
}

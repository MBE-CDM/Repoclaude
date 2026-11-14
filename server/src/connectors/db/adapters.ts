import type { DbConnection } from '../../environments/model.js';
import { normalizeRow, type DbSession, type QueryResult, type SchemaInfo, type SchemaTable } from './types.js';

type Conn = DbConnection<string> & { host: string; port: number };

const ms = (s: number) => Date.now() - s;

function groupColumns(rows: any[], keys: { schema?: string; table: string; column: string; type: string; nullable?: string; kind?: string }): SchemaTable[] {
  const map = new Map<string, SchemaTable>();
  for (const r of rows) {
    const schema = keys.schema ? r[keys.schema] : undefined;
    const name = r[keys.table];
    const id = `${schema ?? ''}.${name}`;
    let t = map.get(id);
    if (!t) {
      const kind = keys.kind ? String(r[keys.kind] ?? '').toUpperCase() : '';
      t = { schema, name, type: kind.includes('VIEW') || kind === 'V' ? 'view' : 'table', columns: [] };
      map.set(id, t);
    }
    if (r[keys.column]) {
      const nv = keys.nullable ? String(r[keys.nullable]).toUpperCase() : undefined;
      t.columns.push({ name: r[keys.column], type: String(r[keys.type] ?? ''), nullable: nv === undefined ? undefined : ['YES', 'Y', '1', 'TRUE'].includes(nv) });
    }
  }
  return [...map.values()];
}

/* ---------------- PostgreSQL ---------------- */
export async function postgres(c: Conn): Promise<DbSession> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    host: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
    ssl: c.ssl?.enabled ? { rejectUnauthorized: c.ssl.rejectUnauthorized ?? true, ca: c.ssl.ca } : undefined,
    connectionTimeoutMillis: 15000, statement_timeout: Number(c.options?.statementTimeoutMs ?? 120000),
  } as any);
  await client.connect();
  if (c.schema) await client.query(`SET search_path TO ${pgIdent(c.schema)}`);
  if (c.readOnly !== false) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  const q = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const s = Date.now();
    const r = await client.query({ text: sql, values: params as any[] });
    const rows = (r.rows ?? []).map(normalizeRow);
    return { columns: r.fields?.map(f => f.name) ?? [], rows, rowCount: rows.length, affected: r.command === 'SELECT' ? undefined : r.rowCount ?? undefined, durationMs: ms(s) };
  };
  return {
    engine: 'postgres', query: q,
    begin: async () => { await q('BEGIN'); }, commit: async () => { await q('COMMIT'); }, rollback: async () => { await q('ROLLBACK'); },
    savepoint: async n => { await q(`SAVEPOINT ${pgIdent(n)}`); }, rollbackTo: async n => { await q(`ROLLBACK TO SAVEPOINT ${pgIdent(n)}`); },
    ping: async () => { await q('SELECT 1'); },
    schema: async () => {
      const r = await q(`SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable
        FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema NOT IN ('pg_catalog','information_schema') ${c.schema ? 'AND c.table_schema = $1' : ''}
        ORDER BY c.table_schema, c.table_name, c.ordinal_position`, c.schema ? [c.schema] : []);
      return { tables: groupColumns(r.rows, { schema: 'table_schema', table: 'table_name', column: 'column_name', type: 'data_type', nullable: 'is_nullable', kind: 'table_type' }) };
    },
    close: async () => { await client.end(); },
  };
}
const pgIdent = (s: string) => s.split('.').map(p => '"' + p.replace(/"/g, '""') + '"').join('.');

/* ---------------- MySQL / MariaDB ---------------- */
export async function mysql(c: Conn): Promise<DbSession> {
  const m = await import('mysql2/promise');
  const conn = await m.createConnection({
    host: c.host, port: c.port, database: c.schema ?? c.database, user: c.user, password: c.password,
    ssl: c.ssl?.enabled ? { rejectUnauthorized: c.ssl.rejectUnauthorized ?? true, ca: c.ssl.ca } : undefined,
    connectTimeout: 15000, multipleStatements: false, dateStrings: true,
  });
  if (c.readOnly !== false) await conn.query('SET SESSION TRANSACTION READ ONLY');
  const q = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const s = Date.now();
    const [res, fields] = await conn.query(sql, params);
    if (Array.isArray(res)) {
      const rows = (res as any[]).map(normalizeRow);
      return { columns: (fields as any[] | undefined)?.map(f => f.name) ?? Object.keys(rows[0] ?? {}), rows, rowCount: rows.length, durationMs: ms(s) };
    }
    return { columns: [], rows: [], rowCount: 0, affected: (res as any).affectedRows, durationMs: ms(s) };
  };
  return {
    engine: c.engine, query: q,
    begin: async () => { await q('START TRANSACTION'); }, commit: async () => { await q('COMMIT'); }, rollback: async () => { await q('ROLLBACK'); },
    savepoint: async n => { await q(`SAVEPOINT \`${n.replace(/`/g, '')}\``); }, rollbackTo: async n => { await q(`ROLLBACK TO SAVEPOINT \`${n.replace(/`/g, '')}\``); },
    ping: async () => { await conn.ping(); },
    schema: async () => {
      const r = await q(`SELECT c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE
        FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = DATABASE() ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`);
      return { tables: groupColumns(r.rows, { schema: 'TABLE_SCHEMA', table: 'TABLE_NAME', column: 'COLUMN_NAME', type: 'COLUMN_TYPE', nullable: 'IS_NULLABLE', kind: 'TABLE_TYPE' }) };
    },
    close: async () => { await conn.end(); },
  };
}

/* ---------------- SQL Server ---------------- */
export async function mssql(c: Conn): Promise<DbSession> {
  const { default: sql } = await import('mssql');
  const pool = new sql.ConnectionPool({
    server: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
    pool: { min: 1, max: 1 }, // une seule connexion physique : transactions/savepoints cohérents
    options: {
      encrypt: !!c.ssl?.enabled, trustServerCertificate: c.ssl?.enabled ? c.ssl.rejectUnauthorized === false : true,
      readOnlyIntent: c.readOnly !== false,
    } as any,
    connectionTimeout: 15000, requestTimeout: Number(c.options?.statementTimeoutMs ?? 120000),
  });
  await pool.connect();
  // Évite d'attendre indéfiniment un verrou posé par une autre session (ex. cas en rollback transactionnel).
  await pool.request().batch(`SET LOCK_TIMEOUT ${Math.max(0, Number(c.options?.lockTimeoutMs ?? 30000))}`);
  // Transactions via l'objet Transaction du pilote (BEGIN TRANSACTION brut est refusé dans sp_executesql).
  let tx: InstanceType<typeof sql.Transaction> | undefined;
  const req = () => (tx ? new sql.Request(tx) : pool.request());
  const q = async (text: string, params: unknown[] = []): Promise<QueryResult> => {
    const s = Date.now();
    const r0 = req();
    params.forEach((v, i) => r0.input(`p${i + 1}`, v as any));
    const r = params.length ? await r0.query(text) : await r0.batch(text);
    const rows = (r.recordset ?? []).map(normalizeRow);
    const columns = r.recordset?.columns ? Object.keys(r.recordset.columns) : Object.keys(rows[0] ?? {});
    return { columns, rows, rowCount: rows.length, affected: r.recordset ? undefined : r.rowsAffected?.reduce((a, b) => a + b, 0), durationMs: ms(s) };
  };
  const id = (n: string) => n.replace(/[^\w]/g, '').slice(0, 32);
  return {
    engine: 'mssql', query: q,
    begin: async () => { tx = new sql.Transaction(pool); await tx.begin(); },
    commit: async () => { await tx?.commit(); tx = undefined; },
    rollback: async () => { if (tx) { await tx.rollback().catch(() => {}); tx = undefined; } },
    savepoint: async n => { await req().batch(`SAVE TRANSACTION ${id(n)}`); }, rollbackTo: async n => { await req().batch(`ROLLBACK TRANSACTION ${id(n)}`); },
    ping: async () => { await q('SELECT 1 AS ok'); },
    schema: async () => {
      const r = await q(`SELECT c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        ${c.schema ? 'WHERE c.TABLE_SCHEMA = @p1' : ''} ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`, c.schema ? [c.schema] : []);
      return { tables: groupColumns(r.rows, { schema: 'TABLE_SCHEMA', table: 'TABLE_NAME', column: 'COLUMN_NAME', type: 'DATA_TYPE', nullable: 'IS_NULLABLE', kind: 'TABLE_TYPE' }) };
    },
    close: async () => { if (tx) await tx.rollback().catch(() => {}); await pool.close(); },
  };
}

/* ---------------- Oracle (mode thin, sans Instant Client) ---------------- */
export async function oracle(c: Conn): Promise<DbSession> {
  const { default: oracledb } = await import('oracledb');
  const conn = await oracledb.getConnection({
    user: c.user, password: c.password,
    connectString: c.connectString ?? `${c.ssl?.enabled ? 'tcps://' : ''}${c.host}:${c.port}/${c.database}`,
  });
  if (c.schema) await conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${c.schema.replace(/[^\w$#]/g, '')}`);
  let inTx = false;
  const q = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const s = Date.now();
    const r = await conn.execute(sql, params as any[], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: !inTx });
    const rows = ((r.rows ?? []) as any[]).map(normalizeRow);
    return { columns: r.metaData?.map(m => m.name) ?? [], rows, rowCount: rows.length, affected: r.rows ? undefined : r.rowsAffected, durationMs: ms(s) };
  };
  const id = (n: string) => n.replace(/[^\w]/g, '').slice(0, 30);
  return {
    engine: 'oracle', query: q,
    begin: async () => { inTx = true; }, commit: async () => { await conn.commit(); inTx = false; }, rollback: async () => { await conn.rollback(); inTx = false; },
    savepoint: async n => { await q(`SAVEPOINT ${id(n)}`); }, rollbackTo: async n => { await q(`ROLLBACK TO SAVEPOINT ${id(n)}`); },
    ping: async () => { await conn.ping(); },
    schema: async () => {
      const r = await q(`SELECT c.OWNER, c.TABLE_NAME, o.OBJECT_TYPE, c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE
        FROM ALL_TAB_COLUMNS c JOIN ALL_OBJECTS o ON o.OWNER = c.OWNER AND o.OBJECT_NAME = c.TABLE_NAME AND o.OBJECT_TYPE IN ('TABLE','VIEW')
        WHERE c.OWNER = :p1 ORDER BY c.TABLE_NAME, c.COLUMN_ID`, [(c.schema ?? c.user ?? '').toUpperCase()]);
      return { tables: groupColumns(r.rows, { schema: 'OWNER', table: 'TABLE_NAME', column: 'COLUMN_NAME', type: 'DATA_TYPE', nullable: 'NULLABLE', kind: 'OBJECT_TYPE' }) };
    },
    close: async () => { if (inTx) await conn.rollback(); await conn.close(); },
  };
}

/* ---------------- SQLite ---------------- */
export async function sqlite(c: DbConnection<string>): Promise<DbSession> {
  const { default: Database } = await import('better-sqlite3');
  if (!c.file) throw new Error('SQLite : chemin du fichier (file) obligatoire');
  const db = new Database(c.file, { readonly: c.readOnly !== false, fileMustExist: c.readOnly !== false });
  const q = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const s = Date.now();
    const st = db.prepare(sql);
    if (st.reader) {
      const rows = (st.all(...(params as any[])) as any[]).map(normalizeRow);
      return { columns: st.columns().map(x => x.name), rows, rowCount: rows.length, durationMs: ms(s) };
    }
    const r = st.run(...(params as any[]));
    return { columns: [], rows: [], rowCount: 0, affected: r.changes, durationMs: ms(s) };
  };
  const id = (n: string) => '"' + n.replace(/"/g, '') + '"';
  return {
    engine: 'sqlite', query: q,
    begin: async () => { db.exec('BEGIN'); }, commit: async () => { db.exec('COMMIT'); }, rollback: async () => { if (db.inTransaction) db.exec('ROLLBACK'); },
    savepoint: async n => { db.exec(`SAVEPOINT ${id(n)}`); }, rollbackTo: async n => { db.exec(`ROLLBACK TO SAVEPOINT ${id(n)}`); },
    ping: async () => { db.prepare('SELECT 1').get(); },
    schema: async () => {
      const objs = db.prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as any[];
      return {
        tables: objs.map(o => ({
          name: o.name, type: o.type,
          columns: (db.prepare(`SELECT name, type, "notnull" AS nn FROM pragma_table_info(?)`).all(o.name) as any[])
            .map(col => ({ name: col.name, type: col.type, nullable: !col.nn })),
        })),
      };
    },
    close: async () => { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); },
  };
}

/* ---------------- DB2 (module natif ibm_db, optionnel) ---------------- */
export async function db2(c: Conn): Promise<DbSession> {
  let ibm: any;
  try { ibm = (await import('ibm_db' as string)).default; } catch (e: any) {
    throw new Error(`Connecteur DB2 indisponible : le module natif ibm_db n'est pas chargé (${e.message.split('\n')[0]}). Installez le clidriver IBM puis « npm rebuild ibm_db ».`);
  }
  const cs = `DATABASE=${c.database};HOSTNAME=${c.host};PORT=${c.port};PROTOCOL=TCPIP;UID=${c.user};PWD=${c.password};${c.ssl?.enabled ? 'Security=SSL;' : ''}${c.schema ? `CurrentSchema=${c.schema};` : ''}`;
  const conn = await ibm.open(cs);
  const q = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const s = Date.now();
    const rows = ((await conn.query(sql, params)) ?? []).map(normalizeRow);
    return { columns: Object.keys(rows[0] ?? {}), rows, rowCount: rows.length, durationMs: ms(s) };
  };
  const id = (n: string) => n.replace(/[^\w]/g, '').slice(0, 30);
  return {
    engine: 'db2', query: q,
    begin: async () => { await conn.beginTransaction(); }, commit: async () => { await conn.commitTransaction(); }, rollback: async () => { await conn.rollbackTransaction(); },
    savepoint: async n => { await q(`SAVEPOINT ${id(n)} ON ROLLBACK RETAIN CURSORS`); }, rollbackTo: async n => { await q(`ROLLBACK TO SAVEPOINT ${id(n)}`); },
    ping: async () => { await q('SELECT 1 FROM SYSIBM.SYSDUMMY1'); },
    schema: async () => {
      const r = await q(`SELECT c.TABSCHEMA, c.TABNAME, t.TYPE, c.COLNAME, c.TYPENAME, c.NULLS FROM SYSCAT.COLUMNS c
        JOIN SYSCAT.TABLES t ON t.TABSCHEMA = c.TABSCHEMA AND t.TABNAME = c.TABNAME WHERE c.TABSCHEMA = ? ORDER BY c.TABNAME, c.COLNO`, [(c.schema ?? c.user ?? '').toUpperCase()]);
      return { tables: groupColumns(r.rows, { schema: 'TABSCHEMA', table: 'TABNAME', column: 'COLNAME', type: 'TYPENAME', nullable: 'NULLS', kind: 'TYPE' }) };
    },
    close: async () => { await conn.close(); },
  };
}

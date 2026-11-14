/**
 * Tests d'intégration sur de vrais moteurs (conteneurs Docker, cf. scripts/it-up.sh).
 * Activés avec TESTHUB_IT=1 ; chaque moteur est ignoré si son conteneur ne répond pas.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execSync } from 'node:child_process';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/connectors/db/index.js';

const IT = process.env.TESTHUB_IT === '1';
const H = process.env.TESTHUB_IT_HOST ?? '127.0.0.1';

const ENGINES: Record<string, any> = {
  postgres: { engine: 'postgres', host: H, port: 15432, database: 'postgres', schema: 'public', user: 'postgres', password: 'Pg_pass1' },
  mariadb: { engine: 'mariadb', host: H, port: 13306, database: 'boutique', user: 'root', password: 'Maria_pass1' },
  mssql: { engine: 'mssql', host: H, port: 11433, database: 'master', user: 'sa', password: 'Mssql_pass1!' },
  oracle: { engine: 'oracle', host: H, port: 11521, database: 'FREEPDB1', user: 'boutique', password: 'Ora_pass1' },
};

const PROC: Record<string, string> = {
  postgres: "CREATE PROCEDURE valider(p_id INT) LANGUAGE SQL AS $$ UPDATE commande SET statut = 'VALIDEE' WHERE id = p_id $$",
  mariadb: "CREATE PROCEDURE valider(IN p_id INT) UPDATE commande SET statut = 'VALIDEE' WHERE id = p_id",
  mssql: "CREATE PROCEDURE valider @p_id INT AS UPDATE commande SET statut = 'VALIDEE' WHERE id = @p_id",
  oracle: "CREATE OR REPLACE PROCEDURE valider(p_id IN NUMBER) AS\nBEGIN\n  UPDATE commande SET statut = 'VALIDEE' WHERE id = p_id;\nEND;\n/",
};
const DROP_PROC: Record<string, string> = {
  postgres: 'DROP PROCEDURE IF EXISTS valider', mariadb: 'DROP PROCEDURE IF EXISTS valider', mssql: "IF OBJECT_ID('valider') IS NOT NULL DROP PROCEDURE valider",
  oracle: "BEGIN EXECUTE IMMEDIATE 'DROP PROCEDURE valider'; EXCEPTION WHEN OTHERS THEN NULL; END;\n/",
};
const dropTable = (e: string, t: string) => e === 'oracle' ? `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${t}'; EXCEPTION WHEN OTHERS THEN NULL; END;\n/`
  : e === 'mssql' ? `IF OBJECT_ID('${t}') IS NOT NULL DROP TABLE ${t}` : `DROP TABLE IF EXISTS ${t}`;

function reachable(port: number, host = H): Promise<boolean> {
  return new Promise(r => { const s = net.connect({ host, port }); s.setTimeout(2000); s.once('connect', () => { s.end(); r(true); }); s.once('error', () => r(false)); s.once('timeout', () => { s.destroy(); r(false); }); });
}

async function ready(name: string, cfg: any): Promise<boolean> {
  if (!(await reachable(cfg.port))) return false;
  for (let i = 0; i < 24; i++) {
    try { const d = await openDb({ name: 'x', kind: 'DEV', accounts: [], databases: [{ name: 'x', ...cfg }], servers: [], agents: [], schedulers: [], fileShares: [] } as any, 'x'); await d.session.ping(); await d.close(); return true; }
    catch { await new Promise(r => setTimeout(r, 5000)); }
  }
  console.warn(`${name} injoignable, ignoré`);
  return false;
}

let tmp: string, ctx: Awaited<ReturnType<typeof buildApp>>;
const auth = { authorization: 'Bearer it-admin' };
const call = async (method: string, url: string, payload?: any) => {
  const r = await ctx.app.inject({ method: method as any, url, payload, headers: auth });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
};

beforeAll(async () => {
  if (!IT) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testhub-it-'));
  ctx = await buildApp({ dataDir: tmp, bootstrapAdminToken: 'it-admin', webDist: path.join(tmp, 'none') });
});
afterAll(async () => { await ctx?.app.close(); });

describe.skipIf(!IT)('moteurs SQL réels', () => {
  for (const [name, cfg] of Object.entries(ENGINES)) {
    it(`${name} : scénario complet (paramètres, procédure, savepoint, diff, intégrité, rollback, lecture seule)`, async () => {
      if (!(await ready(name, cfg))) return;
      const env = await call('POST', '/api/environments', {
        name: `IT-${name}`, kind: 'INT',
        databases: [{ name: 'ro', ...cfg }, { name: 'rw', ...cfg, readOnly: false, allowDestructive: true }],
      });
      expect(env.status).toBe(200);
      const envId = env.body.id;
      const setup = [
        { database: 'rw', script: DROP_PROC[name], allowDestructive: true },
        { database: 'rw', script: dropTable(name, 'commande'), allowDestructive: true },
        { database: 'rw', script: dropTable(name, 'client'), allowDestructive: true },
        { database: 'rw', script: 'CREATE TABLE client (id INT PRIMARY KEY, nom VARCHAR(50) NOT NULL, email VARCHAR(100));\nCREATE TABLE commande (id INT PRIMARY KEY, client_id INT, statut VARCHAR(20) NOT NULL)' },
        { database: 'rw', script: "INSERT INTO client VALUES (1, 'Dupont', 'd@x.fr');\nINSERT INTO client VALUES (2, 'Martin', NULL);\nINSERT INTO commande VALUES (10, 1, 'CREEE');\nINSERT INTO commande VALUES (11, 2, 'CREEE')" },
        { database: 'rw', script: PROC[name] },
      ];
      const tc = await call('POST', '/api/testcases', {
        name: `IT ${name}`, environmentId: envId, dataset: { cid: 10 }, setup, transactional: ['rw'],
        steps: [
          { type: 'sql', database: 'ro', query: 'SELECT statut FROM commande WHERE id = {{cid}}', assertions: [{ type: 'value', column: 'statut', value: 'CREEE' }] },
          { type: 'sql', database: 'ro', query: "SELECT id, statut FROM commande WHERE statut = '{{statutInitial}}' ORDER BY id", assertions: [{ type: 'rowCount', value: 2 }, { type: 'reference', rows: [{ id: 10, statut: 'CREEE' }, { id: 11, statut: 'CREEE' }] }] },
          { type: 'sql', database: 'rw', mode: 'snapshot', snapshot: 'avant', query: 'SELECT id, statut FROM commande ORDER BY id' },
          { type: 'sql', database: 'rw', mode: 'procedure', procedure: { name: 'valider', args: ['{{cid}}'] } },
          { type: 'sql', database: 'rw', query: 'SELECT statut FROM commande WHERE id = {{cid}}', assertions: [{ type: 'value', column: 'statut', value: 'VALIDEE' }] },
          { type: 'sql', database: 'rw', mode: 'savepoint', savepoint: 'sp1' },
          { type: 'sql', database: 'rw', mode: 'script', query: "UPDATE commande SET statut = 'ANNULEE' WHERE id = 11" },
          { type: 'sql', database: 'rw', mode: 'rollbackTo', savepoint: 'sp1' },
          { type: 'sql', database: 'rw', mode: 'diff', diff: { snapshot: 'avant', key: ['id'], expect: { added: 0, removed: 0, changed: 1, changedColumns: ['statut'] } } },
          { type: 'sql', database: 'rw', mode: 'integrity', integrity: [
            { kind: 'foreignKey', table: 'commande', column: 'client_id', refTable: 'client', refColumn: 'id' },
            { kind: 'duplicates', table: 'client', columns: ['email'], where: 'email IS NOT NULL' },
            { kind: 'notNull', table: 'client', columns: ['nom'] },
          ] },
        ],
        teardown: [],
      });
      expect(tc.status).toBe(200);
      // variable de campagne / d'exécution
      const r = await call('POST', '/api/executions', { kind: 'case', refId: tc.body.id, wait: true, variables: { statutInitial: 'CREEE' } });
      const e = (await call('GET', `/api/executions/${r.body.id}`)).body;
      const bad = e.cases.flatMap((c: any) => c.steps).filter((s: any) => s.status !== 'passed').map((s: any) => ({ i: s.index, n: s.name, err: s.error, a: s.assertions.filter((x: any) => !x.ok) }));
      expect(bad).toEqual([]);

      // Rollback transactionnel effectif : la procédure n'a rien laissé.
      const after = await call('POST', `/api/environments/${envId}/databases/ro/query`, { sql: 'SELECT statut FROM commande WHERE id = 10' });
      expect(Object.values(after.body.rows[0])[0]).toBe('CREEE');

      // Garde : écriture et destructif bloqués.
      expect((await call('POST', `/api/environments/${envId}/databases/ro/query`, { sql: "UPDATE commande SET statut = 'X' WHERE id = 10" })).status).toBe(422);
      expect((await call('POST', `/api/environments/${envId}/databases/rw/query`, { sql: 'DELETE FROM commande' })).status).toBe(422);

      // Explorateur de schéma
      const schema = await call('GET', `/api/environments/${envId}/databases/ro/schema`);
      expect(schema.body.tables.map((t: any) => t.name.toLowerCase())).toEqual(expect.arrayContaining(['client', 'commande']));

      // Lecture seule au niveau session (en plus du garde) pour PostgreSQL et MariaDB.
      if (name === 'postgres' || name === 'mariadb') {
        const envRt = await ctx.envs.resolve(envId);
        const db = await openDb(envRt, 'ro');
        await expect(db.session.query("UPDATE commande SET statut = 'X' WHERE id = 10")).rejects.toThrow(/read.only|READ ONLY/i);
        await db.close();
      }
    }, 600000);
  }

  it('mongodb : find typé, rollback transactionnel, destructif bloqué', async () => {
    const cfg = { engine: 'mongodb', host: H, port: 37017, uri: `mongodb://${H}:37017/?directConnection=true`, database: 'boutique' };
    if (!(await ready('mongodb', cfg))) return;
    const env = await call('POST', '/api/environments', { name: 'IT-mongo', kind: 'INT', databases: [{ name: 'ro', ...cfg }, { name: 'rw', ...cfg, readOnly: false, allowDestructive: true }] });
    const envId = env.body.id;
    const tc = await call('POST', '/api/testcases', {
      name: 'IT mongo', environmentId: envId, dataset: { cid: 10 }, transactional: ['rw'],
      setup: [
        { database: 'rw', script: JSON.stringify({ collection: 'commande', op: 'deleteMany', filter: {} }), allowDestructive: true },
        { database: 'rw', script: JSON.stringify({ collection: 'commande', op: 'insertMany', documents: [{ id: 10, statut: 'CREEE' }, { id: 11, statut: 'CREEE' }] }) },
      ],
      steps: [
        { type: 'sql', database: 'ro', query: JSON.stringify({ collection: 'commande', op: 'find', filter: { id: '{{cid}}' }, projection: { _id: 0 } }), assertions: [{ type: 'rowCount', value: 1 }, { type: 'value', column: 'statut', value: 'CREEE' }] },
        { type: 'sql', database: 'rw', query: JSON.stringify({ collection: 'commande', op: 'updateOne', filter: { id: '{{cid}}' }, update: { $set: { statut: 'VALIDEE' } } }) },
        { type: 'sql', database: 'rw', query: JSON.stringify({ collection: 'commande', op: 'countDocuments', filter: { statut: 'VALIDEE' } }), assertions: [{ type: 'value', column: 'count', value: 1 }] },
      ],
    });
    const r = await call('POST', '/api/executions', { kind: 'case', refId: tc.body.id, wait: true });
    const e = (await call('GET', `/api/executions/${r.body.id}`)).body;
    expect(e.cases[0].steps.filter((s: any) => s.status !== 'passed').map((s: any) => s.error ?? s.assertions)).toEqual([]);
    const after = await call('POST', `/api/environments/${envId}/databases/ro/query`, { sql: JSON.stringify({ collection: 'commande', op: 'countDocuments', filter: { statut: 'VALIDEE' } }) });
    expect(after.body.rows[0].count).toBe(0);
    expect((await call('POST', `/api/environments/${envId}/databases/ro/query`, { sql: JSON.stringify({ collection: 'commande', op: 'insertOne', document: { a: 1 } }) })).status).toBe(422);
    expect((await call('POST', `/api/environments/${envId}/databases/rw/query`, { sql: JSON.stringify({ collection: 'commande', op: 'deleteMany', filter: {} }) })).status).toBe(422);
  }, 300000);
});

describe.skipIf(!IT)('SSH réel : scripts, batch, SFTP, tunnel', () => {
  it('exécute scripts et batch via SSH, lit le fichier produit en SFTP, passe par un tunnel SSH vers PostgreSQL', async () => {
    if (!(await reachable(12222))) return;
    let pgIp = '';
    try { pgIp = execSync("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' th-pg").toString().trim(); } catch { /* */ }
    const server = { name: 'batch01', host: H, port: 12222, user: 'batch', password: 'Ssh_pass1', interpreters: { shell: 'sh', python: 'python3' } };
    const env = await call('POST', '/api/environments', {
      name: 'IT-ssh', kind: 'INT', servers: [server],
      fileShares: [{ name: 'out', kind: 'sftp', server: 'batch01', root: '/tmp' }],
      databases: pgIp ? [{ name: 'pg-tunnel', ...ENGINES.postgres, host: pgIp, port: 5432, sshTunnel: 'batch01' }] : [],
    });
    expect(env.status).toBe(200);
    const envId = env.body.id;
    const checks = await call('POST', `/api/environments/${envId}/test`, {});
    expect(checks.body.filter((c: any) => !c.ok)).toEqual([]);
    const tc = await call('POST', '/api/testcases', {
      name: 'IT ssh', environmentId: envId, dataset: { lot: 'L42' },
      steps: [
        { type: 'script', language: 'shell', target: { server: 'batch01' }, script: 'echo "lot $1"; echo "warn" >&2; exit 0', args: ['{{lot}}'], extract: [{ var: 'sortie', from: 'regex', pattern: 'lot (\\w+)' }] },
        { type: 'batch', launcher: { kind: 'ssh', server: 'batch01', command: "printf 'id;statut\\n1;OK\\n2;OK\\n' > /tmp/export_{{sortie}}.csv" },
          files: [{ source: { share: 'out', path: 'export_{{sortie}}.csv' }, format: 'csv', assertions: [{ type: 'exists' }, { type: 'recordCount', value: 2 }, { type: 'field', row: 1, field: 'statut', value: 'OK' }] }] },
        { type: 'batch', name: 'timeout', continueOnFailure: true, timeoutMs: 1500, launcher: { kind: 'ssh', server: 'batch01', command: 'sleep 10' } },
        { type: 'file', source: { server: 'batch01', path: '/tmp/export_L42.csv' }, assertions: [{ type: 'lineCount', value: 3 }] },
        ...(pgIp ? [{ type: 'sql', database: 'pg-tunnel', query: 'SELECT 1 AS un', assertions: [{ type: 'value', column: 'un', value: 1 }] }] : []),
      ],
    });
    const r = await call('POST', '/api/executions', { kind: 'case', refId: tc.body.id, wait: true });
    const e = (await call('GET', `/api/executions/${r.body.id}`)).body;
    const steps = e.cases[0].steps;
    expect(steps[0].outputs.sortie).toBe('L42');
    expect(steps[0].logs.some((l: string) => l.includes('[stderr] warn'))).toBe(true);
    expect(steps[1].status).toBe('passed');
    expect(steps[2].status).toBe('failed');
    expect(steps[2].assertions[0]).toMatchObject({ ok: false, assertion: 'batch terminé avant le timeout' });
    expect(steps[3].status).toBe('passed');
    if (pgIp) expect(steps[4].status).toBe('passed');
    const audit = await call('GET', `/api/audit?executionId=${e.id}&kind=batch`);
    expect(audit.body.length).toBe(2);
  }, 120000);
});

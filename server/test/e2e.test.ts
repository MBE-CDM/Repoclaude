import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { startSut } from './fixtures/sut.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD = 'S3cret!pass';
const AGENT_TOKEN = 'agent-secret-token-123';

let tmp: string, sut: Awaited<ReturnType<typeof startSut>>, agent: ChildProcess, agentUrl: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
const tokens: Record<string, string> = { admin: 'admin-token' };
let envId: string, prodEnvId: string;

async function api(method: string, url: string, body?: unknown, who = 'admin') {
  const r = await ctx.app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${tokens[who]}` } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
}

function envBody(name: string, kind: string) {
  return {
    name, kind,
    frontUrl: sut.url, apiUrl: sut.url, healthPath: '/health',
    variables: { dbFile: path.join(tmp, 'sut.db'), exportDir: path.join(tmp, 'exports') },
    accounts: [
      { profile: 'alice', username: 'alice', password: PASSWORD, loginTest: { mode: 'api', path: '/api/login', body: { username: '{{username}}', password: '{{password}}' } } },
      { profile: 'alice-ui', username: 'alice', password: PASSWORD, loginTest: { mode: 'ui', path: '/login', userSelector: '#user', passwordSelector: '#pass', submitSelector: '#go', successSelector: '#welcome' } },
    ],
    databases: [
      { name: 'app', engine: 'sqlite', file: path.join(tmp, 'sut.db') },
      { name: 'app-rw', engine: 'sqlite', file: path.join(tmp, 'sut.db'), readOnly: false },
    ],
    agents: [{ name: 'local', url: agentUrl, token: AGENT_TOKEN }],
    fileShares: [{ name: 'exports', kind: 'local', root: path.join(tmp, 'exports') }],
  };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testhub-e2e-'));
  fs.mkdirSync(path.join(tmp, 'exports'));
  sut = await startSut(path.join(tmp, 'sut.db'));
  agent = spawn(process.execPath, [path.join(here, '..', '..', 'agent', 'agent.mjs')], {
    env: { ...process.env, AGENT_TOKEN, AGENT_PORT: '0', AGENT_HOST: '127.0.0.1', AGENT_FILE_ROOTS: tmp },
  });
  agentUrl = await new Promise<string>((resolve, reject) => {
    agent.stdout!.on('data', d => { const m = /:(\d+)/.exec(String(d)); if (m) resolve(`http://127.0.0.1:${m[1]}`); });
    agent.on('exit', c => reject(new Error(`agent arrêté (${c})`)));
  });
  ctx = await buildApp({ dataDir: path.join(tmp, 'data'), bootstrapAdminToken: tokens.admin, prodPolicy: 'dual-approval', webDist: path.join(tmp, 'none') });
  for (const [name, roles] of [['testeur', ['tester']], ['valideur1', ['approver']], ['valideur2', ['approver']]] as const) {
    const r = await api('POST', '/api/users', { name, roles });
    tokens[name] = r.body.token;
  }
  const e = await api('POST', '/api/environments', envBody('RECETTE-1', 'RECETTE'));
  expect(e.status).toBe(200);
  envId = e.body.id;
  prodEnvId = (await api('POST', '/api/environments', envBody('PRODUCTION', 'PROD'))).body.id;
});

afterAll(async () => {
  await ctx?.app.close();
  agent?.kill();
  await sut?.close();
});

describe('environnements', () => {
  it('ne renvoie jamais les secrets et les chiffre au repos', async () => {
    const r = await api('GET', `/api/environments/${envId}`);
    expect(r.body.accounts[0].password).toEqual({ set: true });
    expect(r.body.agents[0].token).toEqual({ set: true });
    expect(r.body.databases[0].readOnly).toBe(true);
    const raw = fs.readFileSync(path.join(tmp, 'data', 'testhub.db'));
    expect(raw.includes(Buffer.from(PASSWORD))).toBe(false);
    expect(raw.includes(Buffer.from(AGENT_TOKEN))).toBe(false);
  });

  it('conserve un secret non renvoyé lors d\'une mise à jour', async () => {
    const cur = (await api('GET', `/api/environments/${envId}`)).body;
    const r = await api('PUT', `/api/environments/${envId}`, { ...cur, description: 'maj' });
    expect(r.status).toBe(200);
    const t = await api('POST', `/api/environments/${envId}/test`, { scope: 'login', only: 'alice' });
    expect(t.body[0].ok).toBe(true);
  });

  it('teste ping, health-check, login API et UI, bases et agent', async () => {
    const r = await api('POST', `/api/environments/${envId}/test`, {}, 'testeur');
    expect(r.status).toBe(200);
    const failed = r.body.filter((x: any) => !x.ok);
    expect(failed).toEqual([]);
    expect(r.body.map((x: any) => x.kind).sort()).toEqual(['agent', 'database', 'database', 'health', 'health', 'login', 'login', 'ping', 'ping']);
  });

  it('réservé aux administrateurs', async () => {
    expect((await api('POST', '/api/environments', envBody('X', 'DEV'), 'testeur')).status).toBe(403);
  });
});

describe('éditeur SQL', () => {
  it('explore le schéma', async () => {
    const r = await api('GET', `/api/environments/${envId}/databases/app/schema`);
    expect(r.body.tables.map((t: any) => t.name)).toEqual(expect.arrayContaining(['client', 'commande']));
  });
  it('bloque les écritures en lecture seule et le destructif sans autorisation', async () => {
    const w = await api('POST', `/api/environments/${envId}/databases/app/query`, { sql: "INSERT INTO client VALUES (99, 'x', null)" });
    expect(w.status).toBe(422);
    expect(w.body.error).toMatch(/lecture seule/);
    const d = await api('POST', `/api/environments/${envId}/databases/app-rw/query`, { sql: 'DELETE FROM commande' });
    expect(d.status).toBe(422);
    expect(d.body.error).toMatch(/destructrice/);
    const d2 = await api('POST', `/api/environments/${envId}/databases/app-rw/query`, { sql: 'DROP TABLE commande', allowDestructive: true });
    expect(d2.status).toBe(422);
    const ok = await api('POST', `/api/environments/${envId}/databases/app/query`, { sql: 'SELECT COUNT(*) AS n FROM commande' });
    expect(ok.status).toBe(200);
    const audit = await api('GET', '/api/audit?kind=sql');
    expect(audit.body.some((a: any) => a.outcome === 'blocked' && a.target.includes('DELETE FROM commande'))).toBe(true);
  });
});

describe('scénario orchestré UI → SQL → API → batch → fichier', () => {
  let execution: any;

  it('exécute le scénario complet avec passage de variables', async () => {
    const tc = await api('POST', '/api/testcases', {
      name: 'Commande de bout en bout', environmentId: envId,
      dataset: { produit: 'Clavier', montant: 49.9 },
      setup: [{ database: 'app-rw', script: "DELETE FROM client WHERE id IN (1, 2); INSERT INTO client VALUES (1, 'Dupont', 'd@x.fr'); INSERT INTO client VALUES (2, 'Martin', NULL);" }],
      teardown: [{ database: 'app-rw', script: 'DELETE FROM commande WHERE id = {{commandeId}}' }],
      steps: [
        { type: 'ui', name: 'Créer la commande dans l\'UI', actions: [
          { action: 'login', profile: 'alice-ui' },
          { action: 'fill', selector: '[data-testid="produit"]', value: '{{produit}}' },
          { action: 'fill', selector: '[data-testid="montant"]', value: '{{montant}}' },
          { action: 'select', selector: 'select[name="client"]', value: '1' },
          { action: 'click', selector: 'button:has-text("Créer la commande")' },
          { action: 'expectText', selector: '#statut', text: 'CREEE' },
          { action: 'extract', var: 'commandeId', selector: '#cmd-id' },
        ] },
        { type: 'sql', name: 'Contrôle SQL de la commande', database: 'app', query: 'SELECT statut, montant, produit FROM commande WHERE id = {{commandeId}}',
          assertions: [{ type: 'rowCount', value: 1 }, { type: 'value', column: 'statut', value: 'CREEE' }, { type: 'range', column: 'montant', min: 0, max: 100 }, { type: 'regex', column: 'produit', pattern: '^Cla' }] },
        { type: 'sql', name: 'Snapshot avant', database: 'app', mode: 'snapshot', snapshot: 'avant', query: 'SELECT id, statut, montant FROM commande WHERE id = {{commandeId}}' },
        { type: 'api', name: 'Login API', method: 'POST', path: '/api/login', body: { username: '{{account.alice.username}}', password: '{{account.alice.password}}' },
          assertions: [{ type: 'status', value: 200 }], extract: [{ var: 'token', from: 'jsonpath', path: '$.token' }] },
        { type: 'api', name: 'Valider la commande', method: 'PATCH', path: '/api/commandes/{{commandeId}}', auth: { mode: 'bearer', token: '{{token}}' }, body: { statut: 'VALIDEE' },
          assertions: [{ type: 'status', value: 200 }, { type: 'jsonpath', path: '$.statut', value: 'VALIDEE' }, { type: 'responseTime', maxMs: 5000 }] },
        { type: 'sql', name: 'Diff après validation', database: 'app', mode: 'diff', diff: { snapshot: 'avant', key: ['id'], expect: { added: 0, removed: 0, changed: 1, changedColumns: ['statut'] } } },
        { type: 'api', name: 'GraphQL', protocol: 'graphql', path: '/graphql', graphql: { query: 'query($id: ID!) { commande(id: $id) { id statut } }', variables: { id: '{{commandeId}}' } },
          assertions: [{ type: 'jsonpath', path: '$.data.commande.statut', value: 'VALIDEE' }] },
        { type: 'api', name: 'SOAP', protocol: 'soap', path: '/soap', soap: { action: 'GetStatut', envelope: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetStatut><id>{{commandeId}}</id></GetStatut></soap:Body></soap:Envelope>' },
          assertions: [{ type: 'status', value: 200 }, { type: 'jsonpath', path: '$.Envelope.Body.GetStatutResponse.statut', value: 'VALIDEE' }] },
        { type: 'sql', name: 'Intégrité', database: 'app', mode: 'integrity', integrity: [
          { kind: 'foreignKey', table: 'commande', column: 'client_id', refTable: 'client', refColumn: 'id' },
          { kind: 'duplicates', table: 'client', columns: ['email'], where: 'email IS NOT NULL' },
          { kind: 'notNull', table: 'client', columns: ['nom'] },
          { kind: 'consistency', name: 'commande ↔ client', left: 'SELECT COUNT(*) FROM commande WHERE id = {{commandeId}}', right: 'SELECT COUNT(*) FROM commande c JOIN client k ON k.id = c.client_id WHERE c.id = {{commandeId}}' },
        ] },
        { type: 'batch', name: 'Batch d\'export', launcher: { kind: 'agent', agent: 'local', command: 'echo "export de la commande {{commandeId}}"; sqlite3 -header -separator ";" {{dbFile}} "SELECT id, produit, statut FROM commande WHERE id = {{commandeId}}" > {{exportDir}}/export_{{commandeId}}.csv' },
          timeoutMs: 30000,
          files: [{ source: { share: 'exports', path: 'export_{{commandeId}}.csv' }, format: 'csv', assertions: [
            { type: 'exists' }, { type: 'formatValid' }, { type: 'recordCount', value: 1 }, { type: 'headers', value: ['id', 'produit', 'statut'] }, { type: 'field', field: 'statut', value: 'VALIDEE' },
          ] }],
          then: [{ type: 'sql', name: 'Effet du batch en base', database: 'app', query: "SELECT COUNT(*) AS n FROM commande WHERE id = {{commandeId}} AND statut = 'VALIDEE'", assertions: [{ type: 'value', column: 'n', value: 1 }] }] },
        { type: 'script', name: 'Script Python distant', language: 'python', target: { agent: 'local' }, script: 'import sys\nprint("commande", "{{commandeId}}", "traitée")\n', extract: [{ var: 'msg', from: 'stdout' }] },
        { type: 'file', name: 'Lecture via agent', source: { agent: 'local', path: '{{exportDir}}/export_{{commandeId}}.csv' }, format: 'csv', assertions: [{ type: 'contains', value: 'Clavier' }] },
      ],
    }, 'testeur');
    expect(tc.status).toBe(200);
    const r = await api('POST', '/api/executions', { kind: 'case', refId: tc.body.id, wait: true }, 'testeur');
    expect(r.status).toBe(200);
    execution = (await api('GET', `/api/executions/${r.body.id}`)).body;
    const problems = execution.cases.flatMap((c: any) => c.steps).filter((s: any) => s.status !== 'passed').map((s: any) => ({ name: s.name, error: s.error, failed: s.assertions.filter((a: any) => !a.ok), logs: s.logs.slice(-5) }));
    expect(problems).toEqual([]);
    expect(execution.status).toBe('passed');
    const steps = execution.cases[0].steps;
    expect(steps.map((s: any) => s.index)).toContain('10.1');
    expect(steps.find((s: any) => s.name === 'Script Python distant').outputs.msg).toMatch(/^commande \d+ traitée$/);
  });

  it('capture les preuves (captures, vidéo, HAR, trace, console, tables)', () => {
    const ui = execution.cases[0].steps.find((s: any) => s.type === 'ui');
    const types = new Set(ui.evidence.map((e: any) => e.type));
    for (const t of ['screenshot', 'video', 'har', 'trace', 'console']) expect(types.has(t)).toBe(true);
    const sql = execution.cases[0].steps.find((s: any) => s.name === 'Contrôle SQL de la commande');
    expect(sql.evidence[0].type).toBe('table');
    expect(sql.evidence[0].data.rows[0].statut).toBe('CREEE');
    const dir = path.join(tmp, 'data', 'evidence', execution.id);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('ne laisse fuiter le mot de passe ni dans le résultat, ni dans les preuves, ni dans l\'audit', async () => {
    expect(JSON.stringify(execution)).not.toContain(PASSWORD);
    const audit = await api('GET', `/api/audit?executionId=${execution.id}&limit=500`);
    expect(audit.body.length).toBeGreaterThan(5);
    expect(JSON.stringify(audit.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(audit.body)).not.toContain('tok-abc-123');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(f => f.isDirectory() ? walk(path.join(d, f.name)) : [path.join(d, f.name)]);
    for (const f of walk(path.join(tmp, 'data', 'evidence', execution.id))) {
      if (/\.(har|log|txt)$/.test(f)) expect(fs.readFileSync(f, 'utf8'), f).not.toContain(PASSWORD);
    }
  });

  it('a nettoyé les données (teardown)', () => {
    const n: any = sut.db.prepare('SELECT COUNT(*) AS n FROM commande').get();
    expect(n.n).toBe(0);
  });

  it('sert les preuves aux utilisateurs authentifiés', async () => {
    const ui = execution.cases[0].steps.find((s: any) => s.type === 'ui');
    const shot = ui.evidence.find((e: any) => e.type === 'screenshot');
    const r = await ctx.app.inject({ method: 'GET', url: `/api/evidence/${execution.id}/1/${shot.file}?token=${tokens.admin}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/evidence/${execution.id}/1/${shot.file}` })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/evidence/${execution.id}/../../testhub.db?token=${tokens.admin}` })).statusCode).toBe(404);
  });
});

describe('données : rollback transactionnel, points de restauration, jeux de données', () => {
  it('annule les écritures du cas en fin d\'exécution', async () => {
    const tc = await api('POST', '/api/testcases', {
      name: 'Transactionnel', environmentId: envId, transactional: ['app-rw'],
      dataset: [{ p: 'A' }, { p: 'B' }],
      steps: [
        { type: 'sql', database: 'app-rw', mode: 'script', query: "INSERT INTO commande (client_id, produit, montant) VALUES (1, {{p}}, 1)" },
        { type: 'sql', database: 'app-rw', mode: 'savepoint', savepoint: 'sp1' },
        { type: 'sql', database: 'app-rw', mode: 'script', query: "INSERT INTO commande (client_id, produit, montant) VALUES (1, 'temp', 2)" },
        { type: 'sql', database: 'app-rw', mode: 'rollbackTo', savepoint: 'sp1' },
        { type: 'sql', database: 'app-rw', query: 'SELECT produit FROM commande ORDER BY id', assertions: [{ type: 'rowCount', value: 1 }, { type: 'value', column: 'produit', value: '{{p}}' }] },
      ],
    });
    const r = await api('POST', '/api/executions', { kind: 'case', refId: tc.body.id, wait: true });
    const e = (await api('GET', `/api/executions/${r.body.id}`)).body;
    expect(e.cases).toHaveLength(2);
    expect(e.cases.map((c: any) => c.status)).toEqual(['passed', 'passed']);
    const n: any = sut.db.prepare('SELECT COUNT(*) AS n FROM commande').get();
    expect(n.n).toBe(0);
  });

  it('bloque une étape destructrice et la marque « blocked »', async () => {
    const tc = await api('POST', '/api/testcases', { name: 'Destructif', environmentId: envId, steps: [{ type: 'sql', database: 'app-rw', mode: 'script', query: 'DELETE FROM client' }] });
    const r = await api('POST', '/api/executions', { kind: 'case', refId: tc.body.id, wait: true });
    const e = (await api('GET', `/api/executions/${r.body.id}`)).body;
    expect(e.status).toBe('blocked');
    expect(e.cases[0].steps[0].error).toMatch(/DELETE sans clause WHERE/);
    expect((sut.db.prepare('SELECT COUNT(*) AS n FROM client').get() as any).n).toBe(2);
  });
});

describe('production : double validation', () => {
  it('exige deux valideurs distincts du demandeur', async () => {
    const tc = await api('POST', '/api/testcases', { name: 'Lecture prod', steps: [{ type: 'sql', database: 'app', query: 'SELECT 1 AS un', assertions: [{ type: 'value', value: 1 }] }] });
    const r = await api('POST', '/api/executions', { kind: 'case', refId: tc.body.id, environmentId: prodEnvId }, 'testeur');
    expect(r.status).toBe(403);
    const approvalId = r.body.approvalId;
    expect(approvalId).toBeTruthy();
    expect((await api('POST', `/api/approvals/${approvalId}/decision`, { decision: 'approve' }, 'testeur')).status).toBe(400);
    expect((await api('POST', `/api/approvals/${approvalId}/execute`, {}, 'testeur')).status).toBe(403);
    expect((await api('POST', `/api/approvals/${approvalId}/decision`, { decision: 'approve' }, 'valideur1')).body.status).toBe('pending');
    expect((await api('POST', `/api/approvals/${approvalId}/decision`, { decision: 'approve' }, 'valideur1')).status).toBe(400);
    expect((await api('POST', `/api/approvals/${approvalId}/decision`, { decision: 'approve' }, 'valideur2')).body.status).toBe('approved');
    const ex = await api('POST', `/api/approvals/${approvalId}/execute`, {}, 'testeur');
    expect(ex.status).toBe(200);
    const done = await ctx.executions.wait(ex.body.id);
    expect(done.status).toBe('passed');
    // Une validation ne sert qu'une fois
    expect((await api('POST', `/api/approvals/${approvalId}/execute`, {}, 'testeur')).status).toBe(403);
  });

  it('soumet aussi l\'éditeur SQL à validation en production', async () => {
    const r = await api('POST', `/api/environments/${prodEnvId}/databases/app/query`, { sql: 'SELECT 1' }, 'testeur');
    expect(r.status).toBe(403);
    expect(r.body.production).toBe(true);
  });
});

describe('campagnes, cron et webhook CI/CD', () => {
  it('valide le cron et déclenche via webhook', async () => {
    const tc = await api('POST', '/api/testcases', { name: 'Santé API', steps: [{ type: 'api', path: '/health', assertions: [{ type: 'jsonpath', path: '$.status', value: 'UP' }] }] });
    expect((await api('POST', '/api/campaigns', { name: 'bad', environmentId: envId, caseIds: [tc.body.id], schedule: { cron: 'pas un cron', enabled: true } })).status).toBe(400);
    const c = await api('POST', '/api/campaigns', { name: 'Nocturne', environmentId: envId, caseIds: [tc.body.id], schedule: { cron: '0 2 * * *', enabled: true } });
    expect(c.status).toBe(200);
    expect((await api('GET', `/api/campaigns/${c.body.id}/next-run`)).body.nextRun).toMatch(/T/);
    const tok = await api('POST', `/api/campaigns/${c.body.id}/webhook-token`);
    const bad = await ctx.app.inject({ method: 'POST', url: `/api/hooks/campaigns/${c.body.id}`, headers: { 'x-testhub-token': 'nope' } });
    expect(bad.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: 'POST', url: `/api/hooks/campaigns/${c.body.id}?wait=true`, headers: { 'x-testhub-token': tok.body.token } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).result).toBe('passed');
    // Le jeton survit à une modification de la campagne
    await api('PUT', `/api/campaigns/${c.body.id}`, { ...c.body, name: 'Nocturne 2' });
    const again = await ctx.app.inject({ method: 'POST', url: `/api/hooks/campaigns/${c.body.id}`, headers: { 'x-testhub-token': tok.body.token } });
    expect(again.statusCode).toBe(200);
    await ctx.executions.wait(JSON.parse(again.body).id);
  });
});

describe('enregistreur', () => {
  it('enregistre un scénario et le convertit en cas de test', async () => {
    const s = await api('POST', '/api/recorder/start', { environmentId: envId, path: '/login', headless: true }, 'testeur');
    expect(s.status).toBe(200);
    const page = ctx.recorder.page(s.body.id);
    await page.fill('#user', 'alice');
    await page.fill('#pass', PASSWORD);
    await page.click('#go');
    await page.waitForSelector('#welcome');
    await page.fill('[data-testid="produit"]', 'Écran');
    await page.click('[data-testid="montant"]');
    await page.fill('[data-testid="montant"]', '120');
    await page.click('button:has-text("Créer la commande")');
    await page.waitForSelector('#cmd-id');
    const stop = await api('POST', `/api/recorder/${s.body.id}/stop`, { saveAs: { name: 'Enregistré', environmentId: envId } }, 'testeur');
    const actions = stop.body.step.actions;
    expect(actions[0]).toEqual({ action: 'goto', url: '/login' });
    expect(actions).toContainEqual({ action: 'fill', selector: '#user', value: 'alice' });
    expect(actions).toContainEqual({ action: 'fill', selector: '#pass', value: '{{motDePasse}}' });
    expect(actions).toContainEqual({ action: 'click', selector: '#go' });
    expect(actions).toContainEqual({ action: 'fill', selector: '[data-testid="montant"]', value: '120' });
    expect(actions).toContainEqual({ action: 'click', selector: 'button:has-text("Créer la commande")' });
    expect(JSON.stringify(actions)).not.toContain(PASSWORD);
    expect(stop.body.testCase.id).toBeTruthy();
  });
});

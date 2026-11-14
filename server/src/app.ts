import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { loadConfig, type AppConfig } from './core/config.js';
import { Store } from './core/store.js';
import { AesSecretProvider, CompositeSecretProvider, resolveMasterKey, VaultSecretProvider } from './security/crypto.js';
import { Masker } from './security/masking.js';
import { AuditLog } from './security/audit.js';
import { hasRole, safeEqual, UserService, type Principal, type Role } from './security/auth.js';
import { ProductionGuard, ProductionGuardError, type Approval } from './security/approvals.js';
import { EnvironmentService } from './environments/service.js';
import { testEnvironment, type CheckScope } from './environments/connectivity.js';
import { openDb, SUPPORTED_ENGINES } from './connectors/db/index.js';
import { analyzeScript, SqlGuardError } from './connectors/db/sqlGuard.js';
import { analyzeMongo } from './connectors/db/mongo.js';
import { ExecutionService, summary } from './engine/runner.js';
import { CampaignScheduler } from './engine/scheduler.js';
import { RecorderService } from './recorder/recorder.js';
import type { Campaign, TestCase } from './engine/model.js';

declare module 'fastify' { interface FastifyRequest { user?: Principal } }

class HttpError extends Error { constructor(public status: number, message: string, public extra?: object) { super(message); } }

export async function buildApp(overrides: Partial<AppConfig> & { dbFile?: string; logger?: boolean } = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = new Store(cfg.dataDir, overrides.dbFile);
  const aes = new AesSecretProvider(resolveMasterKey(cfg.dataDir, cfg.masterKey));
  const secrets = new CompositeSecretProvider(aes, cfg.vault ? new VaultSecretProvider(cfg.vault) : undefined);
  const masker = new Masker();
  const audit = new AuditLog(store, masker);
  const users = new UserService(store);
  const generatedToken = users.bootstrap(cfg.dataDir, cfg.bootstrapAdminToken);
  const guard = new ProductionGuard(store, cfg.prodPolicy, audit);
  const envs = new EnvironmentService(store, secrets);
  const executions = new ExecutionService(store, cfg, envs, audit, guard);
  const scheduler = new CampaignScheduler(store, executions);
  const recorder = new RecorderService();
  scheduler.reloadAll();

  const app = Fastify({ logger: overrides.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  app.addHook('onClose', async () => scheduler.stopAll());

  const bearer = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) return h.slice(7);
    return (req.query as any)?.token as string | undefined; // EventSource / liens de preuves
  };

  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/hooks/') || req.url === '/api/health') return;
    const u = users.authenticate(bearer(req));
    if (!u) throw new HttpError(401, 'Authentification requise (jeton Bearer)');
    req.user = u;
  });

  const need = (req: FastifyRequest, ...roles: Role[]) => {
    if (!hasRole(req.user!, ...roles)) throw new HttpError(403, `Rôle requis : ${roles.join(' ou ')}`);
    return req.user!;
  };

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, ...err.extra });
    if (err instanceof ProductionGuardError) return reply.status(403).send({ error: err.message, approvalId: err.approvalId, production: true });
    if (err instanceof SqlGuardError) return reply.status(422).send({ error: err.message, blocked: true, statement: err.statement });
    if (err.validation || err.statusCode === 400) return reply.status(400).send({ error: err.message });
    return reply.status(err.statusCode && err.statusCode < 500 ? err.statusCode : 400).send({ error: masker.text(String(err.message ?? err)) });
  });

  /* ---------------- Méta / utilisateurs ---------------- */
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/me', async req => req.user);
  app.get('/api/meta', async () => ({
    engines: SUPPORTED_ENGINES, prodPolicy: cfg.prodPolicy, vault: !!cfg.vault,
    stepTypes: ['ui', 'api', 'sql', 'batch', 'file', 'script'], environmentKinds: ['DEV', 'INT', 'RECETTE', 'PREPROD', 'PROD'],
  }));
  app.get('/api/users', async req => { need(req, 'admin'); return users.list(); });
  app.post('/api/users', async req => {
    const me = need(req, 'admin');
    const b = req.body as { name: string; roles: Role[] };
    const r = users.create(b.name, b.roles ?? ['tester']);
    audit.record({ actor: me.name, kind: 'config', target: `utilisateur ${b.name}`, outcome: 'success', detail: { roles: b.roles } });
    return r;
  });

  /* ---------------- Environnements ---------------- */
  app.get('/api/environments', async () => envs.list().map(e => envs.publicView(e)));
  app.get('/api/environments/:id', async req => {
    const e = envs.get((req.params as any).id);
    if (!e) throw new HttpError(404, 'Environnement introuvable');
    return envs.publicView(e);
  });
  const saveEnv = async (req: FastifyRequest, id?: string) => {
    const me = need(req, 'admin');
    const body = { ...(req.body as object), ...(id ? { id } : {}) } as any;
    if (id && !envs.get(id)) throw new HttpError(404, 'Environnement introuvable');
    const e = await envs.save(body);
    audit.record({ actor: me.name, environment: e.name, kind: 'config', target: `environnement ${e.name}`, outcome: 'success', detail: { action: id ? 'modification' : 'création' } });
    return envs.publicView(e);
  };
  app.post('/api/environments', async req => saveEnv(req));
  app.put('/api/environments/:id', async req => saveEnv(req, (req.params as any).id));
  app.delete('/api/environments/:id', async req => {
    const me = need(req, 'admin');
    const e = envs.require((req.params as any).id);
    envs.delete(e.id);
    audit.record({ actor: me.name, environment: e.name, kind: 'config', target: `environnement ${e.name}`, outcome: 'success', detail: { action: 'suppression' } });
    return { ok: true };
  });
  app.post('/api/environments/:id/test', async req => {
    const me = need(req, 'tester');
    const b = (req.body ?? {}) as { scope?: CheckScope; only?: string };
    const m = new Masker();
    const env = await envs.resolve((req.params as any).id, m);
    const results = await testEnvironment(env, b.scope ?? 'all', b.only);
    audit.record({ actor: me.name, environment: env.name, kind: 'connection-test', target: b.scope ?? 'all', outcome: results.every(r => r.ok) ? 'success' : 'failure', detail: results.map(r => ({ target: r.target, ok: r.ok })) }, m);
    return m.value(results);
  });

  /* ---------------- Éditeur SQL & explorateur ---------------- */
  app.get('/api/environments/:id/databases/:db/schema', async req => {
    need(req, 'tester');
    const p = req.params as any;
    const env = await envs.resolve(p.id);
    const db = await openDb(env, p.db);
    try { return await db.session.schema(); } finally { await db.close(); }
  });

  app.post('/api/sql/analyze', async req => {
    const b = req.body as { sql: string; engine?: string };
    if (b.engine === 'mongodb') { try { return [{ ...analyzeMongo(JSON.parse(b.sql)), verb: JSON.parse(b.sql).op }]; } catch (e: any) { return [{ error: e.message }]; } }
    return analyzeScript(b.sql ?? '');
  });

  const runEditorQuery = async (who: Principal, envId: string, dbName: string, sql: string, allowDestructive: boolean, approvalId?: string) => {
    const envDoc = envs.require(envId);
    guard.check(envDoc, who, { type: 'sql', summary: `requête SQL sur ${envDoc.name}/${dbName}`, payload: { environmentId: envDoc.id, database: dbName, sql, allowDestructive } }, approvalId);
    const m = new Masker({ sensitiveKeys: envDoc.sensitiveColumns });
    const env = await envs.resolve(envId, m);
    const db = await openDb(env, dbName);
    try {
      const r = db.config.engine === 'mongodb' || analyzeScript(sql).length <= 1
        ? await db.query(sql, [], { allowDestructive })
        : (await db.script(sql, { allowDestructive })).results.at(-1)!;
      audit.record({ actor: who.name, environment: env.name, kind: 'sql', target: `${dbName}: ${sql.slice(0, 1000)}`, outcome: 'success', detail: { rowCount: r.rowCount, affected: r.affected, durationMs: r.durationMs, source: 'éditeur SQL' } }, m);
      return m.value({ ...r, rows: r.rows.slice(0, 1000), truncated: r.rows.length > 1000 }, env.sensitiveColumns);
    } catch (e: any) {
      audit.record({ actor: who.name, environment: env.name, kind: 'sql', target: `${dbName}: ${sql.slice(0, 1000)}`, outcome: e instanceof SqlGuardError ? 'blocked' : 'failure', detail: { error: e.message, source: 'éditeur SQL' } }, m);
      throw e;
    } finally { await db.close(); }
  };

  app.post('/api/environments/:id/databases/:db/query', async req => {
    const me = need(req, 'tester');
    const p = req.params as any;
    const b = req.body as { sql: string; allowDestructive?: boolean; approvalId?: string };
    if (!b?.sql?.trim()) throw new HttpError(400, 'Requête vide');
    return runEditorQuery(me, p.id, p.db, b.sql, !!b.allowDestructive, b.approvalId);
  });

  /* ---------------- Cas de test & campagnes ---------------- */
  const crud = <T extends { name: string }>(col: string, base: string, validate: (x: any) => void, after?: (x: T & { id: string }) => void, onDelete?: (id: string) => void) => {
    app.get(base, async () => store.list<T>(col));
    app.get(`${base}/:id`, async req => { const x = store.get<T>(col, (req.params as any).id); if (!x) throw new HttpError(404, 'Introuvable'); return x; });
    const save = async (req: FastifyRequest, id?: string) => {
      const me = need(req, 'tester');
      const body = { ...(req.body as object), ...(id ? { id } : {}) } as any;
      if (id && !store.get(col, id)) throw new HttpError(404, 'Introuvable');
      if (id) { const prev = store.get<any>(col, id); if (prev?.webhookTokenHash && body.webhookTokenHash === undefined) body.webhookTokenHash = prev.webhookTokenHash; }
      validate(body);
      const saved = store.put<T>(col, body);
      audit.record({ actor: me.name, kind: 'config', target: `${col} ${saved.name}`, outcome: 'success', detail: { action: id ? 'modification' : 'création' } });
      after?.(saved);
      return saved;
    };
    app.post(base, async req => save(req));
    app.put(`${base}/:id`, async req => save(req, (req.params as any).id));
    app.delete(`${base}/:id`, async req => {
      const me = need(req, 'tester');
      const id = (req.params as any).id;
      const ok = store.delete(col, id);
      onDelete?.(id);
      audit.record({ actor: me.name, kind: 'config', target: `${col} ${id}`, outcome: ok ? 'success' : 'failure', detail: { action: 'suppression' } });
      return { ok };
    });
  };

  crud<TestCase>('testcases', '/api/testcases', b => {
    if (!b.name) throw new HttpError(400, 'Nom du cas obligatoire');
    if (!Array.isArray(b.steps)) throw new HttpError(400, 'steps doit être un tableau');
    for (const [i, s] of b.steps.entries()) if (!['ui', 'api', 'sql', 'batch', 'file', 'script'].includes(s?.type)) throw new HttpError(400, `Étape ${i + 1} : type invalide`);
    if (b.environmentId && !envs.get(b.environmentId)) throw new HttpError(400, 'Environnement inconnu');
  });
  crud<Campaign>('campaigns', '/api/campaigns', b => {
    if (!b.name) throw new HttpError(400, 'Nom de campagne obligatoire');
    if (!b.environmentId || !envs.get(b.environmentId)) throw new HttpError(400, 'Environnement de campagne obligatoire');
    b.caseIds ??= [];
    for (const id of b.caseIds) if (!store.get('testcases', id)) throw new HttpError(400, `Cas inconnu : ${id}`);
    if (b.schedule?.cron) { try { CampaignScheduler.validate(b.schedule.cron, b.schedule.timezone); } catch (e: any) { throw new HttpError(400, `Expression cron invalide : ${e.message}`); } }
  }, c => scheduler.reload(c), id => scheduler.remove(id));

  app.get('/api/campaigns/:id/next-run', async req => ({ nextRun: scheduler.nextRun((req.params as any).id) ?? null }));
  app.post('/api/campaigns/:id/webhook-token', async req => {
    const me = need(req, 'admin');
    const c = store.get<Campaign>('campaigns', (req.params as any).id);
    if (!c) throw new HttpError(404, 'Campagne introuvable');
    const token = randomBytes(24).toString('base64url');
    c.webhookTokenHash = createHash('sha256').update(token).digest('hex');
    store.put('campaigns', c);
    audit.record({ actor: me.name, kind: 'config', target: `webhook campagne ${c.name}`, outcome: 'success' });
    return { token, url: `/api/hooks/campaigns/${c.id}`, usage: `curl -X POST -H "X-TestHub-Token: ${token}" <base>/api/hooks/campaigns/${c.id}?wait=true` };
  });

  /* ---------------- Exécutions ---------------- */
  const startExec = async (who: Principal, b: any, trigger: 'manual' | 'api' | 'webhook') => {
    const e = executions.start({ kind: b.kind, refId: b.refId, environmentId: b.environmentId, variables: b.variables, trigger, approvalId: b.approvalId }, who);
    if (b.wait) { const done = await executions.wait(e.id, Number(b.timeoutMs ?? 30 * 60000)); return { ...summary(done), result: done.status }; }
    return summary(e);
  };
  app.post('/api/executions', async req => startExec(need(req, 'tester'), req.body, ((req.body as any)?.trigger === 'api' ? 'api' : 'manual')));
  app.get('/api/executions', async req => executions.list(Number((req.query as any).limit ?? 100)).map(summary));
  app.get('/api/executions/:id', async req => { const e = executions.get((req.params as any).id); if (!e) throw new HttpError(404, 'Exécution introuvable'); return e; });
  app.post('/api/executions/:id/cancel', async req => { need(req, 'tester'); return { ok: executions.cancel((req.params as any).id) }; });

  app.get('/api/executions/:id/stream', (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req.params as any).id;
    const e = executions.get(id);
    if (!e) { reply.status(404).send({ error: 'Exécution introuvable' }); return; }
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (ev: any) => reply.raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    send({ type: 'execution', data: summary(e) });
    const onEv = (ev: any) => { send(ev); if (ev.type === 'end') close(); };
    const ka = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    const close = () => { clearInterval(ka); executions.events.off(id, onEv); reply.raw.end(); };
    if (!['queued', 'running'].includes(e.status)) { send({ type: 'end', data: summary(e) }); close(); return; }
    executions.events.on(id, onEv);
    req.raw.on('close', close);
  });

  app.get('/api/evidence/:exec/*', async (req, reply) => {
    const p = req.params as any;
    const root = path.resolve(cfg.dataDir, 'evidence', p.exec.replace(/[^\w-]/g, ''));
    const full = path.resolve(root, p['*']);
    if (!full.startsWith(root + path.sep) || !fs.existsSync(full)) throw new HttpError(404, 'Preuve introuvable');
    const ext = path.extname(full).toLowerCase();
    const types: Record<string, string> = { '.png': 'image/png', '.webm': 'video/webm', '.zip': 'application/zip', '.har': 'application/json', '.log': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
    reply.header('content-type', types[ext] ?? 'application/octet-stream');
    return reply.send(fs.createReadStream(full));
  });

  /* ---------------- Webhook CI/CD ---------------- */
  app.post('/api/hooks/campaigns/:id', async req => {
    const c = store.get<Campaign>('campaigns', (req.params as any).id);
    const token = (req.headers['x-testhub-token'] as string) ?? (req.query as any).token;
    if (!c || !c.webhookTokenHash || !token || !safeEqual(c.webhookTokenHash, createHash('sha256').update(token).digest('hex'))) throw new HttpError(401, 'Jeton de webhook invalide');
    const b = (req.body ?? {}) as any;
    const q = req.query as any;
    const who: Principal = { id: 'webhook', name: `webhook:${c.name}`, roles: ['tester'] };
    return startExec(who, { kind: 'campaign', refId: c.id, environmentId: b.environmentId, variables: b.variables, wait: b.wait ?? q.wait === 'true', approvalId: b.approvalId }, 'webhook');
  });

  /* ---------------- Validations (production) ---------------- */
  app.get('/api/approvals', async req => guard.list((req.query as any).status));
  app.post('/api/approvals/:id/decision', async req => {
    const b = req.body as { decision: 'approve' | 'reject'; comment?: string };
    return guard.decide((req.params as any).id, req.user!, b.decision, b.comment);
  });
  app.post('/api/approvals/:id/execute', async req => {
    const me = need(req, 'tester');
    const a = store.get<Approval>('approvals', (req.params as any).id);
    if (!a) throw new HttpError(404, 'Demande introuvable');
    if (a.requestedBy !== me.name && !hasRole(me, 'admin')) throw new HttpError(403, 'Seul le demandeur peut lancer l\'action validée');
    const p = a.action.payload as any;
    if (a.action.type === 'execution') return startExec(me, { ...p, approvalId: a.id }, 'manual');
    return runEditorQuery(me, p.environmentId, p.database, p.sql, !!p.allowDestructive, a.id);
  });

  /* ---------------- Audit ---------------- */
  app.get('/api/audit', async req => { const q = req.query as any; return audit.query({ ...q, limit: q.limit ? Number(q.limit) : undefined }); });

  /* ---------------- Enregistreur ---------------- */
  app.post('/api/recorder/start', async req => {
    need(req, 'tester');
    const b = req.body as { environmentId: string; path?: string; headless?: boolean };
    const env = envs.require(b.environmentId);
    if (!env.frontUrl) throw new HttpError(400, 'L\'environnement n\'a pas d\'URL front');
    const startUrl = new URL((b.path ?? '/').replace(/^\//, ''), env.frontUrl.endsWith('/') ? env.frontUrl : env.frontUrl + '/').toString();
    return recorder.start({ startUrl, baseUrl: env.frontUrl.replace(/\/$/, ''), headless: b.headless });
  });
  app.get('/api/recorder', async () => recorder.list());
  app.get('/api/recorder/:id', async req => ({ actions: recorder.actions((req.params as any).id) }));
  app.post('/api/recorder/:id/stop', async req => {
    const me = need(req, 'tester');
    const b = (req.body ?? {}) as { saveAs?: { name: string; environmentId?: string } };
    const step = await recorder.stop((req.params as any).id);
    if (!b.saveAs?.name) return { step };
    const tc = store.put<Omit<TestCase, 'id'>>('testcases', { name: b.saveAs.name, environmentId: b.saveAs.environmentId, tags: ['enregistré'], steps: [step] });
    audit.record({ actor: me.name, kind: 'config', target: `testcases ${tc.name}`, outcome: 'success', detail: { action: 'création depuis l\'enregistreur' } });
    return { step, testCase: tc };
  });

  /* ---------------- Front ---------------- */
  if (fs.existsSync(cfg.webDist)) {
    await app.register(fastifyStatic, { root: cfg.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Route inconnue' });
      return reply.sendFile('index.html');
    });
  }

  return { app, cfg, store, envs, executions, recorder, users, guard, audit, scheduler, generatedToken };
}

import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Store } from '../core/store.js';
import type { AppConfig } from '../core/config.js';
import type { EnvironmentService } from '../environments/service.js';
import type { AuditLog } from '../security/audit.js';
import type { ProductionGuard } from '../security/approvals.js';
import type { Principal } from '../security/auth.js';
import { Masker } from '../security/masking.js';
import { ExecContext } from './context.js';
import type { Campaign, CaseResult, Execution, Extract, Hook, Status, Step, StepResult, TestCase } from './model.js';
import { lookup, renderDeep, type Vars } from './template.js';
import { jsonPathValue, type AssertionResult } from './assertions.js';
import { runUi } from './steps/ui.js';
import { runApi } from './steps/api.js';
import { runSql, runScript } from './steps/sql.js';
import { runBatch, runFileChecks, runScriptStep } from './steps/batch.js';
import type { QueryResult } from '../connectors/db/types.js';
import type { ApiResponseView } from './assertions.js';
import type { ExecResult } from '../connectors/ssh.js';
import type { RuntimeEnvironment } from '../environments/model.js';

export interface StartRequest {
  kind: 'case' | 'campaign';
  refId: string;
  environmentId?: string;
  variables?: Vars;
  trigger: Execution['trigger'];
  approvalId?: string;
}

interface StepOutput { api?: ApiResponseView; sql?: QueryResult; exec?: ExecResult }

const worst = (a: Status, b: Status): Status => {
  const rank: Status[] = ['passed', 'skipped', 'failed', 'error', 'blocked', 'cancelled'];
  return rank.indexOf(b) > rank.indexOf(a) ? b : a;
};

export class ExecutionService {
  readonly events = new EventEmitter();
  private running = new Map<string, { cancel: () => void }>();

  constructor(
    private store: Store, private cfg: AppConfig, private envs: EnvironmentService,
    private auditLog: AuditLog, private guard: ProductionGuard,
  ) { this.events.setMaxListeners(200); }

  list(limit = 100): Execution[] {
    return this.store.list<Execution>('executions').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  get(id: string) { return this.store.get<Execution>('executions', id); }

  private save(e: Execution) { this.store.put('executions', e); this.events.emit(e.id, { type: 'execution', data: summary(e) }); }

  /** Démarre une exécution (asynchrone). Lève ProductionGuardError si l'environnement l'interdit. */
  start(req: StartRequest, who: Principal): Execution {
    const ref = req.kind === 'case' ? this.store.get<TestCase>('testcases', req.refId) : this.store.get<Campaign>('campaigns', req.refId);
    if (!ref) throw new Error(`${req.kind === 'case' ? 'Cas de test' : 'Campagne'} introuvable : ${req.refId}`);
    const envId = req.environmentId ?? (ref as any).environmentId;
    if (!envId) throw new Error('Aucun environnement : précisez environmentId ou liez le cas à un environnement');
    const env = this.envs.require(envId);
    this.guard.check(env, who, { type: 'execution', summary: `${req.kind} « ${ref.name} » sur ${env.name}`, payload: { ...req, environmentId: env.id } }, req.approvalId);

    const exec = this.store.put<Omit<Execution, 'id'>>('executions', {
      kind: req.kind, refId: ref.id, name: ref.name, environmentId: env.id, environmentName: env.name,
      status: 'queued', trigger: req.trigger, triggeredBy: who.name, createdAt: new Date().toISOString(), cases: [], approvalId: req.approvalId,
    }) as Execution;
    this.auditLog.record({ actor: who.name, environment: env.name, kind: 'execution', target: `${req.kind} ${ref.name}`, outcome: 'pending', executionId: exec.id, detail: { trigger: req.trigger } });
    let cancelled = false;
    this.running.set(exec.id, { cancel: () => { cancelled = true; } });
    setImmediate(() => {
      this.runExecution(exec, ref as any, req, who, () => cancelled)
        .catch(err => { exec.status = 'error'; exec.error = String(err?.message ?? err); })
        .finally(() => {
          exec.endedAt = new Date().toISOString();
          this.running.delete(exec.id);
          this.save(exec);
          this.auditLog.record({ actor: who.name, environment: env.name, kind: 'execution', target: `${req.kind} ${ref.name}`, outcome: exec.status === 'passed' ? 'success' : 'failure', executionId: exec.id, detail: { status: exec.status } });
          this.events.emit(exec.id, { type: 'end', data: summary(exec) });
        });
    });
    return exec;
  }

  cancel(id: string) { const r = this.running.get(id); if (!r) return false; r.cancel(); return true; }

  /** Attend la fin d'une exécution (utile pour les tests et les appels CI synchrones). */
  wait(id: string, timeoutMs = 600000): Promise<Execution> {
    return new Promise((resolve, reject) => {
      const done = () => { const e = this.get(id)!; if (!this.running.has(id) && !['queued', 'running'].includes(e.status)) { cleanup(); resolve(e); return true; } return false; };
      const onEv = (ev: any) => { if (ev.type === 'end') done(); };
      const t = setTimeout(() => { cleanup(); reject(new Error('Délai d\'attente dépassé')); }, timeoutMs);
      const cleanup = () => { clearTimeout(t); this.events.off(id, onEv); };
      this.events.on(id, onEv);
      done();
    });
  }

  private async runExecution(exec: Execution, ref: TestCase | Campaign, req: StartRequest, who: Principal, isCancelled: () => boolean) {
    exec.status = 'running'; exec.startedAt = new Date().toISOString(); this.save(exec);
    const masker = new Masker({ sensitiveKeys: [] });
    const env = await this.envs.resolve(exec.environmentId, masker);
    const evidenceDir = path.join(this.cfg.dataDir, 'evidence', exec.id);
    const emit = (type: string, data: unknown) => this.events.emit(exec.id, { type, data });
    // Comptes de test exposés en variables : {{account.<profil>.username}} / {{account.<profil>.password}} (masqué dans les logs).
    const account = Object.fromEntries(env.accounts.map(a => [a.profile, { username: a.username, password: a.password }]));
    const baseVars: Vars = { env: { name: env.name, kind: env.kind, frontUrl: env.frontUrl, apiUrl: env.apiUrl, ...(env.variables ?? {}) }, account, ...(env.variables ?? {}) };

    if (req.kind === 'case') {
      const tc = ref as TestCase;
      exec.cases = [];
      await this.runCase(exec, tc, env, masker, who, evidenceDir, { ...baseVars, ...(req.variables ?? {}) }, emit, isCancelled);
    } else {
      const camp = ref as Campaign;
      const campVars = { ...baseVars, ...(camp.variables ?? {}), ...(req.variables ?? {}) };
      const hookCtx = new ExecContext(exec.id, env, masker, this.auditLog, who.name, evidenceDir, campVars, emit);
      const setupRes = await this.runHooks(hookCtx, camp.setup, 'setup campagne');
      if (setupRes && setupRes.status !== 'passed') {
        exec.cases.push({ caseId: '-', name: 'Setup de campagne', status: setupRes.status, startedAt: setupRes.startedAt, durationMs: setupRes.durationMs, steps: [setupRes] });
      } else {
        for (const id of camp.caseIds) {
          if (isCancelled()) break;
          const tc = this.store.get<TestCase>('testcases', id);
          if (!tc) { exec.cases.push({ caseId: id, name: `(cas supprimé ${id})`, status: 'error', startedAt: new Date().toISOString(), durationMs: 0, steps: [] }); continue; }
          const results = await this.runCase(exec, tc, env, masker, who, evidenceDir, { ...campVars }, emit, isCancelled);
          if (camp.stopOnFailure && results.some(r => r.status !== 'passed')) break;
        }
      }
      const td = await this.runHooks(hookCtx, camp.teardown, 'teardown campagne');
      if (td && td.status !== 'passed') exec.cases.push({ caseId: '-', name: 'Teardown de campagne', status: td.status, startedAt: td.startedAt, durationMs: td.durationMs, steps: [td] });
      await hookCtx.closeAll();
    }
    exec.status = isCancelled() ? 'cancelled' : exec.cases.reduce<Status>((s, c) => worst(s, c.status), 'passed');
  }

  private async runHooks(ctx: ExecContext, hooks: Hook[] | undefined, label: string): Promise<StepResult | undefined> {
    if (!hooks?.length) return undefined;
    const sr = newStep(label, label, 'hook');
    ctx.current = sr;
    const t0 = Date.now();
    try {
      for (const h of hooks) {
        await runScript(ctx, h.database, h.script, h.allowDestructive);
        sr.assertions.push({ assertion: `${label} sur ${h.database}`, ok: true });
      }
      sr.status = 'passed';
    } catch (e: any) {
      sr.status = 'error'; sr.error = ctx.masker.text(e.message);
      ctx.log(`ERREUR ${label} : ${e.message}`);
    }
    sr.durationMs = Date.now() - t0;
    return sr;
  }

  private async runCase(exec: Execution, tc: TestCase, env: RuntimeEnvironment, masker: Masker, who: Principal, evidenceDir: string, vars: Vars, emit: (t: string, d: unknown) => void, isCancelled: () => boolean): Promise<CaseResult[]> {
    const rows = Array.isArray(tc.dataset) ? tc.dataset : [tc.dataset ?? {}];
    const out: CaseResult[] = [];
    for (const [di, row] of rows.entries()) {
      if (isCancelled()) break;
      const cr: CaseResult = { caseId: tc.id, name: tc.name + (rows.length > 1 ? ` [jeu ${di + 1}]` : ''), datasetIndex: rows.length > 1 ? di : undefined, status: 'running', startedAt: new Date().toISOString(), durationMs: 0, steps: [] };
      exec.cases.push(cr); out.push(cr); this.save(exec);
      const t0 = Date.now();
      const ctx = new ExecContext(exec.id, env, masker, this.auditLog, who.name, path.join(evidenceDir, `${exec.cases.length}`), { ...vars, ...row, data: row }, emit);
      let status: Status = 'passed';
      try {
        const setup = await this.runHooks(ctx, tc.setup, 'setup');
        if (setup) { cr.steps.push(setup); status = worst(status, setup.status); }
        // Rollback transactionnel : toutes les écritures du cas sur ces bases seront annulées.
        for (const name of tc.transactional ?? []) {
          const d = await ctx.db(name);
          await d.session.begin();
          ctx.log(`Transaction ouverte sur ${name} (rollback en fin de cas)`);
        }
        if (status === 'passed') {
          status = await this.runSteps(ctx, tc.steps, '', cr, exec, isCancelled);
        }
      } catch (e: any) {
        status = 'error';
        const sr = newStep('init', 'initialisation', 'hook'); sr.status = 'error'; sr.error = masker.text(e.message); cr.steps.push(sr);
      } finally {
        for (const name of tc.transactional ?? []) {
          const d = ctx.dbs.get(name);
          if (d) { await d.session.rollback().catch(() => {}); ctx.log(`Rollback transactionnel sur ${name}`); ctx.audit({ kind: 'sql', target: `${name}: ROLLBACK (fin de cas)`, outcome: 'success' }); }
        }
        const td = await this.runHooks(ctx, tc.teardown, 'teardown');
        if (td) { cr.steps.push(td); if (td.status !== 'passed') status = worst(status, td.status); }
        ctx.current = cr.steps[cr.steps.length - 1];
        await ctx.closeAll();
      }
      cr.status = isCancelled() && status === 'passed' ? 'cancelled' : status;
      cr.durationMs = Date.now() - t0;
      this.save(exec);
    }
    return out;
  }

  private async runSteps(ctx: ExecContext, steps: Step[], prefix: string, cr: CaseResult, exec: Execution, isCancelled: () => boolean): Promise<Status> {
    let status: Status = 'passed';
    let stop = false;
    for (const [i, step] of steps.entries()) {
      const index = `${prefix}${i + 1}`;
      const sr = newStep(index, step.name ?? `${step.type} ${index}`, step.type);
      cr.steps.push(sr);
      if (stop || isCancelled()) { sr.status = isCancelled() ? 'cancelled' : 'skipped'; continue; }
      ctx.current = sr;
      this.events.emit(exec.id, { type: 'step', data: { index, name: sr.name, status: 'running' } });
      const t0 = Date.now();
      try {
        const { assertions, output } = await this.runOne(ctx, step);
        sr.assertions.push(...assertions);
        if (step.extract?.length) sr.outputs = applyExtract(ctx, step.extract, output);
        sr.status = assertions.every(a => a.ok) ? 'passed' : 'failed';
        for (const a of assertions) ctx.log(`${a.ok ? '✔' : '✘'} ${a.assertion}${a.ok ? '' : ` (attendu ${JSON.stringify(a.expected)}, obtenu ${JSON.stringify(a.actual)?.slice(0, 300)})`}`);
      } catch (e: any) {
        sr.status = e?.constructor?.name === 'SqlGuardError' ? 'blocked' : 'error';
        sr.error = ctx.masker.text(e.message ?? String(e));
        ctx.log(`ERREUR : ${sr.error}`);
      }
      // Fermeture du navigateur si l'étape UI ne garde pas la session, ou si la suivante n'est pas UI.
      const next = steps[i + 1];
      if (ctx.ui && step.type === 'ui' && (step.keepSession === false || !next || next.type !== 'ui' || (sr.status !== 'passed' && !step.continueOnFailure))) await ctx.closeUi();
      sr.durationMs = Date.now() - t0;
      sr.assertions = ctx.masker.value(sr.assertions, ctx.env.sensitiveColumns);
      this.events.emit(exec.id, { type: 'step', data: { index, name: sr.name, status: sr.status, durationMs: sr.durationMs } });
      this.save(exec);

      // Étapes de vérification chaînées d'un batch (ex. effet en base).
      if (step.type === 'batch' && step.then?.length && sr.status === 'passed') {
        const sub = await this.runSteps(ctx, step.then, `${index}.`, cr, exec, isCancelled);
        status = worst(status, sub);
        if (sub !== 'passed' && !step.continueOnFailure) stop = true;
      }
      status = worst(status, sr.status);
      if (sr.status !== 'passed' && !step.continueOnFailure) stop = true;
    }
    return status;
  }

  private async runOne(ctx: ExecContext, step: Step): Promise<{ assertions: AssertionResult[]; output: StepOutput }> {
    switch (step.type) {
      case 'ui': return { assertions: await runUi(ctx, step), output: {} };
      case 'api': { const r = await runApi(ctx, step); return { assertions: r.assertions, output: { api: r.response } }; }
      case 'sql': { const r = await runSql(ctx, step); return { assertions: r.assertions, output: { sql: r.result } }; }
      case 'script': { const r = await runScriptStep(ctx, step); return { assertions: r.assertions, output: { exec: r.exec } }; }
      case 'batch': { const r = await runBatch(ctx, step); return { assertions: r.assertions, output: { exec: r.exec } }; }
      case 'file': return { assertions: await runFileChecks(ctx, [step]), output: {} };
      default: throw new Error(`Type d'étape inconnu : ${(step as any).type}`);
    }
  }
}

function newStep(index: string, name: string, type: StepResult['type']): StepResult {
  return { index, name, type, status: 'running', startedAt: new Date().toISOString(), durationMs: 0, assertions: [], logs: [], evidence: [] };
}

function applyExtract(ctx: ExecContext, extracts: Extract[], o: StepOutput): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const raw of extracts) {
    const x = renderDeep(raw, ctx.vars);
    let v: unknown;
    switch (x.from) {
      case 'jsonpath': v = o.api?.json !== undefined ? jsonPathValue(o.api.json, x.path!) : undefined; break;
      case 'header': v = o.api?.headers[(x.name ?? '').toLowerCase()]; break;
      case 'status': v = o.api?.status; break;
      case 'column': {
        const row = o.sql?.rows[x.row ?? 0];
        if (row) { const k = Object.keys(row).find(c => c.toLowerCase() === (x.column ?? Object.keys(row)[0]).toLowerCase()); v = k ? row[k] : undefined; }
        break;
      }
      case 'rowCount': v = o.sql?.rowCount; break;
      case 'stdout': v = o.exec?.stdout.trim(); break;
      case 'exitCode': v = o.exec?.exitCode; break;
      case 'regex': {
        const src = o.exec?.stdout ?? o.api?.bodyText ?? '';
        const m = new RegExp(x.pattern!).exec(src);
        v = m ? m[x.group ?? 1] ?? m[0] : undefined;
        break;
      }
      case 'url': v = ctx.ui?.page.url(); break;
      default: v = lookup(ctx.vars, x.path ?? '');
    }
    if (v === undefined) throw new Error(`Extraction de {{${x.var}}} impossible (${x.from}${x.path ? ' ' + x.path : ''})`);
    ctx.vars[x.var] = v;
    outputs[x.var] = v;
    ctx.log(`Variable ${x.var} = ${JSON.stringify(v)}`);
  }
  return ctx.masker.value(outputs);
}

export function summary(e: Execution) {
  const steps = e.cases.flatMap(c => c.steps);
  return {
    id: e.id, name: e.name, kind: e.kind, status: e.status, environmentName: e.environmentName, trigger: e.trigger, triggeredBy: e.triggeredBy,
    createdAt: e.createdAt, startedAt: e.startedAt, endedAt: e.endedAt, error: e.error,
    counts: { cases: e.cases.length, passed: e.cases.filter(c => c.status === 'passed').length, steps: steps.length, failedSteps: steps.filter(s => !['passed', 'skipped'].includes(s.status)).length },
  };
}

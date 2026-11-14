import type { ExecContext } from '../context.js';
import type { BatchStep, FileCheck, FileStep, Launcher, ScriptStep } from '../model.js';
import { renderDeep, renderString, shellQuote } from '../template.js';
import type { AssertionResult } from '../assertions.js';
import { sshExec, type ExecResult } from '../../connectors/ssh.js';
import { AgentClient } from '../../connectors/agent.js';
import { runAirflow, runControlM, runGitlab, runJenkins, type JobRun } from '../../connectors/schedulers.js';
import { checkFile, loadFile, parseFile } from '../../files/files.js';
import { runScript } from './sql.js';

const DEFAULT_TIMEOUT = 10 * 60 * 1000;

function streamer(ctx: ExecContext, prefix: string) {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) { ctx.log(`${prefix} ${buf.slice(0, nl)}`); buf = buf.slice(nl + 1); }
    },
    flush() { if (buf) ctx.log(`${prefix} ${buf}`); buf = ''; },
  };
}

function server(ctx: ExecContext, name: string) {
  const s = ctx.env.servers.find(x => x.name === name);
  if (!s) throw new Error(`Serveur SSH « ${name} » non déclaré dans l'environnement ${ctx.env.name}`);
  return s;
}
function agent(ctx: ExecContext, name: string) {
  const a = ctx.env.agents.find(x => x.name === name);
  if (!a) throw new Error(`Agent « ${name} » non déclaré dans l'environnement ${ctx.env.name}`);
  return new AgentClient(a);
}
function scheduler(ctx: ExecContext, name: string) {
  const s = ctx.env.schedulers.find(x => x.name === name);
  if (!s) throw new Error(`Ordonnanceur « ${name} » non déclaré dans l'environnement ${ctx.env.name}`);
  return s;
}

async function execStreaming(ctx: ExecContext, run: (o: { onStdout: (s: string) => void; onStderr: (s: string) => void }) => Promise<ExecResult>): Promise<ExecResult> {
  const out = streamer(ctx, '[stdout]'), err = streamer(ctx, '[stderr]');
  const r = await run({ onStdout: s => out.push(s), onStderr: s => err.push(s) });
  out.flush(); err.flush();
  return r;
}

function evidenceForExec(ctx: ExecContext, label: string, r: ExecResult | JobRun) {
  const text = 'stdout' in r ? `$ ${label}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n--- code retour : ${r.exitCode}${r.timedOut ? ' (timeout)' : ''} — ${r.durationMs} ms`
    : `${label}\n${r.url ?? r.externalId}\n--- état : ${r.state}, code : ${r.exitCode} — ${r.durationMs} ms\n${r.log}`;
  ctx.saveEvidence('log', label, text, 'log');
}

/* ---------------- Étape Script ---------------- */
export async function runScriptStep(ctx: ExecContext, step: ScriptStep): Promise<{ assertions: AssertionResult[]; exec?: ExecResult }> {
  const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT;
  const script = renderString(step.script, ctx.vars);
  const args = (step.args ?? []).map(a => renderString(a, ctx.vars));
  const expect = step.expectExitCode ?? 0;

  if (step.language === 'sql') {
    if (!('database' in step.target)) throw new Error('Script SQL : cible database obligatoire');
    // Les variables {{x}} du script SQL d'origine sont liées en paramètres par runScript.
    const n = await runScript(ctx, step.target.database, step.script, step.allowDestructive);
    return { assertions: [{ assertion: 'script SQL exécuté', ok: true, actual: `${n} instruction(s)` }] };
  }

  let r: ExecResult;
  let label: string;
  if ('server' in step.target) {
    const s = server(ctx, step.target.server);
    const it = s.interpreters ?? {};
    const interp = step.language === 'shell' ? `${it.shell ?? 'bash'} -s --`
      : step.language === 'python' ? `${it.python ?? 'python3'} -`
      : `${it.powershell ?? 'pwsh'} -NoProfile -NonInteractive -Command -`;
    const cmd = `${interp}${args.length ? ' ' + args.map(shellQuote).join(' ') : ''}`;
    label = `${step.language} sur ${s.name} (${s.user}@${s.host})`;
    ctx.log(`Exécution ${label}`);
    r = await execStreaming(ctx, o => sshExec(s, cmd, { ...o, stdin: script, timeoutMs }));
  } else if ('agent' in step.target) {
    const a = agent(ctx, step.target.agent);
    label = `${step.language} via agent ${step.target.agent}`;
    ctx.log(`Exécution ${label}`);
    r = await execStreaming(ctx, o => a.exec({ interpreter: step.language as any, script, args }, { ...o, timeoutMs }));
  } else throw new Error('Script : cible server ou agent obligatoire');

  ctx.log(`→ code retour ${r.exitCode}${r.timedOut ? ' (timeout ' + timeoutMs + ' ms)' : ''} en ${r.durationMs} ms`);
  evidenceForExec(ctx, label, r);
  ctx.audit({ kind: 'script', target: label, outcome: r.exitCode === expect ? 'success' : 'failure', detail: { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, script: script.slice(0, 2000) } });
  return {
    exec: r,
    assertions: [
      { assertion: 'terminé avant le timeout', ok: !r.timedOut, expected: `≤ ${timeoutMs} ms`, actual: `${r.durationMs} ms` },
      { assertion: `code retour = ${expect}`, ok: r.exitCode === expect, expected: expect, actual: r.exitCode },
    ],
  };
}

/* ---------------- Lancement de batch ---------------- */
export async function launch(ctx: ExecContext, l: Launcher, timeoutMs: number, wait: boolean | undefined): Promise<ExecResult & { url?: string }> {
  const L = renderDeep(l, ctx.vars);
  const log = (s: string) => s.split('\n').forEach(x => ctx.log(x));
  switch (L.kind) {
    case 'ssh': {
      const s = server(ctx, L.server);
      ctx.log(`Batch SSH ${s.user}@${s.host} : ${L.command}`);
      return execStreaming(ctx, o => sshExec(s, L.command, { ...o, timeoutMs }));
    }
    case 'agent': {
      ctx.log(`Batch via agent ${L.agent} : ${L.command}`);
      const a = agent(ctx, L.agent);
      return execStreaming(ctx, o => a.exec({ command: L.command, cwd: L.cwd }, { ...o, timeoutMs }));
    }
    default: {
      const s = scheduler(ctx, L.scheduler);
      if (s.kind !== L.kind) throw new Error(`L'ordonnanceur « ${s.name} » est de type ${s.kind}, pas ${L.kind}`);
      const o = { timeoutMs, wait, log };
      const j = L.kind === 'jenkins' ? await runJenkins(s, L.job, L.parameters, o)
        : L.kind === 'gitlab' ? await runGitlab(s, L.project, L.ref, L.variables, o)
        : L.kind === 'airflow' ? await runAirflow(s, L.dag, L.conf, o)
        : await runControlM(s, L.ctm, L.folder, L.jobs, o);
      return { exitCode: j.exitCode, stdout: j.log, stderr: '', durationMs: j.durationMs, timedOut: j.state === 'timeout', url: j.url ?? j.externalId };
    }
  }
}

export async function runFileChecks(ctx: ExecContext, checks: (FileCheck | FileStep)[]): Promise<AssertionResult[]> {
  const out: AssertionResult[] = [];
  for (const raw of checks) {
    const f = renderDeep(raw, ctx.vars);
    const loaded = await loadFile(ctx.env, f);
    ctx.log(`Fichier ${loaded.location} : ${loaded.exists ? loaded.size + ' octets' : 'absent'}`);
    const parsed = loaded.exists ? parseFile(loaded.content!, f) : undefined;
    if (parsed) {
      ctx.saveEvidence('file', `fichier ${(f.source as any).path}`, parsed.text.slice(0, 200_000), 'txt');
      if (parsed.error) ctx.log(`Erreur de format : ${parsed.error}`);
    }
    for (const a of f.assertions) out.push(await checkFile(ctx.env, loaded, parsed, a));
    ctx.audit({ kind: 'file', target: loaded.location, outcome: 'success', detail: { exists: loaded.exists, size: loaded.size } });
  }
  return out;
}

/* ---------------- Étape Batch ---------------- */
export async function runBatch(ctx: ExecContext, step: BatchStep): Promise<{ assertions: AssertionResult[]; exec: ExecResult }> {
  const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT;
  const expect = step.expectExitCode ?? 0;
  const r = await launch(ctx, step.launcher, timeoutMs, step.wait);
  const label = `batch ${step.launcher.kind}${'url' in r && r.url ? ' ' + r.url : ''}`;
  ctx.log(`→ batch terminé : code ${r.exitCode}${r.timedOut ? ' (timeout)' : ''} en ${r.durationMs} ms`);
  evidenceForExec(ctx, label, r);
  ctx.audit({ kind: 'batch', target: `${step.launcher.kind}: ${JSON.stringify(renderDeep(step.launcher, ctx.vars)).slice(0, 500)}`, outcome: r.exitCode === expect && !r.timedOut ? 'success' : 'failure', detail: { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs } });
  const assertions: AssertionResult[] = [
    { assertion: 'batch terminé avant le timeout', ok: !r.timedOut, expected: `≤ ${timeoutMs} ms`, actual: `${r.durationMs} ms` },
    { assertion: `code retour = ${expect}`, ok: r.exitCode === expect, expected: expect, actual: r.exitCode },
  ];
  if (step.files?.length) assertions.push(...await runFileChecks(ctx, step.files));
  return { assertions, exec: r };
}

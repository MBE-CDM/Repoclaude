import net from 'node:net';
import { chromium } from 'playwright';
import type { RuntimeEnvironment, TestAccount } from './model.js';
import { openDb } from '../connectors/db/index.js';
import { sshConnect } from '../connectors/ssh.js';
import { AgentClient } from '../connectors/agent.js';
import { pingScheduler } from '../connectors/schedulers.js';
import { resolveUrl } from '../engine/steps/ui.js';

export interface CheckResult { target: string; kind: 'ping' | 'health' | 'login' | 'database' | 'ssh' | 'agent' | 'scheduler'; ok: boolean; durationMs: number; message: string }

export type CheckScope = 'all' | 'ping' | 'health' | 'login' | 'databases' | 'servers' | 'agents' | 'schedulers';

export function tcpPing(host: string, port: number, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`délai dépassé (${timeoutMs} ms)`)); }, timeoutMs);
    s.once('connect', () => { clearTimeout(timer); s.end(); resolve(Date.now() - t0); });
    s.once('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function timed(target: string, kind: CheckResult['kind'], fn: () => Promise<string>): Promise<CheckResult> {
  const t0 = Date.now();
  try { const message = await fn(); return { target, kind, ok: true, durationMs: Date.now() - t0, message }; }
  catch (e: any) { return { target, kind, ok: false, durationMs: Date.now() - t0, message: String(e?.message ?? e).split('\n')[0] }; }
}

function hostPort(u: string) {
  const url = new URL(u);
  return { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
}

export async function testLogin(env: RuntimeEnvironment, acc: TestAccount<string>): Promise<string> {
  const lt = acc.loginTest;
  if (!lt) throw new Error('aucun test de login configuré pour ce profil');
  if (lt.mode === 'api') {
    const url = resolveUrl(env.apiUrl ?? env.frontUrl, lt.path);
    const body = JSON.parse(JSON.stringify(lt.body ?? { username: '{{username}}', password: '{{password}}' })
      .replaceAll('{{username}}', JSON.stringify(acc.username).slice(1, -1))
      .replaceAll('{{password}}', JSON.stringify(acc.password ?? '').slice(1, -1)));
    const r = await fetch(url, { method: lt.method ?? 'POST', headers: { 'content-type': 'application/json', ...(lt.headers ?? {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const expected = lt.expectStatus ?? 200;
    if (r.status !== expected) throw new Error(`HTTP ${r.status} (attendu ${expected})`);
    return `login API OK (HTTP ${r.status})`;
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(resolveUrl(env.frontUrl, lt.path ?? '/'));
    await page.fill(lt.userSelector, acc.username);
    await page.fill(lt.passwordSelector, acc.password ?? '');
    await page.click(lt.submitSelector);
    if (lt.successSelector) await page.waitForSelector(lt.successSelector);
    if (lt.successUrlContains) await page.waitForURL(u => u.toString().includes(lt.successUrlContains!));
    return `login UI OK (${page.url()})`;
  } finally { await browser.close(); }
}

/** Tests de connexion d'un environnement : ping, health-check, login, bases, SSH, agents, ordonnanceurs. */
export async function testEnvironment(env: RuntimeEnvironment, scope: CheckScope = 'all', only?: string): Promise<CheckResult[]> {
  const jobs: Promise<CheckResult>[] = [];
  const want = (s: CheckScope) => scope === 'all' || scope === s;
  const match = (n: string) => !only || only === n;

  for (const [label, u] of [['front', env.frontUrl], ['api', env.apiUrl]] as const) {
    if (!u) continue;
    if (want('ping') && match(label)) jobs.push(timed(`${label} ${u}`, 'ping', async () => { const { host, port } = hostPort(u); return `TCP ${host}:${port} joignable en ${await tcpPing(host, port)} ms`; }));
    if (want('health') && match(label)) jobs.push(timed(`${label} ${u}`, 'health', async () => {
      const url = resolveUrl(u, label === 'api' || !env.apiUrl ? env.healthPath ?? '/' : '/');
      const r = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
      if (r.status >= 400) throw new Error(`${url} → HTTP ${r.status}`);
      return `${url} → HTTP ${r.status}`;
    }));
  }
  if (want('login')) for (const a of env.accounts) if (a.loginTest && match(a.profile)) jobs.push(timed(`compte ${a.profile} (${a.username})`, 'login', () => testLogin(env, a)));
  if (want('databases')) for (const d of env.databases) if (match(d.name)) jobs.push(timed(`base ${d.name} (${d.engine})`, 'database', async () => {
    const db = await openDb(env, d.name);
    try { await db.session.ping(); return `connexion OK${d.readOnly !== false ? ' (lecture seule)' : ''}${d.sshTunnel ? ` via tunnel ${d.sshTunnel}` : ''}`; } finally { await db.close(); }
  }));
  if (want('servers')) for (const s of env.servers) if (match(s.name)) jobs.push(timed(`serveur ${s.name} (${s.user}@${s.host})`, 'ssh', async () => { const c = await sshConnect(s); c.end(); return 'authentification SSH OK'; }));
  if (want('agents')) for (const a of env.agents) if (match(a.name)) jobs.push(timed(`agent ${a.name}`, 'agent', async () => JSON.stringify(await new AgentClient(a).health())));
  if (want('schedulers')) for (const s of env.schedulers) if (match(s.name)) jobs.push(timed(`ordonnanceur ${s.name} (${s.kind})`, 'scheduler', () => pingScheduler(s)));
  return Promise.all(jobs);
}

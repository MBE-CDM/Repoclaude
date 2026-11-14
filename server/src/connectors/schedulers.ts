import type { SchedulerConfig } from '../environments/model.js';

export interface JobRun {
  state: 'success' | 'failed' | 'timeout';
  exitCode: number | null;
  externalId: string;
  url?: string;
  log: string;
  durationMs: number;
  detail?: unknown;
}

type Log = (s: string) => void;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const trim = (u: string) => u.replace(/\/$/, '');

async function http(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; headers: Headers; text: string; json?: any }> {
  const r = await fetch(url, {
    method, headers: { ...(body !== undefined && !(body instanceof URLSearchParams) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof URLSearchParams ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30000), redirect: 'manual',
  });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { /* */ }
  if (r.status >= 400) throw new Error(`${method} ${url} → HTTP ${r.status} ${text.slice(0, 300)}`);
  return { status: r.status, headers: r.headers, text, json };
}

async function poll<T>(fn: () => Promise<T | undefined>, timeoutMs: number, intervalMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(intervalMs);
  }
  return undefined;
}

export interface TriggerOptions { timeoutMs: number; intervalMs?: number; wait?: boolean; log: Log }

/* ---------- Jenkins ---------- */
export async function runJenkins(s: SchedulerConfig<string>, job: string, params: Record<string, string> | undefined, o: TriggerOptions): Promise<JobRun> {
  const start = Date.now();
  const auth = { authorization: 'Basic ' + Buffer.from(`${s.user ?? ''}:${s.token ?? s.password ?? ''}`).toString('base64') };
  const jobPath = job.split('/').map(p => `job/${encodeURIComponent(p)}`).join('/');
  const hasParams = params && Object.keys(params).length > 0;
  const r = await http('POST', `${trim(s.baseUrl)}/${jobPath}/${hasParams ? 'buildWithParameters' : 'build'}`, auth, hasParams ? new URLSearchParams(params) : undefined);
  const queue = r.headers.get('location');
  if (!queue) throw new Error('Jenkins : en-tête Location de file d\'attente absent');
  o.log(`Jenkins : build mis en file (${queue})`);
  const buildUrl = await poll(async () => {
    const q = await http('GET', `${trim(queue)}/api/json`, auth);
    if (q.json?.cancelled) throw new Error('Jenkins : build annulé dans la file');
    return q.json?.executable?.url as string | undefined;
  }, o.timeoutMs, o.intervalMs ?? 3000);
  if (!buildUrl) return { state: 'timeout', exitCode: null, externalId: queue, log: '', durationMs: Date.now() - start };
  o.log(`Jenkins : build démarré ${buildUrl}`);
  if (o.wait === false) return { state: 'success', exitCode: 0, externalId: buildUrl, url: buildUrl, log: '', durationMs: Date.now() - start };
  let offset = 0, log = '';
  const result = await poll(async () => {
    const t = await fetch(`${trim(buildUrl)}/logText/progressiveText?start=${offset}`, { headers: auth });
    const chunk = await t.text();
    if (chunk) { log += chunk; o.log(chunk.trimEnd()); }
    offset = Number(t.headers.get('x-text-size') ?? offset + chunk.length);
    const b = await http('GET', `${trim(buildUrl)}/api/json?tree=building,result,number`, auth);
    return b.json?.building ? undefined : (b.json?.result as string);
  }, o.timeoutMs - (Date.now() - start), o.intervalMs ?? 3000);
  if (!result) return { state: 'timeout', exitCode: null, externalId: buildUrl, url: buildUrl, log, durationMs: Date.now() - start };
  return { state: result === 'SUCCESS' ? 'success' : 'failed', exitCode: result === 'SUCCESS' ? 0 : 1, externalId: buildUrl, url: buildUrl, log, durationMs: Date.now() - start, detail: { result } };
}

/* ---------- GitLab CI ---------- */
export async function runGitlab(s: SchedulerConfig<string>, project: string, ref: string, variables: Record<string, string> | undefined, o: TriggerOptions): Promise<JobRun> {
  const start = Date.now();
  const h = { 'PRIVATE-TOKEN': s.token ?? '' };
  const base = `${trim(s.baseUrl)}/api/v4/projects/${encodeURIComponent(project)}`;
  const p = await http('POST', `${base}/pipeline`, h, { ref, variables: Object.entries(variables ?? {}).map(([key, value]) => ({ key, value })) });
  const id = p.json.id, url = p.json.web_url;
  o.log(`GitLab : pipeline ${id} créé (${url})`);
  if (o.wait === false) return { state: 'success', exitCode: 0, externalId: String(id), url, log: '', durationMs: Date.now() - start };
  let last = '';
  const status = await poll(async () => {
    const r = await http('GET', `${base}/pipelines/${id}`, h);
    if (r.json.status !== last) { last = r.json.status; o.log(`GitLab : statut ${last}`); }
    return ['success', 'failed', 'canceled', 'skipped'].includes(r.json.status) ? r.json.status as string : undefined;
  }, o.timeoutMs, o.intervalMs ?? 5000);
  let log = '';
  try {
    const jobs = await http('GET', `${base}/pipelines/${id}/jobs`, h);
    for (const j of jobs.json ?? []) {
      const t = await fetch(`${base}/jobs/${j.id}/trace`, { headers: h });
      log += `===== ${j.name} (${j.status}) =====\n${(await t.text()).slice(-20000)}\n`;
    }
  } catch { /* traces facultatives */ }
  if (!status) return { state: 'timeout', exitCode: null, externalId: String(id), url, log, durationMs: Date.now() - start };
  return { state: status === 'success' ? 'success' : 'failed', exitCode: status === 'success' ? 0 : 1, externalId: String(id), url, log, durationMs: Date.now() - start, detail: { status } };
}

/* ---------- Apache Airflow (API REST stable v1) ---------- */
export async function runAirflow(s: SchedulerConfig<string>, dag: string, conf: Record<string, unknown> | undefined, o: TriggerOptions): Promise<JobRun> {
  const start = Date.now();
  const h: Record<string, string> = s.user
    ? { authorization: 'Basic ' + Buffer.from(`${s.user}:${s.password ?? s.token ?? ''}`).toString('base64') }
    : { authorization: `Bearer ${s.token ?? ''}` };
  const base = `${trim(s.baseUrl)}/api/v1/dags/${encodeURIComponent(dag)}/dagRuns`;
  const runId = `testhub__${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await http('POST', base, h, { dag_run_id: runId, conf: conf ?? {} });
  o.log(`Airflow : DAG ${dag} déclenché (run ${runId})`);
  if (o.wait === false) return { state: 'success', exitCode: 0, externalId: runId, log: '', durationMs: Date.now() - start };
  let last = '';
  const state = await poll(async () => {
    const r = await http('GET', `${base}/${encodeURIComponent(runId)}`, h);
    if (r.json.state !== last) { last = r.json.state; o.log(`Airflow : état ${last}`); }
    return ['success', 'failed'].includes(r.json.state) ? r.json.state as string : undefined;
  }, o.timeoutMs, o.intervalMs ?? 5000);
  let log = '';
  try {
    const tis = await http('GET', `${base}/${encodeURIComponent(runId)}/taskInstances`, h);
    log = (tis.json.task_instances ?? []).map((t: any) => `${t.task_id}: ${t.state} (${t.duration ?? '?'} s)`).join('\n');
  } catch { /* */ }
  if (!state) return { state: 'timeout', exitCode: null, externalId: runId, log, durationMs: Date.now() - start };
  return { state: state === 'success' ? 'success' : 'failed', exitCode: state === 'success' ? 0 : 1, externalId: runId, log, durationMs: Date.now() - start, detail: { state } };
}

/* ---------- Control-M (Automation API) ---------- */
export async function runControlM(s: SchedulerConfig<string>, ctm: string, folder: string, jobs: string | undefined, o: TriggerOptions): Promise<JobRun> {
  const start = Date.now();
  const base = `${trim(s.baseUrl)}/automation-api`;
  let h: Record<string, string>;
  if (s.user) {
    const l = await http('POST', `${base}/session/login`, {}, { username: s.user, password: s.password ?? s.token });
    h = { authorization: `Bearer ${l.json.token}` };
  } else h = { 'x-api-key': s.token ?? '' };
  const r = await http('POST', `${base}/run/order`, h, { ctm, folder, ...(jobs ? { jobs } : {}) });
  const runId = r.json.runId;
  o.log(`Control-M : ordre ${runId} (${ctm}/${folder}${jobs ? '/' + jobs : ''})`);
  if (o.wait === false) return { state: 'success', exitCode: 0, externalId: runId, log: '', durationMs: Date.now() - start };
  let statuses: any[] = [];
  const done = await poll(async () => {
    const st = await http('GET', `${base}/run/status/${encodeURIComponent(runId)}`, h);
    statuses = (st.json.statuses ?? []).filter((x: any) => x.type !== 'Folder');
    const pending = statuses.filter(x => !/^Ended/i.test(x.status));
    return statuses.length && !pending.length ? true : undefined;
  }, o.timeoutMs, o.intervalMs ?? 5000);
  const log = statuses.map(x => `${x.name} [${x.jobId}] : ${x.status}`).join('\n');
  o.log(log);
  if (!done) return { state: 'timeout', exitCode: null, externalId: runId, log, durationMs: Date.now() - start };
  const ok = statuses.every(x => /Ended OK/i.test(x.status));
  return { state: ok ? 'success' : 'failed', exitCode: ok ? 0 : 1, externalId: runId, log, durationMs: Date.now() - start, detail: { statuses } };
}

export async function pingScheduler(s: SchedulerConfig<string>): Promise<string> {
  const urls: Record<string, string> = { jenkins: '/api/json', gitlab: '/api/v4/version', airflow: '/api/v1/health', controlm: '/automation-api/status' };
  const r = await fetch(trim(s.baseUrl) + urls[s.kind], { signal: AbortSignal.timeout(10000), headers: s.kind === 'gitlab' ? { 'PRIVATE-TOKEN': s.token ?? '' } : {} });
  return `HTTP ${r.status}`;
}

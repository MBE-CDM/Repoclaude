import type { ExecutionAgent } from '../environments/model.js';
import type { ExecOptions, ExecResult } from './ssh.js';

/** Client de l'agent d'exécution (agent/agent.mjs). */
export class AgentClient {
  constructor(private a: ExecutionAgent<string>) {}
  private headers() { return { authorization: `Bearer ${this.a.token ?? ''}`, 'content-type': 'application/json' }; }
  private url(p: string) { return `${this.a.url.replace(/\/$/, '')}${p}`; }

  async health(): Promise<unknown> {
    const r = await fetch(this.url('/health'), { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Agent ${this.a.name} : HTTP ${r.status}`);
    return r.json();
  }

  async exec(body: { command?: string; interpreter?: 'shell' | 'python' | 'powershell'; script?: string; args?: string[]; cwd?: string; env?: Record<string, string> }, o: ExecOptions = {}): Promise<ExecResult> {
    const start = Date.now();
    const r = await fetch(this.url('/exec'), {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ ...body, timeoutMs: o.timeoutMs }),
      signal: o.timeoutMs ? AbortSignal.timeout(o.timeoutMs + 15000) : undefined,
    });
    if (!r.ok || !r.body) throw new Error(`Agent ${this.a.name} : HTTP ${r.status} ${await r.text().catch(() => '')}`);
    let stdout = '', stderr = '', buf = '';
    let exit: any;
    const dec = new TextDecoder();
    for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.type === 'stdout') { stdout += m.data; o.onStdout?.(m.data); }
        else if (m.type === 'stderr') { stderr += m.data; o.onStderr?.(m.data); }
        else if (m.type === 'exit') exit = m;
      }
    }
    if (!exit) throw new Error(`Agent ${this.a.name} : flux interrompu avant la fin du processus`);
    return { exitCode: exit.code, signal: exit.signal ?? undefined, stdout, stderr, durationMs: exit.durationMs ?? Date.now() - start, timedOut: !!exit.timedOut };
  }

  async stat(p: string): Promise<{ exists: boolean; size?: number }> {
    const r = await fetch(this.url(`/files/stat?path=${encodeURIComponent(p)}`), { headers: this.headers() });
    if (!r.ok) throw new Error(`Agent ${this.a.name} : ${r.status} ${await r.text()}`);
    return r.json() as any;
  }

  async read(p: string): Promise<Buffer> {
    const r = await fetch(this.url(`/files/read?path=${encodeURIComponent(p)}`), { headers: this.headers() });
    if (!r.ok) throw new Error(`Agent ${this.a.name} : ${r.status} ${await r.text()}`);
    return Buffer.from(await r.arrayBuffer());
  }
}

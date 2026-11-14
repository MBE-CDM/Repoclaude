#!/usr/bin/env node
/**
 * Agent d'exécution TestHub — à installer sur un serveur de l'environnement cible.
 * Sans dépendance (Node >= 18). Expose en HTTP(S) :
 *   GET  /health
 *   POST /exec          { command? | (interpreter + script), args?, cwd?, timeoutMs?, env? }
 *                       → flux NDJSON : {type:'stdout'|'stderr',data} … {type:'exit',code,signal,durationMs,timedOut}
 *   GET  /files/stat?path=…   GET /files/read?path=…  (limité aux racines AGENT_FILE_ROOTS)
 *
 * Variables : AGENT_TOKEN (obligatoire), AGENT_PORT (8765), AGENT_HOST (0.0.0.0),
 *             AGENT_FILE_ROOTS (séparées par « : », ou « ; » sous Windows), AGENT_TLS_CERT / AGENT_TLS_KEY (HTTPS).
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

const TOKEN = process.env.AGENT_TOKEN;
if (!TOKEN) { console.error('AGENT_TOKEN est obligatoire'); process.exit(1); }
const PORT = Number(process.env.AGENT_PORT ?? 8765);
const HOST = process.env.AGENT_HOST ?? '0.0.0.0';
const isWin = process.platform === 'win32';
const ROOTS = (process.env.AGENT_FILE_ROOTS ?? '').split(isWin ? ';' : ':').filter(Boolean).map(r => path.resolve(r));

const INTERPRETERS = {
  shell: isWin ? ['cmd.exe', ['/d', '/s', '/c']] : ['bash', ['-s', '--']],
  powershell: [isWin ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', '-']],
  python: [isWin ? 'python' : 'python3', ['-']],
};

function authorized(req) {
  const h = req.headers.authorization ?? '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(t), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function allowedPath(p) {
  const full = path.resolve(p);
  return ROOTS.some(r => full === r || full.startsWith(r + path.sep));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 10 * 1024 * 1024) reject(new Error('corps trop volumineux')); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://agent');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, platform: process.platform, hostname: (await import('node:os')).hostname() })); }
  if (!authorized(req)) { res.writeHead(401); return res.end('unauthorized'); }

  if (req.method === 'POST' && url.pathname === '/exec') {
    const b = await readBody(req);
    let cmd, args, stdin;
    if (b.interpreter) {
      const it = INTERPRETERS[b.interpreter];
      if (!it) { res.writeHead(400); return res.end('interpréteur inconnu'); }
      [cmd, args] = [it[0], [...it[1], ...(b.interpreter === 'shell' && !isWin ? (b.args ?? []) : [])]];
      stdin = b.script ?? '';
      if (b.interpreter === 'shell' && isWin) { args = [...args, b.script]; stdin = undefined; }
    } else if (b.command) {
      [cmd, args] = isWin ? ['cmd.exe', ['/d', '/s', '/c', b.command]] : ['bash', ['-c', b.command]];
    } else { res.writeHead(400); return res.end('command ou interpreter+script requis'); }

    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const start = Date.now();
    const child = spawn(cmd, args, { cwd: b.cwd || undefined, env: { ...process.env, ...(b.env ?? {}), AGENT_TOKEN: '' }, windowsHide: true });
    let timedOut = false;
    const timer = b.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, b.timeoutMs) : undefined;
    const send = o => res.write(JSON.stringify(o) + '\n');
    child.stdout.on('data', d => send({ type: 'stdout', data: d.toString() }));
    child.stderr.on('data', d => send({ type: 'stderr', data: d.toString() }));
    child.on('error', e => send({ type: 'stderr', data: `spawn: ${e.message}\n` }));
    child.on('close', (code, signal) => { if (timer) clearTimeout(timer); send({ type: 'exit', code: timedOut ? null : code, signal, durationMs: Date.now() - start, timedOut }); res.end(); });
    req.on('close', () => { if (child.exitCode === null) child.kill('SIGKILL'); });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/files/stat' || url.pathname === '/files/read')) {
    const p = url.searchParams.get('path') ?? '';
    if (!allowedPath(p)) { res.writeHead(403); return res.end('chemin hors des racines autorisées'); }
    if (url.pathname === '/files/stat') {
      res.writeHead(200, { 'content-type': 'application/json' });
      try { const st = fs.statSync(p); return res.end(JSON.stringify({ exists: true, size: st.size, mtime: st.mtimeMs })); }
      catch { return res.end(JSON.stringify({ exists: false })); }
    }
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end('introuvable'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return fs.createReadStream(p).pipe(res);
  }
  res.writeHead(404); res.end();
}

const server = process.env.AGENT_TLS_CERT
  ? https.createServer({ cert: fs.readFileSync(process.env.AGENT_TLS_CERT), key: fs.readFileSync(process.env.AGENT_TLS_KEY) }, (q, s) => handle(q, s).catch(e => { s.writeHead(500); s.end(String(e.message)); }))
  : http.createServer((q, s) => handle(q, s).catch(e => { s.writeHead(500); s.end(String(e.message)); }));
server.listen(PORT, HOST, () => console.log(`Agent TestHub à l'écoute sur ${HOST}:${server.address().port}`));

import { Client, type ConnectConfig } from 'ssh2';
import net from 'node:net';
import type { SshServer } from '../environments/model.js';

export function sshConfig(s: SshServer<string>): ConnectConfig {
  return {
    host: s.host, port: s.port ?? 22, username: s.user,
    password: s.password, privateKey: s.privateKey, passphrase: s.passphrase,
    readyTimeout: 15000, keepaliveInterval: 10000,
  };
}

export function sshConnect(s: SshServer<string>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.once('ready', () => resolve(c)).once('error', reject).connect(sshConfig(s));
  });
}

export interface ExecOptions {
  stdin?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ExecResult { exitCode: number | null; signal?: string; stdout: string; stderr: string; durationMs: number; timedOut: boolean }

const MAX_CAPTURE = 5 * 1024 * 1024;

/** Exécute une commande distante en streamant stdout/stderr, avec timeout (le processus distant est tué). */
export async function sshExec(s: SshServer<string>, command: string, o: ExecOptions = {}): Promise<ExecResult> {
  const conn = await sshConnect(s);
  const start = Date.now();
  try {
    return await new Promise<ExecResult>((resolve, reject) => {
      conn.exec(command, { env: o.env, pty: false }, (err, stream) => {
        if (err) return reject(err);
        let stdout = '', stderr = '', timedOut = false;
        const timer = o.timeoutMs ? setTimeout(() => {
          timedOut = true;
          try { stream.signal('KILL'); } catch { /* */ }
          stream.close();
        }, o.timeoutMs) : undefined;
        stream.on('data', (d: Buffer) => { const t = d.toString(); if (stdout.length < MAX_CAPTURE) stdout += t; o.onStdout?.(t); });
        stream.stderr.on('data', (d: Buffer) => { const t = d.toString(); if (stderr.length < MAX_CAPTURE) stderr += t; o.onStderr?.(t); });
        stream.on('close', (code: number | null, signal?: string) => {
          if (timer) clearTimeout(timer);
          resolve({ exitCode: timedOut ? null : code, signal, stdout, stderr, durationMs: Date.now() - start, timedOut });
        });
        if (o.stdin !== undefined) stream.end(o.stdin); else stream.end();
      });
    });
  } finally {
    conn.end();
  }
}

export async function sftpRead(s: SshServer<string>, remotePath: string): Promise<Buffer> {
  const conn = await sshConnect(s);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        const chunks: Buffer[] = [];
        sftp.createReadStream(remotePath).on('data', (c: Buffer) => chunks.push(c))
          .on('error', reject).on('close', () => resolve(Buffer.concat(chunks)));
      });
    });
  } finally { conn.end(); }
}

export async function sftpStat(s: SshServer<string>, remotePath: string): Promise<{ exists: boolean; size?: number; mtime?: number }> {
  const conn = await sshConnect(s);
  try {
    return await new Promise((resolve) => {
      conn.sftp((err, sftp) => {
        if (err) return resolve({ exists: false });
        sftp.stat(remotePath, (e, st) => resolve(e ? { exists: false } : { exists: true, size: st.size, mtime: st.mtime }));
      });
    });
  } finally { conn.end(); }
}

/** Tunnel SSH local → (bastion) → dstHost:dstPort. Renvoie le port local à utiliser par le driver. */
export async function openTunnel(s: SshServer<string>, dstHost: string, dstPort: number): Promise<{ host: string; port: number; close: () => void }> {
  const conn = await sshConnect(s);
  const server = net.createServer(sock => {
    sock.on('error', () => { /* connexion cliente fermée */ });
    conn.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) => {
      if (err) { sock.destroy(); return; }
      sock.pipe(stream).pipe(sock);
      sock.on('error', () => stream.close());
      sock.on('close', () => stream.close());
      stream.on('error', () => sock.destroy());
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { host: '127.0.0.1', port, close: () => { server.close(); conn.end(); } };
}

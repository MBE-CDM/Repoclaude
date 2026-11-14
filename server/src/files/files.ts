import fs from 'node:fs';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { RuntimeEnvironment } from '../environments/model.js';
import type { FileAssertion, FileSpec, FileFormat } from '../engine/model.js';
import { sftpRead, sftpStat } from '../connectors/ssh.js';
import { AgentClient } from '../connectors/agent.js';
import { compare, jsonPathValue, diffRows, type AssertionResult } from '../engine/assertions.js';

export interface LoadedFile { exists: boolean; size?: number; location: string; content?: Buffer }

function safeJoin(root: string, p: string): string {
  const full = path.resolve(root, p.replace(/^[/\\]+/, ''));
  const r = path.resolve(root);
  if (full !== r && !full.startsWith(r + path.sep)) throw new Error(`Chemin hors du partage : ${p}`);
  return full;
}

/** Lit un fichier sur un partage local/réseau monté, en SFTP, ou via l'agent. */
export async function loadFile(env: RuntimeEnvironment, spec: FileSpec): Promise<LoadedFile> {
  const src: any = spec.source;
  if ('share' in src) {
    const share = env.fileShares.find(s => s.name === src.share);
    if (!share) throw new Error(`Partage « ${src.share} » non déclaré`);
    if (share.kind === 'local') {
      const full = safeJoin(share.root, src.path);
      if (!fs.existsSync(full)) return { exists: false, location: full };
      const content = fs.readFileSync(full);
      return { exists: true, size: content.length, location: full, content };
    }
    const srv = env.servers.find(s => s.name === share.server);
    if (!srv) throw new Error(`Partage SFTP « ${share.name} » : serveur « ${share.server} » non déclaré`);
    const remote = path.posix.join(share.root, src.path);
    const st = await sftpStat(srv, remote);
    if (!st.exists) return { exists: false, location: `sftp://${srv.host}${remote}` };
    const content = await sftpRead(srv, remote);
    return { exists: true, size: content.length, location: `sftp://${srv.host}${remote}`, content };
  }
  if ('server' in src) {
    const srv = env.servers.find(s => s.name === src.server);
    if (!srv) throw new Error(`Serveur « ${src.server} » non déclaré`);
    const st = await sftpStat(srv, src.path);
    if (!st.exists) return { exists: false, location: `sftp://${srv.host}${src.path}` };
    const content = await sftpRead(srv, src.path);
    return { exists: true, size: content.length, location: `sftp://${srv.host}${src.path}`, content };
  }
  if ('agent' in src) {
    const ag = env.agents.find(a => a.name === src.agent);
    if (!ag) throw new Error(`Agent « ${src.agent} » non déclaré`);
    const c = new AgentClient(ag);
    const st = await c.stat(src.path);
    if (!st.exists) return { exists: false, location: `agent://${ag.name}${src.path}` };
    const content = await c.read(src.path);
    return { exists: true, size: content.length, location: `agent://${ag.name}${src.path}`, content };
  }
  throw new Error('Source de fichier invalide');
}

/* ---------------- Parseurs ---------------- */
export function parseCsv(text: string, delimiter = ';', quote = '"'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === quote) { if (text[i + 1] === quote) { field += quote; i++; } else inQ = false; }
      else field += c;
    } else if (c === quote && field === '') inQ = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (inQ) throw new Error('CSV invalide : guillemet non fermé');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

export interface ParsedFile { format: FileFormat; text: string; lines: string[]; records: Record<string, unknown>[]; data?: unknown; headers?: string[]; error?: string }

export function guessFormat(p: string): FileFormat {
  const ext = path.extname(p).toLowerCase();
  return ext === '.csv' ? 'csv' : ext === '.json' ? 'json' : ext === '.xml' ? 'xml' : 'text';
}

export function parseFile(content: Buffer, spec: FileSpec): ParsedFile {
  const text = content.toString(spec.encoding ?? 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const format = spec.format ?? guessFormat((spec.source as any).path);
  const out: ParsedFile = { format, text, lines, records: [] };
  try {
    switch (format) {
      case 'csv': {
        const rows = parseCsv(text, spec.csv?.delimiter ?? ';', spec.csv?.quote ?? '"');
        if (spec.csv?.header !== false) {
          const [h, ...rest] = rows;
          out.headers = h ?? [];
          rest.forEach((r, i) => { if (r.length !== out.headers!.length) throw new Error(`CSV : ligne ${i + 2} a ${r.length} champs au lieu de ${out.headers!.length}`); });
          out.records = rest.map(r => Object.fromEntries(out.headers!.map((k, i) => [k, r[i]])));
        } else out.records = rows.map(r => Object.fromEntries(r.map((v, i) => [String(i), v])));
        break;
      }
      case 'json': {
        out.data = JSON.parse(text);
        out.records = Array.isArray(out.data) ? out.data as any[] : [out.data as any];
        break;
      }
      case 'xml': {
        const v = XMLValidator.validate(text);
        if (v !== true) throw new Error(`XML invalide : ${v.err.msg} (ligne ${v.err.line})`);
        out.data = xml.parse(text);
        // Enregistrements : premier tableau trouvé sous la racine.
        const root: any = Object.values(out.data as any).find(x => x && typeof x === 'object');
        const arr = root && Object.values(root).find(Array.isArray);
        out.records = (arr as any[]) ?? (root ? [root] : []);
        break;
      }
      case 'fixed': {
        const f = spec.fixed;
        if (!f?.fields?.length) throw new Error('Fichier positionnel : description des champs (fixed.fields) obligatoire');
        const width = Math.max(...f.fields.map(x => x.start + x.length));
        out.records = lines.slice(f.skipLines ?? 0).map((l, i) => {
          if (l.length < width) throw new Error(`Positionnel : ligne ${i + 1 + (f.skipLines ?? 0)} trop courte (${l.length} < ${width})`);
          return Object.fromEntries(f.fields.map(x => [x.name, l.slice(x.start, x.start + x.length).trim()]));
        });
        out.headers = f.fields.map(x => x.name);
        break;
      }
      case 'text': out.records = lines.map((l, i) => ({ line: i + 1, text: l })); break;
    }
  } catch (e: any) { out.error = e.message; }
  return out;
}

/* ---------------- Assertions fichiers ---------------- */
export async function checkFile(env: RuntimeEnvironment, f: LoadedFile, parsed: ParsedFile | undefined, a: FileAssertion): Promise<AssertionResult> {
  const missing = (name: string): AssertionResult => ({ assertion: name, ok: false, message: `Fichier absent : ${f.location}` });
  switch (a.type) {
    case 'exists': return { assertion: 'fichier présent', ok: f.exists, actual: f.location };
    case 'notExists': return { assertion: 'fichier absent', ok: !f.exists, actual: f.location };
  }
  if (!f.exists || !parsed) return missing(a.type);
  switch (a.type) {
    case 'formatValid': return { assertion: `format ${parsed.format} valide`, ok: !parsed.error, message: parsed.error };
    case 'lineCount': return { assertion: `nombre de lignes ${a.op ?? 'eq'} ${a.value}`, ok: compare(parsed.lines.length, a.op ?? 'eq', a.value), expected: a.value, actual: parsed.lines.length };
    case 'recordCount': return { assertion: `nombre d'enregistrements ${a.op ?? 'eq'} ${a.value}`, ok: !parsed.error && compare(parsed.records.length, a.op ?? 'eq', a.value), expected: a.value, actual: parsed.records.length, message: parsed.error };
    case 'contains': return { assertion: `contient ${JSON.stringify(a.value)}`, ok: parsed.text.includes(a.value) };
    case 'notContains': return { assertion: `ne contient pas ${JSON.stringify(a.value)}`, ok: !parsed.text.includes(a.value) };
    case 'regex': return { assertion: `correspond à /${a.pattern}/m`, ok: new RegExp(a.pattern, 'm').test(parsed.text) };
    case 'maxSize': return { assertion: `taille ≤ ${a.bytes} octets`, ok: (f.size ?? 0) <= a.bytes, actual: f.size };
    case 'headers': return { assertion: `en-têtes = ${a.value.join(', ')}`, ok: JSON.stringify(parsed.headers ?? []) === JSON.stringify(a.value), expected: a.value, actual: parsed.headers };
    case 'field': {
      const actual = parsed.records[a.row ?? 0]?.[a.field];
      const op = a.op ?? (a.value === undefined ? 'exists' : 'eq');
      return { assertion: `enregistrement ${a.row ?? 0}.${a.field} ${op} ${a.value ?? ''}`.trim(), ok: compare(actual, op, a.value), expected: a.value, actual };
    }
    case 'jsonpath': {
      const actual = jsonPathValue(parsed.data ?? parsed.records, a.path);
      const op = a.op ?? (a.value === undefined ? 'exists' : 'eq');
      return { assertion: `${a.path} ${op} ${a.value === undefined ? '' : JSON.stringify(a.value)}`.trim(), ok: compare(actual, op, a.value), expected: a.value, actual };
    }
    case 'equalsFile': {
      const of = await loadFile(env, a.other);
      if (!of.exists) return { assertion: 'identique au fichier de référence', ok: false, message: `Référence absente : ${of.location}` };
      const op = parseFile(of.content!, a.other);
      if (a.key?.length) {
        const d = diffRows(op.records, parsed.records, a.key);
        const ok = !d.added.length && !d.removed.length && !d.changed.length;
        return { assertion: `identique à ${of.location} (clé ${a.key.join(', ')})`, ok, actual: { ajoutés: d.added.length, supprimés: d.removed.length, modifiés: d.changed.length }, expected: d.changed.slice(0, 20) };
      }
      const norm = (r: Record<string, unknown>[]) => { const m = r.map(x => JSON.stringify(x)); return a.ignoreOrder ? m.sort() : m; };
      const x = norm(parsed.records), y = norm(op.records);
      const firstDiff = x.findIndex((v, i) => v !== y[i]);
      const ok = x.length === y.length && firstDiff === -1;
      return { assertion: `identique à ${of.location}`, ok, message: ok ? undefined : `Différence à l'enregistrement ${firstDiff === -1 ? Math.min(x.length, y.length) : firstDiff} (${x.length} vs ${y.length} enregistrements)` };
    }
  }
}

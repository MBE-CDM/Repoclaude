import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { keymap } from '@codemirror/view';
import { sql, PostgreSQL, MySQL, MariaSQL, MSSQL, PLSQL, SQLite, StandardSQL, type SQLDialect } from '@codemirror/lang-sql';
import { json } from '@codemirror/lang-json';
import { get, post, ApiError, type Environment } from '../api';
import { Alert, Chip, fmtMs, useLoad } from '../ui';
import type { Nav } from '../App';

const DIALECTS: Record<string, SQLDialect> = { postgres: PostgreSQL, mysql: MySQL, mariadb: MariaSQL, mssql: MSSQL, oracle: PLSQL, sqlite: SQLite, db2: StandardSQL };

export function SqlEditorPage(_: { nav: Nav }) {
  const envs = useLoad(() => get<Environment[]>('/api/environments'));
  const [envId, setEnvId] = useState('');
  const [dbName, setDbName] = useState('');
  const [text, setText] = useState('SELECT 1');
  const [schema, setSchema] = useState<any>();
  const [schemaErr, setSchemaErr] = useState<string>();
  const [analysis, setAnalysis] = useState<any[]>([]);
  const [result, setResult] = useState<any>();
  const [error, setError] = useState<{ text: string; approvalId?: string }>();
  const [busy, setBusy] = useState(false);
  const [allowDestructive, setAllowDestructive] = useState(false);

  const env = envs.data?.find(e => e.id === envId);
  const db = env?.databases.find((d: any) => d.name === dbName);

  useEffect(() => { if (envs.data?.length && !envId) setEnvId(envs.data[0].id); }, [envs.data, envId]);
  useEffect(() => { if (env && !env.databases.some((d: any) => d.name === dbName)) setDbName(env.databases[0]?.name ?? ''); }, [env, dbName]);
  useEffect(() => {
    setSchema(undefined); setSchemaErr(undefined);
    if (envId && dbName) get(`/api/environments/${envId}/databases/${encodeURIComponent(dbName)}/schema`).then(setSchema).catch(e => setSchemaErr(e.message));
  }, [envId, dbName]);
  useEffect(() => {
    const t = setTimeout(() => post('/api/sql/analyze', { sql: text, engine: db?.engine }).then(setAnalysis).catch(() => setAnalysis([])), 300);
    return () => clearTimeout(t);
  }, [text, db?.engine]);

  const completion = useMemo(() => {
    const s: Record<string, string[]> = {};
    for (const t of schema?.tables ?? []) s[t.schema && db?.engine !== 'sqlite' ? `${t.schema}.${t.name}` : t.name] = t.columns.map((c: any) => c.name);
    for (const t of schema?.tables ?? []) s[t.name] ??= t.columns.map((c: any) => c.name);
    return s;
  }, [schema, db?.engine]);

  const run = async () => {
    if (!envId || !dbName) return;
    setBusy(true); setError(undefined); setResult(undefined);
    try { setResult(await post(`/api/environments/${envId}/databases/${encodeURIComponent(dbName)}/query`, { sql: text, allowDestructive })); }
    catch (e: any) { setError({ text: e.message, approvalId: e instanceof ApiError ? e.body?.approvalId : undefined }); }
    setBusy(false);
  };

  const extensions = useMemo(() => [
    db?.engine === 'mongodb' ? json() : sql({ dialect: DIALECTS[db?.engine] ?? StandardSQL, schema: completion, upperCaseKeywords: true }),
    keymap.of([{ key: 'Mod-Enter', run: () => { run(); return true; } }]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [db?.engine, completion, envId, dbName, text, allowDestructive]);

  const writes = analysis.some(a => a.write), destructive = analysis.some(a => a.destructive);

  return (
    <>
      <h1>Éditeur SQL</h1>
      <div className="panel row">
        <select value={envId} onChange={e => setEnvId(e.target.value)}>{envs.data?.map(e => <option key={e.id} value={e.id}>{e.name}{e.isProduction ? ' (PROD)' : ''}</option>)}</select>
        <select value={dbName} onChange={e => setDbName(e.target.value)}>{env?.databases.map((d: any) => <option key={d.name} value={d.name}>{d.name} — {d.engine}</option>)}</select>
        {db && (db.readOnly !== false ? <Chip s="ok">lecture seule</Chip> : <Chip s="warn">écriture autorisée</Chip>)}
        {env?.isProduction && <Chip s="prod">PRODUCTION — validation requise</Chip>}
      </div>
      <div className="split">
        <div className="panel tree">
          <b>Schéma</b>
          {schemaErr && <Alert>{schemaErr}</Alert>}
          {!schema && !schemaErr && dbName && <div className="muted small">Chargement…</div>}
          {schema?.tables.map((t: any) => (
            <details key={`${t.schema}.${t.name}`}>
              <summary onDoubleClick={() => setText(x => `${x}${x.endsWith(' ') || !x ? '' : ' '}${t.name}`)}>{t.type === 'view' ? '👁 ' : ''}{t.schema && db?.engine !== 'sqlite' ? <span className="muted">{t.schema}.</span> : null}{t.name}</summary>
              {t.columns.map((c: any) => <div key={c.name} className="col" title="Insérer" onClick={() => setText(x => `${x}${x.endsWith(' ') || !x ? '' : ' '}${c.name}`)}>{c.name} <span className="small">{c.type}{c.nullable === false ? ' NOT NULL' : ''}</span></div>)}
            </details>
          ))}
        </div>
        <div>
          <CodeMirror value={text} height="220px" extensions={extensions} onChange={setText} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={busy || !dbName} onClick={run}>{busy ? 'Exécution…' : 'Exécuter (Ctrl+Entrée)'}</button>
            {analysis.map((a, i) => a.error ? <Chip key={i} s="ko">{a.error}</Chip> : <Chip key={i} s={a.destructive ? 'ko' : a.write ? 'warn' : 'ok'}>{a.verb || '?'}{a.destructive ? ' · destructif' : a.write ? ' · écriture' : ' · lecture'}</Chip>)}
            {destructive && <label className="small"><input type="checkbox" checked={allowDestructive} onChange={e => setAllowDestructive(e.target.checked)} /> J'autorise explicitement cette requête destructrice</label>}
          </div>
          {writes && db?.readOnly !== false && <Alert kind="warn">Cette connexion est en lecture seule : les écritures seront refusées.</Alert>}
          {error && <Alert>{error.text}{error.approvalId && <> — une demande de validation a été créée (<a href="#/approvals">voir les validations</a>).</>}</Alert>}
          {result && (
            <div className="panel scroll" style={{ marginTop: 10 }}>
              <div className="small muted">{result.affected !== undefined ? `${result.affected} ligne(s) affectée(s)` : `${result.rowCount} ligne(s)`} · {fmtMs(result.durationMs)}{result.truncated ? ' · affichage limité à 1000 lignes' : ''}</div>
              <table className="t"><thead><tr>{result.columns.map((c: string) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{result.rows.map((r: any, i: number) => <tr key={i}>{result.columns.map((c: string) => <td key={c}>{r[c] === null ? <span className="muted">NULL</span> : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c])}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

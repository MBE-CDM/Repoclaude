import { useEffect, useState } from 'react';
import { del, get, post, put, type Environment } from '../api';
import { Alert, Chip, Field, JsonEditor, fmtMs, useLoad } from '../ui';
import type { Nav } from '../App';

type Def = { key: string; label: string; type?: 'text' | 'number' | 'secret' | 'bool' | 'select' | 'json'; options?: string[]; width?: number };

const SECTIONS: { key: keyof Environment; title: string; scope: string; defs: Def[]; empty: any }[] = [
  { key: 'accounts', title: 'Comptes de test par profil', scope: 'login', empty: { profile: '', username: '' }, defs: [
    { key: 'profile', label: 'Profil' }, { key: 'username', label: 'Identifiant' }, { key: 'password', label: 'Mot de passe', type: 'secret' },
    { key: 'loginTest', label: 'Test de login (JSON)', type: 'json' },
  ] },
  { key: 'databases', title: 'Bases de données', scope: 'databases', empty: { name: '', engine: 'postgres', readOnly: true }, defs: [
    { key: 'name', label: 'Nom logique' }, { key: 'engine', label: 'Moteur', type: 'select', options: ['postgres', 'oracle', 'mssql', 'mysql', 'mariadb', 'db2', 'sqlite', 'mongodb'] },
    { key: 'host', label: 'Hôte' }, { key: 'port', label: 'Port', type: 'number' }, { key: 'database', label: 'Base / service' }, { key: 'schema', label: 'Schéma' },
    { key: 'user', label: 'Utilisateur' }, { key: 'password', label: 'Mot de passe', type: 'secret' }, { key: 'file', label: 'Fichier (SQLite)' },
    { key: 'sshTunnel', label: 'Tunnel SSH (serveur)' }, { key: 'readOnly', label: 'Lecture seule', type: 'bool' }, { key: 'allowDestructive', label: 'Autoriser le destructif', type: 'bool' },
    { key: 'ssl', label: 'SSL (JSON)', type: 'json' },
  ] },
  { key: 'servers', title: 'Serveurs d\'exécution (SSH)', scope: 'servers', empty: { name: '', host: '', port: 22, user: '' }, defs: [
    { key: 'name', label: 'Nom logique' }, { key: 'host', label: 'Hôte' }, { key: 'port', label: 'Port', type: 'number' }, { key: 'user', label: 'Utilisateur' },
    { key: 'password', label: 'Mot de passe', type: 'secret' }, { key: 'privateKey', label: 'Clé privée', type: 'secret' }, { key: 'passphrase', label: 'Phrase de passe', type: 'secret' },
    { key: 'interpreters', label: 'Interpréteurs (JSON)', type: 'json' },
  ] },
  { key: 'agents', title: 'Agents d\'exécution', scope: 'agents', empty: { name: '', url: '' }, defs: [
    { key: 'name', label: 'Nom logique' }, { key: 'url', label: 'URL' }, { key: 'token', label: 'Jeton', type: 'secret' },
  ] },
  { key: 'schedulers', title: 'Ordonnanceurs / CI', scope: 'schedulers', empty: { name: '', kind: 'jenkins', baseUrl: '' }, defs: [
    { key: 'name', label: 'Nom logique' }, { key: 'kind', label: 'Type', type: 'select', options: ['jenkins', 'gitlab', 'airflow', 'controlm'] },
    { key: 'baseUrl', label: 'URL' }, { key: 'user', label: 'Utilisateur' }, { key: 'token', label: 'Jeton / API key', type: 'secret' }, { key: 'password', label: 'Mot de passe', type: 'secret' },
  ] },
  { key: 'fileShares', title: 'Partages de fichiers', scope: 'all', empty: { name: '', kind: 'local', root: '' }, defs: [
    { key: 'name', label: 'Nom logique' }, { key: 'kind', label: 'Type', type: 'select', options: ['local', 'sftp'] }, { key: 'server', label: 'Serveur (SFTP)' }, { key: 'root', label: 'Racine' },
  ] },
];

function Cell({ d, value, onChange }: { d: Def; value: any; onChange: (v: any) => void }) {
  switch (d.type) {
    case 'secret':
      return <input type="password" autoComplete="new-password" placeholder={value?.set ? '•••••• (défini, laisser vide pour conserver)' : ''} value={typeof value === 'string' ? value : ''}
        onChange={e => onChange(e.target.value === '' ? (value?.set ? { set: true } : undefined) : e.target.value)} />;
    case 'bool': return <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} style={{ alignSelf: 'flex-start' }} />;
    case 'number': return <input type="number" value={value ?? ''} onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
    case 'select': return <select value={value ?? ''} onChange={e => onChange(e.target.value)}>{d.options!.map(o => <option key={o}>{o}</option>)}</select>;
    case 'json': return <textarea rows={2} defaultValue={value ? JSON.stringify(value) : ''} onBlur={e => { try { onChange(e.target.value ? JSON.parse(e.target.value) : undefined); } catch { alert(`${d.label} : JSON invalide`); } }} />;
    default: return <input value={value ?? ''} onChange={e => onChange(e.target.value || undefined)} />;
  }
}

export function EnvironmentsPage({ nav }: { nav: Nav }) {
  const list = useLoad(() => get<Environment[]>('/api/environments'));
  const [edit, setEdit] = useState<Environment | undefined>();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'ko'; text: string }>();
  const [checks, setChecks] = useState<any[]>();
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!list.data) return;
    const e = list.data.find(x => x.id === nav.param) ?? (nav.param === 'new' ? undefined : list.data[0]);
    if (nav.param === 'new') setEdit({ id: '', name: '', kind: 'DEV', accounts: [], databases: [], servers: [], agents: [], schedulers: [], fileShares: [] });
    else setEdit(e ? structuredClone(e) : undefined);
    setChecks(undefined); setMsg(undefined);
  }, [list.data, nav.param]);

  const save = async () => {
    if (!edit) return;
    try {
      const body: any = { ...edit }; if (!body.id) delete body.id;
      const r = edit.id ? await put(`/api/environments/${edit.id}`, body) : await post('/api/environments', body);
      setMsg({ kind: 'ok', text: 'Environnement enregistré.' });
      list.reload(); nav.go('environments', r.id);
    } catch (e: any) { setMsg({ kind: 'ko', text: e.message }); }
  };

  const test = async (scope = 'all') => {
    if (!edit?.id) return;
    setTesting(true); setChecks(undefined);
    try { setChecks(await post(`/api/environments/${edit.id}/test`, { scope })); } catch (e: any) { setMsg({ kind: 'ko', text: e.message }); }
    setTesting(false);
  };

  const upd = (patch: Partial<Environment>) => setEdit(e => ({ ...e!, ...patch }));

  return (
    <>
      <h1>Environnements cibles</h1>
      <div className="split">
        <div className="panel">
          {list.data?.map(e => (
            <div key={e.id} className={`list-item ${edit?.id === e.id ? 'active' : ''}`} onClick={() => nav.go('environments', e.id)}>
              <span>{e.name}</span>{e.isProduction ? <Chip s="prod">PROD</Chip> : <Chip>{e.kind}</Chip>}
            </div>
          ))}
          <div style={{ marginTop: 10 }}><button className="btn" onClick={() => nav.go('environments', 'new')}>+ Nouvel environnement</button></div>
          <Alert>{list.error}</Alert>
        </div>
        {edit && (
          <div>
            <div className="panel">
              <div className="grid2">
                <Field label="Nom"><input value={edit.name} onChange={e => upd({ name: e.target.value })} /></Field>
                <Field label="Type"><select value={edit.kind} onChange={e => upd({ kind: e.target.value, isProduction: e.target.value === 'PROD' ? true : edit.isProduction })}>
                  {['DEV', 'INT', 'RECETTE', 'PREPROD', 'PROD'].map(k => <option key={k}>{k}</option>)}</select></Field>
                <Field label="URL front"><input value={edit.frontUrl ?? ''} onChange={e => upd({ frontUrl: e.target.value || undefined })} placeholder="https://app.recette.exemple.fr" /></Field>
                <Field label="URL API"><input value={edit.apiUrl ?? ''} onChange={e => upd({ apiUrl: e.target.value || undefined })} placeholder="https://api.recette.exemple.fr" /></Field>
                <Field label="Chemin health-check"><input value={edit.healthPath ?? ''} onChange={e => upd({ healthPath: e.target.value || undefined })} placeholder="/actuator/health" /></Field>
                <Field label="Production"><input type="checkbox" checked={!!edit.isProduction} onChange={e => upd({ isProduction: e.target.checked })} style={{ alignSelf: 'flex-start' }} /></Field>
              </div>
              <h3>Variables d'environnement</h3>
              <JsonEditor value={edit.variables ?? {}} onChange={v => upd({ variables: v })} height="80px" />
              <h3>Colonnes sensibles (masquées)</h3>
              <input style={{ width: '100%' }} value={(edit.sensitiveColumns ?? []).join(', ')} onChange={e => upd({ sensitiveColumns: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} placeholder="email, telephone, numero_carte" />
            </div>

            {SECTIONS.map(sec => (
              <div className="panel" key={sec.key}>
                <div className="row"><h3 className="grow" style={{ margin: 0 }}>{sec.title}</h3>
                  {edit.id && sec.scope !== 'all' && <button className="btn" disabled={testing} onClick={() => test(sec.scope)}>Tester</button>}
                  <button className="btn" onClick={() => upd({ [sec.key]: [...(edit[sec.key] as any[]), structuredClone(sec.empty)] } as any)}>+ Ajouter</button>
                </div>
                {(edit[sec.key] as any[]).map((item, i) => (
                  <div key={i} className="grid2" style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
                    {sec.defs.map(d => (
                      <Field key={d.key} label={d.label}>
                        <Cell d={d} value={item[d.key]} onChange={v => { const arr = [...(edit[sec.key] as any[])]; arr[i] = { ...arr[i], [d.key]: v }; if (v === undefined) delete arr[i][d.key]; upd({ [sec.key]: arr } as any); }} />
                      </Field>
                    ))}
                    <div style={{ alignSelf: 'end' }}><button className="btn danger" onClick={() => upd({ [sec.key]: (edit[sec.key] as any[]).filter((_, j) => j !== i) } as any)}>Retirer</button></div>
                  </div>
                ))}
              </div>
            ))}

            <div className="panel row">
              <button className="btn primary" onClick={save}>Enregistrer</button>
              {edit.id && <button className="btn" disabled={testing} onClick={() => test('all')}>{testing ? 'Test en cours…' : 'Tester toutes les connexions'}</button>}
              <span className="grow" />
              {edit.id && <button className="btn danger" onClick={async () => { if (confirm(`Supprimer ${edit.name} ?`)) { await del(`/api/environments/${edit.id}`); list.reload(); nav.go('environments'); } }}>Supprimer</button>}
            </div>
            {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
            {checks && (
              <div className="panel scroll">
                <table className="t"><thead><tr><th>Cible</th><th>Test</th><th>Résultat</th><th>Durée</th><th>Détail</th></tr></thead>
                  <tbody>{checks.map((c, i) => <tr key={i}><td>{c.target}</td><td>{c.kind}</td><td><Chip s={c.ok ? 'ok' : 'ko'}>{c.ok ? 'OK' : 'KO'}</Chip></td><td>{fmtMs(c.durationMs)}</td><td className="small">{c.message}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

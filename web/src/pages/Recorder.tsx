import { useEffect, useState } from 'react';
import { get, post, type Environment } from '../api';
import { Alert, Field, useLoad } from '../ui';
import type { Nav } from '../App';

export function RecorderPage({ nav }: { nav: Nav }) {
  const envs = useLoad(() => get<Environment[]>('/api/environments'));
  const [envId, setEnvId] = useState('');
  const [path, setPath] = useState('/');
  const [session, setSession] = useState<string>();
  const [actions, setActions] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string>();

  useEffect(() => { if (!envId && envs.data?.length) setEnvId(envs.data[0].id); }, [envs.data, envId]);
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => get(`/api/recorder/${session}`).then(r => setActions(r.actions)).catch(() => {}), 1000);
    return () => clearInterval(t);
  }, [session]);

  return (
    <>
      <h1>Enregistreur de scénarios</h1>
      <div className="panel">
        <p className="small muted">Un navigateur Chromium s'ouvre <b>sur le poste du serveur TestHub</b> à l'URL front de l'environnement. Vos clics, saisies et sélections sont enregistrés puis convertis en étape UI. Les mots de passe sont remplacés par la variable <code>{'{{motDePasse}}'}</code>.</p>
        <div className="grid2">
          <Field label="Environnement"><select value={envId} onChange={e => setEnvId(e.target.value)} disabled={!!session}>{envs.data?.map(e => <option key={e.id} value={e.id}>{e.name} — {e.frontUrl ?? 'pas d\'URL front'}</option>)}</select></Field>
          <Field label="Chemin de départ"><input value={path} onChange={e => setPath(e.target.value)} disabled={!!session} /></Field>
          <Field label="Nom du cas à créer"><input value={name} onChange={e => setName(e.target.value)} placeholder="Parcours enregistré" /></Field>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          {!session && <button className="btn primary" onClick={async () => { try { setErr(undefined); setActions([]); setSession((await post('/api/recorder/start', { environmentId: envId, path })).id); } catch (e: any) { setErr(e.message); } }}>● Démarrer l'enregistrement</button>}
          {session && <button className="btn primary" onClick={async () => {
            try {
              const r = await post(`/api/recorder/${session}/stop`, { saveAs: { name: name || 'Parcours enregistré', environmentId: envId } });
              setSession(undefined); nav.go('testcases', r.testCase.id);
            } catch (e: any) { setErr(e.message); }
          }}>■ Arrêter et créer le cas de test</button>}
          {session && <button className="btn" onClick={async () => { await post(`/api/recorder/${session}/stop`); setSession(undefined); }}>Abandonner</button>}
        </div>
        <Alert>{err}</Alert>
      </div>
      {actions.length > 0 && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Actions capturées ({actions.length})</h3>
          <table className="t"><tbody>{actions.map((a, i) => <tr key={i}><td>{i + 1}</td><td><b>{a.action}</b></td><td><code>{a.selector ?? a.url ?? a.key}</code></td><td>{a.value}</td></tr>)}</tbody></table>
        </div>
      )}
    </>
  );
}

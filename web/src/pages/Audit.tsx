import { useState } from 'react';
import { get } from '../api';
import { Status, fmtDate, useLoad } from '../ui';
import type { Nav } from '../App';

export function AuditPage(_: { nav: Nav }) {
  const [kind, setKind] = useState('');
  const [environment, setEnvironment] = useState('');
  const [actor, setActor] = useState('');
  const q = new URLSearchParams({ limit: '500', ...(kind && { kind }), ...(environment && { environment }), ...(actor && { actor }) }).toString();
  const list = useLoad(() => get<any[]>(`/api/audit?${q}`), [q]);
  return (
    <>
      <h1>Journal d'audit</h1>
      <div className="panel row">
        <select value={kind} onChange={e => setKind(e.target.value)}>
          <option value="">Tous les types</option>{['sql', 'script', 'batch', 'api', 'file', 'execution', 'connection-test', 'approval', 'config'].map(k => <option key={k}>{k}</option>)}
        </select>
        <input placeholder="Environnement" value={environment} onChange={e => setEnvironment(e.target.value)} />
        <input placeholder="Utilisateur" value={actor} onChange={e => setActor(e.target.value)} />
        <button className="btn" onClick={list.reload}>Actualiser</button>
      </div>
      <div className="panel scroll">
        <table className="t">
          <thead><tr><th>Quand</th><th>Qui</th><th>Environnement</th><th>Type</th><th>Cible</th><th>Résultat</th><th>Détail</th></tr></thead>
          <tbody>{list.data?.map(a => (
            <tr key={a.id}>
              <td className="small">{fmtDate(a.at)}</td><td>{a.actor}</td><td>{a.environment}</td><td>{a.kind}</td>
              <td className="small"><code>{a.target}</code></td><td><Status s={a.outcome} /></td>
              <td className="small">{a.detail ? <details><summary>voir</summary><pre className="code">{JSON.stringify(a.detail, null, 2)}</pre></details> : null}{a.execution_id && <a href={`#/executions/${a.execution_id}`}>exécution</a>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}

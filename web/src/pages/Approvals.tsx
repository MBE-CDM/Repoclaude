import { useState } from 'react';
import { get, post } from '../api';
import { Alert, Status, fmtDate, useLoad } from '../ui';
import type { Nav } from '../App';

export function ApprovalsPage({ nav }: { nav: Nav }) {
  const list = useLoad(() => get<any[]>('/api/approvals'));
  const [msg, setMsg] = useState<{ kind: 'ok' | 'ko'; text: string }>();
  const act = async (fn: () => Promise<any>) => { try { const r = await fn(); setMsg(undefined); list.reload(); return r; } catch (e: any) { setMsg({ kind: 'ko', text: e.message }); } };

  return (
    <>
      <h1>Validations production</h1>
      <p className="muted small">Toute exécution ou requête sur un environnement de production nécessite l'accord de deux valideurs distincts du demandeur. Une validation ne sert qu'une seule fois.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="panel scroll">
        <table className="t">
          <thead><tr><th>Date</th><th>Environnement</th><th>Action</th><th>Demandeur</th><th>Décisions</th><th>Statut</th><th></th></tr></thead>
          <tbody>{list.data?.map(a => (
            <tr key={a.id}>
              <td>{fmtDate(a.requestedAt)}</td><td>{a.environmentName}</td>
              <td>{a.action.summary}{a.action.type === 'sql' && <pre className="code">{a.action.payload.sql}</pre>}</td>
              <td>{a.requestedBy}</td>
              <td className="small">{a.decisions.map((d: any) => <div key={d.user}>{d.decision === 'approve' ? '✔' : '✘'} {d.user}{d.comment ? ` — ${d.comment}` : ''}</div>)}{a.decisions.length}/{a.required}</td>
              <td><Status s={a.status} /></td>
              <td className="row">
                {a.status === 'pending' && <>
                  <button className="btn" onClick={() => act(() => post(`/api/approvals/${a.id}/decision`, { decision: 'approve' }))}>Approuver</button>
                  <button className="btn danger" onClick={() => act(() => post(`/api/approvals/${a.id}/decision`, { decision: 'reject', comment: prompt('Motif du refus ?') ?? undefined }))}>Refuser</button>
                </>}
                {a.status === 'approved' && <button className="btn primary" onClick={async () => {
                  const r = await act(() => post(`/api/approvals/${a.id}/execute`));
                  if (r?.id) nav.go('executions', r.id); else if (r) setMsg({ kind: 'ok', text: `Requête exécutée : ${r.rowCount} ligne(s)${r.affected !== undefined ? `, ${r.affected} affectée(s)` : ''}.` });
                }}>Exécuter</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}

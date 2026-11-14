import { useEffect, useRef, useState } from 'react';
import { evidenceUrl, get, getToken, post } from '../api';
import { Status, fmtDate, fmtMs, useLoad } from '../ui';
import type { Nav } from '../App';

function Evidence({ execId, caseIdx, ev }: { execId: string; caseIdx: number; ev: any }) {
  if (ev.file) {
    const url = evidenceUrl(execId, ev.file, String(caseIdx));
    if (ev.type === 'screenshot') return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={ev.name} title={ev.name} /></a>;
    if (ev.type === 'video') return <video src={url} controls />;
    return <a className="chip" href={url} target="_blank" rel="noreferrer">⬇ {ev.name}</a>;
  }
  if (ev.type === 'table') {
    const d = ev.data;
    return (
      <details style={{ width: '100%' }}><summary className="small">{ev.name} — {d.affected !== undefined ? `${d.affected} ligne(s) affectée(s)` : `${d.rowCount} ligne(s)`}</summary>
        <pre className="code">{d.query}{d.params?.length ? `\n-- paramètres : ${JSON.stringify(d.params)}` : ''}</pre>
        <div className="scroll"><table className="t"><thead><tr>{d.columns.map((c: string) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{d.rows.map((r: any, i: number) => <tr key={i}>{d.columns.map((c: string) => <td key={c}>{r[c] === null ? 'NULL' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c])}</td>)}</tr>)}</tbody></table></div>
      </details>
    );
  }
  return <details style={{ width: '100%' }}><summary className="small">{ev.name}</summary><pre className="code">{JSON.stringify(ev.data, null, 2)}</pre></details>;
}

function Detail({ id, nav }: { id: string; nav: Nav }) {
  const [e, setE] = useState<any>();
  const [live, setLive] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let es: EventSource | undefined;
    setLive([]);
    get(`/api/executions/${id}`).then(x => {
      setE(x);
      if (['queued', 'running'].includes(x.status)) {
        es = new EventSource(`/api/executions/${id}/stream?token=${encodeURIComponent(getToken())}`);
        es.addEventListener('log', (m: MessageEvent) => { const d = JSON.parse(m.data); setLive(l => [...l.slice(-2000), `[${d.step ?? '-'}] ${d.line}`]); });
        es.addEventListener('step', () => get(`/api/executions/${id}`).then(setE));
        es.addEventListener('end', () => { es?.close(); get(`/api/executions/${id}`).then(setE); });
      }
    });
    return () => es?.close();
  }, [id]);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [live]);

  if (!e) return <div className="muted">Chargement…</div>;
  return (
    <>
      <div className="row"><button className="link" onClick={() => nav.go('executions')}>← Exécutions</button></div>
      <h1>{e.name} <Status s={e.status} /></h1>
      <div className="panel small">
        Environnement <b>{e.environmentName}</b> · déclenché par {e.triggeredBy} ({e.trigger}) · début {fmtDate(e.startedAt)} · fin {fmtDate(e.endedAt)}
        {['queued', 'running'].includes(e.status) && <> · <button className="btn" onClick={() => post(`/api/executions/${id}/cancel`)}>Annuler</button></>}
        {e.error && <div className="alert ko">{e.error}</div>}
      </div>
      {live.length > 0 && <><h2>Logs en temps réel</h2><pre className="code" ref={logRef}>{live.join('\n')}</pre></>}
      {e.cases.map((c: any, ci: number) => (
        <div className="panel" key={ci}>
          <h2 style={{ marginTop: 0 }}>{c.name} <Status s={c.status} /> <span className="small muted">{fmtMs(c.durationMs)}</span></h2>
          {c.steps.map((s: any) => (
            <details className="step-card" key={s.index} open={!['passed', 'skipped'].includes(s.status)}>
              <summary className="head"><b>{s.index}</b> <Status s={s.status} /> {s.name} <span className="muted small">{s.type} · {fmtMs(s.durationMs)}</span></summary>
              <div className="body">
                {s.error && <div className="alert ko">{s.error}</div>}
                {s.assertions.length > 0 && (
                  <table className="t"><thead><tr><th></th><th>Assertion</th><th>Attendu</th><th>Obtenu</th></tr></thead>
                    <tbody>{s.assertions.map((a: any, i: number) => <tr key={i}><td>{a.ok ? '✔' : '✘'}</td><td>{a.assertion}{a.message ? <div className="small muted">{a.message}</div> : null}</td>
                      <td className="small">{a.expected === undefined ? '' : JSON.stringify(a.expected).slice(0, 200)}</td><td className="small">{a.actual === undefined ? '' : JSON.stringify(a.actual).slice(0, 200)}</td></tr>)}</tbody></table>
                )}
                {s.outputs && <div className="small">Variables : <code>{JSON.stringify(s.outputs)}</code></div>}
                {s.evidence.length > 0 && <><h3>Preuves</h3><div className="evid">{s.evidence.map((ev: any, i: number) => <Evidence key={i} execId={e.id} caseIdx={ci + 1} ev={ev} />)}</div></>}
                {s.logs.length > 0 && <details><summary className="small">Logs ({s.logs.length})</summary><pre className="code">{s.logs.join('\n')}</pre></details>}
              </div>
            </details>
          ))}
        </div>
      ))}
    </>
  );
}

export function ExecutionsPage({ nav }: { nav: Nav }) {
  const list = useLoad(() => get<any[]>('/api/executions?limit=200'));
  useEffect(() => {
    if (nav.param) return;
    const t = setInterval(list.reload, 5000);
    return () => clearInterval(t);
  }, [nav.param, list.reload]);
  if (nav.param) return <Detail id={nav.param} nav={nav} />;
  return (
    <>
      <h1>Exécutions</h1>
      <div className="panel scroll">
        <table className="t">
          <thead><tr><th>Date</th><th>Nom</th><th>Type</th><th>Environnement</th><th>Statut</th><th>Cas</th><th>Étapes KO</th><th>Déclencheur</th></tr></thead>
          <tbody>{list.data?.map(e => (
            <tr key={e.id} className="click" onClick={() => nav.go('executions', e.id)}>
              <td>{fmtDate(e.createdAt)}</td><td>{e.name}</td><td>{e.kind === 'case' ? 'cas' : 'campagne'}</td><td>{e.environmentName}</td>
              <td><Status s={e.status} /></td><td>{e.counts.passed}/{e.counts.cases}</td><td>{e.counts.failedSteps}</td><td className="small">{e.trigger} · {e.triggeredBy}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}

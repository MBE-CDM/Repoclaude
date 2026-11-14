import { useEffect, useState } from 'react';
import { del, get, post, put, type Environment } from '../api';
import { Alert, Field, JsonEditor, fmtDate, useLoad } from '../ui';
import type { Nav } from '../App';

export function CampaignsPage({ nav }: { nav: Nav }) {
  const list = useLoad(() => get<any[]>('/api/campaigns'));
  const cases = useLoad(() => get<any[]>('/api/testcases'));
  const envs = useLoad(() => get<Environment[]>('/api/environments'));
  const [c, setC] = useState<any>();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'ko' | 'warn'; text: string }>();
  const [hook, setHook] = useState<any>();
  const [nextRun, setNextRun] = useState<string | null>();

  useEffect(() => {
    if (!list.data) return;
    if (nav.param === 'new') setC({ name: '', environmentId: envs.data?.[0]?.id ?? '', caseIds: [], schedule: { cron: '', enabled: false } });
    else { const x = list.data.find(t => t.id === nav.param) ?? list.data[0]; setC(x ? structuredClone(x) : undefined); }
    setHook(undefined); setMsg(undefined);
  }, [list.data, nav.param, envs.data]);
  useEffect(() => { setNextRun(undefined); if (c?.id) get(`/api/campaigns/${c.id}/next-run`).then(r => setNextRun(r.nextRun)); }, [c?.id, list.data]);

  const save = async () => {
    try {
      const body = { ...c }; if (!body.id) delete body.id;
      const r = c.id ? await put(`/api/campaigns/${c.id}`, body) : await post('/api/campaigns', body);
      setMsg({ kind: 'ok', text: 'Campagne enregistrée.' }); list.reload(); nav.go('campaigns', r.id); return r;
    } catch (e: any) { setMsg({ kind: 'ko', text: e.message }); }
  };
  const toggle = (id: string) => setC({ ...c, caseIds: c.caseIds.includes(id) ? c.caseIds.filter((x: string) => x !== id) : [...c.caseIds, id] });

  return (
    <>
      <h1>Campagnes</h1>
      <div className="split">
        <div className="panel">
          {list.data?.map(x => <div key={x.id} className={`list-item ${c?.id === x.id ? 'active' : ''}`} onClick={() => nav.go('campaigns', x.id)}><span>{x.name}</span><span className="small muted">{x.schedule?.enabled ? '⏱' : ''} {x.caseIds.length} cas</span></div>)}
          <div style={{ marginTop: 10 }}><button className="btn" onClick={() => nav.go('campaigns', 'new')}>+ Nouvelle campagne</button></div>
        </div>
        {c && (
          <div>
            <div className="panel">
              <div className="grid2">
                <Field label="Nom"><input value={c.name} onChange={e => setC({ ...c, name: e.target.value })} /></Field>
                <Field label="Environnement"><select value={c.environmentId} onChange={e => setC({ ...c, environmentId: e.target.value })}>{envs.data?.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
                <Field label="Planification (cron)"><input value={c.schedule?.cron ?? ''} placeholder="0 2 * * 1-5" onChange={e => setC({ ...c, schedule: { ...c.schedule, cron: e.target.value } })} /></Field>
                <Field label="Fuseau horaire"><input value={c.schedule?.timezone ?? ''} placeholder="Europe/Paris" onChange={e => setC({ ...c, schedule: { ...c.schedule, timezone: e.target.value || undefined } })} /></Field>
                <Field label="Planification active"><input type="checkbox" style={{ alignSelf: 'flex-start' }} checked={!!c.schedule?.enabled} onChange={e => setC({ ...c, schedule: { ...c.schedule, enabled: e.target.checked } })} /></Field>
                <Field label="Arrêter au premier échec"><input type="checkbox" style={{ alignSelf: 'flex-start' }} checked={!!c.stopOnFailure} onChange={e => setC({ ...c, stopOnFailure: e.target.checked })} /></Field>
              </div>
              {nextRun && <p className="small muted">Prochaine exécution : {fmtDate(nextRun)}</p>}
              <h3>Cas de test (ordre d'exécution)</h3>
              {cases.data?.map(t => <label key={t.id} className="row small"><input type="checkbox" checked={c.caseIds.includes(t.id)} onChange={() => toggle(t.id)} />{t.name}</label>)}
              <div className="grid2" style={{ marginTop: 10 }}>
                <div><h3>Variables de campagne</h3><JsonEditor value={c.variables ?? {}} onChange={v => setC({ ...c, variables: v })} height="90px" /></div>
                <div><h3>Setup SQL de campagne</h3><JsonEditor value={c.setup ?? []} onChange={v => setC({ ...c, setup: v })} height="90px" /></div>
                <div><h3>Teardown SQL de campagne</h3><JsonEditor value={c.teardown ?? []} onChange={v => setC({ ...c, teardown: v })} height="90px" /></div>
              </div>
            </div>
            <div className="panel row">
              <button className="btn primary" onClick={save}>Enregistrer</button>
              {c.id && <button className="btn" onClick={async () => { try { const e = await post('/api/executions', { kind: 'campaign', refId: c.id }); nav.go('executions', e.id); } catch (e: any) { setMsg({ kind: e.body?.approvalId ? 'warn' : 'ko', text: e.message }); } }}>Lancer maintenant</button>}
              {c.id && <button className="btn" onClick={async () => setHook(await post(`/api/campaigns/${c.id}/webhook-token`))}>{c.webhookTokenHash ? 'Régénérer' : 'Créer'} le jeton webhook</button>}
              <span className="grow" />
              {c.id && <button className="btn danger" onClick={async () => { if (confirm('Supprimer ?')) { await del(`/api/campaigns/${c.id}`); list.reload(); nav.go('campaigns'); } }}>Supprimer</button>}
            </div>
            {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
            {hook && (
              <div className="panel">
                <b>Déclenchement CI/CD</b> — ce jeton n'est affiché qu'une fois :
                <pre className="code">{`curl -fsS -X POST \\
  -H "X-TestHub-Token: ${hook.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"wait": true, "variables": {"version": "$CI_COMMIT_SHA"}}' \\
  ${location.origin}${hook.url}`}</pre>
                <p className="small muted">Avec <code>wait: true</code>, la réponse contient <code>result</code> (passed / failed…) : la CI peut échouer selon ce résultat.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

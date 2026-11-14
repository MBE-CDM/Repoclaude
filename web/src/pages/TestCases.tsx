import { useEffect, useState } from 'react';
import { del, get, post, put, type Environment } from '../api';
import { Alert, Chip, Field, JsonEditor, useLoad } from '../ui';
import type { Nav } from '../App';

/** Modèles d'étapes proposés à l'ajout. */
export const STEP_TEMPLATES: Record<string, { label: string; step: any }> = {
  ui: { label: 'UI (Playwright)', step: { type: 'ui', name: 'Parcours UI', actions: [{ action: 'login', profile: 'admin' }, { action: 'goto', url: '/' }, { action: 'click', selector: 'text=Nouvelle commande' }, { action: 'extract', var: 'commandeId', selector: '#id' }] } },
  api: { label: 'API REST', step: { type: 'api', name: 'Appel API', method: 'GET', path: '/api/commandes/{{commandeId}}', assertions: [{ type: 'status', value: 200 }, { type: 'jsonpath', path: '$.statut', value: 'VALIDEE' }, { type: 'responseTime', maxMs: 2000 }], extract: [] } },
  graphql: { label: 'API GraphQL', step: { type: 'api', protocol: 'graphql', name: 'Requête GraphQL', path: '/graphql', graphql: { query: 'query($id: ID!) { commande(id: $id) { statut } }', variables: { id: '{{commandeId}}' } }, assertions: [{ type: 'jsonpath', path: '$.data.commande.statut', value: 'VALIDEE' }] } },
  soap: { label: 'API SOAP', step: { type: 'api', protocol: 'soap', name: 'Appel SOAP', path: '/ws', soap: { action: 'GetStatut', envelope: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetStatut><id>{{commandeId}}</id></GetStatut></soap:Body></soap:Envelope>' }, assertions: [{ type: 'jsonpath', path: '$.Envelope.Body.GetStatutResponse.statut', value: 'VALIDEE' }] } },
  sql: { label: 'Contrôle SQL', step: { type: 'sql', name: 'Contrôle SQL', database: 'principale', query: 'SELECT statut FROM commande WHERE id = {{commandeId}}', assertions: [{ type: 'rowCount', value: 1 }, { type: 'value', column: 'statut', value: 'VALIDEE' }] } },
  snapshot: { label: 'SQL snapshot', step: { type: 'sql', mode: 'snapshot', name: 'Snapshot avant', database: 'principale', snapshot: 'avant', query: 'SELECT id, statut FROM commande WHERE client_id = {{client.id}}' } },
  diff: { label: 'SQL diff avant/après', step: { type: 'sql', mode: 'diff', name: 'Diff après action', database: 'principale', diff: { snapshot: 'avant', key: ['id'], expect: { added: 0, removed: 0, changed: 1, changedColumns: ['statut'] } } } },
  integrity: { label: 'Intégrité', step: { type: 'sql', mode: 'integrity', name: 'Contrôles d\'intégrité', database: 'principale', integrity: [{ kind: 'foreignKey', table: 'commande', column: 'client_id', refTable: 'client', refColumn: 'id' }, { kind: 'duplicates', table: 'client', columns: ['email'] }, { kind: 'notNull', table: 'commande', columns: ['statut'] }] } },
  batch: { label: 'Batch', step: { type: 'batch', name: 'Batch nocturne', launcher: { kind: 'ssh', server: 'batch01', command: '/opt/batch/export.sh {{commandeId}}' }, timeoutMs: 600000, expectExitCode: 0,
    files: [{ source: { share: 'exports', path: 'export_{{$today}}.csv' }, format: 'csv', assertions: [{ type: 'exists' }, { type: 'formatValid' }, { type: 'recordCount', op: 'gte', value: 1 }] }],
    then: [{ type: 'sql', name: 'Effet du batch', database: 'principale', query: "SELECT COUNT(*) AS n FROM commande WHERE statut = 'EXPORTEE' AND id = {{commandeId}}", assertions: [{ type: 'value', column: 'n', value: 1 }] }] } },
  jenkins: { label: 'Job Jenkins / GitLab / Airflow / Control-M', step: { type: 'batch', name: 'Job ordonnanceur', launcher: { kind: 'jenkins', scheduler: 'jenkins', job: 'dossier/mon-job', parameters: { ID: '{{commandeId}}' } }, timeoutMs: 1800000 } },
  script: { label: 'Script (Shell / PowerShell / Python)', step: { type: 'script', name: 'Script distant', language: 'shell', target: { server: 'batch01' }, script: 'echo "traitement {{commandeId}}"\nls -l /data/out', expectExitCode: 0 } },
  procedure: { label: 'Procédure stockée', step: { type: 'sql', mode: 'procedure', name: 'Procédure stockée', database: 'principale', procedure: { name: 'pkg_commande.valider', args: ['{{commandeId}}'] } } },
  file: { label: 'Fichier (CSV/XML/JSON/positionnel)', step: { type: 'file', name: 'Contrôle fichier', source: { share: 'exports', path: 'factures.txt' }, format: 'fixed', fixed: { fields: [{ name: 'id', start: 0, length: 8 }, { name: 'montant', start: 8, length: 10 }] }, assertions: [{ type: 'formatValid' }, { type: 'lineCount', op: 'gte', value: 1 }] } },
};

const empty = () => ({ id: '', name: '', steps: [] as any[], tags: [] as string[], dataset: {}, setup: [], teardown: [], transactional: [] });

export function TestCasesPage({ nav }: { nav: Nav }) {
  const list = useLoad(() => get<any[]>('/api/testcases'));
  const envs = useLoad(() => get<Environment[]>('/api/environments'));
  const [tc, setTc] = useState<any>();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'ko' | 'warn'; text: string }>();
  const [runEnv, setRunEnv] = useState('');
  const [tpl, setTpl] = useState('sql');

  useEffect(() => {
    if (!list.data) return;
    if (nav.param === 'new') setTc(empty());
    else { const x = list.data.find(t => t.id === nav.param) ?? list.data[0]; setTc(x ? structuredClone(x) : undefined); }
    setMsg(undefined);
  }, [list.data, nav.param]);
  useEffect(() => { setRunEnv(tc?.environmentId ?? ''); }, [tc?.id, tc?.environmentId]);

  const save = async () => {
    try {
      const body = { ...tc }; if (!body.id) delete body.id;
      const r = tc.id ? await put(`/api/testcases/${tc.id}`, body) : await post('/api/testcases', body);
      setMsg({ kind: 'ok', text: 'Cas de test enregistré.' }); list.reload(); nav.go('testcases', r.id);
      return r;
    } catch (e: any) { setMsg({ kind: 'ko', text: e.message }); }
  };
  const run = async () => {
    const saved = await save(); if (!saved) return;
    try {
      const e = await post('/api/executions', { kind: 'case', refId: saved.id, environmentId: runEnv || undefined });
      nav.go('executions', e.id);
    } catch (e: any) { setMsg({ kind: e.body?.approvalId ? 'warn' : 'ko', text: e.body?.approvalId ? `${e.message} — voir l'onglet Validations.` : e.message }); }
  };
  const setStep = (i: number, s: any) => setTc((t: any) => ({ ...t, steps: t.steps.map((x: any, j: number) => (j === i ? s : x)) }));
  const move = (i: number, d: number) => setTc((t: any) => { const s = [...t.steps]; const [x] = s.splice(i, 1); s.splice(i + d, 0, x); return { ...t, steps: s }; });

  return (
    <>
      <h1>Cas de test</h1>
      <div className="split">
        <div className="panel">
          {list.data?.map(t => (
            <div key={t.id} className={`list-item ${tc?.id === t.id ? 'active' : ''}`} onClick={() => nav.go('testcases', t.id)}>
              <span>{t.name}</span><span className="small muted">{t.steps.length} ét.</span>
            </div>
          ))}
          <div style={{ marginTop: 10 }}><button className="btn" onClick={() => nav.go('testcases', 'new')}>+ Nouveau cas</button></div>
        </div>
        {tc && (
          <div>
            <div className="panel">
              <div className="grid2">
                <Field label="Nom"><input value={tc.name} onChange={e => setTc({ ...tc, name: e.target.value })} /></Field>
                <Field label="Environnement par défaut"><select value={tc.environmentId ?? ''} onChange={e => setTc({ ...tc, environmentId: e.target.value || undefined })}>
                  <option value="">(aucun)</option>{envs.data?.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
                <Field label="Tags"><input value={(tc.tags ?? []).join(', ')} onChange={e => setTc({ ...tc, tags: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })} /></Field>
                <Field label="Bases en rollback transactionnel"><input value={(tc.transactional ?? []).join(', ')} placeholder="principale" onChange={e => setTc({ ...tc, transactional: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })} /></Field>
              </div>
              <p className="small muted">Les étapes désignent bases, serveurs, comptes et agents par leur <b>nom logique</b> : le même cas s'exécute sur n'importe quel environnement qui les déclare. Variables : <code>{'{{var}}'}</code>, <code>{'{{account.<profil>.username}}'}</code>, <code>{'{{env.frontUrl}}'}</code>, <code>{'{{$uuid}}'}</code>, <code>{'{{$today}}'}</code>.</p>
              <div className="grid2">
                <div><h3>Jeu de données (objet, ou tableau pour rejouer le cas par ligne)</h3><JsonEditor value={tc.dataset ?? {}} onChange={v => setTc({ ...tc, dataset: v })} height="110px" /></div>
                <div><h3>Setup SQL (avant le cas)</h3><JsonEditor value={tc.setup ?? []} onChange={v => setTc({ ...tc, setup: v })} height="110px" /></div>
                <div><h3>Teardown SQL (après le cas)</h3><JsonEditor value={tc.teardown ?? []} onChange={v => setTc({ ...tc, teardown: v })} height="110px" /></div>
              </div>
            </div>

            <h2>Étapes</h2>
            {tc.steps.map((s: any, i: number) => (
              <div className="step-card" key={i}>
                <div className="head">
                  <b>{i + 1}.</b><Chip>{s.type}{s.mode ? ` · ${s.mode}` : ''}{s.protocol ? ` · ${s.protocol}` : ''}</Chip>
                  <input className="grow" value={s.name ?? ''} onChange={e => setStep(i, { ...s, name: e.target.value })} placeholder="Nom de l'étape" />
                  <label className="small"><input type="checkbox" checked={!!s.continueOnFailure} onChange={e => setStep(i, { ...s, continueOnFailure: e.target.checked })} /> continuer si échec</label>
                  <button className="btn" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="btn" disabled={i === tc.steps.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button className="btn danger" onClick={() => setTc({ ...tc, steps: tc.steps.filter((_: any, j: number) => j !== i) })}>Retirer</button>
                </div>
                <div className="body"><JsonEditor value={s} onChange={v => setStep(i, v)} height="200px" /></div>
              </div>
            ))}
            <div className="panel row">
              <select value={tpl} onChange={e => setTpl(e.target.value)}>{Object.entries(STEP_TEMPLATES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
              <button className="btn" onClick={() => setTc({ ...tc, steps: [...tc.steps, structuredClone(STEP_TEMPLATES[tpl].step)] })}>+ Ajouter l'étape</button>
            </div>
            <div className="panel row">
              <button className="btn primary" onClick={save}>Enregistrer</button>
              <select value={runEnv} onChange={e => setRunEnv(e.target.value)}>
                <option value="">Environnement…</option>{envs.data?.map(e => <option key={e.id} value={e.id}>{e.name}{e.isProduction ? ' (PROD)' : ''}</option>)}</select>
              <button className="btn" disabled={!runEnv} onClick={run}>Enregistrer et exécuter</button>
              <span className="grow" />
              {tc.id && <button className="btn danger" onClick={async () => { if (confirm('Supprimer ce cas ?')) { await del(`/api/testcases/${tc.id}`); list.reload(); nav.go('testcases'); } }}>Supprimer</button>}
            </div>
            {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
          </div>
        )}
      </div>
    </>
  );
}

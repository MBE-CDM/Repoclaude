import { useEffect, useState } from 'react';
import { get, getToken, setToken } from './api';
import { Alert } from './ui';
import { EnvironmentsPage } from './pages/Environments';
import { SqlEditorPage } from './pages/SqlEditor';
import { TestCasesPage } from './pages/TestCases';
import { CampaignsPage } from './pages/Campaigns';
import { ExecutionsPage } from './pages/Executions';
import { RecorderPage } from './pages/Recorder';
import { ApprovalsPage } from './pages/Approvals';
import { AuditPage } from './pages/Audit';

const PAGES = {
  environments: ['Environnements', EnvironmentsPage],
  testcases: ['Cas de test', TestCasesPage],
  campaigns: ['Campagnes', CampaignsPage],
  executions: ['Exécutions', ExecutionsPage],
  sql: ['Éditeur SQL', SqlEditorPage],
  recorder: ['Enregistreur', RecorderPage],
  approvals: ['Validations', ApprovalsPage],
  audit: ['Journal d\'audit', AuditPage],
} as const;
type PageKey = keyof typeof PAGES;

export interface Nav { go: (page: PageKey, param?: string) => void; param?: string }

function readHash(): [PageKey, string | undefined] {
  const [p, param] = location.hash.replace(/^#\/?/, '').split('/');
  return [(p in PAGES ? p : 'environments') as PageKey, param ? decodeURIComponent(param) : undefined];
}

export function App() {
  const [me, setMe] = useState<any>();
  const [err, setErr] = useState<string>();
  const [tok, setTok] = useState('');
  const [[page, param], setRoute] = useState(readHash);

  useEffect(() => {
    const on = () => setRoute(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => { if (getToken()) get('/api/me').then(setMe).catch(() => setToken('')); }, []);

  const go: Nav['go'] = (p, prm) => { location.hash = `/${p}${prm ? '/' + encodeURIComponent(prm) : ''}`; };

  if (!me) {
    return (
      <main style={{ maxWidth: 420, margin: '10vh auto' }}>
        <div className="panel">
          <h1>TestHub</h1>
          <p className="muted">Connectez-vous avec votre jeton d'API.</p>
          <form onSubmit={async e => {
            e.preventDefault();
            setToken(tok);
            try { setMe(await get('/api/me')); setErr(undefined); } catch (x: any) { setErr(x.message); setToken(''); }
          }}>
            <input type="password" style={{ width: '100%' }} placeholder="Jeton" value={tok} onChange={e => setTok(e.target.value)} autoFocus />
            <div style={{ marginTop: 10 }}><button className="btn primary" type="submit">Se connecter</button></div>
          </form>
          <Alert>{err}</Alert>
          <p className="small muted">Au premier démarrage, le jeton administrateur est affiché dans la console du serveur et enregistré dans <code>data/admin.token</code>.</p>
        </div>
      </main>
    );
  }

  const [, Page] = PAGES[page];
  return (
    <div className="layout">
      <nav className="side">
        <div className="brand">TestHub</div>
        {(Object.keys(PAGES) as PageKey[]).map(k => (
          <button key={k} className={k === page ? 'active' : ''} onClick={() => go(k)}>{PAGES[k][0]}</button>
        ))}
        <div className="who">
          {me.name} · {me.roles.join(', ')}<br />
          <button className="link" onClick={() => { setToken(''); setMe(undefined); }}>Déconnexion</button>
        </div>
      </nav>
      <main><Page nav={{ go, param }} /></main>
    </div>
  );
}

import http from 'node:http';
import Database from 'better-sqlite3';
import type { AddressInfo } from 'node:net';

/**
 * Application « système sous test » minimale : page de login, création de commande (UI),
 * API REST/GraphQL/SOAP, base SQLite. Sert aux tests d'intégration de bout en bout.
 */
export async function startSut(dbFile: string) {
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS client (id INTEGER PRIMARY KEY, nom TEXT NOT NULL, email TEXT);
    CREATE TABLE IF NOT EXISTS commande (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, produit TEXT NOT NULL, montant REAL, statut TEXT NOT NULL DEFAULT 'CREEE');
  `);
  const page = (body: string) => `<!doctype html><html><head><title>Boutique test</title></head><body>${body}
    <script>console.log('page chargée : ' + location.pathname)</script></body></html>`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const body = await new Promise<string>(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(s)); });
    const json = (code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const html = (s: string) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(s)); };
    const cookie = req.headers.cookie ?? '';

    if (url.pathname === '/health') return json(200, { status: 'UP' });
    if (url.pathname === '/' || url.pathname === '/login') {
      return html(`<form method="post" action="/login-submit"><input id="user" name="user" placeholder="Identifiant"><input id="pass" name="pass" type="password"><button id="go" type="submit">Se connecter</button></form>`);
    }
    if (url.pathname === '/login-submit' && req.method === 'POST') {
      const p = new URLSearchParams(body);
      if (p.get('user') === 'alice' && p.get('pass') === 'S3cret!pass') { res.writeHead(302, { location: '/accueil', 'set-cookie': 'session=ok; Path=/' }); return res.end(); }
      return html('<p id="err">Identifiants invalides</p>');
    }
    if (url.pathname === '/accueil') {
      if (!cookie.includes('session=ok')) { res.writeHead(302, { location: '/login' }); return res.end(); }
      return html(`<h1 id="welcome">Bienvenue alice</h1>
        <form method="post" action="/commandes"><input data-testid="produit" name="produit"><input data-testid="montant" name="montant"><select name="client"><option value="1">Dupont</option><option value="2">Martin</option></select><button type="submit">Créer la commande</button></form>`);
    }
    if (url.pathname === '/commandes' && req.method === 'POST') {
      const p = new URLSearchParams(body);
      const r = db.prepare('INSERT INTO commande (client_id, produit, montant) VALUES (?, ?, ?)').run(Number(p.get('client')), p.get('produit'), Number(p.get('montant')));
      res.writeHead(302, { location: `/commandes/${r.lastInsertRowid}` }); return res.end();
    }
    const mc = /^\/commandes\/(\d+)$/.exec(url.pathname);
    if (mc) {
      const c: any = db.prepare('SELECT * FROM commande WHERE id = ?').get(Number(mc[1]));
      return html(`<p>Commande n° <span id="cmd-id">${c.id}</span> créée — statut <b id="statut">${c.statut}</b></p>`);
    }

    /* API REST */
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      return b.username === 'alice' && b.password === 'S3cret!pass' ? json(200, { token: 'tok-abc-123' }) : json(401, { error: 'bad credentials' });
    }
    const ma = /^\/api\/commandes\/(\d+)$/.exec(url.pathname);
    if (ma && req.method === 'GET') {
      const c = db.prepare('SELECT * FROM commande WHERE id = ?').get(Number(ma[1]));
      return c ? json(200, { data: c }) : json(404, { error: 'not found' });
    }
    if (ma && req.method === 'PATCH') {
      if (req.headers.authorization !== 'Bearer tok-abc-123') return json(401, { error: 'unauthorized' });
      const b = JSON.parse(body);
      db.prepare('UPDATE commande SET statut = ? WHERE id = ?').run(b.statut, Number(ma[1]));
      return json(200, { ok: true, id: Number(ma[1]), statut: b.statut });
    }
    if (url.pathname === '/graphql' && req.method === 'POST') {
      const b = JSON.parse(body);
      const c = db.prepare('SELECT id, produit, statut FROM commande WHERE id = ?').get(Number(b.variables?.id));
      return json(200, { data: { commande: c ?? null } });
    }
    if (url.pathname === '/soap' && req.method === 'POST') {
      const id = /<id>(\d+)<\/id>/.exec(body)?.[1];
      const c: any = db.prepare('SELECT statut FROM commande WHERE id = ?').get(Number(id));
      res.writeHead(200, { 'content-type': 'text/xml' });
      return res.end(`<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetStatutResponse><statut>${c?.statut ?? 'INCONNU'}</statut></GetStatutResponse></soap:Body></soap:Envelope>`);
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, db, close: () => new Promise<void>(r => { server.close(() => r()); db.close(); }) };
}

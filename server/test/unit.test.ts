import { describe, expect, it } from 'vitest';
import { analyzeStatement, analyzeScript, enforce, splitStatements, SqlGuardError } from '../src/connectors/db/sqlGuard.js';
import { analyzeMongo } from '../src/connectors/db/mongo.js';
import { renderSql, renderString, renderDeep } from '../src/engine/template.js';
import { Masker } from '../src/security/masking.js';
import { AesSecretProvider } from '../src/security/crypto.js';
import { checkSql, checkApi, diffRows, checkDiff } from '../src/engine/assertions.js';
import { parseCsv, parseFile } from '../src/files/files.js';
import { randomBytes } from 'node:crypto';

const ro = { readOnly: true, connectionAllowsDestructive: false, explicitDestructive: false };
const rw = { readOnly: false, connectionAllowsDestructive: false, explicitDestructive: false };
const rwDestr = { readOnly: false, connectionAllowsDestructive: true, explicitDestructive: true };

describe('garde SQL', () => {
  it('classe lectures et écritures', () => {
    expect(analyzeStatement('SELECT * FROM t').write).toBe(false);
    expect(analyzeStatement('with x as (select 1) select * from x').write).toBe(false);
    expect(analyzeStatement('WITH x AS (SELECT 1) DELETE FROM t').verb).toBe('DELETE');
    expect(analyzeStatement('insert into t values (1)').write).toBe(true);
    expect(analyzeStatement('SELECT * INTO copie FROM t').write).toBe(true);
    expect(analyzeStatement('SELECT * FROM t FOR UPDATE').write).toBe(true);
    expect(analyzeStatement('BEGIN pkg.proc(1); END;').write).toBe(true);
    expect(analyzeStatement('BEGIN TRANSACTION').write).toBe(false);
    expect(analyzeStatement('SET TRANSACTION READ WRITE').write).toBe(true);
  });

  it('détecte les requêtes destructrices', () => {
    expect(analyzeStatement('DROP TABLE commande').destructive).toBe(true);
    expect(analyzeStatement('truncate table commande').destructive).toBe(true);
    expect(analyzeStatement('DELETE FROM commande').destructive).toBe(true);
    expect(analyzeStatement('DELETE FROM commande WHERE id = 3').destructive).toBe(false);
    expect(analyzeStatement('UPDATE commande SET statut = 1').destructive).toBe(true);
    // WHERE uniquement dans une sous-requête : toujours destructeur
    expect(analyzeStatement('DELETE FROM commande USING (SELECT id FROM x WHERE a = 1) s').destructive).toBe(true);
    // WHERE dans une chaîne ou un commentaire : ignoré
    expect(analyzeStatement("DELETE FROM commande -- WHERE id = 1").destructive).toBe(true);
    expect(analyzeStatement("DELETE FROM t /* where */").destructive).toBe(true);
    expect(analyzeStatement("UPDATE t SET a = 'where x'").destructive).toBe(true);
    expect(analyzeStatement('ALTER TABLE t DROP COLUMN c').destructive).toBe(true);
  });

  it('ne se laisse pas contourner par les blocs procéduraux ou le SQL dynamique', () => {
    expect(analyzeStatement("IF OBJECT_ID('t') IS NOT NULL DROP TABLE t").destructive).toBe(true);
    expect(analyzeStatement("BEGIN EXECUTE IMMEDIATE 'DROP TABLE t'; END;").destructive).toBe(true);
    expect(analyzeStatement('BEGIN DELETE FROM t; END;').destructive).toBe(true);
    expect(analyzeStatement("DO $$ BEGIN DELETE FROM t; END $$").destructive).toBe(true);
    expect(analyzeStatement("EXEC('DROP TABLE t')").destructive).toBe(true);
    expect(analyzeStatement("EXEC sp_executesql N'DELETE FROM t'").destructive).toBe(true);
    expect(analyzeStatement('DECLARE @x INT; SELECT @x = 1').destructive).toBe(false);
    const call = analyzeStatement('BEGIN pkg.valider(:p1); END;');
    expect([call.write, call.destructive]).toEqual([true, false]);
    const exec = analyzeStatement('EXEC valider @p1');
    expect([exec.write, exec.destructive]).toEqual([true, false]);
  });

  it('applique la politique', () => {
    expect(() => enforce(analyzeStatement('SELECT 1'), ro)).not.toThrow();
    expect(() => enforce(analyzeStatement('INSERT INTO t VALUES (1)'), ro)).toThrow(SqlGuardError);
    expect(() => enforce(analyzeStatement('INSERT INTO t VALUES (1)'), rw)).not.toThrow();
    expect(() => enforce(analyzeStatement('DELETE FROM t'), rw)).toThrow(/autorisation explicite/);
    expect(() => enforce(analyzeStatement('DELETE FROM t'), { ...rw, explicitDestructive: true })).toThrow();
    expect(() => enforce(analyzeStatement('DELETE FROM t'), rwDestr)).not.toThrow();
  });

  it('découpe les scripts', () => {
    expect(splitStatements("INSERT INTO t VALUES ('a;b'); -- x;y\nSELECT 1;")).toHaveLength(2);
    expect(splitStatements('CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1')).toHaveLength(2);
    expect(splitStatements('BEGIN\n  x := 1;\n  y := 2;\nEND;\n/\nSELECT 1 FROM dual\n/')).toHaveLength(2);
    expect(analyzeScript('SELECT 1; DROP TABLE x').map(s => s.destructive)).toEqual([false, true]);
  });

  it('MongoDB', () => {
    expect(analyzeMongo({ collection: 'c', op: 'find' }).write).toBe(false);
    expect(analyzeMongo({ collection: 'c', op: 'deleteMany', filter: {} }).destructive).toBe(true);
    expect(analyzeMongo({ collection: 'c', op: 'deleteMany', filter: { a: 1 } }).destructive).toBe(false);
    expect(analyzeMongo({ collection: 'c', op: 'aggregate', pipeline: [{ $out: 'x' }] }).write).toBe(true);
  });
});

describe('gabarits', () => {
  const vars = { commande: { id: 42 }, nom: "O'Brien", tbl: 'commande' };
  it('lie les variables SQL en paramètres', () => {
    expect(renderSql('SELECT statut FROM commande WHERE id = {{commande.id}}', vars, 'dollar')).toEqual({ sql: 'SELECT statut FROM commande WHERE id = $1', params: [42] });
    expect(renderSql("SELECT * FROM c WHERE nom = '{{nom}}' AND id = {{commande.id}}", vars, 'question')).toEqual({ sql: 'SELECT * FROM c WHERE nom = ? AND id = ?', params: ["O'Brien", 42] });
    expect(renderSql('SELECT 1 FROM t WHERE a = {{commande.id}}', vars, 'colon').sql).toBe('SELECT 1 FROM t WHERE a = :p1');
    expect(renderSql('SELECT * FROM {{ident:tbl}}', vars, 'at').sql).toBe('SELECT * FROM commande');
    expect(() => renderSql("SELECT * FROM c WHERE nom LIKE '%{{nom}}%'", vars, 'question')).toThrow(/chaîne SQL/);
    expect(() => renderSql('SELECT {{inconnu}}', vars, 'question')).toThrow(/non définie/);
    expect(() => renderSql('SELECT * FROM {{ident:nom}}', vars, 'question')).toThrow(/Identifiant invalide/);
  });
  it('substitue texte et objets typés', () => {
    expect(renderString('/api/commandes/{{commande.id}}', vars)).toBe('/api/commandes/42');
    expect(renderDeep({ id: '{{commande.id}}', label: 'n°{{commande.id}}' }, vars)).toEqual({ id: 42, label: 'n°42' });
  });
});

describe('masquage', () => {
  it('masque secrets, en-têtes, cartes et IBAN', () => {
    const m = new Masker();
    m.addSecret('S3cret!pass');
    const t = m.text('login alice/S3cret!pass Authorization: Bearer abc.def password=toto carte 4111 1111 1111 1111 iban FR76 3000 6000 0112 3456 7890 189');
    expect(t).not.toContain('S3cret!pass');
    expect(t).not.toContain('abc.def');
    expect(t).not.toContain('toto');
    expect(t).not.toContain('4111 1111 1111 1111');
    expect(t).not.toContain('FR76 3000');
    expect(m.value({ user: 'a', password: 'x', nested: [{ token: 'y', iban_client: 'z', ok: 1 }] }, ['ok'])).toEqual({ user: 'a', password: '****', nested: [{ token: '****', iban_client: '****', ok: '****' }] });
  });
});

describe('chiffrement AES-256-GCM', () => {
  it('scelle et ouvre, détecte la falsification', async () => {
    const p = new AesSecretProvider(randomBytes(32));
    const ref = await p.seal('mot de passe é');
    expect(JSON.stringify(ref)).not.toContain('mot de passe');
    expect(await p.open(ref)).toBe('mot de passe é');
    const bad = { ...ref, data: Buffer.from('xxxxxxxx').toString('base64') } as any;
    await expect(p.open(bad)).rejects.toThrow();
    await expect(new AesSecretProvider(randomBytes(32)).open(ref)).rejects.toThrow();
  });
});

describe('assertions', () => {
  const r = { columns: ['id', 'statut', 'montant'], rows: [{ id: 1, statut: 'VALIDEE', montant: 10 }, { id: 2, statut: 'CREEE', montant: 99.5 }], rowCount: 2, durationMs: 1 };
  it('SQL', () => {
    expect(checkSql({ type: 'value', column: 'statut', value: 'VALIDEE' }, r).ok).toBe(true);
    expect(checkSql({ type: 'value', column: 'STATUT', row: 1, value: 'CREEE' }, r).ok).toBe(true);
    expect(checkSql({ type: 'rowCount', op: 'gte', value: 2 }, r).ok).toBe(true);
    expect(checkSql({ type: 'exists' }, r).ok).toBe(true);
    expect(checkSql({ type: 'notExists' }, r).ok).toBe(false);
    expect(checkSql({ type: 'range', column: 'montant', min: 0, max: 100 }, r).ok).toBe(true);
    expect(checkSql({ type: 'range', column: 'montant', max: 50 }, r).ok).toBe(false);
    expect(checkSql({ type: 'regex', column: 'statut', pattern: '^[A-Z]+$' }, r).ok).toBe(true);
    expect(checkSql({ type: 'reference', rows: [{ id: 2, statut: 'CREEE' }, { id: 1, statut: 'VALIDEE' }] }, r).ok).toBe(true);
    expect(checkSql({ type: 'reference', rows: [{ id: 1, statut: 'X' }] }, r).ok).toBe(false);
  });
  it('diff', () => {
    const d = diffRows([{ id: 1, s: 'A' }, { id: 2, s: 'B' }], [{ id: 1, s: 'A' }, { id: 2, s: 'C' }, { id: 3, s: 'D' }], ['id']);
    expect(d.added).toHaveLength(1); expect(d.changed[0].columns).toEqual(['s']);
    expect(checkDiff(d, { added: 1, removed: 0, changed: 1, changedColumns: ['s'] }).every(a => a.ok)).toBe(true);
  });
  it('API', () => {
    const v = { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{}', json: { data: { items: [{ id: 7 }] } }, durationMs: 120 };
    expect(checkApi({ type: 'jsonpath', path: '$.data.items[0].id', value: 7 }, v).ok).toBe(true);
    expect(checkApi({ type: 'jsonpath', path: '$.data.items.length', op: 'eq', value: 1 }, v).ok).toBe(true);
    expect(checkApi({ type: 'responseTime', maxMs: 100 }, v).ok).toBe(false);
    expect(checkApi({ type: 'status', in: [200, 201] }, v).ok).toBe(true);
  });
});

describe('fichiers', () => {
  it('CSV avec guillemets', () => {
    expect(parseCsv('a;b\n"x;1";"y""z"\n')).toEqual([['a', 'b'], ['x;1', 'y"z']]);
  });
  it('positionnel, JSON, XML', () => {
    const fx = parseFile(Buffer.from('0001DUPONT    0100\n0002MARTIN    0250\n'), { source: { share: 's', path: 'a.txt' }, format: 'fixed', fixed: { fields: [{ name: 'id', start: 0, length: 4 }, { name: 'nom', start: 4, length: 10 }, { name: 'montant', start: 14, length: 4 }] } });
    expect(fx.records[1]).toEqual({ id: '0002', nom: 'MARTIN', montant: '0250' });
    const xml = parseFile(Buffer.from('<commandes><commande><id>1</id></commande><commande><id>2</id></commande></commandes>'), { source: { share: 's', path: 'a.xml' } });
    expect(xml.records).toHaveLength(2);
    const bad = parseFile(Buffer.from('<a><b></a>'), { source: { share: 's', path: 'a.xml' } });
    expect(bad.error).toMatch(/XML invalide/);
    expect(parseFile(Buffer.from('[{"a":1},{"a":2}]'), { source: { share: 's', path: 'x.json' } }).records).toHaveLength(2);
  });
});

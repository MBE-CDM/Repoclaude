/**
 * Analyse lexicale des requêtes SQL, indépendante du dialecte :
 * découpe en instructions, détermine le verbe principal (y compris après un WITH),
 * détecte les écritures et les requêtes destructrices (DROP, TRUNCATE, DELETE/UPDATE sans WHERE…).
 * Les chaînes, identifiants entre guillemets, commentaires et blocs $$ sont neutralisés avant analyse.
 */

export interface StatementInfo {
  sql: string;
  verb: string;
  write: boolean;
  destructive: boolean;
  reason?: string;
}

const READ_VERBS = new Set(['SELECT', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE']);
const CONTROL_VERBS = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'START', 'SET']);
const DML = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'REPLACE']);

/** Remplace le contenu des littéraux et commentaires par des espaces (conserve les positions). */
export function neutralize(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], c2 = sql.slice(i, i + 2);
    if (c2 === '--') { const j = sql.indexOf('\n', i); const end = j < 0 ? n : j; out += ' '.repeat(end - i); i = end; continue; }
    if (c2 === '/*') { const j = sql.indexOf('*/', i + 2); const end = j < 0 ? n : j + 2; out += sql.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === close) { if (sql[j + 1] === close && c !== '[') { j += 2; continue; } break; }
        j++;
      }
      const end = Math.min(j + 1, n);
      out += c + ' '.repeat(Math.max(0, end - i - 2)) + (end - i >= 2 ? close : '');
      i = end; continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0]; const j = sql.indexOf(tag, i + tag.length); const end = j < 0 ? n : j + tag.length;
        out += sql.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue;
      }
    }
    out += c; i++;
  }
  return out;
}

/**
 * Découpe un script en instructions. Si le script contient des lignes séparatrices « / » (Oracle)
 * ou « GO » (SQL Server), elles font foi (blocs PL/SQL ou T-SQL) ; sinon découpe sur « ; ».
 */
export function splitStatements(script: string): string[] {
  const neutral = neutralize(script);
  const sepLine = /^[ \t]*(\/|GO)[ \t]*$/gim;
  const cuts: [number, number][] = [];
  if (sepLine.test(neutral)) {
    sepLine.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = sepLine.exec(neutral))) cuts.push([m.index, m.index + m[0].length]);
  } else {
    for (let i = 0; i < neutral.length; i++) if (neutral[i] === ';') cuts.push([i, i + 1]);
  }
  const parts: string[] = [];
  let start = 0;
  for (const [a, b] of cuts) { parts.push(script.slice(start, a)); start = b; }
  parts.push(script.slice(start));
  // Un bloc PL/SQL se termine par « END; » : ce point-virgule fait partie de l'instruction.
  return parts.map(s => s.trim()).map(s => (/\bEND(\s+\w+)?\s*;\s*$/i.test(neutralize(s)) ? s : s.replace(/;\s*$/, '')))
    .filter(s => neutralize(s).trim().length > 0);
}

function tokensAtDepth0(neutral: string): { word: string; depth: number }[] {
  const toks: { word: string; depth: number }[] = [];
  let depth = 0;
  const re = /[A-Za-z_][\w$#]*|\(|\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(neutral))) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') depth = Math.max(0, depth - 1);
    else toks.push({ word: m[0].toUpperCase(), depth });
  }
  return toks;
}

export function analyzeStatement(sql: string): StatementInfo {
  const neutral = neutralize(sql);
  const toks = tokensAtDepth0(neutral);
  const top = toks.filter(t => t.depth === 0).map(t => t.word);
  let verb = top[0] ?? '';
  if (verb === 'WITH') verb = top.find(w => DML.has(w)) ?? 'SELECT';
  const has = (w: string) => top.includes(w);
  const info: StatementInfo = { sql, verb, write: true, destructive: false };

  if (READ_VERBS.has(verb)) {
    info.write = false;
    if (verb === 'SELECT' && has('INTO')) { info.write = true; info.reason = 'SELECT … INTO crée ou modifie des données'; }
    if (verb === 'SELECT' && has('FOR') && (has('UPDATE') || has('SHARE'))) { info.write = true; info.reason = 'SELECT … FOR UPDATE pose des verrous'; }
    if (verb === 'EXPLAIN' && has('ANALYZE')) { const inner = analyzeStatement(sql.replace(/^\s*EXPLAIN\s+(\([^)]*\)\s*)?ANALYZE\s*/i, '')); return { ...inner, sql }; }
    return info;
  }
  if (verb === 'PRAGMA') { info.write = /=/.test(neutral); return info; }
  // Blocs procéduraux et SQL dynamique : leur contenu ne peut pas être garanti par l'analyse,
  // ils sont donc traités comme destructifs dès qu'ils contiennent une instruction à risque.
  const all = toks.map(t => t.word);
  const procedural = (verb === 'BEGIN' && top.length > 1 && !['TRANSACTION', 'TRAN', 'WORK', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'].includes(top[1]))
    || verb === 'DECLARE' || verb === 'IF' || verb === 'WHILE';
  if (verb === 'DO') { info.destructive = true; info.reason = 'bloc anonyme DO non analysable'; return info; }
  if ((verb === 'EXEC' || verb === 'EXECUTE') && (/^\s*EXEC(UTE)?\s*\(/i.test(neutral) || /^\s*EXEC(UTE)?\s*'/i.test(sql.trim()) || all.includes('SP_EXECUTESQL'))) {
    info.destructive = true; info.reason = 'SQL dynamique'; return info;
  }
  if (procedural) {
    const risky = all.find(w => ['DROP', 'TRUNCATE', 'DELETE', 'UPDATE', 'ALTER', 'GRANT', 'REVOKE', 'MERGE', 'IMMEDIATE', 'EXEC', 'EXECUTE', 'SP_EXECUTESQL'].includes(w));
    info.reason = risky ? `bloc procédural contenant ${risky === 'IMMEDIATE' ? 'EXECUTE IMMEDIATE' : risky}` : 'bloc procédural';
    info.destructive = !!risky;
    return info;
  }
  if (CONTROL_VERBS.has(verb)) {
    info.write = false;
    // Empêche de lever le mode lecture seule de la session.
    if ((has('READ') && has('WRITE')) || /read_only|readonly/i.test(neutral)) { info.write = true; info.reason = 'modification du mode lecture seule'; }
    return info;
  }

  switch (verb) {
    case 'DROP': info.destructive = true; info.reason = 'DROP supprime un objet'; break;
    case 'TRUNCATE': info.destructive = true; info.reason = 'TRUNCATE vide une table'; break;
    case 'DELETE':
      if (!has('WHERE')) { info.destructive = true; info.reason = 'DELETE sans clause WHERE'; }
      break;
    case 'UPDATE':
      if (!has('WHERE')) { info.destructive = true; info.reason = 'UPDATE sans clause WHERE'; }
      break;
    case 'ALTER':
      if (has('DROP')) { info.destructive = true; info.reason = 'ALTER … DROP supprime une colonne ou contrainte'; }
      break;
    case 'GRANT': case 'REVOKE':
      info.destructive = true; info.reason = `${verb} modifie les droits`; break;
  }
  return info;
}

export function analyzeScript(script: string): StatementInfo[] {
  return splitStatements(script).map(analyzeStatement);
}

export class SqlGuardError extends Error {
  constructor(message: string, public statement?: string) { super(message); }
}

export interface GuardPolicy {
  /** Connexion en lecture seule (défaut). */
  readOnly: boolean;
  /** Autorisation au niveau de la connexion d'exécuter du destructif. */
  connectionAllowsDestructive: boolean;
  /** Autorisation explicite au niveau de l'étape ou de la requête. */
  explicitDestructive: boolean;
}

/** Vérifie une instruction ; lève SqlGuardError si elle est interdite par la politique. */
export function enforce(stmt: StatementInfo, p: GuardPolicy): void {
  if (stmt.destructive) {
    if (p.readOnly) throw new SqlGuardError(`Requête destructrice bloquée (${stmt.reason}) : connexion en lecture seule`, stmt.sql);
    if (!(p.connectionAllowsDestructive && p.explicitDestructive)) {
      throw new SqlGuardError(`Requête destructrice bloquée (${stmt.reason}) : autorisation explicite requise (connexion allowDestructive + étape allowDestructive)`, stmt.sql);
    }
  }
  if (stmt.write && p.readOnly) {
    throw new SqlGuardError(`Écriture refusée (${stmt.verb}${stmt.reason ? ' : ' + stmt.reason : ''}) : connexion en lecture seule`, stmt.sql);
  }
}

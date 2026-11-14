import { randomUUID } from 'node:crypto';
import { neutralize } from '../connectors/db/sqlGuard.js';
import { placeholder, type PlaceholderStyle } from '../connectors/db/types.js';

/**
 * Variables : {{chemin.vers.valeur}} résolu dans le contexte d'exécution
 * (jeu de données, variables d'environnement, sorties des étapes précédentes).
 * Variables intégrées : {{$uuid}}, {{$now}}, {{$timestamp}}, {{$today}}.
 */
const VAR = /\{\{\s*([\w$.\-[\]:]+)\s*\}\}/g;

export type Vars = Record<string, unknown>;

export function lookup(vars: Vars, path: string): unknown {
  switch (path) {
    case '$uuid': return randomUUID();
    case '$now': return new Date().toISOString();
    case '$timestamp': return Date.now();
    case '$today': return new Date().toISOString().slice(0, 10);
  }
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur: any = vars;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function need(vars: Vars, path: string): unknown {
  const v = lookup(vars, path);
  if (v === undefined) throw new Error(`Variable non définie : {{${path}}}`);
  return v;
}

/** Substitution texte (URL, corps, sélecteurs, commandes). */
export function renderString(tpl: string, vars: Vars): string {
  return tpl.replace(VAR, (_m, p) => {
    const v = need(vars, p);
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** Substitution profonde d'un objet : une chaîne réduite à « {{x}} » prend la valeur typée de x. */
export function renderDeep<T>(v: T, vars: Vars): T {
  const walk = (x: any): any => {
    if (typeof x === 'string') {
      const whole = /^\{\{\s*([\w$.\-[\]:]+)\s*\}\}$/.exec(x);
      return whole ? need(vars, whole[1]) : renderString(x, vars);
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  return walk(v);
}

/**
 * Requête SQL paramétrée : chaque {{var}} devient un paramètre lié (jamais concaténé),
 * y compris la forme '{{var}}' entre quotes. {{ident:var}} insère un identifiant validé.
 */
export function renderSql(sql: string, vars: Vars, style: PlaceholderStyle): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const neutral = neutralize(sql);
  let out = '';
  let last = 0;
  const re = /'?\{\{\s*([\w$.\-[\]:]+)\s*\}\}'?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    let token = m[0];
    let start = m.index;
    const quotedOpen = token.startsWith("'"), quotedClose = token.endsWith("'") && token.length > 1;
    const exactQuoted = quotedOpen && quotedClose;
    if (!exactQuoted) {
      // Retire une quote isolée captée par erreur.
      if (quotedOpen) { start += 1; token = token.slice(1); }
      if (token.endsWith("'")) token = token.slice(0, -1);
      // Variable située dans un littéral (ex. '%{{x}}%') : interdit, car non paramétrable.
      const at = neutral.slice(start, start + token.length);
      if (!at.includes('{{')) throw new Error(`{{${m[1]}}} est à l'intérieur d'une chaîne SQL : utilisez une concaténation, ex. '%' || {{${m[1]}}} || '%'`);
    }
    out += sql.slice(last, start);
    const name = m[1];
    if (name.startsWith('ident:')) {
      const v = String(need(vars, name.slice(6)));
      if (!/^[A-Za-z_][\w$#]*(\.[A-Za-z_][\w$#]*)?$/.test(v)) throw new Error(`Identifiant invalide pour {{${name}}} : ${v}`);
      out += v;
    } else {
      params.push(need(vars, name));
      out += placeholder(style, params.length);
    }
    last = start + token.length;
  }
  out += sql.slice(last);
  return { sql: out, params };
}

/** Commande MongoDB (JSON) : substitution typée des valeurs. */
export function renderMongo(cmd: string | object, vars: Vars): string {
  const obj = typeof cmd === 'string' ? JSON.parse(cmd) : cmd;
  return JSON.stringify(renderDeep(obj, vars));
}

/** Échappement pour insertion sûre dans un script shell (valeur entre quotes simples). */
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

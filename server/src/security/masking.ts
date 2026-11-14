/**
 * Masquage des données sensibles dans les logs, preuves et rapports.
 * - valeurs secrètes connues (mots de passe déchiffrés pendant l'exécution) ;
 * - motifs : en-têtes d'auth, paires clé=valeur sensibles, cartes bancaires (Luhn), IBAN, e-mails ;
 * - colonnes déclarées sensibles dans les résultats tabulaires.
 */
const MASK = '****';

const DEFAULT_SENSITIVE_KEYS = ['password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'mot_de_passe', 'iban', 'card', 'cvv'];

function luhn(digits: string): boolean {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

export interface MaskOptions { maskEmails?: boolean; sensitiveKeys?: string[] }

export class Masker {
  private secrets = new Set<string>();
  private keys: string[];
  constructor(private opts: MaskOptions = {}) {
    this.keys = [...DEFAULT_SENSITIVE_KEYS, ...(opts.sensitiveKeys ?? [])].map(k => k.toLowerCase());
  }

  addSecret(value: string | undefined | null) {
    if (value && value.length >= 3) this.secrets.add(value);
  }

  isSensitiveKey(key: string): boolean {
    const k = key.toLowerCase();
    return this.keys.some(s => k.includes(s));
  }

  text(input: string): string {
    if (!input) return input;
    let out = input;
    // Les plus longs d'abord pour éviter un masquage partiel.
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join(MASK);
    out = out.replace(/(authorization|proxy-authorization)\s*[:=]\s*("?)[^\s",}]+(\s+[^\s",}]+)?/gi, (_m, h, q) => `${h}: ${q}${MASK}`);
    out = out.replace(/\b(bearer|basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, (_m, s) => `${s} ${MASK}`);
    const keyAlt = this.keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    out = out.replace(new RegExp(`(["']?[\\w-]*(?:${keyAlt})[\\w-]*["']?\\s*[:=]\\s*)("([^"]*)"|'([^']*)'|[^\\s,;&}]+)`, 'gi'),
      (_m, k, v: string) => `${k}${v.startsWith('"') ? `"${MASK}"` : v.startsWith("'") ? `'${MASK}'` : MASK}`);
    out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, m => { const d = m.replace(/\D/g, ''); return d.length >= 13 && luhn(d) ? MASK : m; });
    out = out.replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g, MASK);
    if (this.opts.maskEmails) out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, MASK);
    return out;
  }

  /** Masque récursivement un objet JSON (clés sensibles + texte). */
  value<T>(v: T, extraColumns: string[] = []): T {
    const cols = extraColumns.map(c => c.toLowerCase());
    const walk = (x: any): any => {
      if (typeof x === 'string') return this.text(x);
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === 'object' && !(x instanceof Date) && !Buffer.isBuffer(x)) {
        const o: any = {};
        for (const [k, val] of Object.entries(x)) {
          o[k] = (this.isSensitiveKey(k) || cols.includes(k.toLowerCase())) && val != null ? MASK : walk(val);
        }
        return o;
      }
      return x;
    };
    return walk(v);
  }
}

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Secret chiffré tel que stocké : soit AES-256-GCM local, soit une référence Vault.
 * Le clair n'est jamais persisté ni renvoyé par l'API.
 */
export type SecretRef =
  | { kind: 'aes'; iv: string; tag: string; data: string }
  | { kind: 'vault'; path: string; key: string };

export interface SecretProvider {
  seal(plain: string): Promise<SecretRef>;
  open(ref: SecretRef): Promise<string>;
}

export function isSecretRef(v: unknown): v is SecretRef {
  return !!v && typeof v === 'object' && ((v as any).kind === 'aes' || (v as any).kind === 'vault');
}

function parseKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b = Buffer.from(raw, 'base64');
  if (b.length === 32) return b;
  // Phrase de passe : dérivation scrypt (sel fixe applicatif, la phrase reste le secret).
  return scryptSync(raw, 'testhub-master-key', 32);
}

/** Charge la clé maître depuis l'environnement, ou en génère une stockée dans dataDir (mode 0600). */
export function resolveMasterKey(dataDir: string, configured?: string): Buffer {
  if (configured) return parseKey(configured);
  const file = path.join(dataDir, 'master.key');
  if (fs.existsSync(file)) return parseKey(fs.readFileSync(file, 'utf8').trim());
  const key = randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

export class AesSecretProvider implements SecretProvider {
  constructor(private key: Buffer) {
    if (key.length !== 32) throw new Error('La clé AES-256 doit faire 32 octets');
  }
  async seal(plain: string): Promise<SecretRef> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return { kind: 'aes', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  async open(ref: SecretRef): Promise<string> {
    if (ref.kind !== 'aes') throw new Error('Secret non AES');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ref.iv, 'base64'));
    d.setAuthTag(Buffer.from(ref.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ref.data, 'base64')), d.final()]).toString('utf8');
  }
}

/** HashiCorp Vault KV v2. Les secrets saisis sont écrits sous `testhub/<uuid>`. */
export class VaultSecretProvider implements SecretProvider {
  constructor(private opts: { addr: string; token: string; mount: string }) {}
  private url(p: string) { return `${this.opts.addr.replace(/\/$/, '')}/v1/${this.opts.mount}/data/${p}`; }
  async seal(plain: string): Promise<SecretRef> {
    const p = `testhub/${crypto.randomUUID()}`;
    const r = await fetch(this.url(p), {
      method: 'POST', headers: { 'X-Vault-Token': this.opts.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { value: plain } }),
    });
    if (!r.ok) throw new Error(`Vault: écriture refusée (${r.status})`);
    return { kind: 'vault', path: p, key: 'value' };
  }
  async open(ref: SecretRef): Promise<string> {
    if (ref.kind !== 'vault') throw new Error('Secret non Vault');
    const r = await fetch(this.url(ref.path), { headers: { 'X-Vault-Token': this.opts.token } });
    if (!r.ok) throw new Error(`Vault: lecture refusée (${r.status})`);
    const j: any = await r.json();
    const v = j?.data?.data?.[ref.key];
    if (typeof v !== 'string') throw new Error(`Vault: clé ${ref.key} absente`);
    return v;
  }
}

/** Route vers AES ou Vault selon le type de référence ; scelle avec Vault s'il est configuré. */
export class CompositeSecretProvider implements SecretProvider {
  constructor(private aes: AesSecretProvider, private vault?: VaultSecretProvider) {}
  seal(plain: string) { return (this.vault ?? this.aes).seal(plain); }
  open(ref: SecretRef) {
    if (ref.kind === 'vault') {
      if (!this.vault) throw new Error('Secret Vault mais Vault non configuré');
      return this.vault.open(ref);
    }
    return this.aes.open(ref);
  }
}

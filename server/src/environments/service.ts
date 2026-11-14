import type { Store } from '../core/store.js';
import { isSecretRef, type SecretProvider, type SecretRef } from '../security/crypto.js';
import type { Masker } from '../security/masking.js';
import { SECRET_FIELDS, type Environment, type RuntimeEnvironment } from './model.js';

const COLLECTION = 'environments';

/**
 * Gestion des environnements cibles. Les secrets arrivent en clair dans l'API,
 * sont scellés (AES-256-GCM ou Vault) avant stockage, et ne ressortent jamais :
 * la vue publique remplace chaque secret par { set: true }.
 */
export class EnvironmentService {
  constructor(private store: Store, private secrets: SecretProvider) {}

  list(): Environment[] { return this.store.list<Environment>(COLLECTION); }

  get(idOrName: string): Environment | undefined {
    return this.store.get<Environment>(COLLECTION, idOrName) ?? this.list().find(e => e.name === idOrName);
  }

  require(idOrName: string): Environment {
    const e = this.get(idOrName);
    if (!e) throw new Error(`Environnement introuvable : ${idOrName}`);
    return e;
  }

  async save(input: any): Promise<Environment> {
    if (!input?.name) throw new Error('Le nom de l\'environnement est obligatoire');
    const existing = input.id ? this.get(input.id) : undefined;
    const dup = this.list().find(e => e.name === input.name && e.id !== input.id);
    if (dup) throw new Error(`Un environnement nommé ${input.name} existe déjà`);
    const env: any = {
      accounts: [], databases: [], servers: [], agents: [], schedulers: [], fileShares: [],
      ...input,
      isProduction: input.isProduction ?? input.kind === 'PROD',
    };
    for (const [list, { key, fields }] of Object.entries(SECRET_FIELDS)) {
      const items: any[] = env[list] ?? [];
      const seen = new Set<string>();
      for (const item of items) {
        if (!item[key]) throw new Error(`${list} : le champ ${key} est obligatoire`);
        if (seen.has(item[key])) throw new Error(`${list} : « ${item[key]} » est déclaré deux fois`);
        seen.add(item[key]);
        const prev = (existing as any)?.[list]?.find((x: any) => x[key] === item[key]);
        for (const f of fields) {
          const v = item[f];
          if (typeof v === 'string' && v !== '') item[f] = await this.secrets.seal(v);
          else if (isSecretRef(v)) { /* déjà scellé (import) */ }
          else if (v === null || v === '') delete item[f];
          else if (prev?.[f]) item[f] = prev[f]; // absent ou { set: true } : on conserve
          else delete item[f];
        }
      }
    }
    if (env.databases) for (const d of env.databases) if (d.readOnly === undefined) d.readOnly = true;
    return this.store.put<Environment>(COLLECTION, env);
  }

  delete(id: string) { return this.store.delete(COLLECTION, id); }

  /** Vue sans secrets pour l'API. */
  publicView(env: Environment): any {
    const out: any = structuredClone(env);
    for (const [list, { fields }] of Object.entries(SECRET_FIELDS)) {
      for (const item of out[list] ?? []) for (const f of fields) if (item[f]) item[f] = { set: true };
    }
    return out;
  }

  /** Déchiffre les secrets pour l'exécution et les enregistre dans le masqueur. */
  async resolve(idOrName: string, masker?: Masker): Promise<RuntimeEnvironment> {
    const env: any = structuredClone(this.require(idOrName));
    for (const [list, { fields }] of Object.entries(SECRET_FIELDS)) {
      for (const item of env[list] ?? []) {
        for (const f of fields) {
          if (isSecretRef(item[f])) {
            item[f] = await this.secrets.open(item[f] as SecretRef);
            masker?.addSecret(item[f]);
          }
        }
      }
    }
    return env as RuntimeEnvironment;
  }
}

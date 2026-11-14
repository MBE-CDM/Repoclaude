import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../core/store.js';

export type Role = 'admin' | 'tester' | 'approver' | 'viewer';
export interface User { id: string; name: string; roles: Role[]; tokenHash: string }
export interface Principal { id: string; name: string; roles: Role[] }

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class UserService {
  constructor(private store: Store) {}

  /** Crée l'administrateur initial si aucun utilisateur n'existe. Renvoie le jeton s'il vient d'être généré. */
  bootstrap(dataDir: string, adminToken?: string): string | undefined {
    if (this.store.list('users').length) return undefined;
    const token = adminToken ?? randomBytes(24).toString('base64url');
    this.store.put<Omit<User, 'id'>>('users', { name: 'admin', roles: ['admin', 'approver', 'tester'], tokenHash: hash(token) });
    if (!adminToken) fs.writeFileSync(path.join(dataDir, 'admin.token'), token, { mode: 0o600 });
    return adminToken ? undefined : token;
  }

  create(name: string, roles: Role[]): { user: Principal; token: string } {
    if (this.store.list<User>('users').some(u => u.name === name)) throw new Error(`Utilisateur ${name} déjà existant`);
    const token = randomBytes(24).toString('base64url');
    const u = this.store.put<Omit<User, 'id'>>('users', { name, roles, tokenHash: hash(token) });
    return { user: { id: u.id, name, roles }, token };
  }

  list(): Principal[] {
    return this.store.list<User>('users').map(({ id, name, roles }) => ({ id, name, roles }));
  }

  authenticate(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    const h = hash(token);
    const u = this.store.list<User>('users').find(x => safeEqual(x.tokenHash, h));
    return u ? { id: u.id, name: u.name, roles: u.roles } : undefined;
  }
}

export function hasRole(p: Principal, ...roles: Role[]) {
  return p.roles.includes('admin') || roles.some(r => p.roles.includes(r));
}

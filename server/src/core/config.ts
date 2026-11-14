import path from 'node:path';
import fs from 'node:fs';

export type ProdPolicy = 'forbid' | 'dual-approval';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Clé maître AES-256 (hex 64 car. ou base64 32 octets). */
  masterKey?: string;
  /** Coffre HashiCorp Vault (optionnel). */
  vault?: { addr: string; token: string; mount: string };
  prodPolicy: ProdPolicy;
  bootstrapAdminToken?: string;
  webDist: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.TESTHUB_DATA_DIR ?? path.join(process.cwd(), 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    port: Number(env.TESTHUB_PORT ?? 8080),
    host: env.TESTHUB_HOST ?? '0.0.0.0',
    dataDir,
    masterKey: env.TESTHUB_MASTER_KEY,
    vault: env.VAULT_ADDR && env.VAULT_TOKEN
      ? { addr: env.VAULT_ADDR, token: env.VAULT_TOKEN, mount: env.VAULT_MOUNT ?? 'secret' }
      : undefined,
    prodPolicy: env.TESTHUB_PROD_POLICY === 'forbid' ? 'forbid' : 'dual-approval',
    bootstrapAdminToken: env.TESTHUB_ADMIN_TOKEN,
    webDist: path.resolve(env.TESTHUB_WEB_DIST ?? path.join(process.cwd(), '..', 'web', 'dist')),
  };
}

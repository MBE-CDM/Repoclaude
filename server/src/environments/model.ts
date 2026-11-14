import type { SecretRef } from '../security/crypto.js';

export type DbEngine = 'postgres' | 'oracle' | 'mssql' | 'mysql' | 'mariadb' | 'db2' | 'sqlite' | 'mongodb';

/** Champ secret : chiffré au repos (S = SecretRef), en clair uniquement à l'exécution (S = string). */
export interface SshServer<S = SecretRef> {
  name: string;
  host: string;
  port?: number;
  user: string;
  password?: S;
  privateKey?: S;
  passphrase?: S;
  /** Interpréteurs disponibles, ex. { python: 'python3', powershell: 'pwsh' } */
  interpreters?: Partial<Record<'shell' | 'python' | 'powershell', string>>;
}

export interface DbConnection<S = SecretRef> {
  name: string;
  engine: DbEngine;
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
  user?: string;
  password?: S;
  /** SQLite : chemin du fichier. Oracle : connectString facultatif. MongoDB : URI facultative. */
  file?: string;
  connectString?: string;
  uri?: string;
  ssl?: { enabled: boolean; rejectUnauthorized?: boolean; ca?: string };
  /** Nom d'un serveur SSH de l'environnement servant de bastion. */
  sshTunnel?: string;
  /** Lecture seule par défaut. Les écritures nécessitent readOnly=false ; les requêtes destructrices une autorisation explicite. */
  readOnly?: boolean;
  allowDestructive?: boolean;
  options?: Record<string, unknown>;
}

export type LoginTest =
  | { mode: 'api'; method?: string; path: string; body?: unknown; headers?: Record<string, string>; expectStatus?: number }
  | { mode: 'ui'; path?: string; userSelector: string; passwordSelector: string; submitSelector: string; successSelector?: string; successUrlContains?: string };

export interface TestAccount<S = SecretRef> {
  profile: string;
  username: string;
  password?: S;
  loginTest?: LoginTest;
}

export interface ExecutionAgent<S = SecretRef> { name: string; url: string; token?: S }

export type SchedulerKind = 'jenkins' | 'gitlab' | 'airflow' | 'controlm';
export interface SchedulerConfig<S = SecretRef> {
  name: string;
  kind: SchedulerKind;
  baseUrl: string;
  user?: string;
  token?: S;
  password?: S;
  options?: Record<string, unknown>;
}

export interface FileShare { name: string; kind: 'sftp' | 'local'; server?: string; root: string }

export interface Environment<S = SecretRef> {
  id: string;
  name: string;
  kind: 'DEV' | 'INT' | 'RECETTE' | 'PREPROD' | 'PROD' | string;
  isProduction?: boolean;
  description?: string;
  frontUrl?: string;
  apiUrl?: string;
  healthPath?: string;
  variables?: Record<string, string>;
  accounts: TestAccount<S>[];
  databases: DbConnection<S>[];
  servers: SshServer<S>[];
  agents: ExecutionAgent<S>[];
  schedulers: SchedulerConfig<S>[];
  fileShares: FileShare[];
  /** Colonnes masquées dans les résultats et preuves (en plus des clés sensibles par défaut). */
  sensitiveColumns?: string[];
}

export type RuntimeEnvironment = Environment<string>;

/** Chemins des champs secrets dans un environnement, par liste nommée. */
export const SECRET_FIELDS: Record<'accounts' | 'databases' | 'servers' | 'agents' | 'schedulers', { key: string; fields: string[] }> = {
  accounts: { key: 'profile', fields: ['password'] },
  databases: { key: 'name', fields: ['password'] },
  servers: { key: 'name', fields: ['password', 'privateKey', 'passphrase'] },
  agents: { key: 'name', fields: ['token'] },
  schedulers: { key: 'name', fields: ['token', 'password'] },
};

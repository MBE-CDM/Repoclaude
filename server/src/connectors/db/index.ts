import type { DbConnection, DbEngine, RuntimeEnvironment } from '../../environments/model.js';
import { openTunnel } from '../ssh.js';
import * as A from './adapters.js';
import { mongodb, enforceMongo, type MongoCommand } from './mongo.js';
import { analyzeStatement, enforce, splitStatements, type GuardPolicy } from './sqlGuard.js';
import type { DbSession, QueryResult } from './types.js';

export const DEFAULT_PORTS: Record<DbEngine, number> = {
  postgres: 5432, mysql: 3306, mariadb: 3306, mssql: 1433, oracle: 1521, db2: 50000, sqlite: 0, mongodb: 27017,
};

export const SUPPORTED_ENGINES: DbEngine[] = ['postgres', 'oracle', 'mssql', 'mysql', 'mariadb', 'db2', 'sqlite', 'mongodb'];

/**
 * Connexion ouverte et protégée : toute requête passe par le garde SQL
 * (lecture seule par défaut, blocage des requêtes destructrices sauf double autorisation).
 */
export class GuardedDb {
  constructor(readonly config: DbConnection<string>, readonly session: DbSession, private onClose: () => void) {}

  policy(explicitDestructive = false): GuardPolicy {
    return { readOnly: this.config.readOnly !== false, connectionAllowsDestructive: !!this.config.allowDestructive, explicitDestructive };
  }

  /** Exécute une instruction unique (ou une commande MongoDB JSON). */
  async query(sql: string, params: unknown[] = [], opts: { allowDestructive?: boolean } = {}): Promise<QueryResult> {
    if (this.config.engine === 'mongodb') {
      enforceMongo(JSON.parse(sql) as MongoCommand, this.policy(opts.allowDestructive));
      return this.session.query(sql, params);
    }
    const parts = splitStatements(sql);
    const block = /^\s*(BEGIN|DECLARE)\b/i.test(sql) && !/^\s*BEGIN\s+(TRANSACTION|TRAN|WORK)\b/i.test(sql);
    if (parts.length > 1 && !block) throw new Error('Une seule instruction SQL par requête (utilisez un script pour en enchaîner plusieurs)');
    enforce(analyzeStatement(sql), this.policy(opts.allowDestructive));
    return this.session.query(sql, params);
  }

  /** Exécute un script multi-instructions (setup/teardown). Chaque instruction est contrôlée avant exécution. */
  async script(script: string, opts: { allowDestructive?: boolean } = {}): Promise<{ statements: number; results: QueryResult[] }> {
    const stmts = this.config.engine === 'mongodb' ? parseMongoScript(script) : splitStatements(script);
    const pol = this.policy(opts.allowDestructive);
    // Contrôle complet AVANT d'exécuter quoi que ce soit.
    if (this.config.engine !== 'mongodb') for (const s of stmts) enforce(analyzeStatement(s), pol);
    else for (const s of stmts) enforceMongo(JSON.parse(s), pol);
    const results: QueryResult[] = [];
    for (const s of stmts) results.push(await this.session.query(s));
    return { statements: stmts.length, results };
  }

  async close() { try { await this.session.close(); } finally { this.onClose(); } }
}

function parseMongoScript(script: string): string[] {
  const v = JSON.parse(script);
  return (Array.isArray(v) ? v : [v]).map(x => JSON.stringify(x));
}

export async function openDb(env: RuntimeEnvironment, name: string): Promise<GuardedDb> {
  const cfg = env.databases.find(d => d.name === name);
  if (!cfg) throw new Error(`Base « ${name} » non déclarée dans l'environnement ${env.name}`);
  const c: any = { ...cfg, port: cfg.port ?? DEFAULT_PORTS[cfg.engine], host: cfg.host ?? 'localhost' };
  let closeTunnel = () => {};
  if (cfg.sshTunnel && cfg.engine !== 'sqlite') {
    const srv = env.servers.find(s => s.name === cfg.sshTunnel);
    if (!srv) throw new Error(`Tunnel SSH : serveur « ${cfg.sshTunnel} » non déclaré`);
    const t = await openTunnel(srv, c.host, c.port);
    c.host = t.host; c.port = t.port; closeTunnel = t.close;
  }
  try {
    let s: DbSession;
    switch (cfg.engine) {
      case 'postgres': s = await A.postgres(c); break;
      case 'mysql': case 'mariadb': s = await A.mysql(c); break;
      case 'mssql': s = await A.mssql(c); break;
      case 'oracle': s = await A.oracle(c); break;
      case 'sqlite': s = await A.sqlite(c); break;
      case 'db2': s = await A.db2(c); break;
      case 'mongodb': s = await mongodb(c); break;
      default: throw new Error(`Moteur non pris en charge : ${(cfg as any).engine}`);
    }
    return new GuardedDb(cfg, s, closeTunnel);
  } catch (e) {
    closeTunnel();
    throw e;
  }
}

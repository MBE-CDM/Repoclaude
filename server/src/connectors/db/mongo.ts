import type { DbConnection } from '../../environments/model.js';
import { normalizeRow, type DbSession, type QueryResult } from './types.js';
import { SqlGuardError, type GuardPolicy } from './sqlGuard.js';

/**
 * MongoDB : la « requête » est un document JSON :
 * { "collection": "commande", "op": "find", "filter": {...}, "projection": {...}, "sort": {...}, "limit": 100 }
 * op ∈ find | findOne | aggregate | countDocuments | distinct | insertOne | insertMany | updateOne | updateMany | deleteOne | deleteMany | drop
 */
export interface MongoCommand {
  collection: string;
  op: string;
  filter?: any; projection?: any; sort?: any; limit?: number;
  pipeline?: any[]; field?: string; document?: any; documents?: any[]; update?: any;
}

const READ_OPS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'distinct']);

export function analyzeMongo(cmd: MongoCommand): { write: boolean; destructive: boolean; reason?: string } {
  if (!cmd?.collection || !cmd?.op) throw new Error('Commande MongoDB invalide : collection et op obligatoires');
  if (READ_OPS.has(cmd.op)) {
    const w = cmd.op === 'aggregate' && (cmd.pipeline ?? []).some(s => '$out' in s || '$merge' in s);
    return { write: w, destructive: false, reason: w ? 'aggregate avec $out/$merge' : undefined };
  }
  const emptyFilter = !cmd.filter || Object.keys(cmd.filter).length === 0;
  if (cmd.op === 'drop') return { write: true, destructive: true, reason: 'drop de collection' };
  if ((cmd.op === 'deleteMany' || cmd.op === 'updateMany') && emptyFilter) return { write: true, destructive: true, reason: `${cmd.op} sans filtre` };
  return { write: true, destructive: false };
}

export function enforceMongo(cmd: MongoCommand, p: GuardPolicy) {
  const a = analyzeMongo(cmd);
  if (a.destructive && (p.readOnly || !(p.connectionAllowsDestructive && p.explicitDestructive))) {
    throw new SqlGuardError(`Commande MongoDB destructrice bloquée (${a.reason}) : autorisation explicite requise`);
  }
  if (a.write && p.readOnly) throw new SqlGuardError(`Écriture MongoDB refusée (${cmd.op}) : connexion en lecture seule`);
}

export async function mongodb(c: DbConnection<string> & { host?: string; port?: number }): Promise<DbSession> {
  const { MongoClient } = await import('mongodb');
  const uri = c.uri ?? `mongodb://${c.user ? `${encodeURIComponent(c.user)}:${encodeURIComponent(c.password ?? '')}@` : ''}${c.host}:${c.port ?? 27017}/${c.database ?? ''}`;
  const client = new MongoClient(uri, { tls: c.ssl?.enabled, tlsAllowInvalidCertificates: c.ssl?.enabled ? c.ssl.rejectUnauthorized === false : undefined, serverSelectionTimeoutMS: 15000, ...(c.uri ? {} : { directConnection: true }) });
  await client.connect();
  const db = client.db(c.database);
  let session: any;
  const run = async (raw: string): Promise<QueryResult> => {
    const s = Date.now();
    const cmd: MongoCommand = JSON.parse(raw);
    const col = db.collection(cmd.collection);
    const opt = session ? { session } : {};
    let rows: any[] = []; let affected: number | undefined;
    switch (cmd.op) {
      case 'find': rows = await col.find(cmd.filter ?? {}, { projection: cmd.projection, sort: cmd.sort, limit: cmd.limit ?? 1000, ...opt }).toArray(); break;
      case 'findOne': { const d = await col.findOne(cmd.filter ?? {}, { projection: cmd.projection, ...opt }); rows = d ? [d] : []; break; }
      case 'aggregate': rows = await col.aggregate(cmd.pipeline ?? [], opt).toArray(); break;
      case 'countDocuments': rows = [{ count: await col.countDocuments(cmd.filter ?? {}, opt) }]; break;
      case 'distinct': rows = (await col.distinct(cmd.field!, cmd.filter ?? {}, opt)).map(v => ({ [cmd.field!]: v })); break;
      case 'insertOne': await col.insertOne(cmd.document, opt); affected = 1; break;
      case 'insertMany': affected = (await col.insertMany(cmd.documents ?? [], opt)).insertedCount; break;
      case 'updateOne': affected = (await col.updateOne(cmd.filter ?? {}, cmd.update, opt)).modifiedCount; break;
      case 'updateMany': affected = (await col.updateMany(cmd.filter ?? {}, cmd.update, opt)).modifiedCount; break;
      case 'deleteOne': affected = (await col.deleteOne(cmd.filter ?? {}, opt)).deletedCount; break;
      case 'deleteMany': affected = (await col.deleteMany(cmd.filter ?? {}, opt)).deletedCount; break;
      case 'drop': await col.drop(); affected = 0; break;
      default: throw new Error(`Opération MongoDB non prise en charge : ${cmd.op}`);
    }
    const norm = rows.map(r => normalizeRow(JSON.parse(JSON.stringify(r))));
    const columns = [...new Set(norm.flatMap(r => Object.keys(r)))];
    return { columns, rows: norm, rowCount: norm.length, affected, durationMs: Date.now() - s };
  };
  return {
    engine: 'mongodb',
    query: (raw) => run(raw),
    // Transactions : nécessitent un replica set.
    begin: async () => { session = client.startSession(); session.startTransaction(); },
    commit: async () => { await session?.commitTransaction(); await session?.endSession(); session = undefined; },
    rollback: async () => { if (session) { await session.abortTransaction(); await session.endSession(); session = undefined; } },
    savepoint: async () => { throw new Error('MongoDB ne gère pas les points de sauvegarde'); },
    rollbackTo: async () => { throw new Error('MongoDB ne gère pas les points de sauvegarde'); },
    ping: async () => { await db.command({ ping: 1 }); },
    schema: async () => {
      const cols = await db.listCollections({}, { nameOnly: true }).toArray();
      const tables = [];
      for (const ci of cols) {
        const sample = await db.collection(ci.name).find({}, { limit: 20 }).toArray();
        const keys = new Map<string, string>();
        for (const d of sample) for (const [k, v] of Object.entries(d)) if (!keys.has(k)) keys.set(k, Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'object' ? (v as any).constructor?.name ?? 'object' : typeof v);
        tables.push({ name: ci.name, type: 'collection' as const, columns: [...keys].map(([name, type]) => ({ name, type })) });
      }
      return { tables };
    },
    close: async () => { if (session) await session.abortTransaction().catch(() => {}); await client.close(); },
  };
}

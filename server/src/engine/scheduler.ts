import { Cron } from 'croner';
import type { Store } from '../core/store.js';
import type { Campaign } from './model.js';
import type { ExecutionService } from './runner.js';
import type { Principal } from '../security/auth.js';

/** Planification cron des campagnes automatiques. */
export class CampaignScheduler {
  private jobs = new Map<string, Cron>();
  constructor(private store: Store, private executions: ExecutionService, private log: (msg: string) => void = console.log) {}

  static validate(expr: string, timezone?: string) {
    const c = new Cron(expr, { paused: true, timezone });
    const next = c.nextRun();
    c.stop();
    return next?.toISOString();
  }

  reloadAll() {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    for (const c of this.store.list<Campaign>('campaigns')) this.reload(c);
  }

  reload(c: Campaign) {
    this.jobs.get(c.id)?.stop();
    this.jobs.delete(c.id);
    if (!c.schedule?.enabled || !c.schedule.cron) return;
    const sys: Principal = { id: 'scheduler', name: 'planificateur', roles: ['tester'] };
    const job = new Cron(c.schedule.cron, { timezone: c.schedule.timezone, protect: true }, () => {
      try {
        const e = this.executions.start({ kind: 'campaign', refId: c.id, trigger: 'schedule' }, sys);
        this.log(`Campagne planifiée « ${c.name} » lancée (exécution ${e.id})`);
      } catch (err: any) {
        this.log(`Campagne planifiée « ${c.name} » non lancée : ${err.message}`);
      }
    });
    this.jobs.set(c.id, job);
  }

  remove(id: string) { this.jobs.get(id)?.stop(); this.jobs.delete(id); }

  nextRun(id: string) { return this.jobs.get(id)?.nextRun()?.toISOString(); }

  stopAll() { for (const j of this.jobs.values()) j.stop(); this.jobs.clear(); }
}

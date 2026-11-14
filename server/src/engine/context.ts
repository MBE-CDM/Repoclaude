import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { RuntimeEnvironment } from '../environments/model.js';
import type { GuardedDb } from '../connectors/db/index.js';
import { openDb } from '../connectors/db/index.js';
import type { Masker } from '../security/masking.js';
import type { AuditLog, AuditEntry } from '../security/audit.js';
import type { Evidence, StepResult } from './model.js';
import type { Vars } from './template.js';

export interface UiSession { browser: Browser; context: BrowserContext; page: Page; headless: boolean; consoleLines: string[] }

/** Contexte partagé par toutes les étapes d'un cas : variables, connexions, navigateur, preuves. */
export class ExecContext {
  vars: Vars;
  readonly dbs = new Map<string, GuardedDb>();
  readonly snapshots = new Map<string, { query: string; params: unknown[]; database: string; rows: Record<string, unknown>[] }>();
  ui?: UiSession;
  current?: StepResult;
  private seq = 0;
  aborted = false;

  constructor(
    readonly executionId: string,
    readonly env: RuntimeEnvironment,
    readonly masker: Masker,
    private auditLog: AuditLog,
    readonly actor: string,
    readonly evidenceDir: string,
    vars: Vars,
    readonly emit: (event: string, data: unknown) => void = () => {},
  ) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    this.vars = vars;
  }

  log(line: string) {
    const masked = this.masker.text(line);
    const stamped = `${new Date().toISOString().slice(11, 23)} ${masked}`;
    this.current?.logs.push(stamped);
    this.emit('log', { step: this.current?.index, line: stamped });
  }

  audit(e: Omit<AuditEntry, 'actor' | 'environment' | 'executionId'>) {
    this.auditLog.record({ ...e, actor: this.actor, environment: this.env.name, executionId: this.executionId }, this.masker);
  }

  /** Enregistre un fichier de preuve (le contenu texte est masqué). */
  saveEvidence(type: Evidence['type'], name: string, content: Buffer | string, ext: string): Evidence {
    const file = `${String(++this.seq).padStart(3, '0')}-${name.replace(/[^\w.-]+/g, '_').slice(0, 60)}.${ext}`;
    const data = typeof content === 'string' ? this.masker.text(content) : content;
    fs.writeFileSync(path.join(this.evidenceDir, file), data);
    const ev: Evidence = { type, name, file };
    this.current?.evidence.push(ev);
    return ev;
  }

  addEvidence(ev: Evidence) {
    const masked = ev.data !== undefined ? { ...ev, data: this.masker.value(ev.data, this.env.sensitiveColumns) } : ev;
    this.current?.evidence.push(masked);
    return masked;
  }

  newFilePath(name: string) {
    return path.join(this.evidenceDir, `${String(++this.seq).padStart(3, '0')}-${name}`);
  }

  async db(name: string): Promise<GuardedDb> {
    let d = this.dbs.get(name);
    if (!d) {
      d = await openDb(this.env, name);
      this.dbs.set(name, d);
    }
    return d;
  }

  async closeUi() {
    if (!this.ui) return;
    const ui = this.ui; this.ui = undefined;
    const video = ui.page.video();
    try { await ui.context.tracing.stop({ path: this.newFilePath('trace.zip') }); } catch { /* */ }
    await ui.context.close().catch(() => {});
    await ui.browser.close().catch(() => {});
    if (video) {
      const p = await video.path().catch(() => undefined);
      if (p && fs.existsSync(p)) this.current?.evidence.push({ type: 'video', name: 'vidéo', file: path.basename(p) });
    }
    // Rattache trace et HAR produits à l'étape courante.
    for (const f of fs.readdirSync(this.evidenceDir)) {
      if (f.endsWith('trace.zip') && !this.current?.evidence.some(e => e.file === f)) this.current?.evidence.push({ type: 'trace', name: 'trace Playwright', file: f });
      if (f.endsWith('.har') && !this.current?.evidence.some(e => e.file === f)) {
        const full = path.join(this.evidenceDir, f);
        fs.writeFileSync(full, this.masker.text(fs.readFileSync(full, 'utf8')));
        this.current?.evidence.push({ type: 'har', name: 'trace réseau (HAR)', file: f });
      }
    }
    if (ui.consoleLines.length) this.saveEvidence('console', 'console navigateur', ui.consoleLines.join('\n'), 'log');
  }

  async closeAll() {
    await this.closeUi();
    for (const [, d] of this.dbs) await d.close().catch(() => {});
    this.dbs.clear();
  }
}

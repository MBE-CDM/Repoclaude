import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import type { UiAction, UiStep } from '../engine/model.js';

/** Script injecté dans la page : capture clics, saisies, sélections et validations. */
const INIT_SCRIPT = `(() => {
  if (window.__thRecorderInstalled) return; window.__thRecorderInstalled = true;
  const esc = s => s.replace(/"/g, '\\\\"');
  function selector(el) {
    if (!(el instanceof Element)) return null;
    for (const a of ['data-testid', 'data-test', 'data-cy']) if (el.getAttribute(a)) return '[' + a + '="' + esc(el.getAttribute(a)) + '"]';
    if (el.id && !/^\\d|[:.]/.test(el.id)) return '#' + el.id;
    if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + esc(el.getAttribute('name')) + '"]';
    if (el.getAttribute('aria-label')) return '[aria-label="' + esc(el.getAttribute('aria-label')) + '"]';
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || '').trim();
    if ((tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') && text && text.length < 60 && !text.includes('\\n')) return tag + ':has-text("' + esc(text) + '")';
    if (el.getAttribute('placeholder')) return tag + '[placeholder="' + esc(el.getAttribute('placeholder')) + '"]';
    const parts = []; let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let p = cur.tagName.toLowerCase();
      if (cur.id && !/^\\d|[:.]/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
      const sib = cur.parentElement ? [...cur.parentElement.children].filter(c => c.tagName === cur.tagName) : [];
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
      parts.unshift(p); cur = cur.parentElement;
    }
    return parts.join(' > ');
  }
  const target = e => { let t = e.composedPath ? e.composedPath()[0] : e.target; if (t && t.nodeType === 3) t = t.parentElement; return t; };
  const clickable = el => el && el.closest('a,button,input[type=submit],input[type=button],input[type=checkbox],input[type=radio],[role=button],[onclick],label,summary,li,td,span,div');
  document.addEventListener('click', e => {
    const t = target(e); if (!t) return;
    if (t.tagName === 'INPUT' && ['text','email','password','number','search','tel','url','date'].includes(t.type)) return;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'OPTION') return;
    const el = clickable(t) || t;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) { window.__thRecord({ action: el.checked ? 'check' : 'uncheck', selector: selector(el) }); return; }
    window.__thRecord({ action: 'click', selector: selector(el) });
  }, true);
  document.addEventListener('change', e => {
    const t = target(e); if (!t) return;
    if (t.tagName === 'SELECT') window.__thRecord({ action: 'select', selector: selector(t), value: t.value });
    else if ((t.tagName === 'INPUT' && !['checkbox','radio','submit','button','file'].includes(t.type)) || t.tagName === 'TEXTAREA')
      window.__thRecord({ action: 'fill', selector: selector(t), value: t.type === 'password' ? '{{motDePasse}}' : t.value, sensitive: t.type === 'password' });
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const t = target(e); if (t && (t.tagName === 'INPUT')) {
      if (t.type !== 'password') window.__thRecord({ action: 'fill', selector: selector(t), value: t.value });
      else window.__thRecord({ action: 'fill', selector: selector(t), value: '{{motDePasse}}', sensitive: true });
      window.__thRecord({ action: 'press', selector: selector(t), key: 'Enter' }); } }
  }, true);
})();`;

interface RecSession { id: string; browser: Browser; page: Page; baseUrl?: string; actions: UiAction[]; startedAt: string; startUrl: string }

export class RecorderService {
  private sessions = new Map<string, RecSession>();

  async start(opts: { startUrl: string; baseUrl?: string; headless?: boolean }): Promise<{ id: string }> {
    const browser = await chromium.launch({ headless: opts.headless ?? false });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const s: RecSession = { id: randomUUID(), browser, page: await context.newPage(), baseUrl: opts.baseUrl, actions: [], startedAt: new Date().toISOString(), startUrl: opts.startUrl };
    await context.exposeBinding('__thRecord', (_src, a: any) => this.push(s, a));
    await context.addInitScript(INIT_SCRIPT);
    s.actions.push({ action: 'goto', url: this.relative(s, opts.startUrl) });
    await s.page.goto(opts.startUrl);
    browser.on('disconnected', () => { /* fenêtre fermée par l'utilisateur : la session reste lisible jusqu'à stop() */ });
    this.sessions.set(s.id, s);
    return { id: s.id };
  }

  private relative(s: RecSession, url: string) {
    if (s.baseUrl && url.startsWith(s.baseUrl)) return '/' + url.slice(s.baseUrl.length).replace(/^\//, '');
    return url;
  }

  private push(s: RecSession, a: any) {
    if (!a?.selector && a?.action !== 'press') return;
    const last = s.actions[s.actions.length - 1] as any;
    // Fusionne les saisies successives sur le même champ.
    if (a.action === 'fill' && last?.action === 'fill' && last.selector === a.selector) { last.value = a.value; return; }
    if (a.action === 'click' && last?.action === 'click' && last.selector === a.selector) return;
    // Un clic sur un champ suivi d'un fill du même champ : le clic est superflu.
    if (a.action === 'fill' && last?.action === 'click' && last.selector === a.selector) s.actions.pop();
    const { sensitive, ...action } = a;
    void sensitive;
    s.actions.push(action);
  }

  get(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Session d\'enregistrement introuvable');
    return s;
  }

  /** Accès direct à la page (tests automatisés de l'enregistreur). */
  page(id: string): Page { return this.get(id).page; }

  actions(id: string) { return this.get(id).actions; }

  async stop(id: string, opts: { addFinalScreenshot?: boolean } = {}): Promise<UiStep> {
    const s = this.get(id);
    this.sessions.delete(id);
    await s.browser.close().catch(() => {});
    const actions = [...s.actions];
    if (opts.addFinalScreenshot !== false) actions.push({ action: 'screenshot', name: 'fin du scénario enregistré' });
    return { type: 'ui', name: `Scénario enregistré le ${s.startedAt.slice(0, 16).replace('T', ' ')}`, actions };
  }

  list() { return [...this.sessions.values()].map(s => ({ id: s.id, startUrl: s.startUrl, startedAt: s.startedAt, actions: s.actions.length })); }
}

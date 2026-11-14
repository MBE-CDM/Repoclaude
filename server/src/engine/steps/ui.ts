import { chromium } from 'playwright';
import type { ExecContext } from '../context.js';
import type { UiAction, UiStep } from '../model.js';
import { renderString } from '../template.js';
import type { AssertionResult } from '../assertions.js';
import type { LoginTest, RuntimeEnvironment } from '../../environments/model.js';

export function resolveUrl(base: string | undefined, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!base) throw new Error(`URL relative « ${url} » mais aucune URL n'est configurée pour l'environnement`);
  return new URL(url.replace(/^\//, ''), base.endsWith('/') ? base : base + '/').toString();
}

export async function launchUi(ctx: ExecContext, step: Pick<UiStep, 'headless' | 'viewport'>) {
  if (ctx.ui) return ctx.ui;
  const headless = step.headless ?? process.env.TESTHUB_HEADLESS !== 'false';
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: step.viewport ?? { width: 1366, height: 768 },
    recordVideo: { dir: ctx.evidenceDir, size: { width: 1280, height: 720 } },
    recordHar: { path: ctx.newFilePath('network.har'), content: 'omit' },
    ignoreHTTPSErrors: true,
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => consoleLines.push(`[requestfailed] ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
  ctx.ui = { browser, context, page, headless, consoleLines };
  ctx.log(`Navigateur Chromium lancé (${headless ? 'headless' : 'visible'})`);
  return ctx.ui;
}

async function uiLogin(page: import('playwright').Page, env: RuntimeEnvironment, profile: string, log: (s: string) => void) {
  const acc = env.accounts.find(a => a.profile === profile);
  if (!acc) throw new Error(`Compte de test « ${profile} » absent de l'environnement ${env.name}`);
  const lt = acc.loginTest as Extract<LoginTest, { mode: 'ui' }> | undefined;
  if (!lt || lt.mode !== 'ui') throw new Error(`Le compte « ${profile} » n'a pas de configuration de login UI`);
  await page.goto(resolveUrl(env.frontUrl, lt.path ?? '/'));
  await page.fill(lt.userSelector, acc.username);
  await page.fill(lt.passwordSelector, acc.password ?? '');
  await page.click(lt.submitSelector);
  if (lt.successSelector) await page.waitForSelector(lt.successSelector, { timeout: 15000 });
  if (lt.successUrlContains) await page.waitForURL(u => u.toString().includes(lt.successUrlContains!), { timeout: 15000 });
  log(`Connexion UI avec le profil ${profile} (${acc.username})`);
}

export async function runUi(ctx: ExecContext, step: UiStep): Promise<AssertionResult[]> {
  const { page } = await launchUi(ctx, step);
  const timeout = step.timeoutMs ?? 15000;
  page.setDefaultTimeout(timeout);
  const results: AssertionResult[] = [];
  const r = (s: string) => renderString(s, ctx.vars);
  for (const [i, a] of step.actions.entries()) {
    const label = `#${i + 1} ${a.action}${'selector' in a && a.selector ? ' ' + a.selector : ''}`;
    ctx.log(label);
    try {
      await runAction(ctx, page, a, r, results);
    } catch (e: any) {
      const shot = await page.screenshot({ fullPage: true }).catch(() => undefined);
      if (shot) ctx.saveEvidence('screenshot', `échec-${a.action}`, shot, 'png');
      throw new Error(`${label} : ${e.message.split('\n')[0]}`);
    }
  }
  const shot = await page.screenshot().catch(() => undefined);
  if (shot) ctx.saveEvidence('screenshot', 'fin d\'étape', shot, 'png');
  return results;
}

async function runAction(ctx: ExecContext, page: import('playwright').Page, a: UiAction, r: (s: string) => string, results: AssertionResult[]) {
  switch (a.action) {
    case 'goto': await page.goto(resolveUrl(ctx.env.frontUrl, r(a.url ?? '/'))); break;
    case 'login': await uiLogin(page, ctx.env, r(a.profile), s => ctx.log(s)); break;
    case 'click': await page.click(r(a.selector)); break;
    case 'dblclick': await page.dblclick(r(a.selector)); break;
    case 'hover': await page.hover(r(a.selector)); break;
    case 'check': await page.check(r(a.selector)); break;
    case 'uncheck': await page.uncheck(r(a.selector)); break;
    case 'waitFor': await page.waitForSelector(r(a.selector)); break;
    case 'fill': await page.fill(r(a.selector), r(a.value)); break;
    case 'press': a.selector ? await page.press(r(a.selector), a.key) : await page.keyboard.press(a.key); break;
    case 'select': await page.selectOption(r(a.selector), r(a.value)); break;
    case 'wait': await page.waitForTimeout(Math.min(a.ms, 60000)); break;
    case 'screenshot': ctx.saveEvidence('screenshot', a.name ?? 'capture', await page.screenshot({ fullPage: a.fullPage }), 'png'); break;
    case 'expectText': {
      const loc = page.locator(r(a.selector)).first();
      await loc.waitFor();
      const actual = (await loc.innerText()).trim();
      const ok = a.text !== undefined ? actual === r(a.text) : actual.includes(r(a.contains ?? ''));
      results.push({ assertion: `texte de ${a.selector} ${a.text !== undefined ? '= ' + JSON.stringify(r(a.text)) : 'contient ' + JSON.stringify(r(a.contains ?? ''))}`, ok, expected: a.text ?? a.contains, actual });
      break;
    }
    case 'expectVisible': case 'expectHidden': {
      const sel = r(a.selector);
      let ok = true;
      try { await page.waitForSelector(sel, { state: a.action === 'expectVisible' ? 'visible' : 'hidden', timeout: 10000 }); } catch { ok = false; }
      results.push({ assertion: `${sel} ${a.action === 'expectVisible' ? 'visible' : 'masqué'}`, ok });
      break;
    }
    case 'expectUrl': {
      const c = r(a.contains);
      try { await page.waitForURL(u => u.toString().includes(c), { timeout: 10000 }); } catch { /* évalué ci-dessous */ }
      results.push({ assertion: `URL contient ${c}`, ok: page.url().includes(c), expected: c, actual: page.url() });
      break;
    }
    case 'expectTitle': {
      const t = await page.title();
      results.push({ assertion: `titre contient ${a.contains}`, ok: t.includes(r(a.contains)), expected: a.contains, actual: t });
      break;
    }
    case 'extract': {
      const loc = page.locator(r(a.selector)).first();
      await loc.waitFor();
      let v: string = a.attribute ? (await loc.getAttribute(a.attribute)) ?? '' : (await loc.innerText()).trim();
      if (a.pattern) { const m = new RegExp(a.pattern).exec(v); v = m ? (m[1] ?? m[0]) : ''; }
      ctx.vars[a.var] = v;
      ctx.log(`Variable ${a.var} = ${v}`);
      break;
    }
    case 'extractUrl': {
      let v = page.url();
      if (a.pattern) { const m = new RegExp(a.pattern).exec(v); v = m ? (m[1] ?? m[0]) : ''; }
      ctx.vars[a.var] = v;
      ctx.log(`Variable ${a.var} = ${v}`);
      break;
    }
    default: throw new Error(`Action UI inconnue : ${(a as any).action}`);
  }
}

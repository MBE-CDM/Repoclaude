import { XMLParser } from 'fast-xml-parser';
import type { ExecContext } from '../context.js';
import type { ApiStep } from '../model.js';
import { renderDeep, renderString } from '../template.js';
import { checkApi, type ApiResponseView, type AssertionResult } from '../assertions.js';
import { resolveUrl } from './ui.js';

const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: true });

export async function httpCall(ctx: ExecContext, step: ApiStep): Promise<ApiResponseView> {
  const protocol = step.protocol ?? 'rest';
  const url = new URL(resolveUrl(ctx.env.apiUrl ?? ctx.env.frontUrl, renderString(step.path, ctx.vars)));
  for (const [k, v] of Object.entries(renderDeep(step.query ?? {}, ctx.vars))) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = renderDeep(step.headers ?? {}, ctx.vars);
  let body: string | undefined;
  let method = (step.method ?? (protocol === 'rest' ? 'GET' : 'POST')).toUpperCase();

  if (protocol === 'graphql') {
    if (!step.graphql) throw new Error('Étape GraphQL : champ graphql.query obligatoire');
    method = 'POST';
    headers['content-type'] ??= 'application/json';
    body = JSON.stringify({ query: step.graphql.query, variables: renderDeep(step.graphql.variables ?? {}, ctx.vars), operationName: step.graphql.operationName });
  } else if (protocol === 'soap') {
    if (!step.soap) throw new Error('Étape SOAP : champ soap.envelope obligatoire');
    method = 'POST';
    body = renderString(step.soap.envelope, ctx.vars);
    if (step.soap.version === '1.2') headers['content-type'] ??= `application/soap+xml; charset=utf-8${step.soap.action ? `; action="${step.soap.action}"` : ''}`;
    else { headers['content-type'] ??= 'text/xml; charset=utf-8'; if (step.soap.action) headers['soapaction'] ??= `"${step.soap.action}"`; }
  } else if (step.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    const b = renderDeep(step.body, ctx.vars);
    if (typeof b === 'string') body = b;
    else { body = JSON.stringify(b); headers['content-type'] ??= 'application/json'; }
  }

  if (step.auth) {
    if (step.auth.mode === 'basic') {
      const acc = ctx.env.accounts.find(a => a.profile === (step.auth as any).profile);
      if (!acc) throw new Error(`Compte de test « ${(step.auth as any).profile} » introuvable`);
      headers['authorization'] = 'Basic ' + Buffer.from(`${acc.username}:${acc.password ?? ''}`).toString('base64');
    } else {
      const t = renderString(step.auth.token, ctx.vars);
      ctx.masker.addSecret(t);
      headers['authorization'] = `Bearer ${t}`;
    }
  }

  ctx.log(`${method} ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), step.timeoutMs ?? 30000);
  const start = performance.now();
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' });
  } catch (e: any) {
    throw new Error(e.name === 'AbortError' ? `Délai dépassé (${step.timeoutMs ?? 30000} ms)` : `Appel HTTP impossible : ${e.cause?.message ?? e.message}`);
  } finally { clearTimeout(timer); }
  const bodyText = await res.text();
  const durationMs = Math.round(performance.now() - start);
  const rh: Record<string, string> = {};
  res.headers.forEach((v, k) => { rh[k] = v; });
  let json: unknown;
  const ct = rh['content-type'] ?? '';
  try {
    if (ct.includes('json') || /^\s*[[{]/.test(bodyText)) json = JSON.parse(bodyText);
    else if (ct.includes('xml') || /^\s*</.test(bodyText)) json = xml.parse(bodyText); // SOAP : JSONPath sur l'XML converti
  } catch { /* corps non structuré */ }
  ctx.log(`→ HTTP ${res.status} en ${durationMs} ms (${bodyText.length} octets)`);
  ctx.addEvidence({ type: 'json', name: `${method} ${url.pathname}`, data: { request: { method, url: url.toString(), headers, body: body?.slice(0, 20000) }, response: { status: res.status, headers: rh, durationMs, body: json ?? bodyText.slice(0, 20000) } } });
  ctx.audit({ kind: 'api', target: `${method} ${url.origin}${url.pathname}`, outcome: 'success', detail: { status: res.status, durationMs } });
  return { status: res.status, headers: rh, bodyText, json, durationMs };
}

export async function runApi(ctx: ExecContext, step: ApiStep): Promise<{ assertions: AssertionResult[]; response: ApiResponseView }> {
  const response = await httpCall(ctx, step);
  const assertions = (step.assertions ?? [{ type: 'status', in: [200, 201, 202, 204] }]).map(a => checkApi(renderDeep(a, ctx.vars), response));
  return { assertions, response };
}

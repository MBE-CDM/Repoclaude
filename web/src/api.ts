const TOKEN_KEY = 'testhub.token';

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}
export function setToken(t: string) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* stockage indisponible */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) { super(message); }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${getToken()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!r.ok) throw new ApiError(r.status, data?.error ?? `HTTP ${r.status}`, data);
  return data as T;
}

export const get = <T = any>(u: string) => api<T>('GET', u);
export const post = <T = any>(u: string, b?: unknown) => api<T>('POST', u, b ?? {});
export const put = <T = any>(u: string, b: unknown) => api<T>('PUT', u, b);
export const del = <T = any>(u: string) => api<T>('DELETE', u);

export const evidenceUrl = (execId: string, file: string, dir?: string) =>
  `/api/evidence/${execId}/${dir ? dir + '/' : ''}${encodeURIComponent(file)}?token=${encodeURIComponent(getToken())}`;

export interface Environment {
  id: string; name: string; kind: string; isProduction?: boolean; description?: string;
  frontUrl?: string; apiUrl?: string; healthPath?: string; variables?: Record<string, string>;
  accounts: any[]; databases: any[]; servers: any[]; agents: any[]; schedulers: any[]; fileShares: any[];
  sensitiveColumns?: string[];
}

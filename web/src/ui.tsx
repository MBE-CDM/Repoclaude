import { useCallback, useEffect, useState, type ReactNode } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fn().then(d => { setData(d); setError(undefined); }).catch(e => setError(e.message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export const Chip = ({ s, children }: { s?: string; children?: ReactNode }) => <span className={`chip ${s ?? ''}`}>{children ?? s}</span>;

const STATUS_FR: Record<string, string> = {
  passed: 'réussi', failed: 'échec', error: 'erreur', blocked: 'bloqué', running: 'en cours', queued: 'en attente',
  skipped: 'ignoré', cancelled: 'annulé', pending: 'en attente', approved: 'approuvé', rejected: 'refusé', executed: 'exécuté',
  success: 'succès', failure: 'échec',
};
export const Status = ({ s }: { s: string }) => <Chip s={s}>{STATUS_FR[s] ?? s}</Chip>;

export function Alert({ kind = 'ko', children }: { kind?: 'ko' | 'ok' | 'warn'; children: ReactNode }) {
  return children ? <div className={`alert ${kind}`}>{children}</div> : null;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="f">{label}{children}</label>;
}

/** Éditeur JSON avec validation. */
export function JsonEditor({ value, onChange, height = '160px' }: { value: unknown; onChange: (v: any) => void; height?: string }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [err, setErr] = useState<string>();
  useEffect(() => {
    try { if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(value)) setText(JSON.stringify(value ?? null, null, 2)); } catch { /* saisie en cours */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);
  return (
    <div>
      <CodeMirror value={text} height={height} extensions={[json()]} basicSetup={{ lineNumbers: true, foldGutter: true }}
        onChange={t => { setText(t); try { onChange(JSON.parse(t)); setErr(undefined); } catch (e: any) { setErr(e.message); } }} />
      {err && <div className="small" style={{ color: 'var(--ko)' }}>JSON invalide : {err}</div>}
    </div>
  );
}

export const fmtDate = (s?: string) => (s ? new Date(s).toLocaleString('fr-FR') : '');
export const fmtMs = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

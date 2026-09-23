/**
 * EndpointEditor — the Manual HTTP Request form, also used to edit any
 * catalogued endpoint. A right-hand drawer: method + URL, then params,
 * headers, auth, body and the expected response as collapsible sections.
 */
import { useEffect, useMemo, useState } from 'react';
import { X, Plus, Trash2, Save } from 'lucide-react';
import { Section, RequiredMark } from './primitives';
import { parseQueryParams, buildUrlWithParams, PRIMARY_BTN, SECONDARY_BTN, INPUT, LABEL, BAR_3D, STRIP, CHIP_3D } from './format';
import type { CatalogEndpoint, AuthType, HeaderPair, QueryParamRow } from './types';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

interface Props {
  initial?: Partial<CatalogEndpoint> | null;
  title?: string;
  onSave: (endpoint: Omit<CatalogEndpoint, 'id' | 'importedAt'>) => void;
  onClose: () => void;
}

export default function EndpointEditor({ initial, title, onSave, onClose }: Props) {
  const [name, setName] = useState(initial?.title || '');
  const [method, setMethod] = useState((initial?.method || 'GET').toUpperCase());
  const [url, setUrl] = useState(initial?.url || '');
  const [params, setParams] = useState<QueryParamRow[]>(() => parseQueryParams(initial?.url || ''));
  const [headers, setHeaders] = useState<HeaderPair[]>(initial?.headers?.length ? initial.headers : [{ key: '', value: '' }]);
  const [authType, setAuthType] = useState<AuthType>(initial?.auth?.type || 'none');
  const [authValue, setAuthValue] = useState(initial?.auth?.value || '');
  const [headerName, setHeaderName] = useState(initial?.auth?.headerName || 'X-API-Key');
  const [body, setBody] = useState(initial?.body || '');
  const [expectedStatus, setExpectedStatus] = useState(String(initial?.expectedStatus || 200));
  const [expectedResponse, setExpectedResponse] = useState(initial?.expectedResponse || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [showRequired, setShowRequired] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const urlValid = useMemo(() => { try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }, [url]);

  const applyParams = (rows: QueryParamRow[]) => { setParams(rows); setUrl((u) => buildUrlWithParams(u, rows)); };
  const changeUrl = (v: string) => { setUrl(v); setParams(parseQueryParams(v)); };

  const bodyJsonError = useMemo(() => {
    if (!hasBody || !body.trim()) return '';
    try { JSON.parse(body); return ''; } catch { return 'Not valid JSON — it will be sent as raw text.'; }
  }, [body, hasBody]);

  const submit = () => {
    if (!urlValid) { setShowRequired(true); return; }
    const status = parseInt(expectedStatus, 10);
    onSave({
      title: name.trim() || `${method} ${url}`,
      method,
      url: url.trim(),
      headers: headers.filter((h) => h.key.trim()).map((h) => ({ key: h.key.trim(), value: h.value })),
      auth: { type: authType, value: authType === 'none' ? undefined : authValue || undefined, headerName: authType === 'apikey' ? headerName.trim() || 'X-API-Key' : undefined },
      body: hasBody && body.trim() ? body : undefined,
      expectedStatus: Number.isFinite(status) ? status : 200,
      expectedResponse: expectedResponse.trim() || undefined,
      description: description.trim() || undefined,
      style: initial?.style || 'rest',
      source: initial?.source || { method: 'manual', name: 'Manual request' },
      operationId: initial?.operationId, tags: initial?.tags, resource: initial?.resource, pathTemplate: initial?.pathTemplate,
      pathParams: initial?.pathParams, queryParams: initial?.queryParams, deprecated: initial?.deprecated, discovered: initial?.discovered,
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-[#1E1B4B]/30 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="relative w-full max-w-[520px] h-full bg-gradient-to-b from-white to-[#FCFBFF] flex flex-col border-l border-[#E9E5FB] shadow-[-24px_0_60px_-24px_rgba(30,27,75,0.55),inset_1px_0_0_rgba(255,255,255,0.9)]">
        <header className={`flex items-center gap-2 px-4 h-12 border-b border-[#E9E5FB] flex-shrink-0 ${STRIP}`}>
          <h2 className="text-[13px] font-semibold text-gray-900">{title || (initial?.url ? 'Edit endpoint' : 'Manual HTTP request')}</h2>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </header>

        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="px-4 pt-3 pb-2 space-y-2.5">
            <div>
              <label className={LABEL}>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Create order" className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Request <RequiredMark /></label>
              <div className={`flex rounded-lg border bg-white overflow-hidden ${BAR_3D} ${showRequired && !urlValid ? 'border-red-300 ring-2 ring-red-100' : 'border-gray-200/80 focus-within:border-[#A5B4FC] focus-within:ring-2 focus-within:ring-[#EDE9FE]'}`}>
                <select value={method} onChange={(e) => setMethod(e.target.value)} className="px-2.5 py-2 border-r border-gray-200 text-[12px] font-mono font-bold outline-none text-[#6D28D9] bg-gradient-to-b from-[#F5F3FF] to-[#EDE9FE]">
                  {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <input value={url} onChange={(e) => changeUrl(e.target.value)} placeholder="https://api.mycompany.com/v1/orders" spellCheck={false} className="flex-1 min-w-0 px-2.5 py-2 font-mono text-[12.5px] text-gray-800 placeholder-gray-300 outline-none" />
              </div>
              {showRequired && !urlValid && <p className="text-[11px] text-red-600 mt-1">Enter an absolute http(s) URL.</p>}
            </div>
            <div>
              <label className={LABEL}>Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this endpoint does — helps the generator design better scenarios" className={INPUT} />
            </div>
          </div>

          <Section title="Query params" badge={params.filter((p) => p.enabled && p.key).length || ''} defaultOpen={params.length > 0}>
            <KeyValueRows rows={params.map((p) => ({ key: p.key, value: p.value, enabled: p.enabled }))} withEnabled onChange={(rows) => applyParams(rows.map((r) => ({ key: r.key, value: r.value, enabled: r.enabled ?? true })))} placeholderKey="page" placeholderValue="1" />
          </Section>

          <Section title="Headers" badge={headers.filter((h) => h.key).length || ''}>
            <KeyValueRows rows={headers} onChange={(rows) => setHeaders(rows.map((r) => ({ key: r.key, value: r.value })))} placeholderKey="Content-Type" placeholderValue="application/json" />
          </Section>

          <Section title="Auth" badge={authType === 'none' ? 'None' : authType === 'apikey' ? 'API key' : authType[0]!.toUpperCase() + authType.slice(1)}>
            <div className="flex gap-1">
              {(['none', 'bearer', 'basic', 'apikey'] as AuthType[]).map((t) => (
                <button key={t} type="button" onClick={() => setAuthType(t)} className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-all active:translate-y-px ${CHIP_3D} ${authType === t ? 'bg-gradient-to-b from-[#F5F3FF] to-[#EDE9FE] text-[#6D28D9] border-[#DDD6FE]' : 'bg-white text-gray-500 border-gray-200 hover:border-[#DDD6FE]'}`}>
                  {t === 'none' ? 'None' : t === 'bearer' ? 'Bearer' : t === 'basic' ? 'Basic' : 'API key'}
                </button>
              ))}
            </div>
            {authType !== 'none' && (
              <div className="space-y-2">
                {authType === 'apikey' && (
                  <div><label className={LABEL}>Header name</label><input value={headerName} onChange={(e) => setHeaderName(e.target.value)} className={`${INPUT} font-mono`} /></div>
                )}
                <div>
                  <label className={LABEL}>{authType === 'bearer' ? 'Token' : authType === 'basic' ? 'user:password' : 'Key'}</label>
                  <input value={authValue} onChange={(e) => setAuthValue(e.target.value)} type="password" autoComplete="off" placeholder={authType === 'basic' ? 'alice:s3cret' : '{{token}} or the literal value'} className={`${INPUT} font-mono`} />
                  <p className="text-[10.5px] text-gray-400 mt-1">Stored encrypted and sent only from the server at run time.</p>
                </div>
              </div>
            )}
          </Section>

          {hasBody && (
            <Section title="Body" badge={body.trim() ? 'JSON' : ''}>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} spellCheck={false} placeholder='{"sku": "A1", "qty": 2}' className={`${INPUT} font-mono text-[11.5px] resize-y`} />
              {bodyJsonError && <p className="text-[11px] text-amber-700">{bodyJsonError}</p>}
            </Section>
          )}

          <Section title="Expected response" badge={expectedStatus}>
            <div className="grid grid-cols-[110px_1fr] gap-2">
              <div><label className={LABEL}>Status</label><input value={expectedStatus} onChange={(e) => setExpectedStatus(e.target.value.replace(/[^\d]/g, '').slice(0, 3))} className={`${INPUT} font-mono`} /></div>
              <div><label className={LABEL}>Body (shape or example)</label><textarea value={expectedResponse} onChange={(e) => setExpectedResponse(e.target.value)} rows={4} spellCheck={false} placeholder='{"id": "string", "status": "created"}' className={`${INPUT} font-mono text-[11.5px] resize-y`} /></div>
            </div>
          </Section>
        </div>

        <footer className={`flex items-center gap-2 px-4 h-14 border-t border-[#E9E5FB] flex-shrink-0 ${STRIP} shadow-[inset_0_1px_0_#EDE9FE,0_-8px_20px_-16px_rgba(30,27,75,0.35)]`}>
          <p className="text-[11px] text-gray-400 min-w-0 truncate">Saved to the catalogue; scenarios are designed when you run.</p>
          <button type="button" onClick={onClose} className={`ml-auto ${SECONDARY_BTN}`}>Cancel</button>
          <button type="button" onClick={submit} className={PRIMARY_BTN}><Save className="w-3.5 h-3.5" />{initial?.url ? 'Save changes' : 'Add to catalogue'}</button>
        </footer>
      </aside>
    </div>
  );
}

/* ── Key / value editor ─────────────────────────────────────────── */

interface KvRow { key: string; value: string; enabled?: boolean }

export function KeyValueRows({ rows, onChange, withEnabled = false, placeholderKey, placeholderValue, secretValues = false }: {
  rows: KvRow[]; onChange: (rows: KvRow[]) => void; withEnabled?: boolean; placeholderKey?: string; placeholderValue?: string; secretValues?: boolean;
}) {
  const list = rows.length ? rows : [{ key: '', value: '', enabled: true }];
  const update = (i: number, patch: Partial<KvRow>) => onChange(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1">
      {list.map((r, i) => (
        <div key={i} className="flex items-center gap-1">
          {withEnabled && <input type="checkbox" checked={r.enabled !== false} onChange={(e) => update(i, { enabled: e.target.checked })} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC]" />}
          <input value={r.key} onChange={(e) => update(i, { key: e.target.value })} placeholder={placeholderKey || 'key'} spellCheck={false} className={`${INPUT} font-mono text-[11.5px] flex-[2]`} />
          <input value={r.value} onChange={(e) => update(i, { value: e.target.value })} placeholder={placeholderValue || 'value'} spellCheck={false} type={secretValues ? 'password' : 'text'} className={`${INPUT} font-mono text-[11.5px] flex-[3]`} />
          <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} className="p-1 text-gray-300 hover:text-red-500" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...list, { key: '', value: '', enabled: true }])} className="inline-flex items-center gap-1 text-[11px] font-medium text-[#7C3AED] hover:text-[#6D28D9]"><Plus className="w-3 h-3" />Add row</button>
    </div>
  );
}

/**
 * ImportView — the intake hub.
 *
 * Top: a bulk drop zone that takes any document (OpenAPI, Postman, HAR, Bruno,
 * WSDL/XML, PDF, Word, Excel, Markdown, source files) and sorts out the parser
 * per file. Below: the twelve named methods, each with the form it needs.
 * Every path ends in the same place — endpoints in the catalogue, profiled.
 */
import { useCallback, useRef, useState, type DragEvent } from 'react';
import { UploadCloud, Loader2, CheckCircle2, AlertTriangle, ArrowRight, Sparkles, FileText, X, Plus, Trash2 } from 'lucide-react';
import {
  importApiFiles, importApiText, importApiUrl, importApiEndpoint, importApiCurl, importApiGraphql, importApiMcp,
  importApiConnector, importApiWebhook, importApiSource, type ApiImportResponse,
} from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';
import { IMPORT_METHODS, BULK_ACCEPT, type ImportMethodDef, type ImportInput } from '../importMethods';
import { PRIMARY_BTN, SECONDARY_BTN, INPUT, FIELD, LABEL, CARD, CARD_HOVER, BRAND_CHIP, MUTED_CHIP, CHIP_3D, TILE, TILE_ACTIVE, THEAD } from '../format';
import { KeyValueRows } from '../EndpointEditor';
import EndpointEditor from '../EndpointEditor';
import type { Catalog } from '../hooks/useCatalog';
import type { AuthType, HeaderPair, ImportMethod, LogLine } from '../types';

interface Props {
  catalog: Catalog;
  onOpenCatalogue: () => void;
  log: (stage: LogLine['stage'], text: string, level?: LogLine['level']) => void;
}

interface Outcome { method: ImportMethod; name: string; res: ApiImportResponse; added: number; duplicates: number }

/** What the drop zone takes, named the way a tester thinks of them. */
const ACCEPTED = ['OpenAPI', 'Swagger', 'Postman', 'HAR', 'Bruno', 'WSDL / XML', 'PDF', 'Word', 'Excel', 'Markdown', 'Source code'];

export default function ImportView({ catalog, onOpenCatalogue, log }: Props) {
  const toast = useToast();
  const [active, setActive] = useState<ImportMethodDef | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  /** Every import funnels through here so the catalogue, log and result panel agree. */
  const finish = useCallback((method: ImportMethod, name: string, res: ApiImportResponse) => {
    const { added, duplicates } = catalog.addEndpoints(res.endpoints || [], {
      method, name, format: res.format, parser: res.parser, warnings: res.warnings, notice: res.notice, profile: res.profile,
    });
    setOutcome({ method, name, res, added, duplicates });
    if ((res.endpoints || []).length === 0) {
      log('import', `${name}: no endpoints found${res.warnings?.[0] ? ` — ${res.warnings[0]}` : ''}`, 'warn');
      toast.warning('Nothing imported', res.warnings?.[0] || 'No endpoints could be read from that source.');
    } else {
      log('import', `${name}: ${added} endpoint${added === 1 ? '' : 's'} added${duplicates ? ` (${duplicates} already in the catalogue)` : ''} via ${res.parser}`, 'ok');
      for (const w of res.warnings || []) log('import', w, 'warn');
      toast.success(`${added} endpoint${added === 1 ? '' : 's'} imported`, name);
    }
  }, [catalog, log, toast]);

  const run = useCallback(async (key: string, method: ImportMethod, name: string, fn: () => Promise<ApiImportResponse>) => {
    setBusy(key); setError(''); setOutcome(null);
    log('import', `Importing ${name}…`);
    try {
      const res = await fn();
      finish(method, name, res);
      return true;
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Import failed.';
      setError(msg); log('import', `${name}: ${msg}`, 'error'); toast.error('Import failed', msg);
      return false;
    } finally { setBusy(null); }
  }, [finish, log, toast]);

  /* ── Bulk drop zone ── */
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bulk = (files: File[]) => {
    if (!files.length) return;
    const name = files.length === 1 ? files[0]!.name : `${files.length} files`;
    void run('bulk', 'file', name, () => importApiFiles(files, 'auto'));
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); bulk(Array.from(e.dataTransfer.files || [])); };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1180px] mx-auto px-6 py-5 space-y-5">
        {/* Bulk zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`${CARD} relative overflow-hidden px-6 py-7 text-center transition-all ${dragging ? 'border-[#A5B4FC] bg-[#F5F3FF] scale-[1.01] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_24px_48px_-16px_rgba(76,29,149,0.55)]' : ''}`}
        >
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] shadow-[0_2px_6px_rgba(124,58,237,0.45)]" />
          <div className={`mx-auto w-14 h-14 rounded-2xl flex items-center justify-center ${TILE_ACTIVE} shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_4px_0_0_#4338CA,0_14px_28px_-8px_rgba(124,58,237,0.65)]`}>
            {busy === 'bulk' ? <Loader2 className="w-5 h-5 text-white animate-spin" /> : <UploadCloud className="w-5 h-5 text-white" />}
          </div>
          <h2 className="mt-3 text-[15px] font-semibold text-gray-900">Bulk upload — any API document</h2>
          <p className="mt-1 text-[12px] text-gray-500">Up to 20 files at a time — each one parsed automatically.</p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <button type="button" onClick={() => fileRef.current?.click()} disabled={!!busy} className={PRIMARY_BTN}>
              <UploadCloud className="w-3.5 h-3.5" />Choose files
            </button>
            <span className="text-[11px] text-gray-400">or drag them here</span>
          </div>
          <input ref={fileRef} type="file" multiple accept={BULK_ACCEPT} className="hidden" onChange={(e) => { bulk(Array.from(e.target.files || [])); e.target.value = ''; }} />
          {/* What's accepted, as scannable chips rather than a paragraph. */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
            {ACCEPTED.map((f) => (
              <span key={f} className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10.5px] font-medium ${MUTED_CHIP} ${CHIP_3D}`}>{f}</span>
            ))}
          </div>
        </div>

        {/* Outcome / error */}
        {error && (
          <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
            <p className="text-[12px] text-red-700 min-w-0">{error}</p>
            <button type="button" onClick={() => setError('')} className="ml-auto text-red-400 hover:text-red-600"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}
        {outcome && <OutcomePanel outcome={outcome} onOpenCatalogue={onOpenCatalogue} onDismiss={() => setOutcome(null)} />}

        {/* Method grid */}
        <div>
          <div className="flex items-baseline gap-2 mb-2.5">
            <h3 className="text-[12px] font-semibold text-gray-700 uppercase tracking-wide">Import by method</h3>
            <span className="text-[11px] text-gray-400">12 ways in — all land in the same catalogue</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
            {IMPORT_METHODS.map((m) => {
              const Icon = m.icon;
              const isActive = active?.id === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { if (m.id === 'manual') { setManualOpen(true); return; } setActive(isActive ? null : m); setError(''); }}
                  className={`${CARD_HOVER} text-left p-3.5 group hover:border-[#DDD6FE] active:translate-y-0 ${isActive ? 'border-[#A5B4FC] ring-2 ring-[#EDE9FE] -translate-y-0.5' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${isActive ? TILE_ACTIVE : TILE}`}>
                      <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-[#7C3AED]'}`} />
                    </span>
                    <span className="text-[12.5px] font-semibold text-gray-900 leading-tight">{m.label}</span>
                    {m.ai && <span className={`ml-auto inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9.5px] font-semibold ${BRAND_CHIP}`}><Sparkles className="w-2.5 h-2.5" />AI</span>}
                  </div>
                  <p className="mt-2 text-[11px] text-gray-500 truncate">{m.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Active method form */}
        {active && active.id !== 'manual' && (
          <MethodForm
            key={active.id}
            def={active}
            busy={busy === active.id}
            onClose={() => setActive(null)}
            onRun={(name, fn) => run(active.id, active.id, name, fn)}
          />
        )}
      </div>

      {manualOpen && (
        <EndpointEditor
          onClose={() => setManualOpen(false)}
          onSave={(ep) => {
            const r = catalog.addEndpoints([ep], { method: 'manual', name: ep.title, format: 'manual', parser: 'manual' });
            setManualOpen(false);
            log('import', `${ep.method} ${ep.url} added to the catalogue`, 'ok');
            toast.success(r.added ? 'Endpoint added' : 'Already in the catalogue', ep.title);
          }}
        />
      )}
    </div>
  );
}

/* ── Result panel ─────────────────────────────────────────────── */

function OutcomePanel({ outcome, onOpenCatalogue, onDismiss }: { outcome: Outcome; onOpenCatalogue: () => void; onDismiss: () => void }) {
  const { res, added, duplicates } = outcome;
  const none = (res.endpoints || []).length === 0;
  const label = IMPORT_METHODS.find((m) => m.id === outcome.method)?.label || 'Bulk upload';
  return (
    <div className={`${CARD} p-4`}>
      <div className="flex items-start gap-3">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_5px_-2px_rgba(30,27,75,0.25)] ${none ? 'bg-gradient-to-br from-amber-50 to-amber-100 border border-amber-200' : 'bg-gradient-to-br from-emerald-50 to-emerald-100 border border-emerald-200'}`}>
          {none ? <AlertTriangle className="w-4 h-4 text-amber-600" /> : <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-gray-900">
            {none ? 'No endpoints found' : `${added} endpoint${added === 1 ? '' : 's'} added to the catalogue`}
            {duplicates > 0 && <span className="font-normal text-gray-500"> · {duplicates} already present</span>}
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {label} · <span className="font-mono">{outcome.name}</span> · parsed as <span className="font-mono">{res.parser}</span>{res.format ? ` (${res.format})` : ''}
          </p>
          {res.notice && <p className="mt-2 text-[11.5px] text-[#4C1D95] bg-[#F5F3FF] border border-[#DDD6FE] rounded-md px-2.5 py-1.5">{res.notice}</p>}
          {res.observed && (
            <p className="mt-2 text-[11px] text-gray-600">Live probe: status <span className="font-mono font-semibold">{res.observed.status}</span> in {res.observed.durationMs}ms · {res.observed.contentType || 'no content-type'}</p>
          )}
          {!!res.warnings?.length && (
            <ul className="mt-2 space-y-0.5">
              {res.warnings.slice(0, 6).map((w, i) => <li key={i} className="text-[11px] text-amber-700 flex gap-1.5"><span>•</span><span className="min-w-0">{w}</span></li>)}
              {res.warnings.length > 6 && <li className="text-[11px] text-gray-400">…and {res.warnings.length - 6} more</li>}
            </ul>
          )}
          {!!res.files?.length && (
            <div className="mt-3 border border-[#E9E5FB] rounded-md overflow-hidden shadow-[inset_0_1px_3px_rgba(30,27,75,0.06)]">
              <table className="w-full text-[11px]">
                <thead className={`text-gray-500 ${THEAD}`}><tr><th className="text-left px-2 py-1 font-medium">File</th><th className="text-left px-2 py-1 font-medium">Parser</th><th className="text-right px-2 py-1 font-medium">Endpoints</th><th className="text-left px-2 py-1 font-medium">Notes</th></tr></thead>
                <tbody>
                  {res.files.map((f, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="px-2 py-1 font-mono text-gray-700 flex items-center gap-1"><FileText className="w-3 h-3 text-gray-300" />{f.fileName}</td>
                      <td className="px-2 py-1 font-mono text-gray-500">{f.parser || '—'}</td>
                      <td className="px-2 py-1 text-right tabular-nums font-semibold text-gray-800">{f.count}</td>
                      <td className={`px-2 py-1 ${f.error ? 'text-red-600' : 'text-amber-700'}`}>{f.error || f.warnings?.[0] || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {res.profile?.summary && !none && <p className="mt-2 text-[11.5px] text-gray-600 leading-relaxed">{res.profile.summary}</p>}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {!none && <button type="button" onClick={onOpenCatalogue} className={PRIMARY_BTN}>Review catalogue<ArrowRight className="w-3.5 h-3.5" /></button>}
          <button type="button" onClick={onDismiss} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}

/* ── Per-method forms ─────────────────────────────────────────── */

function MethodForm({ def, busy, onClose, onRun }: { def: ImportMethodDef; busy: boolean; onClose: () => void; onRun: (name: string, fn: () => Promise<ApiImportResponse>) => Promise<boolean> }) {
  const [input, setInput] = useState<ImportInput>(def.inputs[0]!);
  const Icon = def.icon;
  const tabs: { id: ImportInput; label: string }[] = def.inputs.map((i) => ({
    id: i,
    label: i === 'files' ? 'Upload file' : i === 'url' ? 'From URL' : i === 'text' ? 'Paste' : i === 'probe' ? 'Live endpoint' : i === 'graphql' ? 'Introspect' : i === 'mcp' ? 'Connect' : i === 'webhook' ? 'Define' : i === 'connector' ? 'Manifest' : 'Manual',
  }));
  return (
    <div className={`${CARD} p-4`}>
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${TILE}`}><Icon className="w-4 h-4 text-[#7C3AED]" /></span>
        <h3 className="text-[13px] font-semibold text-gray-900">{def.label}</h3>
        {tabs.length > 1 && (
          <div className="ml-3 flex gap-0.5 bg-[#EEEBFA] rounded-md p-0.5 shadow-[inset_0_1px_3px_rgba(30,27,75,0.12)]">
            {tabs.map((t) => (
              <button key={t.id} type="button" onClick={() => setInput(t.id)} className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${input === t.id ? 'bg-white text-[#6D28D9] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(30,27,75,0.15)]' : 'text-gray-500 hover:text-gray-700'}`}>{t.label}</button>
            ))}
          </div>
        )}
        <button type="button" onClick={onClose} className="ml-auto p-1 rounded text-gray-400 hover:text-[#7C3AED]"><X className="w-4 h-4" /></button>
      </div>
      {/* The full explanation lives here rather than on the card: it is worth
          reading once you have chosen a method, and noise before that. */}
      <p className="-mt-1 mb-3 text-[11.5px] text-gray-500 leading-relaxed">{def.detail}</p>
      {input === 'files' && <FilesForm def={def} busy={busy} onRun={onRun} />}
      {input === 'url' && <UrlForm def={def} busy={busy} onRun={onRun} />}
      {input === 'text' && <TextForm def={def} busy={busy} onRun={onRun} />}
      {input === 'probe' && <ProbeForm busy={busy} onRun={onRun} />}
      {(input === 'graphql' || input === 'mcp') && <ServerForm kind={input} busy={busy} onRun={onRun} />}
      {input === 'webhook' && <WebhookForm busy={busy} onRun={onRun} />}
      {input === 'connector' && <ConnectorForm busy={busy} onRun={onRun} />}
    </div>
  );
}

type RunFn = (name: string, fn: () => Promise<ApiImportResponse>) => Promise<boolean>;

function SubmitBtn({ busy, label, disabled }: { busy: boolean; label: string; disabled?: boolean }) {
  return (
    <button type="submit" disabled={busy || disabled} className={PRIMARY_BTN}>
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
      {busy ? 'Importing…' : label}
    </button>
  );
}

function FilesForm({ def, busy, onRun }: { def: ImportMethodDef; busy: boolean; onRun: RunFn }) {
  const [files, setFiles] = useState<File[]>([]);
  const ref = useRef<HTMLInputElement>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!files.length) return;
    const name = files.length === 1 ? files[0]!.name : `${files.length} files`;
    const ok = def.id === 'sdk' || def.id === 'middleware'
      ? await onRun(name, () => importApiSource(def.id as 'sdk' | 'middleware', { file: files[0], name }))
      : await onRun(name, () => importApiFiles(files, def.format || 'auto'));
    if (ok) setFiles([]);
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div onClick={() => ref.current?.click()} className="border border-dashed border-[#DDD6FE] rounded-lg bg-[#FAFAFE] px-4 py-5 text-center cursor-pointer hover:bg-[#F5F3FF] transition-colors shadow-[inset_0_2px_6px_rgba(30,27,75,0.06)]">
        <p className="text-[12px] text-gray-600">{files.length ? files.map((f) => f.name).join(', ') : 'Click to choose'}{' '}<span className="text-gray-400 font-mono text-[10.5px]">{def.accept}</span></p>
        <input ref={ref} type="file" accept={def.accept} multiple={def.id !== 'sdk' && def.id !== 'middleware'} className="hidden" onChange={(e) => { setFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
      </div>
      <div className="flex justify-end"><SubmitBtn busy={busy} label="Import" disabled={!files.length} /></div>
    </form>
  );
}

function UrlForm({ def, busy, onRun }: { def: ImportMethodDef; busy: boolean; onRun: RunFn }) {
  const [url, setUrl] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [headers, setHeaders] = useState<HeaderPair[]>([]);
  const docs = def.id === 'docs-url';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    const ok = await onRun(url.trim(), () => importApiUrl(url.trim(), { format: docs ? 'docs' : def.format, headers: headers.filter((h) => h.key.trim()), baseUrl: baseUrl.trim() || undefined }));
    if (ok) setUrl('');
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className={LABEL}>{docs ? 'Documentation page URL' : 'Spec URL'}</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={docs ? 'https://developer.acme.com/reference/orders' : 'https://api.acme.com/openapi.json'} spellCheck={false} className={`${INPUT} font-mono`} />
        {docs && <p className="text-[10.5px] text-gray-400 mt-1">If the page links to an OpenAPI/Swagger document it is imported directly; otherwise the page text is read by the platform's AI.</p>}
      </div>
      {docs && (
        <div>
          <label className={LABEL}>API base URL (when the docs use relative paths)</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.acme.com/v1" spellCheck={false} className={`${INPUT} font-mono`} />
        </div>
      )}
      <details className="text-[11px]">
        <summary className="cursor-pointer text-gray-500 hover:text-[#7C3AED]">Request headers (private docs / spec behind auth)</summary>
        <div className="mt-2"><KeyValueRows rows={headers} onChange={(r) => setHeaders(r.map((x) => ({ key: x.key, value: x.value })))} placeholderKey="Authorization" placeholderValue="Bearer …" /></div>
      </details>
      <div className="flex justify-end"><SubmitBtn busy={busy} label={docs ? 'Read documentation' : 'Fetch & import'} disabled={!url.trim()} /></div>
    </form>
  );
}

function TextForm({ def, busy, onRun }: { def: ImportMethodDef; busy: boolean; onRun: RunFn }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const label = name.trim() || `${def.label} (pasted)`;
    const fn = def.id === 'curl' ? () => importApiCurl(text)
      : def.id === 'sdk' || def.id === 'middleware' ? () => importApiSource(def.id as 'sdk' | 'middleware', { text, name: label })
      : () => importApiText(text, { format: def.format, method: def.id, name: label });
    const ok = await onRun(label, fn);
    if (ok) setText('');
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-[1fr_220px] gap-3">
        <div>
          <label className={LABEL}>{def.id === 'curl' ? 'cURL command(s)' : 'Source'}</label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={9} spellCheck={false} placeholder={def.placeholder} className={`${INPUT} font-mono text-[11.5px] resize-y`} />
        </div>
        <div>
          <label className={LABEL}>Source name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={def.id === 'curl' ? 'Orders API' : 'orders-client.ts'} className={INPUT} />
          {def.ai && <p className="text-[10.5px] text-gray-400 mt-2 leading-relaxed">Read by the platform's AI — every HTTP call it finds becomes an endpoint. Large sources take up to a minute.</p>}
        </div>
      </div>
      <div className="flex justify-end"><SubmitBtn busy={busy} label="Import" disabled={!text.trim()} /></div>
    </form>
  );
}

function AuthFields({ type, value, headerName, onType, onValue, onHeaderName }: { type: AuthType; value: string; headerName: string; onType: (t: AuthType) => void; onValue: (v: string) => void; onHeaderName: (v: string) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className={LABEL}>Auth</label>
        <select value={type} onChange={(e) => onType(e.target.value as AuthType)} className={`${FIELD} w-[120px]`}>
          <option value="none">None</option><option value="bearer">Bearer</option><option value="basic">Basic</option><option value="apikey">API key</option>
        </select>
      </div>
      {type === 'apikey' && <div><label className={LABEL}>Header</label><input value={headerName} onChange={(e) => onHeaderName(e.target.value)} className={`${FIELD} w-[150px] font-mono`} /></div>}
      {type !== 'none' && <div className="flex-1 min-w-[200px]"><label className={LABEL}>{type === 'basic' ? 'user:password' : 'Value'}</label><input type="password" autoComplete="off" value={value} onChange={(e) => onValue(e.target.value)} className={`${INPUT} font-mono`} /></div>}
    </div>
  );
}

function ProbeForm({ busy, onRun }: { busy: boolean; onRun: RunFn }) {
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('GET');
  const [headers, setHeaders] = useState<HeaderPair[]>([]);
  const [authType, setAuthType] = useState<AuthType>('none');
  const [authValue, setAuthValue] = useState('');
  const [headerName, setHeaderName] = useState('X-API-Key');
  const [body, setBody] = useState('');
  const [discover, setDiscover] = useState(true);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    const ok = await onRun(`${method} ${url.trim()}`, () => importApiEndpoint({
      url: url.trim(), method, headers: headers.filter((h) => h.key.trim()),
      auth: { type: authType, value: authType === 'none' ? undefined : authValue, headerName: authType === 'apikey' ? headerName : undefined },
      body: body.trim() || undefined, discover,
    }));
    if (ok) setUrl('');
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex rounded-lg border border-gray-200 overflow-hidden focus-within:border-[#A5B4FC] focus-within:ring-2 focus-within:ring-[#EDE9FE]">
        <select value={method} onChange={(e) => setMethod(e.target.value)} className="px-2.5 py-2 border-r border-gray-200 text-[12px] font-mono font-bold outline-none text-[#6D28D9] bg-gradient-to-b from-[#F5F3FF] to-[#EDE9FE]">
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
        </select>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.acme.com/v1/orders" spellCheck={false} className="flex-1 min-w-0 px-2.5 py-2 font-mono text-[12.5px] outline-none placeholder-gray-300" />
      </div>
      <AuthFields type={authType} value={authValue} headerName={headerName} onType={setAuthType} onValue={setAuthValue} onHeaderName={setHeaderName} />
      <details className="text-[11px]">
        <summary className="cursor-pointer text-gray-500 hover:text-[#7C3AED]">Headers & body</summary>
        <div className="mt-2 space-y-2">
          <KeyValueRows rows={headers} onChange={(r) => setHeaders(r.map((x) => ({ key: x.key, value: x.value })))} placeholderKey="Content-Type" placeholderValue="application/json" />
          {['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} spellCheck={false} placeholder='{"sku":"A1"}' className={`${INPUT} font-mono text-[11.5px]`} />}
        </div>
      </details>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-[11.5px] text-gray-600 cursor-pointer">
          <input type="checkbox" checked={discover} onChange={(e) => setDiscover(e.target.checked)} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC]" />
          Look for an OpenAPI document on the same origin and import the whole API
        </label>
        <div className="ml-auto"><SubmitBtn busy={busy} label="Probe & import" disabled={!url.trim()} /></div>
      </div>
    </form>
  );
}

function ServerForm({ kind, busy, onRun }: { kind: 'graphql' | 'mcp'; busy: boolean; onRun: RunFn }) {
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<HeaderPair[]>([]);
  const [authType, setAuthType] = useState<AuthType>('none');
  const [authValue, setAuthValue] = useState('');
  const [headerName, setHeaderName] = useState('X-API-Key');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    const auth = { type: authType, value: authType === 'none' ? undefined : authValue, headerName: authType === 'apikey' ? headerName : undefined };
    const hs = headers.filter((h) => h.key.trim());
    const ok = await onRun(url.trim(), () => (kind === 'graphql' ? importApiGraphql(url.trim(), hs, auth) : importApiMcp(url.trim(), hs, auth)));
    if (ok) setUrl('');
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className={LABEL}>{kind === 'graphql' ? 'GraphQL endpoint' : 'MCP server URL (Streamable HTTP)'}</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={kind === 'graphql' ? 'https://api.acme.com/graphql' : 'https://mcp.acme.com/mcp'} spellCheck={false} className={`${INPUT} font-mono`} />
        <p className="text-[10.5px] text-gray-400 mt-1">{kind === 'graphql' ? 'Runs an introspection query; one operation per Query and Mutation field. Introspection must be enabled on the server.' : 'Performs initialize → tools/list and creates a tools/call request per tool with sample arguments from its input schema.'}</p>
      </div>
      <AuthFields type={authType} value={authValue} headerName={headerName} onType={setAuthType} onValue={setAuthValue} onHeaderName={setHeaderName} />
      <details className="text-[11px]">
        <summary className="cursor-pointer text-gray-500 hover:text-[#7C3AED]">Extra headers</summary>
        <div className="mt-2"><KeyValueRows rows={headers} onChange={(r) => setHeaders(r.map((x) => ({ key: x.key, value: x.value })))} /></div>
      </details>
      <div className="flex justify-end"><SubmitBtn busy={busy} label={kind === 'graphql' ? 'Introspect & import' : 'Connect & import'} disabled={!url.trim()} /></div>
    </form>
  );
}

function WebhookForm({ busy, onRun }: { busy: boolean; onRun: RunFn }) {
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('POST');
  const [signatureHeader, setSignatureHeader] = useState('X-Signature-256');
  const [secret, setSecret] = useState('');
  const [expectedStatus, setExpectedStatus] = useState('200');
  const [events, setEvents] = useState<{ name: string; payload: string; description: string }[]>([{ name: 'order.created', payload: '{"id":"ord_1","event":"order.created","data":{"total":42}}', description: '' }]);
  const update = (i: number, patch: Partial<typeof events[number]>) => setEvents((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const evs = events.filter((x) => x.name.trim());
    if (!url.trim() || !evs.length) return;
    const ok = await onRun(`Webhook ${url.trim()}`, () => importApiWebhook({
      url: url.trim(), method, signatureHeader: signatureHeader.trim() || undefined, secret: secret || undefined,
      expectedStatus: parseInt(expectedStatus, 10) || 200, events: evs,
    }));
    if (ok) setUrl('');
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-[110px_1fr_170px_120px] gap-2">
        <div><label className={LABEL}>Method</label><select value={method} onChange={(e) => setMethod(e.target.value)} className={INPUT}><option>POST</option><option>PUT</option></select></div>
        <div><label className={LABEL}>Consumer endpoint URL</label><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.acme.com/webhooks/payments" spellCheck={false} className={`${INPUT} font-mono`} /></div>
        <div><label className={LABEL}>Signature header</label><input value={signatureHeader} onChange={(e) => setSignatureHeader(e.target.value)} className={`${INPUT} font-mono`} /></div>
        <div><label className={LABEL}>Expected status</label><input value={expectedStatus} onChange={(e) => setExpectedStatus(e.target.value.replace(/[^\d]/g, '').slice(0, 3))} className={`${INPUT} font-mono`} /></div>
      </div>
      <div>
        <label className={LABEL}>Signing secret (HMAC-SHA256)</label>
        <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="whsec_…" className={`${INPUT} font-mono`} />
      </div>
      <div>
        <label className={LABEL}>Events</label>
        <div className="space-y-2">
          {events.map((ev, i) => (
            <div key={i} className="grid grid-cols-[180px_1fr_auto] gap-2 items-start">
              <input value={ev.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="order.created" spellCheck={false} className={`${INPUT} font-mono`} />
              <textarea value={ev.payload} onChange={(e) => update(i, { payload: e.target.value })} rows={2} spellCheck={false} placeholder='{"event":"order.created", …}' className={`${INPUT} font-mono text-[11.5px]`} />
              <button type="button" onClick={() => setEvents((p) => p.filter((_, j) => j !== i))} className="p-1.5 text-gray-300 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <button type="button" onClick={() => setEvents((p) => [...p, { name: '', payload: '', description: '' }])} className="inline-flex items-center gap-1 text-[11px] font-medium text-[#7C3AED]"><Plus className="w-3 h-3" />Add event</button>
        </div>
      </div>
      <div className="flex justify-end"><SubmitBtn busy={busy} label="Import webhook" disabled={!url.trim() || !events.some((x) => x.name.trim())} /></div>
    </form>
  );
}

const CONNECTOR_EXAMPLE = `{
  "name": "Orders API",
  "baseUrl": "https://api.acme.com/v1",
  "auth": { "type": "bearer", "value": "{{token}}" },
  "headers": [{ "key": "Accept", "value": "application/json" }],
  "endpoints": [
    { "name": "List orders", "method": "GET", "path": "/orders?page=1" },
    { "name": "Create order", "method": "POST", "path": "/orders", "body": { "sku": "A1", "qty": 2 }, "expectedStatus": 201 },
    { "name": "Get order", "method": "GET", "path": "/orders/{id}" }
  ]
}`;

function ConnectorForm({ busy, onRun }: { busy: boolean; onRun: RunFn }) {
  const [manifest, setManifest] = useState('');
  const [name, setName] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manifest.trim()) return;
    const ok = await onRun(name.trim() || 'Connector manifest', () => importApiConnector(manifest, name.trim() || undefined));
    if (ok) setManifest('');
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-[1fr_260px] gap-3">
        <div>
          <label className={LABEL}>Manifest (JSON or YAML)</label>
          <textarea value={manifest} onChange={(e) => setManifest(e.target.value)} rows={12} spellCheck={false} placeholder={CONNECTOR_EXAMPLE} className={`${INPUT} font-mono text-[11.5px] resize-y`} />
        </div>
        <div className="space-y-2">
          <div><label className={LABEL}>Connector name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Orders API" className={INPUT} /></div>
          <p className="text-[10.5px] text-gray-400 leading-relaxed">Keys: <code className="font-mono">name</code>, <code className="font-mono">baseUrl</code>, <code className="font-mono">auth</code>, <code className="font-mono">headers</code>, <code className="font-mono">variables</code> and an <code className="font-mono">endpoints</code> list with <code className="font-mono">method</code>, <code className="font-mono">path</code>, <code className="font-mono">body</code>, <code className="font-mono">expectedStatus</code>. The same shape the Developer page exports.</p>
          <button type="button" onClick={() => setManifest(CONNECTOR_EXAMPLE)} className={SECONDARY_BTN}>Use the example</button>
        </div>
      </div>
      <div className="flex justify-end"><SubmitBtn busy={busy} label="Import connector" disabled={!manifest.trim()} /></div>
    </form>
  );
}

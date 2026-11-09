/**
 * EndpointEditor — the Manual HTTP Request form, also used to edit any
 * catalogued endpoint. A right-hand drawer: method + URL, then params,
 * headers, auth, body and the expected response as collapsible sections.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Trash2, Save, Send, Paperclip, Zap, GripVertical, UploadCloud, Folder, ChevronDown, ChevronRight, FileSearch, Wand2, History, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Section, RequiredMark, MethodBadge } from './primitives';
import Spinner from '@/components/feedback/Spinner';
import { parseQueryParams, buildUrlWithParams, pathOf, newEndpointId, relativeTime, PRIMARY_BTN, SECONDARY_BTN, INPUT, LABEL, BAR_3D, STRIP, CHIP_3D } from './format';
import { sendApiRequest, importApiFiles, healApiRequest, type SendRequestResult, type RequestFix } from '@/services/api';
import { toCatalogEndpoint } from './hooks/useCatalog';
import { BULK_ACCEPT } from './importMethods';
import type { CatalogEndpoint, AuthType, HeaderPair, QueryParamRow, OAuth2Config, DigestConfig, AwsSigV4Config, OAuth1Config, MtlsConfig, EndpointFormField } from './types';

/** An imported group of endpoints the user can pick one from to auto-fill. */
interface ImportFolder { name: string; endpoints: CatalogEndpoint[]; open: boolean }

/** A past import, persisted so the user can see and reuse the same file later. */
interface ImportHistoryEntry { id: string; fileName: string; folderName: string; at: number; endpoints: CatalogEndpoint[] }

const IMPORT_HISTORY_KEY = 'intelliqe_api_import_history_v1';
const MAX_IMPORT_HISTORY = 25;

function loadImportHistory(): ImportHistoryEntry[] {
  try { const v = JSON.parse(localStorage.getItem(IMPORT_HISTORY_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveImportHistory(list: ImportHistoryEntry[]) {
  try { localStorage.setItem(IMPORT_HISTORY_KEY, JSON.stringify(list.slice(0, MAX_IMPORT_HISTORY))); } catch { /* quota — history simply isn't persisted */ }
}
/** Drop the persisted import-file history. Part of clearing the cached workspace
 *  after an end-to-end run completes. */
export function clearImportHistory() {
  try { localStorage.removeItem(IMPORT_HISTORY_KEY); } catch { /* ignore */ }
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const AUTH_LABELS: Record<string, string> = {
  none: 'None', bearer: 'Bearer', basic: 'Basic', apikey: 'API key', oauth2: 'OAuth2',
  digest: 'Digest', awssigv4: 'AWS SigV4', oauth1: 'OAuth1', mtls: 'mTLS',
};
type BodyMode = 'json' | 'raw' | 'form-data' | 'urlencoded' | 'binary';
const BODY_MODES: { id: BodyMode; label: string }[] = [
  { id: 'json', label: 'JSON' }, { id: 'raw', label: 'Raw' }, { id: 'form-data', label: 'Form-data' },
  { id: 'urlencoded', label: 'URL-encoded' }, { id: 'binary', label: 'Binary' },
];

/** Read a File into base64 (no data: prefix) + its content type. */
function fileToBase64(file: File): Promise<{ dataBase64: string; contentType: string; filename: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve({ dataBase64: s.includes(',') ? s.slice(s.indexOf(',') + 1) : s, contentType: file.type || 'application/octet-stream', filename: file.name });
    };
    reader.readAsDataURL(file);
  });
}

interface Props {
  initial?: Partial<CatalogEndpoint> | null;
  title?: string;
  onSave: (endpoint: Omit<CatalogEndpoint, 'id' | 'importedAt'>) => void;
  /** When provided, a primary "Automate" action is shown: it saves this request
      and immediately kicks off the regular API automation pipeline for it.
      `opts.tested` is true when the user fired a successful live Send first — the
      caller may then let automation proceed without the strict readiness review,
      since the request is already proven against the real API. */
  onAutomate?: (endpoint: Omit<CatalogEndpoint, 'id' | 'importedAt'>, opts?: { tested?: boolean }) => void;
  /** When true, the drawer shows an "Import & auto-fill" panel: import an API
      from a file/collection into a named folder, then pick one to fill the form. */
  allowImport?: boolean;
  /** Persist an imported folder to the catalogue (so it joins the regular flow).
      Called with the raw extracted endpoints and the folder name. */
  onImported?: (endpoints: any[], folderName: string) => void;
  /** The active environment — its id is sent with "Send" so the server resolves
      {{vars}} + the base URL (secrets never reach the browser). */
  environment?: { id: string } | null;
  onClose: () => void;
}

export default function EndpointEditor({ initial, title, onSave, onAutomate, allowImport, onImported, environment, onClose }: Props) {
  const [name, setName] = useState(initial?.title || '');
  const [method, setMethod] = useState((initial?.method || 'GET').toUpperCase());
  const [url, setUrl] = useState(initial?.url || '');
  const [params, setParams] = useState<QueryParamRow[]>(() => parseQueryParams(initial?.url || ''));
  const [headers, setHeaders] = useState<HeaderPair[]>(initial?.headers?.length ? initial.headers : [{ key: '', value: '' }]);
  const [authType, setAuthType] = useState<AuthType>(initial?.auth?.type || 'none');
  const [authValue, setAuthValue] = useState(initial?.auth?.value || '');
  const [headerName, setHeaderName] = useState(initial?.auth?.headerName || 'X-API-Key');
  const [apiKeyIn, setApiKeyIn] = useState<'header' | 'query'>(initial?.auth?.in || 'header');
  const [body, setBody] = useState(initial?.body || '');
  const [bodyMode, setBodyMode] = useState<BodyMode>((initial?.bodyMode as BodyMode) || 'json');
  const [formFields, setFormFields] = useState<EndpointFormField[]>(initial?.formFields?.length ? initial.formFields : [{ key: '', value: '', type: 'text' }]);
  const [bodyBase64, setBodyBase64] = useState(initial?.bodyBase64 || '');
  const [binaryMeta, setBinaryMeta] = useState<{ filename: string; contentType: string }>({ filename: '', contentType: initial?.bodyContentType || '' });
  const [oauth2, setOauth2] = useState<OAuth2Config>(initial?.auth?.oauth2 || { grant: 'client_credentials', clientAuthBasic: true });
  const [digestCfg, setDigestCfg] = useState<DigestConfig>(initial?.auth?.digest || { algorithm: 'MD5' });
  const [awsCfg, setAwsCfg] = useState<AwsSigV4Config>(initial?.auth?.awsSigV4 || { region: 'us-east-1', service: 'execute-api' });
  const [oauth1Cfg, setOauth1Cfg] = useState<OAuth1Config>(initial?.auth?.oauth1 || { signatureMethod: 'HMAC-SHA1' });
  const [mtlsCfg, setMtlsCfg] = useState<MtlsConfig>(initial?.auth?.mtls || { rejectUnauthorized: true });
  const [expectedStatus, setExpectedStatus] = useState(String(initial?.expectedStatus || 200));
  const [expectedResponse, setExpectedResponse] = useState(initial?.expectedResponse || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [showRequired, setShowRequired] = useState(false);
  // Send / Try-it panel.
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<SendRequestResult | null>(null);
  const [sendError, setSendError] = useState('');
  const [healing, setHealing] = useState(false);
  const [healResult, setHealResult] = useState<RequestFix | null>(null);
  // Which fields the last heal changed — drives the "Healed" highlight.
  const [healedFields, setHealedFields] = useState<Set<string>>(new Set());

  // ── Import & auto-fill (manual mode) ──
  const [importOpen, setImportOpen] = useState(true);
  const [folders, setFolders] = useState<ImportFolder[]>([]);
  const [folderName, setFolderName] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [pickedKey, setPickedKey] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Persisted history of imported files, so the user can see and reuse them.
  const [history, setHistory] = useState<ImportHistoryEntry[]>(() => loadImportHistory());
  const [showHistory, setShowHistory] = useState(false);

  // ── Horizontal drag (dock right ↔ drag toward the centre/left) ──
  const [offsetX, setOffsetX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ mouseX: number; baseX: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const s = dragStart.current; if (!s) return;
      // Negative moves the right-docked panel toward the centre/left; clamp so a
      // sliver always stays on-screen either side.
      const next = s.baseX + (e.clientX - s.mouseX);
      const min = -(window.innerWidth - 160);
      setOffsetX(Math.max(min, Math.min(40, next)));
    };
    const up = () => setDragging(false);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  }, [dragging]);

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragStart.current = { mouseX: e.clientX, baseX: offsetX };
    setDragging(true);
    e.preventDefault();
  };

  /** Fill every form field from a chosen endpoint (import pick or re-pick). */
  const applyEndpoint = (ep: CatalogEndpoint, key: string) => {
    setPickedKey(key);
    setName(ep.title || '');
    setMethod((ep.method || 'GET').toUpperCase());
    setUrl(ep.url || '');
    setParams(parseQueryParams(ep.url || ''));
    setHeaders(ep.headers?.length ? ep.headers.map((h) => ({ key: h.key, value: h.value })) : [{ key: '', value: '' }]);
    setAuthType(ep.auth?.type || 'none');
    setAuthValue(ep.auth?.value || '');
    setHeaderName(ep.auth?.headerName || 'X-API-Key');
    setApiKeyIn(ep.auth?.in || 'header');
    setOauth2(ep.auth?.oauth2 || { grant: 'client_credentials', clientAuthBasic: true });
    setDigestCfg(ep.auth?.digest || { algorithm: 'MD5' });
    setAwsCfg(ep.auth?.awsSigV4 || { region: 'us-east-1', service: 'execute-api' });
    setOauth1Cfg(ep.auth?.oauth1 || { signatureMethod: 'HMAC-SHA1' });
    setMtlsCfg(ep.auth?.mtls || { rejectUnauthorized: true });
    setBody(ep.body || '');
    setBodyMode((ep.bodyMode as BodyMode) || 'json');
    setFormFields(ep.formFields?.length ? ep.formFields : [{ key: '', value: '', type: 'text' }]);
    setBodyBase64(ep.bodyBase64 || '');
    setBinaryMeta({ filename: '', contentType: ep.bodyContentType || '' });
    setExpectedStatus(String(ep.expectedStatus || 200));
    setExpectedResponse(ep.expectedResponse || '');
    setDescription(ep.description || '');
    setShowRequired(false);
  };

  /** Add (or replace) a persisted history entry for an imported file. */
  const recordHistory = (fileName: string, folder: string, endpoints: CatalogEndpoint[]) => {
    setHistory((prev) => {
      const next = [{ id: newEndpointId(), fileName, folderName: folder, at: Date.now(), endpoints }, ...prev.filter((h) => h.fileName !== fileName || h.folderName !== folder)].slice(0, MAX_IMPORT_HISTORY);
      saveImportHistory(next);
      return next;
    });
  };

  /** Load a folder of endpoints into the picker (from a fresh import or history). */
  const loadFolder = (name: string, eps: CatalogEndpoint[]) => {
    setFolders((prev) => [{ name, endpoints: eps, open: true }, ...prev.filter((f) => f.name !== name)]);
    onImported?.(eps, name); // persist to the catalogue (regular flow)
    if (eps[0]) applyEndpoint(eps[0], `${name}:0`);
  };

  /** Import a file/collection → a named folder of endpoints to pick from. */
  const doImport = async (files: File[]) => {
    if (!files.length) return;
    const base = files[0]!.name.replace(/\.[^.]+$/, '').replace(/\.postman_collection$/i, '');
    const fname = folderName.trim() || base || 'Imported API';
    setImporting(true); setImportError('');
    try {
      const res = await importApiFiles(files, 'auto');
      const raw = res.endpoints || [];
      if (raw.length === 0) { setImportError(res.warnings?.[0] || 'No endpoints could be read from that file.'); return; }
      const eps = raw.map((e: any) => toCatalogEndpoint(e, 'manual'));
      setFolderName('');
      loadFolder(fname, eps);
      recordHistory(files[0]!.name, fname, eps); // save to history so the file can be reused
    } catch (e: any) {
      setImportError(e?.response?.data?.error || e?.message || 'Import failed.');
    } finally { setImporting(false); }
  };

  /** Reuse a previously imported file — no re-upload; recreate its folder. */
  const reuseHistory = (h: ImportHistoryEntry) => { setShowHistory(false); loadFolder(h.folderName, h.endpoints); };
  const removeHistory = (id: string) => setHistory((prev) => { const next = prev.filter((h) => h.id !== id); saveImportHistory(next); return next; });
  const clearHistory = () => { setHistory([]); saveImportHistory([]); };

  const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const urlValid = useMemo(() => { try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }, [url]);
  // A `{{var}}` URL isn't a valid absolute URL client-side, but the server resolves
  // it against the active environment — so Send is allowed when one is selected.
  const urlHasTemplate = useMemo(() => /\{\{\s*[\w.\-]+\s*\}\}/.test(url), [url]);
  const canSend = urlValid || (!!environment?.id && urlHasTemplate && url.trim().length > 0);

  const applyParams = (rows: QueryParamRow[]) => { setParams(rows); setUrl((u) => buildUrlWithParams(u, rows)); };
  const changeUrl = (v: string) => { setUrl(v); setParams(parseQueryParams(v)); };

  const bodyJsonError = useMemo(() => {
    if (!hasBody || !body.trim()) return '';
    try { JSON.parse(body); return ''; } catch { return 'Not valid JSON — it will be sent as raw text.'; }
  }, [body, hasBody]);

  /** The auth object to persist / send — carries the oauth2 config when selected. */
  const buildAuth = () => ({
    type: authType,
    // Advanced schemes carry no simple `value` — their fields live in sub-configs.
    value: ['none', 'oauth2', 'digest', 'awssigv4', 'oauth1', 'mtls'].includes(authType) ? undefined : authValue || undefined,
    headerName: authType === 'apikey' ? (headerName.trim() || (apiKeyIn === 'query' ? 'api_key' : 'X-API-Key')) : undefined,
    in: authType === 'apikey' ? apiKeyIn : undefined,
    oauth2: authType === 'oauth2' ? oauth2 : undefined,
    digest: authType === 'digest' ? digestCfg : undefined,
    awsSigV4: authType === 'awssigv4' ? awsCfg : undefined,
    oauth1: authType === 'oauth1' ? oauth1Cfg : undefined,
    mtls: authType === 'mtls' ? mtlsCfg : undefined,
  });

  /** The body fields to persist / send, per the selected body mode. */
  const buildBodyFields = (): { body?: string; bodyMode?: BodyMode; formFields?: EndpointFormField[]; bodyBase64?: string; bodyContentType?: string } => {
    if (!hasBody) return {};
    if (bodyMode === 'form-data' || bodyMode === 'urlencoded') {
      const ff = formFields.filter((f) => f.key.trim());
      return { bodyMode, formFields: ff.length ? ff : undefined };
    }
    if (bodyMode === 'binary') return { bodyMode, bodyBase64: bodyBase64 || undefined, bodyContentType: binaryMeta.contentType || undefined };
    // json / raw → the textarea body (bodyMode omitted for 'json' keeps the original byte-identical path)
    return { bodyMode: bodyMode === 'json' ? undefined : bodyMode, body: body.trim() ? body : undefined };
  };

  const doSend = async () => {
    if (!canSend) { setShowRequired(true); return; }
    setSending(true); setSendError(''); setSendResult(null); setHealResult(null); setHealedFields(new Set());
    try {
      const b = buildBodyFields();
      setSendResult(await sendApiRequest({
        method,
        url: url.trim(),
        headers: headers.filter((h) => h.key.trim()).map((h) => ({ key: h.key.trim(), value: h.value })),
        auth: buildAuth(),
        body: b.body,
        bodyMode: b.bodyMode,
        formFields: b.formFields,
        bodyBase64: b.bodyBase64,
        bodyContentType: b.bodyContentType,
        environmentId: environment?.id,
      }));
    } catch (e: any) {
      setSendError(e?.response?.data?.error || e?.message || 'The request could not be sent.');
    } finally { setSending(false); }
  };

  /** Apply the healer's auth patch to the split auth form state. */
  const applyAuthFix = (a: NonNullable<RequestFix['fix']['auth']>) => {
    if (!a.type) return;
    setAuthType(a.type as AuthType);
    if (a.headerName) setHeaderName(a.headerName);
    if (a.in === 'query' || a.in === 'header') setApiKeyIn(a.in);
    if (typeof a.value === 'string' && a.value) setAuthValue(a.value);
  };

  /** Merge the healer's proposed fields into the form (auto-fill). Headers are
   *  merged by name so corrections don't drop the ones the model left alone. */
  const applyFix = (fix: RequestFix['fix']) => {
    const healed = new Set<string>();
    if (fix.method) { setMethod(fix.method.toUpperCase()); healed.add('method'); }
    if (fix.url) { changeUrl(fix.url); healed.add('url'); }
    if (fix.headers?.length) {
      setHeaders((prev) => {
        const map = new Map(prev.filter((h) => h.key.trim()).map((h) => [h.key.trim().toLowerCase(), { key: h.key.trim(), value: h.value }]));
        for (const h of fix.headers!) map.set(h.key.trim().toLowerCase(), { key: h.key.trim(), value: h.value });
        return [...map.values(), { key: '', value: '' }];
      });
      healed.add('headers');
    }
    if (typeof fix.body === 'string') {
      setBody(fix.body);
      setBodyMode((prev) => (prev === 'json' || prev === 'raw' ? prev : 'raw'));
      healed.add('body');
    }
    if (fix.auth) { applyAuthFix(fix.auth); healed.add('auth'); }
    if (fix.expectedStatus != null) { setExpectedStatus(String(fix.expectedStatus)); healed.add('expected'); }
    if (typeof fix.expectedResponse === 'string') { setExpectedResponse(fix.expectedResponse); healed.add('expected'); }
    setHealedFields(healed);
  };

  /** "Heal it" — ask the healer to diagnose the last failed Send and, when it
   *  finds a safe fix, auto-fill the corrected request so the next Send passes. */
  const healIt = async () => {
    if (!sendResult && !sendError) return;
    setHealing(true); setHealResult(null);
    try {
      const b = buildBodyFields();
      const status = parseInt(expectedStatus, 10);
      const res = await healApiRequest({
        method,
        url: url.trim(),
        headers: headers.filter((h) => h.key.trim()).map((h) => ({ key: h.key.trim(), value: h.value })),
        auth: buildAuth(),
        body: b.body,
        bodyMode: b.bodyMode,
        expectedStatus: Number.isFinite(status) ? status : undefined,
        expectedResponse: expectedResponse.trim() || undefined,
        observed: sendResult
          ? { status: sendResult.status ?? null, ok: sendResult.ok, error: sendResult.error, bodyText: sendResult.bodyText, headers: sendResult.headers }
          : { status: null, ok: false, error: sendError },
      });
      setHealResult(res);
      if (res.changed) applyFix(res.fix);
    } catch (e: any) {
      setHealResult({ classification: 'unknown', confidence: 'low', changed: false, summary: 'Heal failed', rationale: e?.response?.data?.error || e?.message || 'The healer could not run.', fix: {} });
    } finally { setHealing(false); }
  };

  /** The complete endpoint payload for both Save and Automate. */
  const buildEndpoint = (): Omit<CatalogEndpoint, 'id' | 'importedAt'> => {
    const status = parseInt(expectedStatus, 10);
    const b = buildBodyFields();
    return {
      title: name.trim() || `${method} ${url}`,
      method,
      url: url.trim(),
      headers: headers.filter((h) => h.key.trim()).map((h) => ({ key: h.key.trim(), value: h.value })),
      auth: buildAuth(),
      body: b.body,
      bodyMode: b.bodyMode,
      formFields: b.formFields,
      bodyBase64: b.bodyBase64,
      bodyContentType: b.bodyContentType,
      expectedStatus: Number.isFinite(status) ? status : 200,
      expectedResponse: expectedResponse.trim() || undefined,
      description: description.trim() || undefined,
      style: initial?.style || 'rest',
      source: initial?.source || { method: 'manual', name: 'Manual request' },
      operationId: initial?.operationId, tags: initial?.tags, resource: initial?.resource, pathTemplate: initial?.pathTemplate,
      pathParams: initial?.pathParams, queryParams: initial?.queryParams, deprecated: initial?.deprecated, discovered: initial?.discovered,
    };
  };

  const submit = () => {
    if (!urlValid) { setShowRequired(true); return; }
    onSave(buildEndpoint());
  };

  /** A live Send that came back with a real response (any status, no transport
      error) counts as "manually tested" — the request is proven against the API. */
  const tested = !!sendResult && sendResult.status != null && !sendResult.error;
  /** The last Send failed — a transport error, or a non-2xx response. */
  const sendFailed = (!!sendResult && (sendResult.ok === false || !!sendResult.error)) || !!sendError;
  /** Fields the last heal corrected — drives the green "Healed" highlight. */
  const isHealed = (f: string) => healedFields.has(f);
  const healBadge = (
    <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1 py-0.5">
      <Wand2 className="w-2.5 h-2.5" /> Healed
    </span>
  );

  const automate = () => {
    if (!urlValid) { setShowRequired(true); return; }
    const ep = buildEndpoint();
    // A tested request already knows its real status + body: fold them in (when the
    // reviewer left them blank) so automation runs against genuine expectations
    // rather than placeholders.
    if (tested && sendResult) {
      if (sendResult.status) ep.expectedStatus = sendResult.status;
      if (!ep.expectedResponse && sendResult.bodyText) ep.expectedResponse = sendResult.bodyText.slice(0, 4000);
    }
    onAutomate?.(ep, { tested });
  };

  return (
    <div className={`fixed inset-0 z-40 flex justify-end ${dragging ? 'select-none cursor-grabbing' : ''}`}>
      <div className="absolute inset-0 bg-[#1E1B4B]/30 backdrop-blur-[1px]" onClick={onClose} />
      <aside
        style={{ transform: `translateX(${offsetX}px)` }}
        className={`relative w-full ${allowImport ? 'max-w-[600px]' : 'max-w-[520px]'} h-full bg-white flex flex-col border-l border-[#E9E5FB] shadow-[-24px_0_60px_-24px_rgba(30,27,75,0.55),inset_1px_0_0_rgba(255,255,255,0.9)]`}
      >
        <header
          onMouseDown={startDrag}
          title="Drag to move the panel toward the centre or left"
          className={`flex items-center gap-2 px-4 h-12 border-b border-[#E9E5FB] flex-shrink-0 ${STRIP} ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        >
          <GripVertical className="w-4 h-4 text-gray-300 flex-shrink-0" />
          <h2 className="text-[13px] font-semibold text-gray-900">{title || (initial?.url ? 'Edit endpoint' : 'Manual HTTP request')}</h2>
          {offsetX !== 0 && <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={() => setOffsetX(0)} className="text-[10.5px] font-medium text-[#7C3AED] hover:text-[#5B21B6]">Dock right</button>}
          <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </header>

        <div className="flex-1 overflow-y-auto min-h-0">
          {allowImport && (
            <div className="border-b border-[#EDE9FE] bg-[#FBFAFF]">
              <button type="button" onClick={() => setImportOpen((o) => !o)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left">
                <span className="w-6 h-6 rounded-md bg-[#F5F3FF] border border-[#DDD6FE] flex items-center justify-center flex-shrink-0"><FileSearch className="w-3.5 h-3.5 text-[#7C3AED]" /></span>
                <span className="text-[12.5px] font-semibold text-gray-900">Import API &amp; auto-fill</span>
                <span className="text-[10.5px] text-gray-400">from a collection, PDF, Excel, Word, OpenAPI…</span>
                {importOpen ? <ChevronDown className="w-4 h-4 text-gray-400 ml-auto" /> : <ChevronRight className="w-4 h-4 text-gray-400 ml-auto" />}
              </button>
              {importOpen && (
                <div className="px-4 pb-3 space-y-2.5">
                  <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                    <div>
                      <label className={LABEL}>Folder name</label>
                      <input value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="Orders API (defaults to the file name)" className={INPUT} />
                    </div>
                    <button type="button" onClick={() => fileInputRef.current?.click()} disabled={importing} className={PRIMARY_BTN}>
                      {importing ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}{importing ? 'Importing…' : 'Choose file'}
                    </button>
                    <input ref={fileInputRef} type="file" multiple accept={BULK_ACCEPT} className="hidden" onChange={(e) => { void doImport(Array.from(e.target.files || [])); e.target.value = ''; }} />
                  </div>
                  {importError && <p className="text-[11px] text-red-600">{importError}</p>}

                  {/* Import history — every fetched file is saved here; reuse or remove it. */}
                  {history.length > 0 && (
                    <div className="rounded-lg border border-[#E9E5FB] bg-white overflow-hidden">
                      <div className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-[#FAFAFE]">
                        <button type="button" onClick={() => setShowHistory((o) => !o)} className="flex items-center gap-1.5 text-[11.5px] font-semibold text-gray-700 hover:text-[#7C3AED]">
                          {showHistory ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                          <History className="w-3.5 h-3.5 text-[#7C3AED]" /> Import history
                          <span className="font-mono text-[10.5px] text-gray-400 tabular-nums">{history.length}</span>
                        </button>
                        {showHistory && <button type="button" onClick={clearHistory} className="ml-auto text-[10.5px] font-medium text-gray-400 hover:text-red-500">Clear all</button>}
                      </div>
                      {showHistory && (
                        <ul className="max-h-52 overflow-y-auto divide-y divide-gray-50">
                          {history.map((h) => (
                            <li key={h.id} className="flex items-center gap-2 px-2.5 py-1.5">
                              <FileSearch className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />
                              <span className="min-w-0 flex-1">
                                <span className="block text-[11.5px] text-gray-800 truncate" title={h.fileName}>{h.fileName}</span>
                                <span className="block text-[10px] text-gray-400 truncate">{h.folderName} · {h.endpoints.length} endpoint{h.endpoints.length === 1 ? '' : 's'} · {relativeTime(h.at)}</span>
                              </span>
                              <button type="button" onClick={() => reuseHistory(h)} title="Reuse this file — recreates its folder of endpoints" className={`${SECONDARY_BTN} py-1`}><Wand2 className="w-3.5 h-3.5" />Use</button>
                              <button type="button" onClick={() => removeHistory(h.id)} title="Remove from history" className="p-1 text-gray-300 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {folders.map((f, fi) => (
                    <div key={`${f.name}-${fi}`} className="rounded-lg border border-[#E9E5FB] bg-white overflow-hidden">
                      <button type="button" onClick={() => setFolders((prev) => prev.map((x, j) => (j === fi ? { ...x, open: !x.open } : x)))} className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-[#FAFAFE]">
                        {f.open ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                        <Folder className="w-3.5 h-3.5 text-[#7C3AED]" />
                        <span className="text-[12px] font-semibold text-gray-800 truncate">{f.name}</span>
                        <span className="ml-auto font-mono text-[10.5px] text-gray-400 tabular-nums">{f.endpoints.length}</span>
                      </button>
                      {f.open && (
                        <ul className="max-h-52 overflow-y-auto divide-y divide-gray-50">
                          {f.endpoints.map((ep, ei) => {
                            const key = `${f.name}:${ei}`;
                            const on = pickedKey === key;
                            return (
                              <li key={key}>
                                <button type="button" onClick={() => { applyEndpoint(ep, key); setFolders((prev) => prev.map((x, j) => (j === fi ? { ...x, open: false } : x))); }} title="Auto-fill this request" className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${on ? 'bg-[#F5F3FF]' : 'hover:bg-[#FBFAFF]'}`}>
                                  <MethodBadge method={ep.method} />
                                  <span className="min-w-0 flex-1">
                                    <span className="block font-mono text-[11px] text-gray-800 truncate" title={ep.url}>{pathOf(ep.url)}</span>
                                    <span className="block text-[10px] text-gray-400 truncate">{ep.title}</span>
                                  </span>
                                  {on ? <span className="text-[9.5px] font-semibold text-[#6D28D9] flex-shrink-0">filled</span> : <Wand2 className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ))}
                  {folders.length === 0 && !importing && (
                    <p className="text-[10.5px] text-gray-400 leading-relaxed">Import a file to create a folder of endpoints, then pick one to auto-fill the form below — do manual testing (Send) or Automate it with the regular pipeline.</p>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="px-4 pt-3 pb-2 space-y-2.5">
            <div>
              <label className={LABEL}>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Create order" className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Request <RequiredMark /> {(isHealed('method') || isHealed('url')) && healBadge}</label>
              <div className={`flex rounded-lg border bg-white overflow-hidden ${BAR_3D} ${showRequired && !urlValid ? 'border-red-300 ring-2 ring-red-100' : (isHealed('method') || isHealed('url')) ? 'border-emerald-300 ring-2 ring-emerald-300/60' : 'border-gray-200/80 focus-within:border-[#A5B4FC] focus-within:ring-2 focus-within:ring-[#EDE9FE]'}`}>
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

          <Section key={isHealed('headers') ? 'headers-healed' : 'headers'} title="Headers" badge={headers.filter((h) => h.key).length || ''} action={isHealed('headers') ? healBadge : undefined}>
            <KeyValueRows rows={headers} onChange={(rows) => setHeaders(rows.map((r) => ({ key: r.key, value: r.value })))} placeholderKey="Content-Type" placeholderValue="application/json" />
          </Section>

          <Section key={isHealed('auth') ? 'auth-healed' : 'auth'} title="Auth" badge={AUTH_LABELS[authType] || 'None'} action={isHealed('auth') ? healBadge : undefined}>
            <div className="flex flex-wrap gap-1">
              {(['none', 'bearer', 'basic', 'apikey', 'oauth2', 'digest', 'awssigv4', 'oauth1', 'mtls'] as AuthType[]).map((t) => (
                <button key={t} type="button" onClick={() => setAuthType(t)} className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-all active:translate-y-px ${CHIP_3D} ${authType === t ? 'bg-gradient-to-b from-[#F5F3FF] to-[#EDE9FE] text-[#6D28D9] border-[#DDD6FE]' : 'bg-white text-gray-500 border-gray-200 hover:border-[#DDD6FE]'}`}>
                  {AUTH_LABELS[t]}
                </button>
              ))}
            </div>
            {(['bearer', 'basic', 'apikey'] as AuthType[]).includes(authType) && (
              <div className="space-y-2">
                {authType === 'apikey' && (
                  <div className="grid grid-cols-[auto_1fr] gap-2 items-end">
                    <div>
                      <label className={LABEL}>Add to</label>
                      <div className="flex gap-1">
                        {(['header', 'query'] as const).map((loc) => (
                          <button key={loc} type="button" onClick={() => setApiKeyIn(loc)} className={`px-2 py-1 rounded-md text-[11px] font-medium border capitalize transition-all active:translate-y-px ${CHIP_3D} ${apiKeyIn === loc ? 'bg-gradient-to-b from-[#F5F3FF] to-[#EDE9FE] text-[#6D28D9] border-[#DDD6FE]' : 'bg-white text-gray-500 border-gray-200 hover:border-[#DDD6FE]'}`}>{loc}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className={LABEL}>{apiKeyIn === 'query' ? 'Query param' : 'Header name'}</label>
                      <input value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder={apiKeyIn === 'query' ? 'api_key' : 'X-API-Key'} className={`${INPUT} font-mono`} />
                    </div>
                  </div>
                )}
                <div>
                  <label className={LABEL}>{authType === 'bearer' ? 'Token' : authType === 'basic' ? 'user:password' : 'Key'}</label>
                  <input value={authValue} onChange={(e) => setAuthValue(e.target.value)} type="password" autoComplete="off" placeholder={authType === 'basic' ? 'alice:s3cret' : '{{token}} or the literal value'} className={`${INPUT} font-mono`} />
                  <p className="text-[10.5px] text-gray-400 mt-1">Stored encrypted and sent only from the server at run time.</p>
                </div>
              </div>
            )}
            {authType === 'oauth2' && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={LABEL}>Grant</label>
                    <select value={oauth2.grant || 'client_credentials'} onChange={(e) => setOauth2({ ...oauth2, grant: e.target.value })} className={INPUT}>
                      <option value="client_credentials">client_credentials</option>
                      <option value="password">password</option>
                      <option value="refresh_token">refresh_token</option>
                      <option value="authorization_code">authorization_code</option>
                    </select>
                  </div>
                  <div><label className={LABEL}>Token URL</label><input value={oauth2.tokenUrl || ''} onChange={(e) => setOauth2({ ...oauth2, tokenUrl: e.target.value })} placeholder="https://auth.example.com/oauth/token" className={`${INPUT} font-mono`} /></div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div><label className={LABEL}>Client ID</label><input value={oauth2.clientId || ''} onChange={(e) => setOauth2({ ...oauth2, clientId: e.target.value })} className={`${INPUT} font-mono`} /></div>
                  <div><label className={LABEL}>Client secret</label><input value={oauth2.clientSecret || ''} onChange={(e) => setOauth2({ ...oauth2, clientSecret: e.target.value })} type="password" autoComplete="off" className={`${INPUT} font-mono`} /></div>
                </div>
                {oauth2.grant === 'password' && (
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className={LABEL}>Username</label><input value={oauth2.username || ''} onChange={(e) => setOauth2({ ...oauth2, username: e.target.value })} className={INPUT} /></div>
                    <div><label className={LABEL}>Password</label><input value={oauth2.password || ''} onChange={(e) => setOauth2({ ...oauth2, password: e.target.value })} type="password" autoComplete="off" className={INPUT} /></div>
                  </div>
                )}
                {oauth2.grant === 'refresh_token' && (
                  <div><label className={LABEL}>Refresh token</label><input value={oauth2.refreshToken || ''} onChange={(e) => setOauth2({ ...oauth2, refreshToken: e.target.value })} type="password" autoComplete="off" className={`${INPUT} font-mono`} /></div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div><label className={LABEL}>Scope</label><input value={oauth2.scope || ''} onChange={(e) => setOauth2({ ...oauth2, scope: e.target.value })} placeholder="read write" className={INPUT} /></div>
                  <label className="flex items-end gap-1.5 text-[11.5px] text-gray-600 pb-2"><input type="checkbox" checked={oauth2.clientAuthBasic !== false} onChange={(e) => setOauth2({ ...oauth2, clientAuthBasic: e.target.checked })} className="w-3.5 h-3.5" />Send client creds as Basic auth</label>
                </div>
                <p className="text-[10.5px] text-gray-400">The token is fetched from the server at send/run time and used as a Bearer token. Secrets are stored encrypted.</p>
              </div>
            )}
            {authType === 'digest' && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div><label className={LABEL}>Username</label><input value={digestCfg.username || ''} onChange={(e) => setDigestCfg({ ...digestCfg, username: e.target.value })} className={INPUT} autoComplete="off" /></div>
                  <div><label className={LABEL}>Password</label><input value={digestCfg.password || ''} onChange={(e) => setDigestCfg({ ...digestCfg, password: e.target.value })} type="password" autoComplete="off" className={INPUT} /></div>
                </div>
                <div>
                  <label className={LABEL}>Algorithm</label>
                  <select value={digestCfg.algorithm || 'MD5'} onChange={(e) => setDigestCfg({ ...digestCfg, algorithm: e.target.value })} className={INPUT}>
                    <option value="MD5">MD5</option>
                    <option value="MD5-sess">MD5-sess</option>
                  </select>
                </div>
                <p className="text-[10.5px] text-gray-400">The server performs the Digest challenge round-trip (qop=auth) at send time.</p>
              </div>
            )}
            {authType === 'awssigv4' && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div><label className={LABEL}>Access key ID</label><input value={awsCfg.accessKeyId || ''} onChange={(e) => setAwsCfg({ ...awsCfg, accessKeyId: e.target.value })} className={`${INPUT} font-mono`} autoComplete="off" /></div>
                  <div><label className={LABEL}>Secret access key</label><input value={awsCfg.secretAccessKey || ''} onChange={(e) => setAwsCfg({ ...awsCfg, secretAccessKey: e.target.value })} type="password" autoComplete="off" className={`${INPUT} font-mono`} /></div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div><label className={LABEL}>Region</label><input value={awsCfg.region || ''} onChange={(e) => setAwsCfg({ ...awsCfg, region: e.target.value })} placeholder="us-east-1" className={`${INPUT} font-mono`} /></div>
                  <div><label className={LABEL}>Service</label><input value={awsCfg.service || ''} onChange={(e) => setAwsCfg({ ...awsCfg, service: e.target.value })} placeholder="execute-api" className={`${INPUT} font-mono`} /></div>
                </div>
                <div><label className={LABEL}>Session token (optional)</label><input value={awsCfg.sessionToken || ''} onChange={(e) => setAwsCfg({ ...awsCfg, sessionToken: e.target.value })} type="password" autoComplete="off" className={`${INPUT} font-mono`} /></div>
                <p className="text-[10.5px] text-gray-400">The request is signed (AWS4-HMAC-SHA256) at send time. Secrets are stored encrypted.</p>
              </div>
            )}
            {authType === 'oauth1' && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div><label className={LABEL}>Consumer key</label><input value={oauth1Cfg.consumerKey || ''} onChange={(e) => setOauth1Cfg({ ...oauth1Cfg, consumerKey: e.target.value })} className={`${INPUT} font-mono`} autoComplete="off" /></div>
                  <div><label className={LABEL}>Consumer secret</label><input value={oauth1Cfg.consumerSecret || ''} onChange={(e) => setOauth1Cfg({ ...oauth1Cfg, consumerSecret: e.target.value })} type="password" autoComplete="off" className={`${INPUT} font-mono`} /></div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div><label className={LABEL}>Token (optional)</label><input value={oauth1Cfg.token || ''} onChange={(e) => setOauth1Cfg({ ...oauth1Cfg, token: e.target.value })} className={`${INPUT} font-mono`} autoComplete="off" /></div>
                  <div><label className={LABEL}>Token secret (optional)</label><input value={oauth1Cfg.tokenSecret || ''} onChange={(e) => setOauth1Cfg({ ...oauth1Cfg, tokenSecret: e.target.value })} type="password" autoComplete="off" className={`${INPUT} font-mono`} /></div>
                </div>
                <div>
                  <label className={LABEL}>Signature method</label>
                  <select value={oauth1Cfg.signatureMethod || 'HMAC-SHA1'} onChange={(e) => setOauth1Cfg({ ...oauth1Cfg, signatureMethod: e.target.value })} className={INPUT}>
                    <option value="HMAC-SHA1">HMAC-SHA1</option>
                    <option value="HMAC-SHA256">HMAC-SHA256</option>
                    <option value="PLAINTEXT">PLAINTEXT</option>
                  </select>
                </div>
                <p className="text-[10.5px] text-gray-400">The OAuth 1.0a signature is computed at send time. Secrets are stored encrypted.</p>
              </div>
            )}
            {authType === 'mtls' && (
              <div className="space-y-2">
                <div><label className={LABEL}>Client certificate (PEM)</label><textarea value={mtlsCfg.cert || ''} onChange={(e) => setMtlsCfg({ ...mtlsCfg, cert: e.target.value })} rows={3} spellCheck={false} placeholder={'-----BEGIN CERTIFICATE-----'} className={`${INPUT} font-mono text-[11px] resize-y`} /></div>
                <div><label className={LABEL}>Private key (PEM)</label><textarea value={mtlsCfg.key || ''} onChange={(e) => setMtlsCfg({ ...mtlsCfg, key: e.target.value })} rows={3} spellCheck={false} placeholder={'-----BEGIN PRIVATE KEY-----'} className={`${INPUT} font-mono text-[11px] resize-y`} /></div>
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-gray-500 hover:text-[#7C3AED]">CA chain / passphrase (optional)</summary>
                  <div className="mt-2 space-y-2">
                    <div><label className={LABEL}>CA certificate (PEM)</label><textarea value={mtlsCfg.ca || ''} onChange={(e) => setMtlsCfg({ ...mtlsCfg, ca: e.target.value })} rows={2} spellCheck={false} className={`${INPUT} font-mono text-[11px] resize-y`} /></div>
                    <div><label className={LABEL}>Key passphrase</label><input value={mtlsCfg.passphrase || ''} onChange={(e) => setMtlsCfg({ ...mtlsCfg, passphrase: e.target.value })} type="password" autoComplete="off" className={`${INPUT} font-mono`} /></div>
                  </div>
                </details>
                <label className="flex items-center gap-1.5 text-[11.5px] text-gray-600"><input type="checkbox" checked={mtlsCfg.rejectUnauthorized !== false} onChange={(e) => setMtlsCfg({ ...mtlsCfg, rejectUnauthorized: e.target.checked })} className="w-3.5 h-3.5" />Verify the server certificate</label>
                <p className="text-[10.5px] text-gray-400">The client certificate is presented from the server (via an mTLS dispatcher) at send time.</p>
              </div>
            )}
          </Section>

          {hasBody && (
            <Section key={isHealed('body') ? 'body-healed' : 'body'} title="Body" badge={BODY_MODES.find((m) => m.id === bodyMode)?.label || ''} defaultOpen={isHealed('body') || bodyMode !== 'json' || body.trim().length > 0} action={isHealed('body') ? healBadge : undefined}>
              <div className="flex flex-wrap gap-1 mb-2">
                {BODY_MODES.map((m) => (
                  <button key={m.id} type="button" onClick={() => setBodyMode(m.id)} className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-all active:translate-y-px ${CHIP_3D} ${bodyMode === m.id ? 'bg-gradient-to-b from-[#F5F3FF] to-[#EDE9FE] text-[#6D28D9] border-[#DDD6FE]' : 'bg-white text-gray-500 border-gray-200 hover:border-[#DDD6FE]'}`}>{m.label}</button>
                ))}
              </div>

              {(bodyMode === 'json' || bodyMode === 'raw') && (
                <>
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} spellCheck={false} placeholder={bodyMode === 'json' ? '{"sku": "A1", "qty": 2}' : 'raw request body'} className={`${INPUT} font-mono text-[11.5px] resize-y`} />
                  {bodyMode === 'json' && bodyJsonError && <p className="text-[11px] text-amber-700">{bodyJsonError}</p>}
                </>
              )}

              {bodyMode === 'urlencoded' && (
                <KeyValueRows rows={formFields.map((f) => ({ key: f.key, value: f.value ?? '' }))} onChange={(rows) => setFormFields(rows.map((r) => ({ key: r.key, value: r.value, type: 'text' as const })))} placeholderKey="grant_type" placeholderValue="client_credentials" />
              )}

              {bodyMode === 'form-data' && (
                <FormDataRows rows={formFields} onChange={setFormFields} />
              )}

              {bodyMode === 'binary' && (
                <div className="space-y-1.5">
                  <label className="inline-flex items-center gap-2 text-[12px] text-[#6D28D9] cursor-pointer">
                    <span className={SECONDARY_BTN}><Paperclip className="w-3.5 h-3.5" />Choose file</span>
                    <input type="file" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; const r = await fileToBase64(f); setBodyBase64(r.dataBase64); setBinaryMeta({ filename: r.filename, contentType: r.contentType }); }} />
                    {binaryMeta.filename && <span className="text-[11.5px] text-gray-600 font-mono truncate max-w-[220px]">{binaryMeta.filename}</span>}
                  </label>
                  <div><label className={LABEL}>Content-Type</label><input value={binaryMeta.contentType} onChange={(e) => setBinaryMeta({ ...binaryMeta, contentType: e.target.value })} placeholder="application/octet-stream" className={`${INPUT} font-mono`} /></div>
                  {bodyBase64 && <p className="text-[10.5px] text-gray-400">{Math.round((bodyBase64.length * 3) / 4 / 1024)} KB encoded</p>}
                </div>
              )}
            </Section>
          )}

          {/* ── Send / Try it ── */}
          <Section title="Send" badge={sendResult ? String(sendResult.status ?? 'err') : ''} defaultOpen={!!sendResult || !!sendError}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void doSend()} disabled={sending || !canSend} className={PRIMARY_BTN}>
                {sending ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}{sending ? 'Sending…' : 'Send request'}
              </button>
              <span className="text-[10.5px] text-gray-400">Fires the live request from the server and shows the real response.</span>
            </div>
            {sendError && <p className="text-[11px] text-red-600 mt-2 whitespace-pre-wrap break-words">{sendError}</p>}
            {sendResult && (
              <div className="mt-2 space-y-1.5">
                {(() => {
                  const exp = parseInt(expectedStatus, 10);
                  const actual = sendResult.status ?? null;
                  const transportFail = !!sendResult.error || actual == null;
                  const matched = !transportFail && Number.isFinite(exp) && actual === exp;
                  return (
                    <div className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11.5px] font-semibold ${matched ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
                      {matched ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
                      <span>
                        {matched
                          ? `Success — response matches the expected status (${exp})`
                          : transportFail
                            ? `Failure — the request did not complete${sendResult.error ? `: ${sendResult.error}` : ''}`
                            : `Failure — expected ${Number.isFinite(exp) ? exp : '—'}, got ${actual ?? '—'}`}
                      </span>
                    </div>
                  );
                })()}
                <div className="flex items-center gap-2 text-[11.5px]">
                  <span className={`font-mono font-bold ${sendResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>{sendResult.status ?? '—'}</span>
                  <span className="text-gray-400 tabular-nums">{sendResult.elapsedMs}ms</span>
                  {sendResult.error && <span className="text-red-600 truncate">{sendResult.error}</span>}
                </div>
                <pre className="max-h-56 overflow-auto rounded-md border border-[#E9E5FB] bg-[#FCFBFF] p-2 font-mono text-[11px] text-gray-700 whitespace-pre-wrap break-words">{sendResult.bodyText || '(empty body)'}</pre>
              </div>
            )}
            {sendFailed && (
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={() => void healIt()} disabled={healing} className={SECONDARY_BTN}>
                  {healing ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}{healing ? 'Healing…' : 'Heal it'}
                </button>
                <span className="text-[10.5px] text-gray-400">Diagnoses the failure and auto-fills a corrected request.</span>
              </div>
            )}
            {healResult && (
              <div className={`mt-2 rounded-md border p-2 text-[11px] ${healResult.changed ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
                <div className={`flex items-center gap-1.5 font-semibold ${healResult.changed ? 'text-emerald-800' : 'text-amber-800'}`}>
                  {healResult.changed ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                  {healResult.changed ? 'Healed & auto-filled' : 'No safe auto-fix'}
                  <span className="uppercase text-[9.5px] px-1 py-0.5 rounded bg-white/70 text-gray-600">{healResult.classification}</span>
                  <span className="text-[9.5px] text-gray-500">{healResult.confidence} confidence</span>
                </div>
                {healResult.summary && <p className="mt-1 text-gray-700">{healResult.summary}</p>}
                {healResult.rationale && <p className="mt-0.5 text-gray-500">{healResult.rationale}</p>}
                {healResult.changed && <p className="mt-1 text-emerald-700">Review the updated fields and Send again to confirm.</p>}
              </div>
            )}
          </Section>

          <Section key={isHealed('expected') ? 'expected-healed' : 'expected'} title="Expected response" badge={expectedStatus} action={isHealed('expected') ? healBadge : undefined}>
            <div className="grid grid-cols-[110px_1fr] gap-2">
              <div><label className={LABEL}>Status</label><input value={expectedStatus} onChange={(e) => setExpectedStatus(e.target.value.replace(/[^\d]/g, '').slice(0, 3))} className={`${INPUT} font-mono`} /></div>
              <div><label className={LABEL}>Body (shape or example)</label><textarea value={expectedResponse} onChange={(e) => setExpectedResponse(e.target.value)} rows={4} spellCheck={false} placeholder='{"id": "string", "status": "created"}' className={`${INPUT} font-mono text-[11.5px] resize-y`} /></div>
            </div>
          </Section>
        </div>

        <footer className={`flex items-center gap-2 px-4 h-14 border-t border-[#E9E5FB] flex-shrink-0 ${STRIP} shadow-[inset_0_1px_0_#EDE9FE,0_-8px_20px_-16px_rgba(30,27,75,0.35)]`}>
          {onAutomate && tested
            ? <p className="text-[11px] text-amber-700 min-w-0 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /><span className="min-w-0 truncate">Tested live — Automate skips the readiness review and runs the suite.</span></p>
            : <p className="text-[11px] text-gray-400 min-w-0 truncate">{onAutomate ? 'Automate designs & runs the full suite for this request.' : 'Saved to the catalogue; scenarios are designed when you run.'}</p>}
          <button type="button" onClick={onClose} className={`ml-auto ${SECONDARY_BTN}`}>Cancel</button>
          <button type="button" onClick={submit} className={onAutomate ? SECONDARY_BTN : PRIMARY_BTN}><Save className="w-3.5 h-3.5" />{initial?.url ? 'Save changes' : 'Add to catalogue'}</button>
          {onAutomate && (
            <button type="button" onClick={automate} disabled={!urlValid} title={tested ? 'Tested live — run the full API automation pipeline for this request (readiness review skipped)' : 'Add this request and run the full API automation pipeline for it'} className={PRIMARY_BTN}><Zap className="w-3.5 h-3.5" />Automate</button>
          )}
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

/* ── Multipart form-data editor (text or file per field) ────────────── */

function FormDataRows({ rows, onChange }: { rows: EndpointFormField[]; onChange: (rows: EndpointFormField[]) => void }) {
  const list = rows.length ? rows : [{ key: '', value: '', type: 'text' as const }];
  const update = (i: number, patch: Partial<EndpointFormField>) => onChange(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const pickFile = async (i: number, file: File | undefined) => {
    if (!file) return;
    const r = await fileToBase64(file);
    update(i, { type: 'file', dataBase64: r.dataBase64, filename: r.filename, contentType: r.contentType, value: undefined });
  };
  return (
    <div className="space-y-1">
      {list.map((r, i) => (
        <div key={i} className="flex items-center gap-1">
          <input value={r.key} onChange={(e) => update(i, { key: e.target.value })} placeholder="field" spellCheck={false} className={`${INPUT} font-mono text-[11.5px] flex-[2]`} />
          <select value={r.type || 'text'} onChange={(e) => update(i, { type: e.target.value as 'text' | 'file', ...(e.target.value === 'text' ? { dataBase64: undefined, filename: undefined } : {}) })} className={`${INPUT} flex-shrink-0 w-[70px]`}>
            <option value="text">text</option>
            <option value="file">file</option>
          </select>
          {(r.type || 'text') === 'text' ? (
            <input value={r.value ?? ''} onChange={(e) => update(i, { value: e.target.value })} placeholder="value" spellCheck={false} className={`${INPUT} font-mono text-[11.5px] flex-[3]`} />
          ) : (
            <label className="flex-[3] inline-flex items-center gap-1.5 cursor-pointer text-[11px] text-gray-600">
              <span className={SECONDARY_BTN}><Paperclip className="w-3.5 h-3.5" />File</span>
              <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void pickFile(i, f); }} />
              <span className="truncate font-mono">{r.filename || 'no file'}</span>
            </label>
          )}
          <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} className="p-1 text-gray-300 hover:text-red-500" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...list, { key: '', value: '', type: 'text' }])} className="inline-flex items-center gap-1 text-[11px] font-medium text-[#7C3AED] hover:text-[#6D28D9]"><Plus className="w-3 h-3" />Add field</button>
    </div>
  );
}

/**
 * API Studio — the request panel.
 *
 * Everything the run is grounded in lives here: the endpoint, what is sent with
 * it, and what it is contracted to return. It replaces the old chat form's
 * single stacked card with collapsible sections, so an endpoint carrying eight
 * headers and a large payload stays navigable while the URL, auth scheme and
 * expected status remain readable at a glance from the collapsed summaries.
 *
 * The panel is a controlled component — ApiStudio owns the state, because the
 * same values are sent to generation, execution and healing.
 */
import { useRef, useState } from 'react';
import {
  Plus, Trash2, Eye, EyeOff, Upload, Loader2, AlertTriangle, Layers, X, Lock,
  XCircle, Info,
} from 'lucide-react';
import { Section, RequiredMark } from './primitives';
import { prettyJson } from './format';
import type { HeaderPair, AuthType, QueryParamRow } from './types';

/** HTTP status codes offered for the expected-response contract. */
const HTTP_STATUS_CODES: { code: string; label: string }[] = [
  { code: '200', label: '200 OK' },
  { code: '201', label: '201 Created' },
  { code: '202', label: '202 Accepted' },
  { code: '204', label: '204 No Content' },
  { code: '301', label: '301 Moved Permanently' },
  { code: '302', label: '302 Found' },
  { code: '400', label: '400 Bad Request' },
  { code: '401', label: '401 Unauthorized' },
  { code: '403', label: '403 Forbidden' },
  { code: '404', label: '404 Not Found' },
  { code: '409', label: '409 Conflict' },
  { code: '422', label: '422 Unprocessable Entity' },
  { code: '429', label: '429 Too Many Requests' },
  { code: '500', label: '500 Internal Server Error' },
  { code: '502', label: '502 Bad Gateway' },
  { code: '503', label: '503 Service Unavailable' },
];

const AUTH_OPTIONS: { id: AuthType; label: string }[] = [
  { id: 'none', label: 'No auth' },
  { id: 'bearer', label: 'Bearer token' },
  { id: 'basic', label: 'Basic auth' },
  { id: 'apikey', label: 'API key' },
];

const inputCls =
  'w-full px-2.5 py-1.5 bg-white border border-gray-200 rounded-md text-[12px] text-gray-800 placeholder-gray-300 ' +
  'outline-none focus:border-[#A5B4FC] focus:ring-2 focus:ring-[#EDE9FE] transition-all disabled:bg-gray-50 disabled:text-gray-400';

/** Overlay for a required field left empty when a run was attempted. */
const invalidCls = '!border-red-300 focus:!border-red-400 focus:!ring-red-100';

export interface RequestPanelProps {
  /**
   * The URL's query string as editable rows. Editing them rewrites the URL bar,
   * and typing `?key=value` into the URL bar refills them — the URL stays the
   * source of truth, so these never diverge from what the run actually sends.
   */
  queryParams: QueryParamRow[];
  onQueryParamsChange: (p: QueryParamRow[]) => void;
  headers: HeaderPair[];
  onHeadersChange: (h: HeaderPair[]) => void;
  authType: AuthType;
  onAuthTypeChange: (t: AuthType) => void;
  authValue: string;
  onAuthValueChange: (v: string) => void;
  method: string;
  body: string;
  onBodyChange: (v: string) => void;
  expectedStatus: string;
  onExpectedStatusChange: (v: string) => void;
  expectedBody: string;
  onExpectedBodyChange: (v: string) => void;
  /**
   * A run was attempted with required fields empty. Marks the ones still blank,
   * so the error in the header has somewhere to point.
   */
  showRequired: boolean;

  /** Spec upload */
  specFormats: { id: string; label: string }[];
  onSpecFile: (file: File, format: string) => void;
  specParsing: boolean;
  /** The import failed outright — nothing was read. */
  specError: string;
  /** The import worked but lost something (truncation, a converter complaint). */
  specWarning: string;
  /** The import worked; this reports its scope. Never styled as a problem. */
  specNotice: string;
  endpointCount: number;
  onReopenEndpointPicker: () => void;
  onDiscardSpec: () => void;

  /** True once a run has started — the request is what the results describe. */
  locked: boolean;
}

export default function RequestPanel(props: RequestPanelProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const formatRef = useRef<HTMLSelectElement | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const {
    queryParams, onQueryParamsChange,
    headers, onHeadersChange, authType, onAuthTypeChange, authValue, onAuthValueChange,
    method, body, onBodyChange, expectedStatus, onExpectedStatusChange,
    expectedBody, onExpectedBodyChange, showRequired,
    specFormats, onSpecFile, specParsing, specError, specWarning, specNotice,
    endpointCount, onReopenEndpointPicker, onDiscardSpec, locked,
  } = props;

  // Only an EMPTY required field is marked — once it is filled the mark clears
  // without waiting for another run attempt.
  const missingStatus = showRequired && !expectedStatus.trim();
  const missingBody = showRequired && !expectedBody.trim();

  const filledParams = queryParams.filter((p) => p.enabled && p.key.trim()).length;
  const filledHeaders = headers.filter((h) => h.key.trim()).length;
  const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes((method || '').toUpperCase());
  const authLabel = AUTH_OPTIONS.find((a) => a.id === authType)?.label || 'No auth';

  return (
    <div className="h-full flex flex-col bg-white border-r border-gray-200 min-h-0">
      {/* Panel header */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-gray-200 bg-gray-50/70 flex-shrink-0">
        <span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">Request</span>
        {locked && (
          <span className="inline-flex items-center gap-1 text-[10px] text-gray-400" title="The run in progress describes this request — reset to change it">
            <Lock className="w-3 h-3" />locked
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ''; // allow re-picking the same file
              if (file) onSpecFile(file, formatRef.current?.value || 'auto');
            }}
          />
          <select
            ref={formatRef}
            defaultValue="auto"
            disabled={locked || specParsing}
            title="Format hint for the uploaded spec"
            className="px-1.5 py-1 bg-white border border-gray-200 rounded text-[10px] text-gray-500 outline-none focus:border-[#C4B5FD] disabled:opacity-50 max-w-[86px]"
          >
            {specFormats.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <button
            type="button"
            disabled={locked || specParsing}
            onClick={() => fileRef.current?.click()}
            title="Import an API spec (OpenAPI, Postman, XML, PDF, Word, Excel, JSON, YAML…) and fill these fields from it"
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded hover:bg-[#EDE9FE] transition-colors disabled:opacity-50"
          >
            {specParsing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            {specParsing ? 'Reading' : 'Import'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 pb-14">
        {/* An import reports itself at one of three levels. They look different
            on purpose: if "I read all 6 sheets" arrives in the same red box as
            "that file could not be read", the red box stops meaning anything. */}
        {specError && (
          <div className="m-3 flex items-start gap-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-2">
            <XCircle className="w-3.5 h-3.5 mt-px flex-shrink-0 text-red-500" />
            <span className="leading-relaxed">{specError}</span>
          </div>
        )}
        {specWarning && (
          <div className="m-3 flex items-start gap-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0 text-amber-500" />
            <span className="leading-relaxed">{specWarning}</span>
          </div>
        )}
        {specNotice && (
          <div className="m-3 flex items-start gap-1.5 text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-2.5 py-2">
            <Info className="w-3.5 h-3.5 mt-px flex-shrink-0 text-gray-400" />
            <span className="leading-relaxed">{specNotice}</span>
          </div>
        )}

        {endpointCount > 1 && (
          <div className="m-3 flex items-center gap-1.5 text-[11px] text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded-md px-2.5 py-1.5">
            <Layers className="w-3.5 h-3.5 flex-shrink-0" />
            <button
              type="button"
              onClick={onReopenEndpointPicker}
              disabled={locked}
              className="flex-1 min-w-0 text-left hover:text-[#4C1D95] transition-colors disabled:opacity-50"
            >
              {endpointCount} endpoints imported · <span className="font-medium underline">change</span>
            </button>
            <button
              type="button"
              onClick={onDiscardSpec}
              disabled={locked}
              title="Discard the import and clear these fields"
              className="flex-shrink-0 text-[#A5B4FC] hover:text-[#6D28D9] disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* ── Query params ──
            A structured editor over the URL's query string. Rows here append to
            the endpoint above; a `?key=value` typed into the URL shows up here.
            The checkbox keeps a param in the table but out of the URL. */}
        <Section
          title="Query params"
          badge={filledParams ? String(filledParams) : ''}
          action={
            <button
              type="button"
              onClick={() => onQueryParamsChange([...queryParams, { key: '', value: '', enabled: true }])}
              disabled={locked}
              className="inline-flex items-center gap-0.5 text-[11px] text-[#7C3AED] hover:text-[#5B21B6] disabled:opacity-40"
            >
              <Plus className="w-3 h-3" />Add
            </button>
          }
        >
          {queryParams.length === 0 ? (
            <p className="text-[10px] text-gray-400 leading-relaxed">
              None yet. Add a row — or type <span className="font-mono text-gray-500">?key=value</span> into the URL above and it appears here.
            </p>
          ) : (
            queryParams.map((p, i) => (
              <div key={i} className={`flex items-center gap-1.5 ${p.enabled ? '' : 'opacity-45'}`}>
                <input
                  type="checkbox"
                  checked={p.enabled}
                  disabled={locked}
                  onChange={(e) => onQueryParamsChange(
                    queryParams.map((x, idx) => (idx === i ? { ...x, enabled: e.target.checked } : x)),
                  )}
                  title={p.enabled ? 'Enabled — included in the URL' : 'Disabled — kept here but left out of the URL'}
                  aria-label="Include this parameter"
                  className="w-3.5 h-3.5 flex-shrink-0 rounded accent-[#7C3AED] disabled:opacity-50 cursor-pointer"
                />
                <input
                  value={p.key}
                  disabled={locked}
                  onChange={(e) => onQueryParamsChange(
                    queryParams.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x)),
                  )}
                  placeholder="Key"
                  className={inputCls + ' flex-1 font-mono !text-[11px]'}
                />
                <input
                  value={p.value}
                  disabled={locked}
                  onChange={(e) => onQueryParamsChange(
                    queryParams.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x)),
                  )}
                  placeholder="Value"
                  className={inputCls + ' flex-1 font-mono !text-[11px]'}
                />
                <button
                  type="button"
                  onClick={() => onQueryParamsChange(queryParams.filter((_, idx) => idx !== i))}
                  disabled={locked}
                  className="text-gray-300 hover:text-red-500 disabled:opacity-40 flex-shrink-0"
                  aria-label="Remove parameter"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </Section>

        {/* ── Headers ── */}
        <Section
          title="Headers"
          badge={filledHeaders ? String(filledHeaders) : ''}
          action={
            <button
              type="button"
              onClick={() => onHeadersChange([...headers, { key: '', value: '' }])}
              disabled={locked}
              className="inline-flex items-center gap-0.5 text-[11px] text-[#7C3AED] hover:text-[#5B21B6] disabled:opacity-40"
            >
              <Plus className="w-3 h-3" />Add
            </button>
          }
        >
          {headers.map((h, i) => (
            <div key={i} className="flex gap-1.5">
              <input
                value={h.key}
                disabled={locked}
                onChange={(e) => {
                  const next = headers.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x));
                  onHeadersChange(next);
                }}
                placeholder="Name"
                className={inputCls + ' flex-1 font-mono !text-[11px]'}
              />
              <input
                value={h.value}
                disabled={locked}
                onChange={(e) => {
                  const next = headers.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x));
                  onHeadersChange(next);
                }}
                placeholder="Value"
                className={inputCls + ' flex-1 font-mono !text-[11px]'}
              />
              {headers.length > 1 && (
                <button
                  type="button"
                  onClick={() => onHeadersChange(headers.filter((_, idx) => idx !== i))}
                  disabled={locked}
                  className="text-gray-300 hover:text-red-500 disabled:opacity-40 flex-shrink-0"
                  aria-label="Remove header"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </Section>

        {/* ── Authorization ── */}
        <Section title="Authorization" badge={authType === 'none' ? '' : authLabel}>
          <select
            value={authType}
            disabled={locked}
            onChange={(e) => onAuthTypeChange(e.target.value as AuthType)}
            className={inputCls}
          >
            {AUTH_OPTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          {authType !== 'none' && (
            <div className="relative">
              <input
                value={authValue}
                disabled={locked}
                onChange={(e) => onAuthValueChange(e.target.value)}
                type={showSecret ? 'text' : 'password'}
                placeholder={
                  authType === 'bearer' ? 'Token — without the "Bearer " prefix'
                  : authType === 'basic' ? 'username:password'
                  : 'API key value'
                }
                className={inputCls + ' font-mono !text-[11px] pr-8'}
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"
                aria-label={showSecret ? 'Hide credential' : 'Show credential'}
              >
                {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}
          {authType !== 'none' && (
            <p className="text-[10px] text-gray-400 leading-relaxed">
              Sent on every scenario except the deliberate no-auth negatives. Never written into the generated specs in plain text.
            </p>
          )}
        </Section>

        {/* ── Request body — only for methods that carry one ── */}
        {hasBody && (
          <Section title="Request body" badge={body.trim() ? 'JSON' : ''}>
            <textarea
              value={body}
              disabled={locked}
              onChange={(e) => onBodyChange(e.target.value)}
              onBlur={() => onBodyChange(prettyJson(body))}
              placeholder={'{\n  "name": "example"\n}'}
              rows={7}
              spellCheck={false}
              className={inputCls + ' font-mono !text-[11px] leading-[1.6] resize-y'}
            />
          </Section>
        )}

        {/* ── Expected response — the contract every scenario is measured against ── */}
        <Section title="Expected response" badge={expectedStatus} required>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-1">Status code <RequiredMark /></label>
            <select
              value={expectedStatus}
              disabled={locked}
              onChange={(e) => onExpectedStatusChange(e.target.value)}
              aria-invalid={missingStatus}
              className={inputCls + (missingStatus ? ' ' + invalidCls : '')}
            >
              {HTTP_STATUS_CODES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-500 mb-1">
              Response body <RequiredMark />
            </label>
            <textarea
              value={expectedBody}
              disabled={locked}
              onChange={(e) => onExpectedBodyChange(e.target.value)}
              onBlur={() => onExpectedBodyChange(prettyJson(expectedBody))}
              placeholder={'{\n  "id": 1,\n  "status": "ok"\n}'}
              rows={7}
              spellCheck={false}
              aria-invalid={missingBody}
              className={inputCls + ' font-mono !text-[11px] leading-[1.6] resize-y' + (missingBody ? ' ' + invalidCls : '')}
            />
            <p className={`text-[10px] mt-1 leading-relaxed ${missingBody ? 'text-red-600' : 'text-gray-400'}`}>
              Required. Field names and types here become the schema assertions, and this status is what the happy-path scenario asserts.
            </p>
          </div>
        </Section>

      </div>
    </div>
  );
}

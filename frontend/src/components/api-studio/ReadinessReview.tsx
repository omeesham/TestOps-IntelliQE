/**
 * ReadinessReview — the strict reviewer gate between import and planning.
 *
 * Grades every endpoint in the selection (deterministically, via
 * buildReadinessReview) across purpose, inputs, expected responses, business
 * rules, schema validity and basic validity. Each item shows its source and a
 * per-category (REST/SOAP/…) test checklist. The reviewer can fix missing data
 * inline or reject (remove) an item. Planning stays disabled until EVERY
 * endpoint is ready — nothing half-documented reaches the pipeline.
 */
import { useState } from 'react';
import {
  Check, X, Trash2, ShieldCheck, ChevronDown, Link2, FlaskConical, AlertCircle, Pencil, Sparkles,
} from 'lucide-react';
import { PRIMARY_BTN, SECONDARY_BTN, INPUT, LABEL } from './format';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { suggestEndpointReadiness } from '@/services/api';
import {
  buildReadinessReview, CATEGORY_CHECKLIST,
  type EndpointReadiness, type ReadinessField,
} from './apiValidation';
import type { Catalog } from './hooks/useCatalog';
import type { CatalogEndpoint } from './types';

const SOURCE_LABEL: Record<string, string> = {
  jira: 'Jira', ado: 'Azure DevOps', brd: 'BRD', frd: 'FRD', openapi: 'OpenAPI', postman: 'Postman',
  bruno: 'Bruno', curl: 'cURL', endpoint: 'URL', 'docs-url': 'Docs', file: 'File', manual: 'Manual',
  graphql: 'GraphQL', mcp: 'MCP', soap: 'SOAP', connector: 'Connector', capture: 'Capture',
};

function FieldRow({ f }: { f: ReadinessField }) {
  return (
    <li className="flex items-start gap-1.5 text-[11.5px] leading-snug">
      {f.ok
        ? <Check className="w-3.5 h-3.5 mt-px flex-shrink-0 text-emerald-600" />
        : f.level === 'error'
          ? <X className="w-3.5 h-3.5 mt-px flex-shrink-0 text-red-500" />
          : <AlertCircle className="w-3.5 h-3.5 mt-px flex-shrink-0 text-amber-500" />}
      <span className="min-w-0">
        <span className="font-semibold text-gray-700">{f.label}</span>
        <span className="text-gray-400"> — </span>
        {f.ok
          ? <span className="text-gray-600">{f.value}</span>
          : <span className="text-red-600">{f.message}</span>}
      </span>
    </li>
  );
}

function EndpointCard({ item, ep, onPatch, onReject, onSuggest, suggesting }: {
  item: EndpointReadiness;
  ep: CatalogEndpoint;
  onPatch: (patch: Partial<CatalogEndpoint>) => void;
  onReject: () => void;
  onSuggest: () => void;
  suggesting: boolean;
}) {
  const [editing, setEditing] = useState(!item.ready);
  const [showTests, setShowTests] = useState(false);
  const cat = CATEGORY_CHECKLIST[item.category];
  const src = item.source;
  // Uncontrolled inputs (defaultValue) won't refresh when a suggestion patches the
  // endpoint; this signature changes with the saved values, remounting them so the
  // suggested text is visible.
  const editSig = `${(ep.description || '').length}:${ep.expectedStatus ?? ''}:${(ep.expectedResponse || '').length}:${(ep.businessRules || '').length}:${(ep.body || '').length}:${ep.method}:${ep.url}`;

  return (
    <div className={`rounded-xl border ${item.ready ? 'border-emerald-200 bg-emerald-50/30' : 'border-red-200 bg-red-50/20'} p-3`}>
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold text-white" style={{ backgroundColor: cat.color }}>{cat.label}</span>
        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-[10px] font-bold font-mono">{item.method}</span>
        <span className="text-[11.5px] font-mono text-gray-600 truncate max-w-[280px]" title={item.url}>{item.url || '(no URL)'}</span>
        {src?.name && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#EFF6FF] border border-[#BFDBFE] text-[10px] font-semibold text-[#1D4ED8]" title={`Imported from ${SOURCE_LABEL[src.method] || src.method}: ${src.name}`}>
            <Link2 className="w-2.5 h-2.5" />{SOURCE_LABEL[src.method] || src.method} · {src.name}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {item.ready
            ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold"><Check className="w-3 h-3" />Ready</span>
            : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold">{item.errorCount} missing</span>}
          {!item.ready && (
            <button type="button" onClick={onSuggest} disabled={suggesting}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#EEF2FF] border border-[#C7D2FE] text-[#4338CA] text-[10px] font-bold hover:bg-[#E0E7FF] disabled:opacity-60"
              title="Suggest the missing details (purpose, expected response, business rules) with AI and fill them in so this endpoint passes review">
              {suggesting ? <Spinner className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Suggest &amp; make ready
            </button>
          )}
          <button type="button" onClick={() => setEditing((v) => !v)} className="p-1 rounded text-gray-400 hover:text-[#2563EB] hover:bg-white" title="Edit fields"><Pencil className="w-3.5 h-3.5" /></button>
          <button type="button" onClick={onReject} className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-white" title="Reject & remove this endpoint"><Trash2 className="w-3.5 h-3.5" /></button>
        </span>
      </div>

      {/* Field checklist */}
      <ul className="mt-2 grid sm:grid-cols-2 gap-x-4 gap-y-1">
        {item.fields.map((f) => <FieldRow key={f.key} f={f} />)}
      </ul>

      {/* Inline edit — fix the captured data without leaving the review */}
      {editing && (
        <div key={editSig} className="mt-3 pt-3 border-t border-black/5 grid sm:grid-cols-2 gap-2.5">
          <div className="sm:col-span-2">
            <label className={LABEL}>Purpose</label>
            <input defaultValue={ep.description || ''} onBlur={(e) => onPatch({ description: e.target.value.trim() || undefined })}
              placeholder="What this endpoint does and when it's used" className={INPUT} />
          </div>
          <div>
            <label className={LABEL}>Expected status</label>
            <input type="number" defaultValue={ep.expectedStatus ?? ''} onBlur={(e) => onPatch({ expectedStatus: e.target.value ? Number(e.target.value) : undefined })}
              placeholder="200" className={INPUT} />
          </div>
          <div>
            <label className={LABEL}>HTTP method</label>
            <input defaultValue={ep.method} onBlur={(e) => onPatch({ method: e.target.value.trim().toUpperCase() || ep.method })} className={INPUT} />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL}>Request URL</label>
            <input defaultValue={ep.url} onBlur={(e) => onPatch({ url: e.target.value.trim() })} placeholder="https://…" className={INPUT} />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL}>Expected response (example body)</label>
            <textarea defaultValue={ep.expectedResponse || ''} onBlur={(e) => onPatch({ expectedResponse: e.target.value.trim() || undefined })}
              rows={2} placeholder='{"id": "string"}' className={`${INPUT} font-mono text-[11px] resize-y`} />
          </div>
          {(item.method === 'POST' || item.method === 'PUT' || item.method === 'PATCH' || item.category === 'soap') && (
            <div className="sm:col-span-2">
              <label className={LABEL}>Request body</label>
              <textarea defaultValue={ep.body || ''} onBlur={(e) => onPatch({ body: e.target.value.trim() || undefined })}
                rows={2} placeholder={item.category === 'soap' ? '<soap:Envelope>…' : '{"field": "value"}'} className={`${INPUT} font-mono text-[11px] resize-y`} />
            </div>
          )}
          <div className="sm:col-span-2">
            <label className={LABEL}>Business rules / acceptance criteria</label>
            <textarea defaultValue={ep.businessRules || ''} onBlur={(e) => onPatch({ businessRules: e.target.value.trim() || undefined })}
              rows={2} placeholder="e.g. must reject orders over the credit limit; returns 409 on duplicate" className={`${INPUT} resize-y`} />
          </div>
        </div>
      )}

      {/* Per-category test plan */}
      <button type="button" onClick={() => setShowTests((v) => !v)} className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-semibold text-gray-500 hover:text-gray-700">
        <FlaskConical className="w-3 h-3" style={{ color: cat.color }} />
        What we'll test for this {cat.label} API
        <ChevronDown className={`w-3 h-3 transition-transform ${showTests ? 'rotate-180' : ''}`} />
      </button>
      {showTests && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {cat.tests.map((t) => (
            <li key={t} className="px-2 py-0.5 rounded-md text-[10.5px] font-medium border" style={{ color: cat.color, backgroundColor: `${cat.color}12`, borderColor: `${cat.color}33` }}>{t}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ReadinessReview({ catalog, endpointIds, onClose, onProceed }: {
  catalog: Catalog;
  endpointIds: string[];
  onClose: () => void;
  onProceed: (eps: CatalogEndpoint[]) => void;
}) {
  const toast = useToast();
  const ids = new Set(endpointIds);
  const eps = catalog.endpoints.filter((e) => ids.has(e.id));
  const report = buildReadinessReview(eps);
  const empty = eps.length === 0;
  const [suggesting, setSuggesting] = useState<Set<string>>(new Set());

  /** Suggest the missing readiness details for one endpoint and fill ONLY the
   *  fields that are currently failing, so a good purpose/body is never clobbered. */
  const suggestFor = async (item: EndpointReadiness, ep: CatalogEndpoint) => {
    if (suggesting.has(item.endpointId)) return;
    setSuggesting((s) => new Set(s).add(item.endpointId));
    try {
      const { suggestion, source } = await suggestEndpointReadiness({
        method: ep.method, url: ep.url, title: ep.title, description: ep.description,
        expectedStatus: ep.expectedStatus, expectedResponse: ep.expectedResponse,
        businessRules: ep.businessRules, body: ep.body, style: ep.style, resource: ep.resource,
        pathParams: ep.pathParams, queryParams: ep.queryParams,
      });
      const fail = new Set(item.fields.filter((f) => !f.ok && f.level === 'error').map((f) => f.key));
      const patch: Partial<CatalogEndpoint> = {};
      if (fail.has('purpose')) patch.description = suggestion.description;
      if (fail.has('responses')) {
        if (!(typeof ep.expectedStatus === 'number' && ep.expectedStatus > 0)) patch.expectedStatus = suggestion.expectedStatus;
        if (!String(ep.expectedResponse || '').trim()) patch.expectedResponse = suggestion.expectedResponse;
      }
      if (fail.has('schema')) patch.expectedResponse = suggestion.expectedResponse; // invalid JSON → replace with a valid example
      if (fail.has('businessRules')) patch.businessRules = suggestion.businessRules;
      if (fail.has('inputs') && suggestion.body) patch.body = suggestion.body;
      const n = Object.keys(patch).length;
      if (n) catalog.updateEndpoint(item.endpointId, patch);
      toast.success(source === 'ai' ? 'Suggested with AI' : 'Suggested', n ? `Filled ${n} missing item${n === 1 ? '' : 's'} — endpoint is ready.` : 'Nothing to fill.');
    } catch (err: any) {
      toast.error('Could not suggest', err?.response?.data?.error || err?.message || 'Please try again.');
    } finally {
      setSuggesting((s) => { const n = new Set(s); n.delete(item.endpointId); return n; });
    }
  };

  /** Suggest for every not-ready endpoint, one at a time. */
  const suggestAll = async () => {
    for (const item of report.items) {
      if (item.ready) continue;
      const ep = eps.find((e) => e.id === item.endpointId);
      if (ep) await suggestFor(item, ep);
    }
  };
  const busyAny = suggesting.size > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[88vh] flex flex-col bg-white rounded-2xl border border-[#ECE9F8] shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start gap-3 p-5 border-b border-gray-100">
          <span className="w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center flex-shrink-0">
            <ShieldCheck className="w-4.5 h-4.5 text-[#2563EB]" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-gray-900">API readiness review</h3>
            <p className="text-[12px] text-gray-500 mt-0.5">
              Strict gate — every endpoint must capture its purpose, inputs, expected responses, business rules and a valid schema before planning starts. Fix items inline or reject them.
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>

        {/* Summary */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-gray-100 bg-[#FBFAFE]">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-bold">{report.ready} ready</span>
          {report.notReady > 0 && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[11px] font-bold">{report.notReady} not ready</span>}
          <span className="text-[11px] text-gray-500">of {report.total} endpoint{report.total === 1 ? '' : 's'}</span>
          {report.allReady && <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700"><Check className="w-3.5 h-3.5" />All ready to plan</span>}
        </div>

        {/* Cards */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {empty
            ? <div className="text-center text-[12px] text-gray-500 py-10">No endpoints to review — every item was removed. Import or select endpoints to continue.</div>
            : report.items.map((item) => {
                const ep = eps.find((e) => e.id === item.endpointId)!;
                return (
                  <EndpointCard key={item.endpointId} item={item} ep={ep}
                    onPatch={(patch) => catalog.updateEndpoint(item.endpointId, patch)}
                    onReject={() => catalog.removeEndpoints([item.endpointId])}
                    onSuggest={() => void suggestFor(item, ep)}
                    suggesting={suggesting.has(item.endpointId)} />
                );
              })}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3.5 border-t border-gray-100">
          <p className="text-[11.5px] text-gray-500">
            {report.allReady ? 'All endpoints are automation-ready.' : `${report.notReady} endpoint${report.notReady === 1 ? '' : 's'} still need${report.notReady === 1 ? 's' : ''} attention.`}
          </p>
          <div className="ml-auto flex items-center gap-2">
            {report.notReady > 0 && (
              <button type="button" onClick={() => void suggestAll()} disabled={busyAny}
                className={SECONDARY_BTN}
                title="Suggest the missing details for every not-ready endpoint with AI and fill them in">
                {busyAny ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Suggest &amp; make all ready ({report.notReady})
              </button>
            )}
            <button type="button" onClick={onClose} className={SECONDARY_BTN}>Close</button>
            <button type="button" disabled={!report.allReady} onClick={() => onProceed(eps)} className={PRIMARY_BTN}>
              Start planning
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

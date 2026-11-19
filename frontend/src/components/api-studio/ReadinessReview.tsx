/**
 * ReadinessReview — the strict reviewer gate between import and planning.
 *
 * Grades every endpoint in the selection (deterministically, via
 * buildReadinessReview) across purpose, inputs, expected responses, business
 * rules, schema validity and basic validity. Every imported endpoint shows as
 * its own card in a scrolling list, each carrying an Accept / Reject pair.
 * Accept sends the endpoint on to the further automation steps; an endpoint can
 * be accepted even with missing fields — they stay flagged as warnings. Reject
 * removes the endpoint from the catalogue entirely, so it goes neither to the
 * next step nor to the Endpoint catalogue screen. Only the ACCEPTED endpoints go
 * forward — planning stays disabled until at least one endpoint is accepted, and
 * then plans with exactly those accepted endpoints (one, two, or all of them);
 * any still-to-review endpoints are simply skipped.
 */
import { useState } from 'react';
import {
  Check, X, Trash2, ShieldCheck, ChevronDown, Link2, FlaskConical, AlertCircle, Pencil,
} from 'lucide-react';
import { PRIMARY_BTN, SECONDARY_BTN, INPUT, LABEL } from './format';
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

function EndpointCard({ item, ep, accepted, onToggleAccept, onPatch, onReject }: {
  item: EndpointReadiness;
  ep: CatalogEndpoint;
  accepted: boolean;
  onToggleAccept: (next: boolean) => void;
  onPatch: (patch: Partial<CatalogEndpoint>) => void;
  onReject: () => void;
}) {
  const [editing, setEditing] = useState(!accepted && !item.ready);
  const [showTests, setShowTests] = useState(false);
  const cat = CATEGORY_CHECKLIST[item.category];
  const src = item.source;
  // Uncontrolled inputs (defaultValue) won't refresh when a suggestion patches the
  // endpoint; this signature changes with the saved values, remounting them so the
  // suggested text is visible.
  const editSig = `${(ep.description || '').length}:${ep.expectedStatus ?? ''}:${(ep.expectedResponse || '').length}:${(ep.businessRules || '').length}:${(ep.body || '').length}:${ep.method}:${ep.url}`;

  const frame = accepted
    ? 'border-emerald-300 bg-emerald-50/60 ring-1 ring-emerald-200'
    : item.ready
      ? 'border-gray-200 bg-white'
      : 'border-red-200 bg-red-50/20';

  return (
    <div className={`rounded-xl border p-3 ${frame}`}>
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold text-white" style={{ backgroundColor: cat.color }}>{cat.label}</span>
        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-[10px] font-bold font-mono">{item.method}</span>
        <span className="text-[11.5px] font-mono text-gray-600 truncate max-w-[250px]" title={item.url}>{item.url || '(no URL)'}</span>
        {src?.name && (() => {
          const label = `${SOURCE_LABEL[src.method] || src.method} · ${src.key || src.name}`;
          const title = `Imported from ${SOURCE_LABEL[src.method] || src.method}: ${src.key ? `${src.key} — ` : ''}${src.name}${src.section ? ` · ${src.section}` : ''}`;
          const chip = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#EFF6FF] border border-[#BFDBFE] text-[10px] font-semibold text-[#1D4ED8]';
          const inner = <><Link2 className="w-2.5 h-2.5" />{label}{src.section && <span className="font-normal text-[#3B82F6]"> · {src.section}</span>}</>;
          // Only link out to a real http(s) URL — never a javascript:/data: href.
          const safeUrl = src.url && /^https?:\/\//i.test(src.url) ? src.url : undefined;
          return safeUrl
            ? <a href={safeUrl} target="_blank" rel="noreferrer" title={title} className={`${chip} hover:bg-[#DBEAFE] hover:underline`}>{inner}</a>
            : <span className={chip} title={title}>{inner}</span>;
        })()}
        <span className="ml-auto flex items-center gap-1.5">
          {accepted
            ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold"><Check className="w-3 h-3" />Accepted</span>
            : item.ready
              ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 text-[10px] font-bold"><Check className="w-3 h-3" />Ready</span>
              : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold">{item.errorCount} missing</span>}
          <button type="button" onClick={() => setEditing((v) => !v)} className="p-1 rounded text-gray-400 hover:text-[#2563EB] hover:bg-white" title="Edit fields"><Pencil className="w-3.5 h-3.5" /></button>
        </span>
      </div>

      {/* Accept / Reject — the reviewer's decision for this imported endpoint */}
      <div className="flex items-center gap-2 mt-2">
        <button type="button" onClick={() => onToggleAccept(!accepted)}
          title={accepted ? 'Accepted — click to move back to review' : !item.ready ? 'Accept this endpoint for automation (missing fields stay flagged as warnings)' : 'Accept this endpoint for automation'}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-colors ${
            accepted
              ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
              : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'
          }`}>
          <Check className="w-3.5 h-3.5" />{accepted ? 'Accepted' : 'Accept'}
        </button>
        <button type="button" onClick={onReject} title="Reject this endpoint — it is removed and won't appear in the catalogue or go to automation"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold border bg-white text-red-600 border-red-300 hover:bg-red-50 transition-colors">
          <Trash2 className="w-3.5 h-3.5" />Reject
        </button>
        {accepted && <span className="text-[11px] text-emerald-700 font-medium">Will go to the next step for automation.</span>}
        {!accepted && !item.ready && <span className="text-[11px] text-amber-600 font-medium">{item.errorCount} field{item.errorCount === 1 ? '' : 's'} missing — you can still accept.</span>}
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
  const ids = new Set(endpointIds);
  const eps = catalog.endpoints.filter((e) => ids.has(e.id));
  const report = buildReadinessReview(eps);
  const empty = eps.length === 0;

  // The reviewer's per-endpoint decision for this sitting. Accept sends it to the
  // further automation steps. Reject removes the endpoint from the catalogue
  // outright (so it disappears from here AND the Endpoint catalogue screen), so
  // the only decision state we need to track is which endpoints are accepted.
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

  const setAccept = (id: string, on: boolean) => setAccepted((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  // Reject = remove from the catalogue entirely. It then falls out of `eps`/report
  // on the next render, and never reaches planning or the Endpoint catalogue.
  const reject = (id: string) => {
    catalog.removeEndpoints([id]);
    setAccepted((prev) => { const n = new Set(prev); n.delete(id); return n; });
  };

  const pendingItems = report.items.filter((i) => !accepted.has(i.endpointId));
  const acceptedItems = report.items.filter((i) => accepted.has(i.endpointId));
  // Only the accepted endpoints go forward to planning.
  const acceptedEps = eps.filter((e) => accepted.has(e.id));

  // Accept-all — send every remaining endpoint through to the further steps at
  // once (and clear them all back to review when every one is already accepted).
  const allIds = report.items.map((i) => i.endpointId);
  const allAccepted = allIds.length > 0 && allIds.every((id) => accepted.has(id));
  const toggleAcceptAll = () => setAccepted((prev) => {
    if (allAccepted) return new Set();
    return new Set(allIds);
  });

  // Planning needs at least one accepted endpoint — and nothing more. The
  // reviewer can plan with just the one or two endpoints they accepted; the
  // still-to-review endpoints simply don't go forward. Only `acceptedEps` are
  // handed to planning, so leaving endpoints undecided never pulls them in.
  const canPlan = acceptedEps.length > 0;

  const renderCard = (item: EndpointReadiness) => {
    const ep = eps.find((e) => e.id === item.endpointId)!;
    return (
      <EndpointCard key={item.endpointId} item={item} ep={ep}
        accepted={accepted.has(item.endpointId)}
        onToggleAccept={(on) => setAccept(item.endpointId, on)}
        onReject={() => reject(item.endpointId)}
        onPatch={(patch) => catalog.updateEndpoint(item.endpointId, patch)} />
    );
  };

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
              Accept each endpoint to send it to the further automation steps, or Reject to remove it — a rejected endpoint is dropped from the catalogue and won't appear in the Endpoint catalogue or go to automation. Fix missing data inline first if you like — an endpoint can be accepted with warnings. Only accepted endpoints go forward; planning starts once at least one endpoint is accepted, and runs with just the ones you accepted.
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>

        {/* Summary */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-gray-100 bg-[#FBFAFE] flex-wrap">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-bold">{acceptedItems.length} accepted</span>
          {pendingItems.length > 0 && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-[#6D28D9] border border-[#DDD6FE] text-[11px] font-bold">{pendingItems.length} to review</span>}
          <span className="text-[11px] text-gray-500">of {report.total} endpoint{report.total === 1 ? '' : 's'}</span>
          {allIds.length > 0 && (
            <button type="button" onClick={toggleAcceptAll}
              title={allAccepted ? 'Move every endpoint back to review' : 'Accept every endpoint'}
              className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold border bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50 transition-colors">
              <Check className="w-3.5 h-3.5" />{allAccepted ? `Clear all (${allIds.length})` : `Accept all (${allIds.length})`}
            </button>
          )}
          {canPlan && <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700"><Check className="w-3.5 h-3.5" />Ready to plan</span>}
        </div>

        {/* Cards — grouped by decision */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {empty ? (
            <div className="text-center text-[12px] text-gray-500 py-10">No endpoints to review — import or select endpoints to continue.</div>
          ) : (
            <>
              {pendingItems.length > 0 && (
                <section className="space-y-2.5">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-gray-400">To review · {pendingItems.length}</h4>
                  {pendingItems.map(renderCard)}
                </section>
              )}
              {acceptedItems.length > 0 && (
                <section className="space-y-2.5">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-emerald-600 flex items-center gap-1"><Check className="w-3.5 h-3.5" />Accepted · {acceptedItems.length}</h4>
                  {acceptedItems.map(renderCard)}
                </section>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3.5 border-t border-gray-100">
          <p className="text-[11.5px] text-gray-500">
            {acceptedEps.length > 0
              ? `${acceptedEps.length} endpoint${acceptedEps.length === 1 ? '' : 's'} accepted — only these go to planning${pendingItems.length > 0 ? ` (${pendingItems.length} still to review will be skipped)` : ''}.`
              : pendingItems.length > 0
                ? `Accept at least one endpoint to start planning — ${pendingItems.length} to review.`
                : 'No endpoints accepted — accept at least one to start planning.'}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onClose} className={SECONDARY_BTN}>Close</button>
            <button type="button" disabled={!canPlan} onClick={() => onProceed(acceptedEps)} className={PRIMARY_BTN}>
              Start planning
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

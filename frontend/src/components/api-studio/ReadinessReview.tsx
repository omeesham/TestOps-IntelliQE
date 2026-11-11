/**
 * ReadinessReview — the strict reviewer gate between import and planning.
 *
 * Grades every endpoint in the selection (deterministically, via
 * buildReadinessReview) across purpose, inputs, expected responses, business
 * rules, schema validity and basic validity. Every imported endpoint shows as
 * its own card in a scrolling list, each carrying an Accept / Reject pair. Accept
 * sends the endpoint on to the further automation steps; Reject keeps it out. An
 * endpoint can be accepted even with missing fields — they stay flagged as
 * warnings. Accepted and rejected endpoints drop into separate sections. Only
 * the ACCEPTED endpoints go forward — planning stays disabled until every
 * endpoint has a decision and at least one is accepted.
 */
import { useState } from 'react';
import {
  Check, X, Trash2, ShieldCheck, ChevronDown, Link2, FlaskConical, AlertCircle, Pencil, RotateCcw,
} from 'lucide-react';
import { PRIMARY_BTN, SECONDARY_BTN, INPUT, LABEL } from './format';
import {
  buildReadinessReview, CATEGORY_CHECKLIST,
  type EndpointReadiness, type ReadinessField,
} from './apiValidation';
import type { Catalog } from './hooks/useCatalog';
import type { CatalogEndpoint } from './types';

type Decision = 'accepted' | 'rejected';

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

function EndpointCard({ item, ep, decision, onToggleAccept, onPatch, onReject, onReset }: {
  item: EndpointReadiness;
  ep: CatalogEndpoint;
  decision?: Decision;
  onToggleAccept: (next: boolean) => void;
  onPatch: (patch: Partial<CatalogEndpoint>) => void;
  onReject: () => void;
  onReset: () => void;
}) {
  const accepted = decision === 'accepted';
  const rejected = decision === 'rejected';
  const pending = !decision;
  const [editing, setEditing] = useState(pending && !item.ready);
  const [showTests, setShowTests] = useState(false);
  const cat = CATEGORY_CHECKLIST[item.category];
  const src = item.source;
  // Uncontrolled inputs (defaultValue) won't refresh when a suggestion patches the
  // endpoint; this signature changes with the saved values, remounting them so the
  // suggested text is visible.
  const editSig = `${(ep.description || '').length}:${ep.expectedStatus ?? ''}:${(ep.expectedResponse || '').length}:${(ep.businessRules || '').length}:${(ep.body || '').length}:${ep.method}:${ep.url}`;

  const frame = accepted
    ? 'border-emerald-300 bg-emerald-50/60 ring-1 ring-emerald-200'
    : rejected
      ? 'border-gray-200 bg-gray-50 opacity-80'
      : item.ready
        ? 'border-gray-200 bg-white'
        : 'border-red-200 bg-red-50/20';

  return (
    <div className={`rounded-xl border p-3 ${frame}`}>
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        {!rejected && (
          <input type="checkbox" checked={accepted}
            onChange={(e) => onToggleAccept(e.target.checked)}
            title={accepted ? 'Accepted for further steps — untick to move back to review' : 'Tick to accept this endpoint for the further automation steps'}
            className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 flex-shrink-0 cursor-pointer" />
        )}
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
            : rejected
              ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 text-[10px] font-bold"><X className="w-3 h-3" />Rejected</span>
              : item.ready
                ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 text-[10px] font-bold"><Check className="w-3 h-3" />Ready</span>
                : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold">{item.errorCount} missing</span>}
          {!rejected && <button type="button" onClick={() => setEditing((v) => !v)} className="p-1 rounded text-gray-400 hover:text-[#2563EB] hover:bg-white" title="Edit fields"><Pencil className="w-3.5 h-3.5" /></button>}
        </span>
      </div>

      {/* Accept / Reject — the reviewer's decision for this imported endpoint */}
      <div className="flex items-center gap-2 mt-2">
        {rejected ? (
          <>
            <span className="text-[11px] text-gray-500">Excluded from this automation run.</span>
            <button type="button" onClick={onReset} title="Move back to review"
              className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold border bg-white text-gray-600 border-gray-300 hover:bg-gray-50 transition-colors">
              <RotateCcw className="w-3.5 h-3.5" />Restore
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => onToggleAccept(!accepted)}
              title={accepted ? 'Accepted — click to move back to review' : !item.ready ? 'Accept this endpoint for automation (missing fields stay flagged as warnings)' : 'Accept this endpoint for automation'}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-colors ${
                accepted
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'
              }`}>
              <Check className="w-3.5 h-3.5" />{accepted ? 'Accepted' : 'Accept'}
            </button>
            <button type="button" onClick={onReject} title="Reject this endpoint — it won't go to automation"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold border bg-white text-red-600 border-red-300 hover:bg-red-50 transition-colors">
              <Trash2 className="w-3.5 h-3.5" />Reject
            </button>
            {accepted && <span className="text-[11px] text-emerald-700 font-medium">Will go to the next step for automation.</span>}
            {!accepted && !item.ready && <span className="text-[11px] text-amber-600 font-medium">{item.errorCount} field{item.errorCount === 1 ? '' : 's'} missing — you can still accept.</span>}
          </>
        )}
      </div>

      {/* Field checklist */}
      <ul className="mt-2 grid sm:grid-cols-2 gap-x-4 gap-y-1">
        {item.fields.map((f) => <FieldRow key={f.key} f={f} />)}
      </ul>

      {/* Inline edit — fix the captured data without leaving the review */}
      {!rejected && editing && (
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
  // further automation steps; Reject keeps it out. Both are kept visible, grouped
  // below. Only the accepted endpoints go forward.
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});

  const accept = (id: string, on: boolean) => setDecisions((prev) => {
    const next = { ...prev };
    if (on) next[id] = 'accepted'; else delete next[id];
    return next;
  });
  const reject = (id: string) => setDecisions((prev) => ({ ...prev, [id]: 'rejected' }));
  const resetDecision = (id: string) => setDecisions((prev) => { const n = { ...prev }; delete n[id]; return n; });

  const pendingItems = report.items.filter((i) => !decisions[i.endpointId]);
  const acceptedItems = report.items.filter((i) => decisions[i.endpointId] === 'accepted');
  const rejectedItems = report.items.filter((i) => decisions[i.endpointId] === 'rejected');
  // Only the accepted endpoints go forward to planning.
  const acceptedEps = eps.filter((e) => decisions[e.id] === 'accepted');

  // Accept-all — tick every not-yet-rejected endpoint through to further steps at
  // once (and untick clears the accepted ones back to review).
  const acceptableIds = report.items.filter((i) => decisions[i.endpointId] !== 'rejected').map((i) => i.endpointId);
  const allAccepted = acceptableIds.length > 0 && acceptableIds.every((id) => decisions[id] === 'accepted');
  const toggleAcceptAll = (on: boolean) => setDecisions((prev) => {
    const next = { ...prev };
    for (const id of acceptableIds) { if (on) next[id] = 'accepted'; else if (next[id] === 'accepted') delete next[id]; }
    return next;
  });

  const canPlan = pendingItems.length === 0 && acceptedEps.length > 0;

  const renderCard = (item: EndpointReadiness) => {
    const ep = eps.find((e) => e.id === item.endpointId)!;
    return (
      <EndpointCard key={item.endpointId} item={item} ep={ep}
        decision={decisions[item.endpointId]}
        onToggleAccept={(on) => accept(item.endpointId, on)}
        onReject={() => reject(item.endpointId)}
        onReset={() => resetDecision(item.endpointId)}
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
              Accept each endpoint to send it to the further automation steps, or Reject it to keep it out. Fix missing data inline first if you like — an endpoint can be accepted with warnings. Only accepted endpoints go forward; planning starts once every endpoint has a decision.
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>

        {/* Summary */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-gray-100 bg-[#FBFAFE] flex-wrap">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-bold">{acceptedItems.length} accepted</span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 text-[11px] font-bold">{rejectedItems.length} rejected</span>
          {pendingItems.length > 0 && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-[#6D28D9] border border-[#DDD6FE] text-[11px] font-bold">{pendingItems.length} to review</span>}
          <span className="text-[11px] text-gray-500">of {report.total} endpoint{report.total === 1 ? '' : 's'}</span>
          {acceptableIds.length > 0 && (
            <label className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-gray-600 cursor-pointer select-none" title="Accept every not-yet-rejected endpoint">
              <input type="checkbox" checked={allAccepted} onChange={(e) => toggleAcceptAll(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer" />
              Accept all ({acceptableIds.length})
            </label>
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
              {rejectedItems.length > 0 && (
                <section className="space-y-2.5">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-gray-400 flex items-center gap-1"><X className="w-3.5 h-3.5" />Rejected · {rejectedItems.length}</h4>
                  {rejectedItems.map(renderCard)}
                </section>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3.5 border-t border-gray-100">
          <p className="text-[11.5px] text-gray-500">
            {pendingItems.length > 0
              ? `${pendingItems.length} endpoint${pendingItems.length === 1 ? '' : 's'} awaiting your accept/reject decision.`
              : acceptedEps.length === 0
                ? 'No endpoints accepted — accept at least one to start planning.'
                : `${acceptedEps.length} endpoint${acceptedEps.length === 1 ? '' : 's'} accepted for automation.`}
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

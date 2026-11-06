/**
 * ImportView — the intake hub.
 *
 * Top: a bulk drop zone that takes any document (OpenAPI, Postman, HAR, Bruno,
 * WSDL/XML, PDF, Word, Excel, Markdown, source files) and sorts out the parser
 * per file. Below: the twelve named methods, each with the form it needs.
 * Every path ends in the same place — endpoints in the catalogue, profiled.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { UploadCloud, CheckCircle2, AlertTriangle, ArrowRight, FileText, X, Plus, Trash2, Layers, Plug, KeyRound, ExternalLink, Paperclip, FileSpreadsheet, RotateCw, Link2, CheckSquare, Square, ShieldCheck } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  importApiFiles, importApiText, importApiUrl, importApiEndpoint, importApiCurl, importApiGraphql, importApiMcp,
  importApiConnector, importApiWebhook, importApiSource, importApiJira, importApiAzure, type ApiImportResponse,
  connectJira, getJiraStatus, getJiraStories, connectAzureDevops, getAzureDevopsStatus, getAzureDevopsStories,
  getAzureDevopsAttachments, getJiraAttachments, getImportAttachmentCounts, type AttachmentCount,
  type PostmanPlanResponse,
} from '@/services/api';

/** Provider-agnostic attachment shape — ADO adds `linked`/`workItemId`; Jira doesn't. */
type AnyAttachment = { id: string; name: string; sizeBytes?: number; linked?: boolean; workItemId?: string; createdDate?: string };
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/feedback/ToastProvider';
import { IMPORT_METHODS, BULK_ACCEPT, type ImportMethodDef, type ImportInput } from '../importMethods';
import { PRIMARY_BTN, SECONDARY_BTN, INPUT, FIELD, LABEL, CARD, CARD_HOVER, CHIP_3D, TILE, TILE_ACTIVE, THEAD } from '../format';
import { KeyValueRows } from '../EndpointEditor';
import EndpointEditor from '../EndpointEditor';
import PostmanImportWizard from '../PostmanImportWizard';
import type { Catalog } from '../hooks/useCatalog';
import { buildReadinessReview } from '../apiValidation';
import type { AuthType, HeaderPair, ImportMethod, LogLine, ApiEnvironment } from '../types';

interface Props {
  catalog: Catalog;
  onOpenCatalogue: () => void;
  log: (stage: LogLine['stage'], text: string, level?: LogLine['level']) => void;
  /** Active environment — used to resolve {{vars}}/base URL when validating the import. */
  environment?: ApiEnvironment | null;
  /** Refresh the app's environment list after an import maps variables into one. */
  onEnvironmentsChanged?: () => void;
  /** Opens the Story generator — offered after a requirement-driven import (Jira/Azure/BRD/FRD). */
  onOpenStory?: () => void;
  /** Opens the strict readiness review. With ids, reviews exactly those endpoints
   *  (the ones just imported); without, reviews the current selection. */
  onReview?: (ids?: string[]) => void;
}

interface Outcome { method: ImportMethod; name: string; res: ApiImportResponse; added: number; duplicates: number }

/** What the drop zone takes, named the way a tester thinks of them. */
const ACCEPTED = ['OpenAPI', 'Swagger', 'Postman', 'HAR', 'Bruno', 'WSDL / XML', 'PDF', 'Word', 'Excel', 'Markdown', 'Source code'];

/** A brand-ish hue per accepted format, so the chips read in colour. */
const FORMAT_COLOR: Record<string, string> = {
  OpenAPI: '#10B981', Swagger: '#65A30D', Postman: '#F97316', HAR: '#0EA5E9', Bruno: '#EA580C',
  'WSDL / XML': '#6366F1', PDF: '#EF4444', Word: '#2563EB', Excel: '#16A34A', Markdown: '#64748B', 'Source code': '#8B5CF6',
};

export default function ImportView({ catalog, onOpenCatalogue, log, environment, onEnvironmentsChanged, onOpenStory, onReview }: Props) {
  const toast = useToast();
  const [active, setActive] = useState<ImportMethodDef | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  /** The opened method form — scrolled into view when a card is picked. */
  const formRef = useRef<HTMLDivElement>(null);
  /** A sentinel at the very top — scrolled into view once an import finishes so
   *  the result panel is on screen (scrollIntoView finds the real scroll parent,
   *  which a direct scrollTo on the container does not inside the dialog). */
  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || active.id === 'manual') return;
    // Let the form mount and lay out before scrolling, so the target offset is final.
    const id = window.setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    return () => window.clearTimeout(id);
  }, [active]);
  // After any import produces an outcome (Jira/Azure/file/…), bring the user back
  // to the top so the result panel is in view instead of leaving them parked on
  // the form they just submitted.
  useEffect(() => {
    if (!outcome) return;
    const id = window.setTimeout(() => topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    return () => window.clearTimeout(id);
  }, [outcome]);

  /** Every import funnels through here so the catalogue, log and result panel agree. */
  const finish = useCallback((method: ImportMethod, name: string, res: ApiImportResponse) => {
    const { added, duplicates, addedIds } = catalog.addEndpoints(res.endpoints || [], {
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
      // Strict readiness applies to EVERY import: if anything the import produced
      // is not automation-ready (missing purpose/inputs/responses/business rules/
      // schema), open the review so it's validated — and fixed or removed — now.
      const rr = buildReadinessReview(res.endpoints || []);
      if (added > 0 && !rr.allReady && onReview) onReview(addedIds);
    }
  }, [catalog, log, toast, onReview]);

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
      <div className="max-w-[1180px] mx-auto px-6 py-5 space-y-4">
        <div ref={topRef} aria-hidden className="scroll-mt-2" />
        {/* Header — a colourful gradient banner */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#5B21B6] via-[#7C3AED] to-[#4338CA] px-5 py-4 shadow-[0_18px_44px_-22px_rgba(76,29,149,0.75)]">
          <div className="pointer-events-none absolute -top-14 -right-6 w-52 h-52 rounded-full bg-[#E879F9]/25 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-16 -left-8 w-52 h-52 rounded-full bg-[#22D3EE]/20 blur-3xl" />
          <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '20px 20px' }} />
          <div className="relative flex items-center gap-3.5">
            <span className="w-11 h-11 rounded-xl bg-white/15 border border-white/25 flex items-center justify-center flex-shrink-0 backdrop-blur-sm"><UploadCloud className="w-5 h-5 text-white" /></span>
            <div className="min-w-0">
              <h2 className="text-[17px] font-bold text-white leading-tight tracking-tight">Import an API</h2>
              <p className="text-[12px] text-white/75 mt-0.5">Drop any document or pick a method — every path ends in endpoints in the catalogue.</p>
            </div>
          </div>
        </div>

        {/* Bulk zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`relative overflow-hidden rounded-2xl border-2 border-dashed px-6 py-6 text-center transition-all ${dragging ? 'border-[#A5B4FC] bg-[#F5F3FF] scale-[1.01]' : 'border-[#DDD6FE] bg-gradient-to-b from-white to-[#FAF8FF] hover:border-[#C7BAF5]'}`}
        >
          <div className={`mx-auto w-11 h-11 rounded-xl flex items-center justify-center ${TILE_ACTIVE}`}>
            {busy === 'bulk' ? <Spinner className="w-5 h-5 text-white animate-spin" /> : <UploadCloud className="w-5 h-5 text-white" />}
          </div>
          <h3 className="mt-3 text-[13px] font-semibold text-gray-900">Bulk upload — any API document</h3>
          <div className="mt-3 flex items-center justify-center gap-2">
            <button type="button" onClick={() => fileRef.current?.click()} disabled={!!busy} className={PRIMARY_BTN}>
              <UploadCloud className="w-3.5 h-3.5" />Choose files
            </button>
            <span className="text-[11px] text-gray-400">or drag them here</span>
          </div>
          <input ref={fileRef} type="file" multiple accept={BULK_ACCEPT} className="hidden" onChange={(e) => { bulk(Array.from(e.target.files || [])); e.target.value = ''; }} />
          {/* What's accepted, as scannable chips rather than a paragraph. */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
            {ACCEPTED.map((f) => {
              const c = FORMAT_COLOR[f] || '#7C3AED';
              return (
                <span key={f} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10.5px] font-semibold ${CHIP_3D}`} style={{ color: c, backgroundColor: `${c}14`, borderColor: `${c}33` }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: c }} />{f}
                </span>
              );
            })}
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
        {outcome && <OutcomePanel outcome={outcome} onOpenCatalogue={onOpenCatalogue} onOpenStory={onOpenStory} onReview={onReview} onDismiss={() => setOutcome(null)} />}

        {/* Method grid */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Layers className="w-4 h-4 text-[#7C3AED]" />
            <h3 className="text-[12.5px] font-semibold text-gray-900">Import by method</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
            {IMPORT_METHODS.map((m) => {
              const Icon = m.icon;
              const isActive = active?.id === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { if (m.id === 'manual') { setManualOpen(true); return; } setActive(isActive ? null : m); setError(''); }}
                  className={`${CARD_HOVER} text-left p-4 group ${isActive ? 'border-[#A5B4FC] ring-2 ring-[#EDE9FE]' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-8 h-8 rounded-lg flex items-center justify-center border transition-all group-hover:scale-105"
                      style={isActive
                        ? { backgroundColor: m.accent, borderColor: m.accent }
                        : { backgroundColor: `${m.accent}1A`, borderColor: `${m.accent}40` }}
                    >
                      <Icon className="w-4 h-4" style={{ color: isActive ? '#fff' : m.accent }} />
                    </span>
                    <span className="text-[13px] font-semibold text-gray-900 leading-tight">{m.label}</span>
                  </div>
                  <p className="mt-2 text-[12px] text-gray-500 leading-snug">{m.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Active method form */}
        {active && active.id === 'postman' && (
          <div ref={formRef} className="scroll-mt-2">
            <PostmanImportWizard
              environment={environment}
              onImported={(name, res: PostmanPlanResponse) => finish('postman', name, res)}
              onEnvironmentsChanged={onEnvironmentsChanged}
              onClose={() => setActive(null)}
            />
          </div>
        )}
        {active && active.id !== 'manual' && active.id !== 'postman' && (
          <div ref={formRef} className="scroll-mt-2">
            <MethodForm
              key={active.id}
              def={active}
              busy={busy === active.id}
              onClose={() => setActive(null)}
              onRun={(name, fn) => run(active.id, active.id, name, fn)}
            />
          </div>
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

function OutcomePanel({ outcome, onOpenCatalogue, onOpenStory, onReview, onDismiss }: { outcome: Outcome; onOpenCatalogue: () => void; onOpenStory?: () => void; onReview?: (ids?: string[]) => void; onDismiss: () => void }) {
  const { res, added, duplicates, method } = outcome;
  const none = (res.endpoints || []).length === 0;
  // Requirement-driven sources can also feed the Story generator for a brief.
  const fromRequirements = method === 'jira' || method === 'ado' || method === 'brd' || method === 'frd';
  // Strict readiness check over what the document produced — the SAME gate that
  // guards planning, applied to every import, so missing purpose/inputs/responses/
  // business rules/schema are surfaced here (and in the review) before anything runs.
  const readiness = useMemo(() => buildReadinessReview(res.endpoints || []), [res.endpoints]);
  const missing = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of readiness.items) for (const f of it.fields) if (!f.ok && f.level === 'error') m[f.label] = (m[f.label] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [readiness]);
  return (
    <div className={`${CARD} p-4`}>
      <div className="flex items-start gap-3">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${none ? 'bg-amber-50 border border-amber-200' : 'bg-emerald-50 border border-emerald-200'}`}>
          {none ? <AlertTriangle className="w-4 h-4 text-amber-600" /> : <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-gray-900">
            {none ? 'No endpoints found' : `${added} endpoint${added === 1 ? '' : 's'} added to the catalogue`}
            {duplicates > 0 && <span className="font-normal text-gray-500"> · {duplicates} already present</span>}
          </p>
          {res.notice && <p className="mt-2 text-[11.5px] text-[#4C1D95] bg-[#F5F3FF] border border-[#DDD6FE] rounded-md px-2.5 py-1.5">{res.notice}</p>}
          {!none && (
            <div className={`mt-2 rounded-lg border px-3 py-2.5 ${readiness.allReady ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
              <div className="flex items-center gap-2">
                {readiness.allReady
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                  : <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />}
                <p className="text-[12px] font-semibold text-gray-800">
                  {readiness.allReady
                    ? `Strict readiness ✓ — all ${readiness.total} endpoint${readiness.total === 1 ? '' : 's'} capture purpose, inputs, responses, business rules & a valid schema.`
                    : `Strict readiness — ${readiness.ready}/${readiness.total} ready · ${readiness.notReady} need detail${readiness.notReady === 1 ? '' : 's'} before automation.`}
                </p>
              </div>
              {!readiness.allReady && (
                <>
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {missing.map(([label, n]) => (
                      <li key={label} className="px-2 py-0.5 rounded-md text-[10.5px] font-medium text-red-700 bg-red-50 border border-red-200">{n} missing {label}</li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-[11px] text-gray-500">The readiness review opened so you can capture the details, or reject endpoints you don't need.</p>
                </>
              )}
            </div>
          )}
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
            <div className="mt-3 border border-gray-100 rounded-md overflow-hidden">
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
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {fromRequirements && onOpenStory && <button type="button" onClick={onOpenStory} className={SECONDARY_BTN} title="Open the Story generator to turn these requirements into a test-plan brief">Requirements brief<ArrowRight className="w-3.5 h-3.5" /></button>}
          {!none && onReview && <button type="button" onClick={() => onReview()} className={readiness.allReady ? SECONDARY_BTN : PRIMARY_BTN} title="Strictly validate every endpoint (purpose, inputs, responses, business rules, schema) before planning"><ShieldCheck className="w-3.5 h-3.5" />{readiness.allReady ? 'Validate & review' : 'Fix & review'}</button>}
          {!none && <button type="button" onClick={onOpenCatalogue} className={readiness.allReady ? PRIMARY_BTN : SECONDARY_BTN}>Review catalogue<ArrowRight className="w-3.5 h-3.5" /></button>}
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
          <div className="ml-3 flex gap-0.5 bg-gray-50 border border-gray-200 rounded-md p-0.5">
            {tabs.map((t) => (
              <button key={t.id} type="button" onClick={() => setInput(t.id)} className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${input === t.id ? 'bg-white text-[#6D28D9] shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>{t.label}</button>
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
      {(input === 'jira' || input === 'ado') && <IssueForm kind={input} busy={busy} onRun={onRun} />}
    </div>
  );
}

/** Jira / Azure DevOps — pull one issue/work item by key and read it for endpoints.
    Reuses the tenant's existing connection; a missing connection surfaces as a
    clear error from the backend on import. */
function IssueForm({ kind, busy, onRun }: { kind: 'jira' | 'ado'; busy: boolean; onRun: RunFn }) {
  const isJira = kind === 'jira';
  const { user } = useAuth();
  const username = user?.username || '';

  const [ref, setRef] = useState('');
  // Connection state, so this screen can connect inline instead of sending the
  // user off to System Configuration. 'unknown' until the first status check.
  const [conn, setConn] = useState<{ connected: boolean; label?: string } | 'unknown'>('unknown');
  const [showConnect, setShowConnect] = useState(false);
  // The issue/work-item list, so the user can pick instead of typing a key blind.
  const [issues, setIssues] = useState<{ key: string; summary: string; state?: string }[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');

  // Attachments on the selected Jira issue / ADO work item (read live, metadata
  // only). `attachFor` records which item the current list belongs to, so a stale
  // list never shows against a newly-picked item. `hidden` are files the user
  // chose to hide from this view — a local-only exclude, no change in the tracker.
  const [attachments, setAttachments] = useState<AnyAttachment[] | null>(null);
  const [attachFor, setAttachFor] = useState('');
  const [attachLoading, setAttachLoading] = useState(false);
  const [attachError, setAttachError] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Per-attachment test-case / endpoint counts (lazy; deterministic server count)
  // and the set of files the user has ticked to import. Both are keyed by the
  // tracker's attachment id; a new selection re-reads counts and ticks everything.
  const [counts, setCounts] = useState<Record<string, AttachmentCount>>({});
  const [countsLoading, setCountsLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const attachReq = useRef(0);

  const loadIssues = useCallback(async () => {
    setListLoading(true); setListError('');
    try {
      const rows = isJira ? await getJiraStories(username) : await getAzureDevopsStories();
      setIssues(Array.isArray(rows) ? rows : []);
    } catch (err: any) {
      setIssues([]);
      setListError(err?.response?.data?.error || err?.message || 'Could not load the issue list — you can still type a key below.');
    } finally { setListLoading(false); }
  }, [isJira, username]);

  const checkStatus = useCallback(async () => {
    try {
      let connected = false; let label: string | undefined;
      if (isJira) {
        const s = await getJiraStatus(username);
        connected = !!s?.connected; label = s?.displayName || s?.jiraUrl;
      } else {
        const s = await getAzureDevopsStatus();
        connected = !!s?.connected; label = s?.project || s?.orgUrl;
      }
      setConn({ connected, label });
      if (connected) void loadIssues(); else setIssues(null);
    } catch { setConn({ connected: false }); setIssues(null); }
  }, [isJira, username, loadIssues]);

  useEffect(() => { void checkStatus(); }, [checkStatus]);

  const loadAttachments = useCallback(async (id: string) => {
    const wid = id.trim();
    const reqId = ++attachReq.current; // guard against a stale response from a previously-selected item
    if (!wid) { setAttachments(null); setAttachError(''); setAttachFor(''); setCounts({}); setSelected(new Set()); setCountsLoading(false); return; }
    setAttachLoading(true); setAttachError(''); setAttachFor(wid); setCounts({}); setCountsLoading(false);
    try {
      const rows = isJira ? await getJiraAttachments(wid) : await getAzureDevopsAttachments(wid);
      const list: AnyAttachment[] = Array.isArray(rows) ? rows : [];
      if (reqId !== attachReq.current) return;
      setAttachments(list);
      // Default: every file ticked, so "Import" brings in all of them unless the
      // user unticks some. Then fetch each file's test-case count in the
      // background (non-blocking — the list is usable before counts land).
      setSelected(new Set(list.map((a) => a.id)));
      if (list.length) {
        setCountsLoading(true);
        getImportAttachmentCounts(isJira ? 'jira' : 'ado', wid)
          .then((cs) => {
            if (reqId !== attachReq.current) return;
            const map: Record<string, AttachmentCount> = {};
            for (const c of cs) map[c.id] = c;
            setCounts(map);
          })
          .catch(() => { /* counts are a nicety — a failure just hides the badges */ })
          .finally(() => { if (reqId === attachReq.current) setCountsLoading(false); });
      }
    } catch (err: any) {
      if (reqId !== attachReq.current) return;
      setAttachments([]); setSelected(new Set());
      setAttachError(err?.response?.data?.error || err?.message || `Could not load attachments for this ${isJira ? 'issue' : 'work item'}.`);
    } finally { if (reqId === attachReq.current) setAttachLoading(false); }
  }, [isJira]);

  // Whenever an issue/work item is chosen or typed, read its files live
  // (debounced so typing an id doesn't fire a request per keystroke). A new
  // selection clears any locally-hidden files.
  useEffect(() => {
    if (conn === 'unknown' || !conn.connected) { setAttachments(null); setAttachFor(''); setAttachError(''); return; }
    const wid = ref.trim();
    if (!wid) { setAttachments(null); setAttachFor(''); setAttachError(''); return; }
    setHidden(new Set());
    const t = setTimeout(() => { void loadAttachments(wid); }, 350);
    return () => clearTimeout(t);
  }, [ref, conn, loadAttachments]);

  const hideAttachment = (id: string) => {
    setHidden((prev) => { const next = new Set(prev); next.add(id); return next; });
    setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; }); // a hidden file can't be imported
  };
  const toggleSelected = (id: string) => setSelected((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const setAllSelected = (on: boolean) => setSelected(() => {
    if (!on) return new Set();
    return new Set((attachments || []).filter((a) => !hidden.has(a.id)).map((a) => a.id));
  });

  // The files the user has ticked (and not hidden) — what Import will pull in.
  const selectedIds = useMemo(
    () => (attachments || []).filter((a) => !hidden.has(a.id) && selected.has(a.id)).map((a) => a.id),
    [attachments, hidden, selected],
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = ref.trim();
    if (!v) return;
    // Pass the ticked attachment ids; an empty array tells the backend to read
    // the issue's description/prose instead (back-compat when there are no files).
    const ok = await onRun(v, () => (isJira ? importApiJira(v, selectedIds) : importApiAzure(v, selectedIds)));
    if (ok) setRef('');
  };

  const needsConnect = conn !== 'unknown' && !conn.connected;
  const showConnectPanel = needsConnect || showConnect;

  return (
    <div className="space-y-3">
      {/* Connection banner — connected state, or the reason to connect here */}
      {conn === 'unknown' ? (
        <div className="flex items-center gap-2 text-[11px] text-gray-400 px-3 py-2"><Spinner className="w-3.5 h-3.5 animate-spin" /> Checking {isJira ? 'Jira' : 'Azure DevOps'} connection…</div>
      ) : conn.connected ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-[11.5px] text-emerald-800">
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 text-emerald-600" />
          <span className="truncate">Connected{conn.label ? ` · ${conn.label}` : ''}</span>
          <button type="button" onClick={() => setShowConnect((v) => !v)} className="ml-auto text-[11px] font-medium text-emerald-700 hover:text-emerald-900 underline">{showConnect ? 'Hide' : 'Change'}</button>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11.5px] text-amber-800">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 text-amber-600" />
          <span>Not connected — enter your {isJira ? 'Jira site, email and API token' : 'Azure DevOps org, project and PAT'} below to connect.</span>
        </div>
      )}

      {/* Inline connect (with API token) — reuses the existing /jira/connect and
          /azure-devops/connect endpoints; the token is encrypted in transit and
          stored encrypted at rest, tenant-scoped. */}
      {showConnectPanel && (
        <ConnectPanel kind={kind} username={username} onConnected={() => { setShowConnect(false); void checkStatus(); }} />
      )}

      {/* Issue import — only once connected */}
      {conn !== 'unknown' && conn.connected && (
        <form onSubmit={submit} className="space-y-3">
          {/* Picker — list the connected tracker's issues so a key can be chosen,
              not typed blind. Selecting one fills the key field below. */}
          <div>
            <label className={`${LABEL} flex items-center gap-1.5`}>
              {isJira ? 'Choose a Jira issue' : 'Choose an Azure DevOps work item'}
              {listLoading && <Spinner className="w-3 h-3 animate-spin text-gray-400" />}
              <button type="button" onClick={() => void loadIssues()} disabled={listLoading} className="ml-auto text-[10.5px] font-medium text-[#7C3AED] hover:text-[#5B21B6] disabled:opacity-50">Refresh</button>
            </label>
            <select
              value={issues?.some((i) => i.key === ref) ? ref : ''}
              onChange={(e) => setRef(e.target.value)}
              disabled={listLoading || !issues}
              className={INPUT}
            >
              <option value="">{listLoading ? 'Loading…' : issues && issues.length === 0 ? '— no items found —' : '— choose an item —'}</option>
              {(issues || []).map((i) => (
                <option key={i.key} value={i.key}>{i.key} — {i.summary}{i.state ? ` (${i.state})` : ''}</option>
              ))}
            </select>
            {listError && <p className="text-[10.5px] text-amber-600 mt-1 leading-snug">{listError}</p>}
          </div>

          <div>
            <label className={LABEL}>or type the {isJira ? 'issue key' : 'work item id'}</label>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={isJira ? 'PROJ-123' : '12345'} className={INPUT} spellCheck={false} />
            <p className="text-[10.5px] text-gray-400 mt-2 leading-relaxed">
              The issue's description and acceptance criteria are read by AI for the API endpoints they describe. The issue itself is not stored here.
            </p>
          </div>

          {/* Attachments on the selected issue / work item — read live (metadata
              only). Delete hides a file from THIS view only; nothing changes in
              Jira or Azure DevOps. */}
          {ref.trim() && (
            <IssueAttachments
              provider={isJira ? 'JIRA' : 'Azure DevOps'}
              itemId={ref.trim()}
              loadedFor={attachFor}
              attachments={attachments}
              loading={attachLoading}
              error={attachError}
              hidden={hidden}
              counts={counts}
              countsLoading={countsLoading}
              selected={selected}
              onToggle={toggleSelected}
              onSelectAll={setAllSelected}
              onRefresh={() => void loadAttachments(ref.trim())}
              onHide={hideAttachment}
              onShowAll={() => setHidden(new Set())}
            />
          )}

          <div className="flex justify-end">
            <SubmitBtn
              busy={busy}
              label={selectedIds.length > 0 ? `Import ${selectedIds.length} selected` : 'Import'}
              disabled={!ref.trim()}
            />
          </div>
        </form>
      )}
    </div>
  );
}

function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const isSheet = ['xlsx', 'xls', 'xlsm', 'csv', 'tsv'].includes(ext);
  const Icon = isSheet ? FileSpreadsheet : FileText;
  return <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${isSheet ? 'text-emerald-600' : 'text-gray-400'}`} />;
}

/**
 * Live list of the files attached to the selected Jira issue / ADO work item
 * (metadata only — nothing is downloaded until import). Shows a spinner while
 * reading, an empty state when the item has no files, and a per-file Delete that
 * hides the file from THIS view only — it never touches the tracker.
 */
/** Small chip showing how many test cases / endpoints a file holds. */
function CountBadge({ info, loading }: { info?: AttachmentCount; loading: boolean }) {
  if (info && info.count != null) {
    return (
      <span className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#F5F3FF] border border-[#DDD6FE] text-[9.5px] font-semibold text-[#6D28D9] tabular-nums" title={`${info.count} ${info.kind || 'items'} in this file`}>
        {info.count} {info.kind || 'items'}
      </span>
    );
  }
  if (loading) return <Spinner className="w-3 h-3 animate-spin text-gray-300 flex-shrink-0" />;
  return null; // a file we can't count cheaply simply shows no badge
}

function IssueAttachments({ provider, itemId, loadedFor, attachments, loading, error, hidden, counts, countsLoading, selected, onToggle, onSelectAll, onRefresh, onHide, onShowAll }: {
  provider: 'JIRA' | 'Azure DevOps';
  itemId: string;
  loadedFor: string;
  attachments: AnyAttachment[] | null;
  loading: boolean;
  error: string;
  hidden: Set<string>;
  counts: Record<string, AttachmentCount>;
  countsLoading: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: (on: boolean) => void;
  onRefresh: () => void;
  onHide: (id: string) => void;
  onShowAll: () => void;
}) {
  const noun = provider === 'JIRA' ? 'issue' : 'work item';
  // The loaded list belongs to a different item than the one now shown — treat
  // as still-loading so a stale list never flashes against a new selection.
  const stale = loadedFor !== itemId;
  const all = attachments || [];
  const visible = all.filter((a) => !hidden.has(a.id));
  const hiddenCount = all.length - visible.length;
  const selectedCount = visible.filter((a) => selected.has(a.id)).length;
  const allSelected = visible.length > 0 && selectedCount === visible.length;
  // Total test cases across the files that are ticked AND countable.
  const selectedCaseTotal = visible.reduce((n, a) => (selected.has(a.id) && counts[a.id]?.count != null ? n + (counts[a.id]!.count as number) : n), 0);

  return (
    <div>
      <label className={`${LABEL} flex items-center gap-1.5`}>
        <Paperclip className="w-3 h-3" /> Attachments
        {!loading && !stale && attachments && <span className="text-gray-400 font-normal">({visible.length})</span>}
        {(loading || stale) && <Spinner className="w-3 h-3 animate-spin text-gray-400" />}
        <button type="button" onClick={onRefresh} disabled={loading} className="ml-auto inline-flex items-center gap-1 text-[10.5px] font-medium text-[#7C3AED] hover:text-[#5B21B6] disabled:opacity-50">
          <RotateCw className="w-3 h-3" /> Refresh
        </button>
      </label>

      {error ? (
        <p className="text-[10.5px] text-amber-600 leading-snug">{error}</p>
      ) : (loading || stale) ? (
        <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-gray-400"><Spinner className="w-3 h-3 animate-spin" /> Reading files from {provider}…</div>
      ) : visible.length === 0 ? (
        <div className="px-3 py-3 rounded-lg border border-dashed border-gray-200 bg-gray-50 text-[11px] text-gray-400 text-center">
          {all.length > 0
            ? <>All {all.length} file{all.length > 1 ? 's' : ''} hidden · <button type="button" onClick={onShowAll} className="underline hover:text-gray-600">show all</button></>
            : `No attachments on this ${noun}.`}
        </div>
      ) : (
        <>
          {/* Select-all / none bar — only the ticked files get imported. */}
          <div className="flex items-center gap-2 px-1 mb-1.5">
            <button type="button" onClick={() => onSelectAll(!allSelected)} className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold text-gray-600 hover:text-[#7C3AED]">
              {allSelected ? <CheckSquare className="w-3.5 h-3.5 text-[#7C3AED]" /> : <Square className="w-3.5 h-3.5 text-gray-400" />}
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
            <span className="text-[10.5px] text-gray-400">
              {selectedCount} of {visible.length} selected{selectedCaseTotal > 0 && <> · {selectedCaseTotal} test case{selectedCaseTotal === 1 ? '' : 's'}</>}
            </span>
          </div>
          <ul className="space-y-1">
            {visible.map((a) => {
              const isSel = selected.has(a.id);
              return (
                <li key={a.id} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-[11.5px] transition-colors ${isSel ? 'border-[#DDD6FE] bg-[#FBFAFF]' : 'border-gray-200 bg-white'}`}>
                  <button type="button" onClick={() => onToggle(a.id)} title={isSel ? 'Deselect — exclude from import' : 'Select — include in import'} className="flex-shrink-0">
                    {isSel ? <CheckSquare className="w-4 h-4 text-[#7C3AED]" /> : <Square className="w-4 h-4 text-gray-300 hover:text-gray-400" />}
                  </button>
                  <AttachmentIcon name={a.name} />
                  <span className="flex-1 min-w-0 truncate text-gray-700" title={a.name}>{a.name}</span>
                  <CountBadge info={counts[a.id]} loading={countsLoading} />
                  {a.linked && <span className="inline-flex items-center gap-0.5 text-[9.5px] text-gray-400" title={`Attached to linked work item #${a.workItemId}`}><Link2 className="w-2.5 h-2.5" />#{a.workItemId}</span>}
                  {a.sizeBytes != null && <span className="text-[10px] text-gray-400 flex-shrink-0">{formatBytes(a.sizeBytes)}</span>}
                  <button type="button" onClick={() => onHide(a.id)} title={`Hide from this view (does not change ${provider})`} className="flex-shrink-0 text-gray-300 hover:text-rose-500">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-[10px] text-gray-400 mt-1.5 leading-snug">
            Tick the files to import; counts show how many test cases each holds. Delete hides a file from this view only — it stays on the {noun} in {provider}.
            {hiddenCount > 0 && <> {hiddenCount} hidden · <button type="button" onClick={onShowAll} className="underline hover:text-gray-600">show all</button></>}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Inline connect form for a tracker, keyed by provider. Jira takes site URL +
 * email + API token; Azure DevOps takes org URL + project + PAT. On success it
 * calls back so the parent re-checks status and reveals the issue-key field.
 */
function ConnectPanel({ kind, username, onConnected }: { kind: 'jira' | 'ado'; username: string; onConnected: () => void }) {
  const isJira = kind === 'jira';
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [email, setEmail] = useState('');   // Jira only
  const [project, setProject] = useState(''); // Azure only
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const ready = isJira
    ? url.trim() && email.trim() && token.trim()
    : url.trim() && project.trim() && token.trim();

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || saving) return;
    setSaving(true); setError('');
    try {
      if (isJira) await connectJira(username, url.trim(), email.trim(), token.trim());
      else await connectAzureDevops(url.trim(), project.trim(), token.trim());
      toast.success(`${isJira ? 'Jira' : 'Azure DevOps'} connected`);
      setToken('');
      onConnected();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not connect. Check the details and try again.');
    } finally { setSaving(false); }
  };

  const tokenHelp = isJira
    ? { label: 'API token', href: 'https://id.atlassian.com/manage-profile/security/api-tokens', hint: 'Create one at id.atlassian.com → Security → API tokens' }
    : { label: 'Personal access token (PAT)', href: 'https://dev.azure.com', hint: 'Create one in Azure DevOps → User settings → Personal access tokens (Work Items: Read & Write)' };

  return (
    <form onSubmit={connect} className="space-y-2.5 rounded-lg border border-[#DDD6FE] bg-[#FAFAFE] p-3">
      <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#5B21B6]"><Plug className="w-3.5 h-3.5" /> Connect {isJira ? 'Jira' : 'Azure DevOps'} with an API token</div>
      <div>
        <label className={LABEL}>{isJira ? 'Jira site URL' : 'Organization URL'}</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={isJira ? 'https://your-site.atlassian.net' : 'https://dev.azure.com/your-org'} className={INPUT} spellCheck={false} autoComplete="off" />
      </div>
      {isJira ? (
        <div>
          <label className={LABEL}>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className={INPUT} spellCheck={false} autoComplete="off" type="email" />
        </div>
      ) : (
        <div>
          <label className={LABEL}>Project</label>
          <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="MyProject" className={INPUT} spellCheck={false} autoComplete="off" />
        </div>
      )}
      <div>
        <label className={`${LABEL} flex items-center gap-1`}><KeyRound className="w-3 h-3" /> {tokenHelp.label}</label>
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="••••••••••••" className={INPUT} spellCheck={false} autoComplete="off" type="password" />
        <a href={tokenHelp.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10.5px] text-[#7C3AED] hover:text-[#5B21B6] mt-1.5">
          {tokenHelp.hint} <ExternalLink className="w-3 h-3" />
        </a>
      </div>
      {error && <p className="text-[11px] text-red-600 leading-snug">{error}</p>}
      <p className="text-[10.5px] text-gray-400 leading-relaxed">The token is encrypted in transit and stored encrypted, scoped to your tenant. You can manage it later in System Configuration → Integrations.</p>
      <div className="flex justify-end">
        <button type="submit" disabled={!ready || saving} className={PRIMARY_BTN}>
          {saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
          {saving ? 'Connecting…' : 'Connect & test'}
        </button>
      </div>
    </form>
  );
}

type RunFn = (name: string, fn: () => Promise<ApiImportResponse>) => Promise<boolean>;

function SubmitBtn({ busy, label, disabled }: { busy: boolean; label: string; disabled?: boolean }) {
  return (
    <button type="submit" disabled={busy || disabled} className={PRIMARY_BTN}>
      {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
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
      <div onClick={() => ref.current?.click()} className="border border-dashed border-[#DDD6FE] rounded-lg bg-[#FAFAFE] px-4 py-5 text-center cursor-pointer hover:bg-[#F5F3FF] transition-colors">
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

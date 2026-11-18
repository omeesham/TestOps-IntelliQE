/**
 * API Studio — the Scripts tab.
 *
 * The generator renders every designed scenario into a self-contained
 * Playwright `request` spec (deterministically, no model-authored code). This
 * tab surfaces those specs: view the exact code that will run, copy or download
 * it, hand-edit it in place (persisted with the workspace, so edits survive a
 * reload), and regenerate the whole set deterministically from the templated
 * cases — no model call, no tokens.
 *
 * Specs join to scenarios by `testCaseId === scenario.id`. The shared service
 * objects (the API half of the Page Object Model) are listed below the specs.
 */
import { useMemo, useState } from 'react';
import { Code2, Search, Copy, Download, Pencil, Check, X, RefreshCw, FileCode2, Boxes, Lock } from 'lucide-react';
import { CodeBlock, EmptyState, FilterChip, TabHero, MethodBadge } from './primitives';
import { STRIP, RAISED, FIELD, PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { Scenario, Spec, ServiceObject } from './types';

interface Props {
  specs: Spec[];
  serviceObjects: ServiceObject[];
  scenarios: Scenario[];
  /** False until the Automating stage has completed — specs stay hidden before then. */
  visible: boolean;
  /** False once the run has moved past the review gate — edits are then fixed. */
  editable: boolean;
  /** True while a deterministic regenerate is in flight. */
  regenerating: boolean;
  /** False when there are no templated cases to regenerate from, or a run is live. */
  canRegenerate: boolean;
  onUpdateSpec: (testCaseId: string, code: string) => void;
  onRegenerate: () => void;
}

/** Pull a method off a scenario's api metadata, tolerating a few shapes. */
function methodOf(sc: Scenario | undefined): string {
  const api = sc?.api as any;
  return String(api?.request?.method || api?.method || '').toUpperCase();
}

function download(fileName: string, code: string) {
  const href = window.URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = href; link.download = fileName || 'spec.spec.ts';
  document.body.appendChild(link); link.click(); link.remove();
  window.URL.revokeObjectURL(href);
}

export default function ScriptsTab({
  specs, serviceObjects, scenarios, visible, editable, regenerating, canRegenerate, onUpdateSpec, onRegenerate,
}: Props) {
  const byId = useMemo(() => new Map(scenarios.map((s) => [s.id, s])), [scenarios]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return specs;
    return specs.filter((s) => {
      const sc = byId.get(s.testCaseId);
      return (s.fileName || '').toLowerCase().includes(q)
        || (s.path || '').toLowerCase().includes(q)
        || (sc?.title || '').toLowerCase().includes(q)
        || (s.code || '').toLowerCase().includes(q);
    });
  }, [specs, search, byId]);

  // The selected spec, defaulting to the first one in view.
  const active = filtered.find((s) => s.testCaseId === selectedId) || filtered[0] || null;

  const startEdit = () => { if (!active) return; setDraft(active.code || ''); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setDraft(''); };
  const saveEdit = () => {
    if (active) onUpdateSpec(active.testCaseId, draft);
    setEditing(false);
  };
  const copy = async () => {
    if (!active) return;
    try { await navigator.clipboard.writeText(active.code || ''); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  // Specs are rendered together with the scenarios, but they belong to the
  // Automating stage — keep them locked until that stage has run, so the review
  // step never reveals scripts before anything is automated.
  if (!visible) {
    return (
      <div className="h-full flex flex-col px-6">
        <TabHero
          icon={Code2}
          title="Scripts"
          subtitle="The Playwright specs rendered from your scenarios appear here — view, edit and export them."
        />
        <EmptyState
          icon={Lock}
          title="Scripts appear after automating"
          hint="Review your scenarios, then run the suite. Once the Automating stage completes, the rendered Playwright specs show up here to view, edit and export."
        />
      </div>
    );
  }

  if (specs.length === 0) {
    return (
      <div className="h-full flex flex-col px-6">
        <TabHero
          icon={Code2}
          title="Scripts"
          subtitle="The Playwright specs rendered from your scenarios appear here — view, edit and export them."
        />
        <EmptyState
          icon={Code2}
          title="No specs generated yet"
          hint="Design scenarios first — each one is rendered into a runnable Playwright request spec that shows up here."
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col px-6 min-h-0">
      <TabHero
        icon={Code2}
        title="Scripts"
        subtitle={`${specs.length} Playwright spec${specs.length === 1 ? '' : 's'}${serviceObjects.length ? ` · ${serviceObjects.length} service object${serviceObjects.length === 1 ? '' : 's'}` : ''}`}
        actions={
          <button
            type="button"
            onClick={onRegenerate}
            disabled={!canRegenerate || regenerating}
            title={canRegenerate ? 'Re-render every spec deterministically from the designed cases — no model call' : 'Design a run first'}
            className={`${SECONDARY_BTN} !bg-white/15 !border-white/30 !text-white disabled:opacity-50`}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{regenerating ? 'Regenerating…' : 'Regenerate specs'}</span>
          </button>
        }
      />

      <div className="flex-1 min-h-0 mt-4 grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        {/* ── Spec list ── */}
        <div className={`${RAISED} flex flex-col min-h-0`}>
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search specs…"
                className={`${FIELD} pl-8`}
              />
            </div>
          </div>
          <ul className="flex-1 overflow-auto p-1.5 space-y-1">
            {filtered.map((s) => {
              const sc = byId.get(s.testCaseId);
              const method = methodOf(sc);
              const isActive = active?.testCaseId === s.testCaseId;
              return (
                <li key={s.testCaseId}>
                  <button
                    type="button"
                    onClick={() => { setSelectedId(s.testCaseId); cancelEdit(); }}
                    className={`w-full text-left px-2.5 py-2 rounded-lg border transition ${isActive ? 'bg-[#F5F3FF] border-[#DDD6FE]' : 'bg-white border-transparent hover:border-gray-200'}`}
                  >
                    <div className="flex items-center gap-1.5">
                      {method && <MethodBadge method={method} />}
                      <span className="text-xs font-medium text-gray-800 truncate">{sc?.title || s.testCaseId}</span>
                    </div>
                    <div className="mt-0.5 font-mono text-[10.5px] text-gray-400 truncate">{s.path || s.fileName}</div>
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-gray-400">No specs match “{search}”.</li>
            )}
          </ul>
        </div>

        {/* ── Spec detail ── */}
        <div className={`${RAISED} flex flex-col min-h-0`}>
          {active ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
                <FileCode2 className="w-4 h-4 text-[#7C3AED] flex-shrink-0" />
                <span className="font-mono text-[11.5px] text-gray-700 truncate">{active.path || active.fileName}</span>
                <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                  {editing ? (
                    <>
                      <button type="button" onClick={saveEdit} className={PRIMARY_BTN}><Check className="w-3.5 h-3.5" />Save</button>
                      <button type="button" onClick={cancelEdit} className={SECONDARY_BTN}><X className="w-3.5 h-3.5" />Cancel</button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={copy} className={SECONDARY_BTN} title="Copy the spec to the clipboard">{copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}<span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span></button>
                      <button type="button" onClick={() => download(active.fileName, active.code)} className={SECONDARY_BTN} title="Download the spec file"><Download className="w-3.5 h-3.5" /><span className="hidden sm:inline">Download</span></button>
                      {editable && <button type="button" onClick={startEdit} className={SECONDARY_BTN} title="Edit the spec in place"><Pencil className="w-3.5 h-3.5" /><span className="hidden sm:inline">Edit</span></button>}
                    </>
                  )}
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-auto">
                {editing ? (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    className="w-full h-full min-h-[300px] p-3 font-mono text-[11.5px] leading-[1.6] text-gray-800 outline-none resize-none"
                  />
                ) : (
                  <CodeBlock code={active.code || '// (empty spec)'} className="p-3" />
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Select a spec to view its code.</div>
          )}
        </div>
      </div>

      {/* ── Service objects (shared across specs) ── */}
      {serviceObjects.length > 0 && (
        <details className={`${STRIP} mt-4`}>
          <summary className="flex items-center gap-2 cursor-pointer select-none py-1">
            <Boxes className="w-4 h-4 text-[#7C3AED]" />
            <span className="text-sm font-medium text-gray-700">Service objects</span>
            <span className="text-xs text-gray-400">({serviceObjects.length})</span>
          </summary>
          <div className="mt-2 space-y-3">
            {serviceObjects.map((o) => (
              <div key={o.path} className={`${RAISED} overflow-hidden`}>
                <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
                  <FileCode2 className="w-4 h-4 text-gray-400" />
                  <span className="font-mono text-[11.5px] text-gray-700 truncate">{o.path}</span>
                  <button type="button" onClick={() => download(o.path.split('/').pop() || 'service.ts', o.code)} className={`${SECONDARY_BTN} ml-auto`} title="Download the service object"><Download className="w-3.5 h-3.5" /></button>
                </div>
                <CodeBlock code={o.code} className="p-3 max-h-80" />
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

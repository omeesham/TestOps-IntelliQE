/**
 * API Studio — the scenarios tab, which is also the run's review gate.
 *
 * The generator designs the coverage; the engineer decides what actually runs.
 * Every scenario is therefore inspectable down to the exact request that will
 * be sent and the exact assertions that will fire, and deselecting one drops it
 * from automation, execution and the report alike.
 */
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, ListChecks, Search, Check, Send, Pencil, Trash2, X } from 'lucide-react';
import {
  MethodBadge, CategoryChip, PriorityChip, StatusCode, CodeBlock, EmptyState, FilterChip, TabHero,
} from './primitives';
import { prettyJson, categoryMeta, STRIP, THEAD, RAISED, FIELD } from './format';
import type { ApiCaseMeta, Scenario } from './types';

/**
 * The suite can run into the thousands of scenarios, so the list is virtualized:
 * only the rows in (and just past) the viewport are mounted. A plain <table>
 * can't be virtualized without losing column alignment once rows are positioned
 * absolutely, so the grid below shares one column template between the header and
 * every row. One row at a time can expand or enter edit mode, so row heights
 * vary — `measureElement` feeds each real height back to the virtualizer.
 */
const GRID_COLS = '32px 56px minmax(0,1fr) 96px 56px 148px 72px 80px 32px';
/** Row height before a row is measured — a collapsed row's natural height. */
const ROW_ESTIMATE = 45;

interface Props {
  scenarios: Scenario[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: (ids: string[]) => void;
  onClearAll: () => void;
  /** Remove a scenario from the suite entirely. */
  onDelete: (id: string) => void;
  /** Edit a scenario's reviewable fields (title, category, priority, status). */
  onUpdate: (id: string, patch: Partial<Pick<Scenario, 'title' | 'type' | 'priority'>> & { api?: Partial<ApiCaseMeta> }) => void;
  /** False once the run has moved past the gate — selection and edits are then fixed. */
  editable: boolean;
}

/** The fields the row-level editor can change. */
interface Draft { title: string; type: string; priority: string; expectedStatus: string }

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

export default function ScenariosTab({ scenarios, selected, onToggle, onSelectAll, onClearAll, onDelete, onUpdate, editable }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ title: '', type: '', priority: 'P2', expectedStatus: '' });

  const startEdit = (s: Scenario) => {
    setExpanded(null);
    setEditingId(s.id);
    setDraft({
      title: s.title,
      type: s.type || '',
      priority: (s.priority || 'P2').toUpperCase(),
      expectedStatus: String(s.api?.expectedStatus ?? ''),
    });
  };
  const cancelEdit = () => setEditingId(null);
  const saveEdit = (s: Scenario) => {
    onUpdate(s.id, {
      title: draft.title.trim() || s.title,
      type: draft.type.trim(),
      priority: draft.priority,
      api: { expectedStatus: draft.expectedStatus.trim() },
    });
    setEditingId(null);
  };
  const confirmDelete = (s: Scenario) => {
    if (window.confirm(`Delete scenario ${s.id}? It will be removed from the suite.`)) {
      if (editingId === s.id) setEditingId(null);
      onDelete(s.id);
    }
  };

  // The categories actually present, so the filter never offers an empty bucket.
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of scenarios) {
      const key = (s.type || 'other').toLowerCase();
      if (!seen.has(key)) seen.set(key, categoryMeta(key).label);
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [scenarios]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return scenarios.filter((s) => {
      if (category !== 'all' && (s.type || 'other').toLowerCase() !== category) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        (s.api?.endpoint || '').toLowerCase().includes(q) ||
        (s.api?.method || '').toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      );
    });
  }, [scenarios, filter, category]);

  // Only the rows near the viewport are mounted. Heights vary (an expanded or
  // editing row is much taller), so measureElement reports each real height.
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 10,
    getItemKey: (index) => visible[index]?.id ?? index,
  });

  if (scenarios.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title="No scenarios yet"
        hint="Import a collection or spec, or enter an endpoint and its expected response, then run. Every scenario the generator designs lands here for review before anything is automated."
      />
    );
  }

  const allVisibleSelected = visible.length > 0 && visible.every((s) => selected.has(s.id));

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Hero + toolbar */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <TabHero
          icon={ListChecks}
          title="Scenarios"
          subtitle={`Review each before it runs · ${selected.size} of ${scenarios.length} selected`}
          actions={<>
            <label className="flex items-center gap-1.5 text-[11px] text-white/90 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                disabled={!editable}
                onChange={() => (allVisibleSelected ? onClearAll() : onSelectAll(visible.map((s) => s.id)))}
                className="w-3.5 h-3.5 rounded border-white/40 text-[#7C3AED] focus:ring-white/50 focus:ring-offset-0 disabled:opacity-40"
              />
              <span className="font-medium">Select all</span>
            </label>
            <div className="relative">
              <Search className="w-3 h-3 text-white/60 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter scenarios…"
                className="w-44 pl-6 pr-2 py-1.5 bg-white/15 border border-white/25 rounded-lg text-[11px] text-white placeholder-white/60 outline-none focus:bg-white/25 focus:border-white/50 transition-colors"
              />
            </div>
          </>}
        />
      </div>

      {/* Category filters */}
      <div className={`flex items-center gap-1.5 flex-wrap px-4 py-2 border-b border-gray-100 flex-shrink-0 ${STRIP}`}>
        <FilterChip active={category === 'all'} onClick={() => setCategory('all')} count={scenarios.length}>All</FilterChip>
        {categories.map((c) => {
          const n = scenarios.filter((s) => (s.type || 'other').toLowerCase() === c.id).length;
          return (
            <FilterChip key={c.id} active={category === c.id} onClick={() => setCategory(c.id)} count={n}>{c.label}</FilterChip>
          );
        })}
      </div>

      {/* Virtualized list.
          The fixed columns need ~640px before the scenario title starts losing
          characters, so the whole list keeps a min width and scrolls sideways
          rather than crushing. Only the rows near the viewport are mounted. */}
      <div ref={scrollRef} className="flex-1 overflow-auto min-h-0">
        <div className="min-w-[680px]">
          {/* Header — same column template as every row, sticky on scroll. */}
          <div
            className={`sticky top-0 z-20 grid items-center border-b border-[#E9E5FB] ${THEAD}`}
            style={{ gridTemplateColumns: GRID_COLS }}
          >
            <div className="px-2 py-1.5" />
            <div className="px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">ID</div>
            <div className="px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Scenario</div>
            <div className="px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Category</div>
            <div className="px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Pri</div>
            <div className="px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Expects</div>
            <div className="px-2 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Asserts</div>
            <div className="px-2 py-1.5 text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wide">{editable ? 'Actions' : ''}</div>
            <div className="px-2 py-1.5" />
          </div>

          {/* Spacer sized to the full list; each visible row is absolutely
              positioned at its measured offset. */}
          <div className="relative" style={{ height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const s = visible[vi.index];
              if (!s) return null;
              const isOpen = expanded === s.id;
              const isSelected = selected.has(s.id);
              const isEditing = editingId === s.id;
              // Prefer the structured steps (each with its own expected result);
              // fall back to parsing the "N. action → Expected: result" strings.
              const stepList = (s.testSteps && s.testSteps.length)
                ? s.testSteps
                : s.steps.map((str, i) => {
                    const m = /^\s*(\d+)\.\s*(.*?)\s*→\s*Expected:\s*(.*)$/.exec(str);
                    return m
                      ? { step: Number(m[1]), action: m[2], expected: m[3] }
                      : { step: i + 1, action: str, expected: '' };
                  });
              const { actionSteps, checkSteps } = splitSteps(stepList);
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={rowVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <div
                    className={`grid items-center border-b border-gray-100 transition-colors ${isEditing ? '' : 'cursor-pointer'} ${
                      isEditing ? 'bg-[#EEF2FF]' : isOpen ? 'bg-[#F5F3FF]' : isSelected ? 'hover:bg-gray-50' : 'bg-gray-50/40 hover:bg-gray-50'
                    }`}
                    style={{ gridTemplateColumns: GRID_COLS }}
                    onClick={() => { if (isEditing) return; setExpanded(isOpen ? null : s.id); }}
                  >
                    <div className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={!editable}
                        onChange={() => onToggle(s.id)}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC] focus:ring-offset-0 disabled:opacity-40"
                      />
                    </div>
                    <div className="px-2 py-1.5 font-mono text-[11px] text-gray-400 truncate">{s.id}</div>
                    <div className="px-2 py-1.5 min-w-0">
                      {isEditing ? (
                        <input
                          value={draft.title}
                          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                          onClick={(e) => e.stopPropagation()}
                          className={`w-full ${FIELD}`}
                          placeholder="Scenario title"
                        />
                      ) : (
                        <>
                          <div className={`text-[12px] leading-snug truncate ${isSelected ? 'text-gray-800' : 'text-gray-400'}`}>{s.title}</div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <MethodBadge method={s.api?.method || ''} />
                          </div>
                        </>
                      )}
                    </div>
                    <div className="px-2 py-1.5 min-w-0">
                      {isEditing ? (
                        <input
                          value={draft.type}
                          onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}
                          onClick={(e) => e.stopPropagation()}
                          className={`w-full ${FIELD}`}
                          placeholder="Category"
                        />
                      ) : <CategoryChip type={s.type} />}
                    </div>
                    <div className="px-2 py-1.5 min-w-0">
                      {isEditing ? (
                        <select
                          value={draft.priority}
                          onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
                          onClick={(e) => e.stopPropagation()}
                          className={`w-full ${FIELD}`}
                        >
                          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                      ) : <PriorityChip priority={s.priority} />}
                    </div>
                    <div className="px-2 py-1.5 min-w-0 overflow-hidden">
                      {isEditing ? (
                        <input
                          value={draft.expectedStatus}
                          onChange={(e) => setDraft((d) => ({ ...d, expectedStatus: e.target.value }))}
                          onClick={(e) => e.stopPropagation()}
                          className={`w-full ${FIELD}`}
                          placeholder="200"
                        />
                      ) : <StatusCode code={s.api?.expectedStatus || ''} />}
                    </div>
                    <div className="px-2 py-1.5 text-[11px] text-gray-500 tabular-nums">{checkSteps.length}</div>
                    <div className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                      {editable && (
                        <div className="flex items-center justify-end gap-1">
                          {isEditing ? (
                            <>
                              <button type="button" onClick={() => saveEdit(s)} title="Save changes" className="p-1 rounded text-emerald-600 hover:bg-emerald-50">
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button type="button" onClick={cancelEdit} title="Cancel" className="p-1 rounded text-gray-400 hover:bg-gray-100">
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button type="button" onClick={() => startEdit(s)} title="Edit scenario" className="p-1 rounded text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button type="button" onClick={() => confirmDelete(s)} title="Delete scenario" className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <ChevronRight className={`w-3.5 h-3.5 text-gray-300 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    </div>
                  </div>

                  {isOpen && !isEditing && (
                    <div className="border-b border-gray-200 bg-[#F5F3FF] px-4 py-3">
                     <div className="@container">
                      <div className="grid grid-cols-1 @[680px]:grid-cols-2 gap-4">
                        {/* What gets sent */}
                        <div className="space-y-2 min-w-0">
                          <SectionLabel icon={Send}>Request</SectionLabel>
                          <div className={`bg-white border border-[#E9E5FB] rounded-lg overflow-hidden ${RAISED}`}>
                            <div className="flex items-center gap-1.5 px-2.5 py-2">
                              <MethodBadge method={s.api?.method || ''} />
                              <span className="font-mono text-[11px] text-gray-700 break-all">
                                {s.api?.endpoint}{s.api?.queryParams ? `?${s.api.queryParams}` : ''}
                              </span>
                            </div>
                            {s.api?.requestBody && (
                              <div className="px-2.5 py-1.5 border-t border-gray-100">
                                <CodeBlock code={prettyJson(s.api.requestBody)} className="max-h-40" />
                              </div>
                            )}
                          </div>
                        </div>

                        {/* What it does, then what it proves. An "Assert that …"
                            step already states its own expected result, so
                            repeating it underneath was pure noise — those steps
                            become a checklist and keep the wording on hover. */}
                        <div className="space-y-2 min-w-0">
                          <SectionLabel icon={ListChecks}>
                            Steps
                            <span className="ml-1.5 font-normal normal-case tracking-normal text-gray-400">
                              {actionSteps.length} action{actionSteps.length === 1 ? '' : 's'} · {checkSteps.length} check{checkSteps.length === 1 ? '' : 's'}
                            </span>
                          </SectionLabel>
                          <div className={`bg-white border border-[#E9E5FB] rounded-lg overflow-hidden ${RAISED}`}>
                            {stepList.length === 0 && (
                              <p className="text-[11px] text-gray-400 p-2.5">No steps were recorded for this scenario.</p>
                            )}
                            {actionSteps.map((st, i) => (
                              <div key={`a${i}`} className="flex gap-2 px-2.5 py-2 border-b border-gray-100 last:border-b-0">
                                <span className="text-[9.5px] font-mono font-semibold text-white bg-gradient-to-b from-[#A78BFA] to-[#8B5CF6] rounded-full w-4 h-4 flex items-center justify-center flex-shrink-0 mt-px tabular-nums shadow-[0_1px_2px_rgba(76,29,149,0.35)]">
                                  {i + 1}
                                </span>
                                <div className="min-w-0">
                                  <p className="text-[11px] text-gray-800 leading-snug"><Highlight text={st.action} /></p>
                                </div>
                              </div>
                            ))}
                            {checkSteps.length > 0 && (
                              <div className="bg-[#FCFBFF] border-t border-gray-100">
                                {checkSteps.map((st, i) => (
                                  <div key={`c${i}`} className="flex gap-2 px-2.5 py-1.5 border-b border-gray-100 last:border-b-0" title={st.expected || undefined}>
                                    <Check className="w-3 h-3 text-emerald-600 flex-shrink-0 mt-[3px]" />
                                    <p className="text-[11px] text-gray-700 leading-snug min-w-0"><Highlight text={st.claim} /></p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                     </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {visible.length === 0 && (
          <div className="px-4 py-10 text-center text-[12px] text-gray-400">
            No scenarios match that filter.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Reading the generated steps ─────────────────────────────────── */

interface Step { step: number; action: string; expected: string }
interface Check extends Step { claim: string }

/** "Assert that …", "Verify …", "Check that …" — a step that proves something. */
const ASSERTION = /^\s*(?:\d+[.)]\s*)?(?:assert|verify|check|confirm|ensure|validate)\b(?:\s+that)?\s*/i;

/**
 * An assertion step states its own expected result, so it reads as a checklist
 * tick rather than a numbered instruction with a restatement underneath.
 */
function splitSteps(steps: Step[]): { actionSteps: Step[]; checkSteps: Check[] } {
  const actionSteps: Step[] = [];
  const checkSteps: Check[] = [];
  for (const st of steps) {
    if (ASSERTION.test(st.action)) {
      const claim = st.action.replace(ASSERTION, '').replace(/\.$/, '');
      checkSteps.push({ ...st, claim: claim.charAt(0).toUpperCase() + claim.slice(1) });
    } else {
      actionSteps.push(st);
    }
  }
  return { actionSteps, checkSteps };
}

/** Quoted fragments and status codes read as values, so they are set in mono. */
function Highlight({ text }: { text: string }) {
  const parts = text.split(/("[^"]*"|`[^`]*`|\b[1-5]\d\d\b)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^["`]/.test(part) || /^[1-5]\d\d$/.test(part) ? (
          <code key={i} className="font-mono text-[10.5px] text-[#6D28D9] bg-[#F5F3FF] border border-[#EDE9FE] rounded px-1 py-px">{part.replace(/^["`]|["`]$/g, '')}</code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** The card sub-header above each half of the detail panel. */
function SectionLabel({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <Icon className="w-4 h-4 text-[#7C3AED]" />
      <h3 className="text-[12.5px] font-semibold text-gray-900">{children}</h3>
    </div>
  );
}

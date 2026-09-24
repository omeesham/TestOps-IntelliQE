/**
 * API Studio — the scenarios tab, which is also the run's review gate.
 *
 * The generator designs the coverage; the engineer decides what actually runs.
 * Every scenario is therefore inspectable down to the exact request that will
 * be sent and the exact assertions that will fire, and deselecting one drops it
 * from automation, execution and the report alike.
 */
import { Fragment, useMemo, useState } from 'react';
import { ChevronRight, ListChecks, Search, Check, Info } from 'lucide-react';
import {
  MethodBadge, CategoryChip, PriorityChip, StatusCode, CodeBlock, EmptyState,
} from './primitives';
import { prettyJson, categoryMeta, STRIP, THEAD, INSET, RAISED } from './format';
import type { Scenario } from './types';

interface Props {
  scenarios: Scenario[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: (ids: string[]) => void;
  onClearAll: () => void;
  /** False once the run has moved past the gate — selection is then fixed. */
  editable: boolean;
}

export default function ScenariosTab({ scenarios, selected, onToggle, onSelectAll, onClearAll, editable }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('all');

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
      {/* Toolbar */}
      <div className={`relative z-10 flex items-center gap-2 px-3 h-10 min-w-0 overflow-hidden border-b border-gray-100 flex-shrink-0 ${STRIP}`}>
        <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            disabled={!editable}
            onChange={() => (allVisibleSelected ? onClearAll() : onSelectAll(visible.map((s) => s.id)))}
            className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC] focus:ring-offset-0 disabled:opacity-40"
          />
          <span className="font-medium">
            {selected.size} of {scenarios.length} selected
          </span>
        </label>

        <div className="relative ml-2">
          <Search className="w-3 h-3 text-gray-300 absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter scenarios…"
            className={`w-52 pl-6 pr-2 py-1 bg-[#FCFBFF] border border-[#E4E0F5] rounded text-[11px] text-gray-700 placeholder-gray-300 outline-none focus:bg-white focus:border-[#A5B4FC] focus:ring-2 focus:ring-[#EDE9FE] transition-all ${INSET}`}
          />
        </div>

        <div className="flex items-center gap-1 ml-auto flex-shrink-0">
          <button
            type="button"
            onClick={() => setCategory('all')}
            className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
              category === 'all' ? 'bg-[#7C3AED] text-white' : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            All {scenarios.length}
          </button>
          {categories.map((c) => {
            const n = scenarios.filter((s) => (s.type || 'other').toLowerCase() === c.id).length;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                  category === c.id ? 'bg-[#7C3AED] text-white' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {c.label} {n}
              </button>
            );
          })}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto min-h-0">
        {/* The fixed columns need ~640px before the scenario title starts
            losing characters — scroll the table rather than crush it. */}
        <table className="w-full min-w-[680px] border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className={`border-b border-[#E9E5FB] ${THEAD}`}>
              <th className="w-8" />
              <th className="w-14 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide">ID</th>
              <th className="px-2 py-1.5 text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Scenario</th>
              <th className="w-24 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Category</th>
              <th className="w-14 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Pri</th>
              <th className="w-24 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Expects</th>
              <th className="w-20 px-2 py-1.5 text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Asserts</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => {
              const isOpen = expanded === s.id;
              const isSelected = selected.has(s.id);
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
                <Fragment key={s.id}>
                  <tr
                    className={`border-b border-gray-100 transition-colors cursor-pointer ${
                      isOpen ? 'bg-[#F5F3FF]' : isSelected ? 'hover:bg-gray-50' : 'bg-gray-50/40 hover:bg-gray-50'
                    }`}
                    onClick={() => setExpanded(isOpen ? null : s.id)}
                  >
                    <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={!editable}
                        onChange={() => onToggle(s.id)}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC] focus:ring-offset-0 disabled:opacity-40"
                      />
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[11px] text-gray-400">{s.id}</td>
                    <td className="px-2 py-1.5">
                      <div className={`text-[12px] leading-snug ${isSelected ? 'text-gray-800' : 'text-gray-400'}`}>{s.title}</div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <MethodBadge method={s.api?.method || ''} />
                        <span className="font-mono text-[10px] text-gray-400 truncate max-w-[420px]">
                          {s.api?.endpoint}{s.api?.queryParams ? `?${s.api.queryParams}` : ''}
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-1.5"><CategoryChip type={s.type} /></td>
                    <td className="px-2 py-1.5"><PriorityChip priority={s.priority} /></td>
                    <td className="px-2 py-1.5"><StatusCode code={s.api?.expectedStatus || ''} /></td>
                    <td className="px-2 py-1.5 text-[11px] text-gray-500 tabular-nums">{checkSteps.length}</td>
                    <td className="px-2 py-1.5">
                      <ChevronRight className={`w-3.5 h-3.5 text-gray-300 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    </td>
                  </tr>

                  {isOpen && (
                    <tr className="border-b border-gray-200 bg-[#F5F3FF]">
                      <td colSpan={8} className="px-4 py-3">
                       <div className="@container">
                        <div className="grid grid-cols-1 @[680px]:grid-cols-2 gap-4">
                          {/* What gets sent */}
                          <div className="space-y-2 min-w-0">
                            <SectionLabel>Request</SectionLabel>
                            <div className={`bg-white border border-[#E9E5FB] rounded-lg overflow-hidden ${RAISED}`}>
                              <div className="flex items-center gap-1.5 px-2.5 py-2">
                                <MethodBadge method={s.api?.method || ''} />
                                <span className="font-mono text-[11px] text-gray-700 break-all">
                                  {s.api?.endpoint}{s.api?.queryParams ? `?${s.api.queryParams}` : ''}
                                </span>
                              </div>
                              {Object.keys(s.api?.headers || {}).length > 0 && (
                                <div className="flex flex-wrap gap-1 px-2.5 py-1.5 border-t border-gray-100 bg-[#FCFBFF]">
                                  {Object.entries(s.api!.headers).map(([k, v]) => (
                                    <span key={k} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#EDE9FE] bg-white font-mono text-[10px] max-w-full">
                                      <span className="text-[#7C3AED] flex-shrink-0">{k}</span>
                                      <span className="text-gray-500 truncate">{v}</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                              {s.api?.requestBody && (
                                <div className="px-2.5 py-1.5 border-t border-gray-100">
                                  <CodeBlock code={prettyJson(s.api.requestBody)} className="max-h-40" />
                                </div>
                              )}
                            </div>
                            {s.description && <p className="text-[11px] text-gray-500 leading-relaxed">{s.description}</p>}
                            {s.precondition && (
                              <p className="flex gap-1.5 text-[10.5px] text-gray-400 leading-relaxed">
                                <Info className="w-3 h-3 flex-shrink-0 mt-0.5 text-[#C4B5FD]" />
                                <span><span className="font-medium text-gray-500">Needs:</span> {s.precondition}</span>
                              </p>
                            )}
                          </div>

                          {/* What it does, then what it proves. An "Assert that …"
                              step already states its own expected result, so
                              repeating it underneath was pure noise — those steps
                              become a checklist and keep the wording on hover. */}
                          <div className="space-y-2 min-w-0">
                            <SectionLabel>
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
                                    {/* Clamped: the generator's expected results run long, and two
                                        lines are enough to know whether to hover for the rest. */}
                                    {st.expected && !restates(st.action, st.expected) && (
                                      <p title={st.expected} className="text-[10.5px] text-gray-500 leading-snug mt-0.5 line-clamp-2">→ <Highlight text={st.expected} /></p>
                                    )}
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
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

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

/* Words that carry no meaning when comparing two phrasings of the same thing. */
const FILLER = new Set(['the', 'a', 'an', 'is', 'are', 'be', 'that', 'to', 'of', 'and', 'it', 'its',
  'should', 'must', 'will', 'exactly', 'successfully', 'this', 'with', 'from', 'for', 'has', 'have',
  'returns', 'return', 'returned', 'response', 'request', 'endpoint', 'api']);

function meaningful(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9_.\-/{}]+/g) || [];
  return new Set(words.filter((w) => !FILLER.has(w)));
}

/**
 * True when the expected result only says the action again. The generator often
 * writes "Send a GET request" / "Expected: the endpoint accepts the request",
 * and printing both wastes the reader's attention.
 */
function restates(action: string, expected: string): boolean {
  const e = meaningful(expected);
  if (e.size === 0) return true;
  const a = meaningful(action);
  let shared = 0;
  for (const w of e) if (a.has(w)) shared++;
  return shared / e.size >= 0.6;
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

/** The small grey heading above each half of the detail panel. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">{children}</p>;
}

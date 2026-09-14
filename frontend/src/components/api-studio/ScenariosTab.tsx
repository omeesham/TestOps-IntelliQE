/**
 * API Studio — the scenarios tab, which is also the run's review gate.
 *
 * The generator designs the coverage; the engineer decides what actually runs.
 * Every scenario is therefore inspectable down to the exact request that will
 * be sent and the exact assertions that will fire, and deselecting one drops it
 * from automation, execution and the report alike.
 */
import { Fragment, useMemo, useState } from 'react';
import { ChevronRight, ListChecks, Search } from 'lucide-react';
import {
  MethodBadge, CategoryChip, PriorityChip, StatusCode, CodeBlock, EmptyState,
} from './primitives';
import { prettyJson, categoryMeta } from './format';
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
        hint="Fill in the endpoint and its expected response, then run the suite. Every scenario the generator designs lands here for review before anything is automated."
      />
    );
  }

  const allVisibleSelected = visible.length > 0 && visible.every((s) => selected.has(s.id));

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-gray-200 bg-white flex-shrink-0">
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
            className="w-52 pl-6 pr-2 py-1 bg-white border border-gray-200 rounded text-[11px] text-gray-700 placeholder-gray-300 outline-none focus:border-[#A5B4FC] focus:ring-2 focus:ring-[#EDE9FE] transition-all"
          />
        </div>

        <div className="flex items-center gap-1 ml-auto">
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
            <tr className="bg-gray-50 border-b border-gray-200">
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
              const assertions = s.steps.filter((t) => /assert/i.test(t));
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
                    <td className="px-2 py-1.5 text-[11px] text-gray-500 tabular-nums">{assertions.length}</td>
                    <td className="px-2 py-1.5">
                      <ChevronRight className={`w-3.5 h-3.5 text-gray-300 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    </td>
                  </tr>

                  {isOpen && (
                    <tr className="border-b border-gray-200 bg-[#F5F3FF]">
                      <td colSpan={8} className="px-4 py-3">
                        <div className="grid grid-cols-2 gap-4">
                          {/* What gets sent */}
                          <div className="space-y-2 min-w-0">
                            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Request</p>
                            <div className="bg-white border border-gray-200 rounded-md p-2.5 space-y-1.5">
                              <div className="flex items-center gap-1.5">
                                <MethodBadge method={s.api?.method || ''} />
                                <span className="font-mono text-[11px] text-gray-700 break-all">
                                  {s.api?.endpoint}{s.api?.queryParams ? `?${s.api.queryParams}` : ''}
                                </span>
                              </div>
                              {Object.keys(s.api?.headers || {}).length > 0 && (
                                <div className="pt-1 border-t border-gray-100">
                                  {Object.entries(s.api!.headers).map(([k, v]) => (
                                    <div key={k} className="font-mono text-[10.5px] leading-relaxed">
                                      <span className="text-[#7C3AED]">{k}</span>
                                      <span className="text-gray-400">: </span>
                                      <span className="text-gray-600 break-all">{v}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {s.api?.requestBody && (
                                <div className="pt-1 border-t border-gray-100">
                                  <CodeBlock code={prettyJson(s.api.requestBody)} className="max-h-40" />
                                </div>
                              )}
                            </div>
                            {s.description && (
                              <p className="text-[11px] text-gray-500 leading-relaxed">{s.description}</p>
                            )}
                          </div>

                          {/* What gets checked */}
                          <div className="space-y-2 min-w-0">
                            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                              Assertions ({assertions.length})
                            </p>
                            <ol className="bg-white border border-gray-200 rounded-md p-2.5 space-y-1">
                              {assertions.length === 0 && (
                                <li className="text-[11px] text-gray-400">No assertions were recorded for this scenario.</li>
                              )}
                              {assertions.map((a, i) => (
                                <li key={i} className="flex gap-1.5 text-[11px] text-gray-700 leading-relaxed">
                                  <span className="text-gray-300 font-mono flex-shrink-0">{String(i + 1).padStart(2, '0')}</span>
                                  <span>{a.replace(/^\d+\.\s*Assert:\s*/i, '').replace(/\s*→ Expected:.*$/, '')}</span>
                                </li>
                              ))}
                            </ol>
                            {s.precondition && (
                              <p className="text-[10.5px] text-gray-400 leading-relaxed">
                                <span className="font-medium">Precondition:</span> {s.precondition}
                              </p>
                            )}
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

/**
 * API Studio — the scenarios tab, which is also the run's review gate.
 *
 * The generator designs the coverage; the engineer decides what actually runs.
 * Every scenario is inspectable down to the exact request that will be sent and
 * the exact assertions that will fire, and it is editable in place: the reviewer
 * can retitle it, retune the request (method, URL, query, headers, body),
 * restate the expectations, or delete it outright before anything is automated.
 * Edits are held in memory and flow into the saved test cases and the report.
 */
import { Fragment, useMemo, useState } from 'react';
import { ChevronRight, ListChecks, Search, Check, Pencil, Trash2, X, Save } from 'lucide-react';
import {
  MethodBadge, CategoryChip, PriorityChip, StatusCode, CodeBlock, EmptyState,
} from './primitives';
import {
  prettyJson, categoryMeta, STRIP, THEAD, INSET, RAISED,
  INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, BRAND_CHIP, MUTED_CHIP,
} from './format';
import type { Scenario, ApiCaseMeta } from './types';

interface Props {
  scenarios: Scenario[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: (ids: string[]) => void;
  onClearAll: () => void;
  /** False once the run has moved past the gate — selection & editing are then fixed. */
  editable: boolean;
  /** Apply an in-place edit to one scenario (review gate only). */
  onUpdate?: (id: string, patch: Partial<Scenario>) => void;
  /** Drop a scenario from the run (review gate only). */
  onDelete?: (id: string) => void;
}

export default function ScenariosTab({ scenarios, selected, onToggle, onSelectAll, onClearAll, editable, onUpdate, onDelete }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
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
              const isEditing = editingId === s.id;
              const { checkSteps } = deriveSteps(s);
              return (
                <Fragment key={s.id}>
                  <tr
                    className={`border-b border-gray-100 transition-colors cursor-pointer ${
                      isOpen ? 'bg-[#F5F3FF]' : isSelected ? 'hover:bg-gray-50' : 'bg-gray-50/40 hover:bg-gray-50'
                    }`}
                    onClick={() => { if (isEditing) return; setExpanded(isOpen ? null : s.id); }}
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
                        {isEditing ? (
                          <ScenarioEditForm
                            scenario={s}
                            onSave={(patch) => { onUpdate?.(s.id, patch); setEditingId(null); }}
                            onCancel={() => setEditingId(null)}
                          />
                        ) : (
                          <ScenarioDetail
                            scenario={s}
                            editable={editable}
                            onEdit={onUpdate ? () => setEditingId(s.id) : undefined}
                            onDelete={onDelete ? () => { if (window.confirm(`Delete ${s.id} — "${s.title}"? It is removed from this run.`)) onDelete(s.id); } : undefined}
                          />
                        )}
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

/* ══════════════════════════════════════════════════════════════════
   Read view — everything the generator designed for this scenario
   ══════════════════════════════════════════════════════════════════ */

function ScenarioDetail({ scenario: s, editable, onEdit, onDelete }: {
  scenario: Scenario;
  editable: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { actionSteps, checkSteps, stepList } = deriveSteps(s);
  const headers = Object.entries(s.api?.headers || {});
  const query = parseQs(s.api?.queryParams);
  const testData = collectTestData(s);

  return (
    <div className="@container space-y-3">
      {/* Meta strip: description + the actions the reviewer can take */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          {s.description && <p className="text-[11.5px] text-gray-600 leading-relaxed">{s.description}</p>}
          <div className="flex flex-wrap items-center gap-1.5">
            {s.severity && (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${MUTED_CHIP}`}>
                Severity: {s.severity}
              </span>
            )}
            {(s.tags || []).map((t) => (
              <span key={t} className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${BRAND_CHIP}`}>{t}</span>
            ))}
          </div>
        </div>
        {editable && (onEdit || onDelete) && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {onEdit && (
              <button type="button" onClick={onEdit} className={`${SECONDARY_BTN} !px-2.5 !py-1.5 !text-[12px]`}>
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                title="Delete this scenario"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium text-gray-500 bg-white border border-gray-200 rounded-lg hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {s.precondition && (
        <div className="flex gap-1.5 text-[11px] text-gray-600">
          <span className="font-semibold text-gray-500 uppercase tracking-wide text-[10px] mt-px flex-shrink-0">Precondition</span>
          <span className="min-w-0">{s.precondition}</span>
        </div>
      )}

      <div className="grid grid-cols-1 @[720px]:grid-cols-2 gap-4">
        {/* Left — the request, in full */}
        <div className="space-y-3 min-w-0">
          <div className="space-y-2 min-w-0">
            <SectionLabel>Request</SectionLabel>
            <div className={`bg-white border border-[#E9E5FB] rounded-lg overflow-hidden ${RAISED}`}>
              <div className="flex items-center gap-1.5 px-2.5 py-2">
                <MethodBadge method={s.api?.method || ''} />
                <span className="font-mono text-[11px] text-gray-700 break-all">{s.api?.endpoint || '—'}</span>
              </div>

              {query.length > 0 && (
                <div className="border-t border-gray-100 px-2.5 py-1.5">
                  <FieldLabel>Query</FieldLabel>
                  <KeyValueRows rows={query} />
                </div>
              )}

              {headers.length > 0 && (
                <div className="border-t border-gray-100 px-2.5 py-1.5">
                  <FieldLabel>Headers</FieldLabel>
                  <KeyValueRows rows={headers.map(([key, value]) => ({ key, value: String(value) }))} />
                </div>
              )}

              {s.api?.requestBody && (
                <div className="border-t border-gray-100 px-2.5 py-1.5">
                  <FieldLabel>Body</FieldLabel>
                  <CodeBlock code={prettyJson(s.api.requestBody)} className="max-h-48" />
                </div>
              )}
            </div>
          </div>

          {/* Expectations */}
          <div className="space-y-2 min-w-0">
            <SectionLabel>Expected</SectionLabel>
            <div className={`bg-white border border-[#E9E5FB] rounded-lg overflow-hidden ${RAISED}`}>
              <div className="flex items-center gap-2 px-2.5 py-2">
                <span className="text-[11px] text-gray-500">Status</span>
                <StatusCode code={s.api?.expectedStatus || ''} />
              </div>
              {s.expectedResult && (
                <div className="border-t border-gray-100 px-2.5 py-1.5">
                  <FieldLabel>Result</FieldLabel>
                  <p className="text-[11px] text-gray-700 leading-relaxed">{s.expectedResult}</p>
                </div>
              )}
            </div>
          </div>

          {/* Test data — the concrete values the case drives */}
          {testData.length > 0 && (
            <div className="space-y-2 min-w-0">
              <SectionLabel>Test data</SectionLabel>
              <div className={`bg-white border border-[#E9E5FB] rounded-lg overflow-hidden ${RAISED} px-2.5 py-1.5`}>
                <KeyValueRows rows={testData} />
              </div>
            </div>
          )}
        </div>

        {/* Right — what it does, then what it proves */}
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
                <span className="text-[9.5px] font-mono font-semibold text-white bg-gradient-to-b from-[#A78BFA] to-[#8B5CF6] rounded-full w-4 h-4 flex items-center justify-center flex-shrink-0 mt-px tabular-nums">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] text-gray-800 leading-snug"><Highlight text={st.action} /></p>
                  {st.testData && <p className="text-[10px] text-gray-400 mt-0.5 font-mono break-all">{st.testData}</p>}
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
  );
}

/* ══════════════════════════════════════════════════════════════════
   Edit form — retitle, retune the request, restate the expectations
   ══════════════════════════════════════════════════════════════════ */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const TYPES: { value: string; label: string }[] = [
  { value: 'positive', label: 'Contract' },
  { value: 'negative', label: 'Negative' },
  { value: 'security', label: 'Auth' },
  { value: 'data', label: 'Schema' },
  { value: 'edge', label: 'Edge' },
  { value: 'performance', label: 'Perf' },
  { value: 'e2e', label: 'Flow' },
];

function ScenarioEditForm({ scenario: s, onSave, onCancel }: {
  scenario: Scenario;
  onSave: (patch: Partial<Scenario>) => void;
  onCancel: () => void;
}) {
  const api = s.api;
  const [title, setTitle] = useState(s.title);
  const [description, setDescription] = useState(s.description || '');
  const [type, setType] = useState((s.type || 'positive').toLowerCase());
  const [priority, setPriority] = useState((s.priority || 'P1').toUpperCase());
  const [severity, setSeverity] = useState(s.severity || '');
  const [precondition, setPrecondition] = useState(s.precondition || '');
  const [expectedResult, setExpectedResult] = useState(s.expectedResult || '');
  const [tags, setTags] = useState((s.tags || []).join(', '));
  const [method, setMethod] = useState((api?.method || 'GET').toUpperCase());
  const [endpoint, setEndpoint] = useState(api?.endpoint || '');
  const [queryParams, setQueryParams] = useState(api?.queryParams || '');
  const [requestBody, setRequestBody] = useState(api?.requestBody || '');
  const [expectedStatus, setExpectedStatus] = useState(String(api?.expectedStatus || ''));
  const [headers, setHeaders] = useState(headersToText(api?.headers));

  const save = () => {
    const nextApi: ApiCaseMeta = {
      endpoint: endpoint.trim(),
      method: method.toUpperCase(),
      headers: textToHeaders(headers),
      queryParams: queryParams.trim(),
      requestBody: requestBody.trim() || undefined,
      expectedStatus: expectedStatus.trim(),
    };
    onSave({
      title: title.trim() || s.title,
      description: description.trim(),
      type,
      priority,
      severity: severity.trim(),
      precondition: precondition.trim(),
      expectedResult: expectedResult.trim(),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      api: nextApi,
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-[#6D28D9] uppercase tracking-wide flex items-center gap-1.5">
          <Pencil className="w-3.5 h-3.5" /> Editing {s.id}
        </p>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={onCancel} className={`${SECONDARY_BTN} !px-3 !py-1.5 !text-[12px]`}>
            <X className="w-3.5 h-3.5" /> Cancel
          </button>
          <button type="button" onClick={save} className={`${PRIMARY_BTN} !px-3 !py-1.5 !text-[12px]`}>
            <Save className="w-3.5 h-3.5" /> Save
          </button>
        </div>
      </div>

      <div className="bg-white border border-[#E9E5FB] rounded-lg p-3 space-y-3">
        {/* Identity */}
        <div>
          <label className={LABEL}>Scenario title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} placeholder="What this scenario verifies" />
        </div>
        <div>
          <label className={LABEL}>Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={`${INPUT} resize-y`} placeholder="Optional context for the reviewer" />
        </div>

        <div className="grid grid-cols-2 @[640px]:grid-cols-4 gap-2.5">
          <div>
            <label className={LABEL}>Category</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className={INPUT}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              {!TYPES.some((t) => t.value === type) && <option value={type}>{type}</option>}
            </select>
          </div>
          <div>
            <label className={LABEL}>Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} className={INPUT}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL}>Severity</label>
            <input value={severity} onChange={(e) => setSeverity(e.target.value)} className={INPUT} placeholder="e.g. major" />
          </div>
          <div>
            <label className={LABEL}>Expected status</label>
            <input value={expectedStatus} onChange={(e) => setExpectedStatus(e.target.value)} className={INPUT} placeholder="200" />
          </div>
        </div>
      </div>

      {/* Request */}
      <div className="bg-white border border-[#E9E5FB] rounded-lg p-3 space-y-3">
        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Request</p>
        <div className="flex gap-2">
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={`${FIELD} flex-shrink-0`}>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className={`${INPUT} font-mono text-[11px]`} placeholder="https://api.example.com/v1/resource" />
        </div>
        <div className="grid grid-cols-1 @[640px]:grid-cols-2 gap-2.5">
          <div>
            <label className={LABEL}>Query string</label>
            <input value={queryParams} onChange={(e) => setQueryParams(e.target.value)} className={`${INPUT} font-mono text-[11px]`} placeholder="limit=10&page=2" />
          </div>
          <div>
            <label className={LABEL}>Headers <span className="normal-case font-normal text-gray-400">(one per line, Key: Value)</span></label>
            <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={2} className={`${INPUT} font-mono text-[11px] resize-y`} placeholder="Accept: application/json" />
          </div>
        </div>
        {['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()) && (
          <div>
            <label className={LABEL}>Request body</label>
            <textarea value={requestBody} onChange={(e) => setRequestBody(e.target.value)} rows={4} className={`${INPUT} font-mono text-[11px] resize-y`} placeholder='{ "name": "example" }' />
          </div>
        )}
      </div>

      {/* Expectations */}
      <div className="bg-white border border-[#E9E5FB] rounded-lg p-3 space-y-3">
        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Expectations</p>
        <div>
          <label className={LABEL}>Expected result</label>
          <textarea value={expectedResult} onChange={(e) => setExpectedResult(e.target.value)} rows={2} className={`${INPUT} resize-y`} placeholder="What a correct response looks like" />
        </div>
        <div>
          <label className={LABEL}>Tags <span className="normal-case font-normal text-gray-400">(comma-separated)</span></label>
          <input value={tags} onChange={(e) => setTags(e.target.value)} className={INPUT} placeholder="smoke, regression" />
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Small building blocks
   ══════════════════════════════════════════════════════════════════ */

/** Serialise a header map to one "Key: Value" line each (for the editor). */
function headersToText(h?: Record<string, string>): string {
  if (!h) return '';
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n');
}

/** Parse "Key: Value" lines back into a header map; blank lines are ignored. */
function textToHeaders(t: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of t.split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    const key = (i === -1 ? line : line.slice(0, i)).trim();
    if (key) out[key] = i === -1 ? '' : line.slice(i + 1).trim();
  }
  return out;
}

/** Split a `?`-less query string into key/value rows for display. */
function parseQs(qs?: string): { key: string; value: string }[] {
  if (!qs) return [];
  return qs.replace(/^\?/, '').split('&').filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i === -1 ? { key: p, value: '' } : { key: p.slice(0, i), value: p.slice(i + 1) };
  });
}

/** A tight key/value table — query params, headers, test data. */
function KeyValueRows({ rows }: { rows: { key: string; value: string }[] }) {
  return (
    <div className="space-y-0.5">
      {rows.map((r, i) => (
        <div key={`${r.key}-${i}`} className="flex items-baseline gap-2 text-[11px]">
          <span className="font-mono text-[#6D28D9] break-all flex-shrink-0 max-w-[45%] truncate" title={r.key}>{r.key}</span>
          <span className="font-mono text-gray-600 break-all min-w-0">{r.value || <span className="text-gray-300">—</span>}</span>
        </div>
      ))}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[9.5px] font-semibold text-gray-400 uppercase tracking-wide mb-1">{children}</p>;
}

/** The small grey heading above each half of the detail panel. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">{children}</p>;
}

/* ── Reading the generated steps ─────────────────────────────────── */

interface Step { step: number; action: string; expected: string; testData?: string }
interface Check extends Step { claim: string }

/** "Assert that …", "Verify …", "Check that …" — a step that proves something. */
const ASSERTION = /^\s*(?:\d+[.)]\s*)?(?:assert|verify|check|confirm|ensure|validate)\b(?:\s+that)?\s*/i;

/** Normalise a scenario's steps into structured actions + checks (once per row). */
function deriveSteps(s: Scenario): { stepList: Step[]; actionSteps: Step[]; checkSteps: Check[] } {
  const stepList: Step[] = (s.testSteps && s.testSteps.length)
    ? s.testSteps.map((st) => ({ step: st.step, action: st.action, expected: st.expected, testData: st.testData }))
    : s.steps.map((str, i) => {
        const m = /^\s*(\d+)\.\s*(.*?)\s*→\s*Expected:\s*(.*)$/.exec(str);
        return m
          ? { step: Number(m[1]), action: m[2]!, expected: m[3]! }
          : { step: i + 1, action: str, expected: '' };
      });
  const { actionSteps, checkSteps } = splitSteps(stepList);
  return { stepList, actionSteps, checkSteps };
}

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

/** The concrete values a case drives — from structured steps and raw.testData. */
function collectTestData(s: Scenario): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const seen = new Set<string>();
  const push = (key: string, value: unknown) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, value: typeof value === 'string' ? value : JSON.stringify(value) });
  };
  const bag = s.raw?.testData;
  if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
    for (const [k, v] of Object.entries(bag)) push(k, v);
  }
  return out;
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

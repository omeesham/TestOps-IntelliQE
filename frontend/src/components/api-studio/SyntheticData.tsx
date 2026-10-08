/**
 * SyntheticData — AI synthetic test-data factory.
 *
 * Opt-in and standalone. Produces realistic, reproducible (seeded) rows for a
 * set of fields the three ways a tester actually has them: inferred from an
 * endpoint (LLM), inferred from a pasted sample JSON body, or defined by hand.
 * Optional PII masking and appended edge-case rows round it out. The result is
 * previewed as a table and downloadable as CSV or JSON. Nothing here touches
 * the catalogue or the run pipeline.
 */
import { useState } from 'react';
import { X, Database, Play, Download, Lock, AlertTriangle, Plus, Trash2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { generateSyntheticData, type SynthField, type SynthDataResult } from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, THEAD, PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

/** The field types the factory understands — drives the per-field type select. */
const FIELD_TYPES = [
  'firstName', 'lastName', 'fullName', 'email', 'phone', 'uuid', 'int', 'float', 'bool',
  'date', 'datetime', 'city', 'country', 'company', 'word', 'sentence', 'url', 'ipv4',
  'currency', 'enum', 'ssn', 'creditCard', 'string',
] as const;

const MODES = [
  { id: 'endpoint', label: 'From endpoint' },
  { id: 'sample', label: 'From sample body' },
  { id: 'manual', label: 'Manual fields' },
] as const;
type Mode = (typeof MODES)[number]['id'];

/** Blob + <a download> — trigger a client-side file download. */
function triggerDownload(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Render a cell value as readable text — objects as compact JSON, else coerced. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function SyntheticData({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('endpoint');
  const [endpointId, setEndpointId] = useState(endpoints[0]?.id || '');
  const [sampleBody, setSampleBody] = useState('');
  const [fields, setFields] = useState<SynthField[]>([{ name: 'id', type: 'uuid' }]);
  const [count, setCount] = useState(20);
  const [seedInput, setSeedInput] = useState('');
  const [piiMask, setPiiMask] = useState(false);
  const [edgeCases, setEdgeCases] = useState(false);
  const [result, setResult] = useState<SynthDataResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const addField = () => setFields((f) => [...f, { name: '', type: 'string' }]);
  const removeField = (i: number) => setFields((f) => f.filter((_, idx) => idx !== i));
  const patchField = (i: number, patch: Partial<SynthField>) =>
    setFields((f) => f.map((fld, idx) => (idx === i ? { ...fld, ...patch } : fld)));

  const generate = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const input: Parameters<typeof generateSyntheticData>[0] = {
        count,
        seed: seedInput.trim() === '' ? undefined : Number(seedInput),
        piiMask,
        edgeCases,
      };
      if (mode === 'endpoint') {
        const ep = endpoints.find((e) => e.id === endpointId);
        if (!ep) { setError('Pick an endpoint first.'); setLoading(false); return; }
        input.endpoint = { method: ep.method, url: ep.url, description: ep.description };
      } else if (mode === 'sample') {
        if (!sampleBody.trim()) { setError('Paste a sample JSON body first.'); setLoading(false); return; }
        input.sampleBody = sampleBody;
      } else {
        const clean = fields.filter((f) => f.name.trim());
        if (!clean.length) { setError('Add at least one named field.'); setLoading(false); return; }
        input.fields = clean;
      }
      setResult(await generateSyntheticData(input));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Generation failed.');
    } finally {
      setLoading(false);
    }
  };

  const piiCols = new Set((result?.fields || []).filter((f) => f.pii).map((f) => f.name));
  const preview = result?.rows.slice(0, 50) || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Database className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Synthetic data factory</h3>
          <span className="text-[11px] text-gray-400">realistic, seeded test data</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0 flex-1">
          {/* Source mode */}
          <div className="inline-flex rounded-lg border border-gray-200 p-0.5 bg-gray-50">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={`px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors ${mode === m.id ? 'bg-white text-[#6D28D9] shadow-sm' : 'text-gray-500 hover:text-[#7C3AED]'}`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'endpoint' && (
            <div>
              <label className={LABEL}>Endpoint</label>
              <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} className={INPUT}>
                {endpoints.length === 0 && <option value="">No endpoints in the catalogue</option>}
                {endpoints.map((e) => <option key={e.id} value={e.id}>{e.method} {e.url}</option>)}
              </select>
              <p className="text-[10.5px] text-gray-400 mt-1">Fields are inferred from the endpoint — needs an LLM configured.</p>
            </div>
          )}

          {mode === 'sample' && (
            <div>
              <label className={LABEL}>Sample JSON body</label>
              <textarea
                value={sampleBody}
                onChange={(e) => setSampleBody(e.target.value)}
                rows={6}
                placeholder={'{\n  "email": "ada@example.com",\n  "age": 36\n}'}
                className={`${INPUT} font-mono text-[11.5px] resize-y`}
              />
            </div>
          )}

          {mode === 'manual' && (
            <div className="space-y-2">
              {fields.map((f, i) => {
                const numeric = f.type === 'int' || f.type === 'float';
                return (
                  <div key={i} className="flex items-center gap-1.5 flex-wrap">
                    <input
                      value={f.name}
                      onChange={(e) => patchField(i, { name: e.target.value })}
                      placeholder="field name"
                      className={`${FIELD} flex-1 min-w-[120px]`}
                    />
                    <select value={f.type} onChange={(e) => patchField(i, { type: e.target.value })} className={FIELD}>
                      {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    {numeric && (
                      <>
                        <input
                          type="number"
                          value={f.min ?? ''}
                          onChange={(e) => patchField(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })}
                          placeholder="min"
                          className={`${FIELD} w-16`}
                        />
                        <input
                          type="number"
                          value={f.max ?? ''}
                          onChange={(e) => patchField(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })}
                          placeholder="max"
                          className={`${FIELD} w-16`}
                        />
                      </>
                    )}
                    {f.type === 'enum' && (
                      <input
                        value={(f.options || []).join(', ')}
                        onChange={(e) => {
                          const opts = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                          patchField(i, { options: opts.length ? opts : undefined });
                        }}
                        placeholder="a, b, c"
                        className={`${FIELD} flex-1 min-w-[120px]`}
                      />
                    )}
                    <label className="flex items-center gap-1 text-[11px] text-gray-500 cursor-pointer select-none">
                      <input type="checkbox" checked={!!f.pii} onChange={(e) => patchField(i, { pii: e.target.checked })} className="accent-[#7C3AED]" />
                      PII
                    </label>
                    <button
                      type="button"
                      onClick={() => removeField(i)}
                      className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                      aria-label="Remove field"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
              <button type="button" onClick={addField} className={SECONDARY_BTN}>
                <Plus className="w-3.5 h-3.5" />Add field
              </button>
            </div>
          )}

          {/* Options */}
          <div className="flex items-end gap-3 flex-wrap pt-1">
            <div className="w-24">
              <label className={LABEL}>Count</label>
              <input type="number" min={1} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} className={INPUT} />
            </div>
            <div className="w-28">
              <label className={LABEL}>Seed</label>
              <input type="number" value={seedInput} onChange={(e) => setSeedInput(e.target.value)} placeholder="random" className={INPUT} />
            </div>
            <label className="flex items-center gap-1.5 text-[12px] text-gray-600 py-2 cursor-pointer select-none">
              <input type="checkbox" checked={piiMask} onChange={(e) => setPiiMask(e.target.checked)} className="accent-[#7C3AED]" />
              Mask PII
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-gray-600 py-2 cursor-pointer select-none">
              <input type="checkbox" checked={edgeCases} onChange={(e) => setEdgeCases(e.target.checked)} className="accent-[#7C3AED]" />
              Add edge cases
            </label>
            <button type="button" onClick={() => void generate()} disabled={loading} className={`${PRIMARY_BTN} ml-auto`}>
              {loading ? <Spinner className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              Generate
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
              <p className="text-[12px] text-red-700">{error}</p>
            </div>
          )}

          {result && (
            <div className="space-y-3">
              {result.notes.length > 0 && (
                <div className="space-y-0.5">
                  {result.notes.map((n, i) => <p key={i} className="text-[11px] text-gray-400 leading-relaxed">{n}</p>)}
                </div>
              )}

              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-[11.5px]">
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]">
                    seed <span className="font-mono font-semibold">{result.seed}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setSeedInput(String(result.seed))}
                    className="text-[11px] text-gray-500 underline-offset-2 hover:text-[#7C3AED] hover:underline"
                  >
                    reuse seed
                  </button>
                  <span className="text-[11px] text-gray-400">{result.rows.length} row{result.rows.length === 1 ? '' : 's'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => triggerDownload('synthetic-data.csv', result.csv, 'text/csv')} className={SECONDARY_BTN}>
                    <Download className="w-3.5 h-3.5" />CSV
                  </button>
                  <button type="button" onClick={() => triggerDownload('synthetic-data.json', JSON.stringify(result.rows, null, 2), 'application/json')} className={SECONDARY_BTN}>
                    <Download className="w-3.5 h-3.5" />JSON
                  </button>
                </div>
              </div>

              <div className="overflow-auto border border-[#E9E5FB] rounded-lg max-h-72">
                <table className="w-full text-left border-collapse">
                  <thead className={`${THEAD} sticky top-0`}>
                    <tr>
                      {result.columns.map((c) => (
                        <th key={c} className="px-2.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 whitespace-nowrap border-b border-gray-100">
                          <span className="inline-flex items-center gap-1">
                            {piiCols.has(c) && <Lock className="w-3 h-3 text-[#7C3AED]" />}
                            {c}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row, ri) => (
                      <tr key={ri} className="even:bg-gray-50/40">
                        {result.columns.map((c) => (
                          <td key={c} className="px-2.5 py-1 font-mono text-[11px] text-gray-700 max-w-[180px] truncate border-b border-gray-50" title={cell(row[c])}>
                            {cell(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.rows.length > preview.length && (
                <p className="text-[10.5px] text-gray-400">Showing first {preview.length} of {result.rows.length} rows — download for the full set.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

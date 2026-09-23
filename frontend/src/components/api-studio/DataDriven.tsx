/**
 * DataDriven — parameterised, table-driven testing for one endpoint.
 *
 * Opt-in and standalone. Pick an endpoint, paste a dataset (JSON rows or CSV),
 * and the endpoint runs once per row with `{{placeholder}}` values substituted
 * in. Each row passes when the response meets its expected status (a per-row
 * `expectedStatus` column, else the endpoint's, else any 2xx). It live-probes
 * the API and changes nothing in the catalogue or the pipeline.
 */
import { useMemo, useState } from 'react';
import { X, Loader2, Table2, AlertTriangle, Play, CheckCircle2, XCircle } from 'lucide-react';
import { runApiDataDriven, type DataDrivenReport } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Every {{name}} referenced anywhere in the endpoint's request. */
function placeholdersOf(e: CatalogEndpoint): string[] {
  const hay = [e.url, e.body || '', ...(e.headers || []).flatMap((h) => [h.key, h.value]), e.auth?.value || ''].join(' ');
  const found = new Set<string>();
  for (const m of hay.matchAll(PLACEHOLDER)) found.add(m[1]);
  return [...found];
}

/** Split one CSV line, honouring double-quoted fields with escaped quotes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parse the dataset textarea as a JSON array of objects, or as CSV with a header row. */
function parseDataset(text: string): { rows: Record<string, string>[]; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { rows: [] };
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const rows = arr.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
      if (rows.length === 0) return { rows: [], error: 'JSON must be an array of objects (one per row).' };
      return { rows };
    } catch (e: any) {
      return { rows: [], error: `Invalid JSON: ${e?.message || 'could not parse'}` };
    }
  }
  // CSV
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], error: 'CSV needs a header row and at least one data row.' };
  const headers = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) row[h] = cells[i] ?? ''; });
    return row;
  });
  return { rows };
}

export default function DataDriven({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [text, setText] = useState('');
  const [report, setReport] = useState<DataDrivenReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ep = endpoints[Math.min(idx, endpoints.length - 1)];
  const vars = useMemo(() => (ep ? placeholdersOf(ep) : []), [ep]);
  const parsed = useMemo(() => parseDataset(text), [text]);

  const run = async () => {
    if (!ep) return;
    if (parsed.error) { setError(parsed.error); return; }
    if (parsed.rows.length === 0) { setError('Add at least one data row.'); return; }
    setLoading(true); setError(''); setReport(null);
    try {
      setReport(await runApiDataDriven(
        { id: ep.id, title: ep.title, method: ep.method, url: ep.url, headers: ep.headers, auth: ep.auth, body: ep.body, expectedStatus: ep.expectedStatus },
        parsed.rows,
      ));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Data-driven run failed.');
    } finally {
      setLoading(false);
    }
  };

  const s = report?.summary;
  const valueKeys = report ? [...new Set(report.results.flatMap((r) => Object.keys(r.values)))].slice(0, 6) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Table2 className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Data-driven testing</h3>
          <span className="text-[11px] text-gray-400">one endpoint × many rows</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div>
            <label className={LABEL}>Endpoint</label>
            <select value={idx} onChange={(e) => { setIdx(Number(e.target.value)); setReport(null); }} className={INPUT}>
              {endpoints.map((e, i) => <option key={e.id} value={i}>{e.method} {e.url}</option>)}
            </select>
          </div>

          {ep && (
            <div className="flex items-center gap-2 text-[11.5px] text-gray-500">
              <MethodBadge method={ep.method} /><span className="font-mono truncate">{ep.url}</span>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={LABEL}>Dataset — JSON rows or CSV</label>
              {vars.length > 0 && (
                <span className="text-[10.5px] text-gray-400">
                  columns to fill:{' '}
                  {vars.map((v) => <code key={v} className="font-mono text-[#6D28D9] bg-[#F5F3FF] rounded px-1 mr-1">{v}</code>)}
                </span>
              )}
            </div>
            <textarea
              value={text}
              onChange={(e) => { setText(e.target.value); setError(''); }}
              rows={6}
              spellCheck={false}
              placeholder={vars.length
                ? `[\n  { ${vars.map((v) => `"${v}": "…"`).join(', ')}, "expectedStatus": 200 }\n]\n\n— or CSV —\n${[...vars, 'expectedStatus'].join(',')}\n${vars.map(() => '…').concat('200').join(',')}`
                : '[\n  { "id": "1", "expectedStatus": 200 },\n  { "id": "999", "expectedStatus": 404 }\n]'}
              className={`${INPUT} font-mono text-[11.5px] leading-relaxed resize-y`}
            />
            <p className="text-[10.5px] text-gray-400 mt-1">
              Each row runs the endpoint once with its <code className="font-mono">{'{{placeholders}}'}</code> filled in. Add an <code className="font-mono">expectedStatus</code> column to assert per row.
              {parsed.rows.length > 0 && <span className="text-emerald-600 font-medium"> · {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} ready</span>}
            </p>
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={() => void run()} disabled={loading || !ep || parsed.rows.length === 0} className={PRIMARY_BTN}>
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {loading ? 'Running…' : `Run ${parsed.rows.length || ''} row${parsed.rows.length === 1 ? '' : 's'}`}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {report && s && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold text-emerald-700 bg-emerald-50 border-emerald-200"><CheckCircle2 className="w-3.5 h-3.5" />{s.passed} passed</span>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold ${s.failed ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-500 bg-gray-50 border-gray-200'}`}><XCircle className="w-3.5 h-3.5" />{s.failed} failed</span>
                <span className="ml-auto text-[11px] text-gray-400 tabular-nums">avg {s.avgMs}ms · {s.total} rows</span>
              </div>
              <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-[11.5px]">
                    <thead>
                      <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                        <th className="font-semibold px-2.5 py-1.5 w-8">#</th>
                        {valueKeys.map((k) => <th key={k} className="font-semibold px-2.5 py-1.5 font-mono">{k}</th>)}
                        <th className="font-semibold px-2.5 py-1.5 text-right">status</th>
                        <th className="font-semibold px-2.5 py-1.5 text-right w-14"> </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {report.results.map((r) => (
                        <tr key={r.index} className={r.pass ? '' : 'bg-red-50/40'}>
                          <td className="px-2.5 py-1.5 text-gray-400 tabular-nums">{r.index + 1}</td>
                          {valueKeys.map((k) => <td key={k} className="px-2.5 py-1.5 font-mono text-gray-700 max-w-[160px] truncate" title={r.values[k]}>{r.values[k] ?? ''}</td>)}
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">
                            {r.reachable
                              ? <span className={r.pass ? 'text-emerald-700' : 'text-red-700'}>{r.status}{r.expectedStatus !== undefined && r.status !== r.expectedStatus ? ` ≠${r.expectedStatus}` : ''}</span>
                              : <span className="text-amber-600" title={r.error}>unreachable</span>}
                          </td>
                          <td className="px-2.5 py-1.5 text-right">
                            {r.pass ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 inline" /> : <XCircle className="w-3.5 h-3.5 text-red-500 inline" />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

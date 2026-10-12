/**
 * DataClassify — PII / secrets scan + shadow-API detection over the catalogue.
 *
 * Scans the request/response bodies and URLs of the endpoint catalogue for
 * sensitive data using field-name + value-shape heuristics, then grades the
 * exposure. Shadow APIs (endpoints seen in traffic but absent from the
 * catalogue) only surface when a captured traffic session is scanned; a
 * catalogue scan asserts nothing live. A posture snapshot, not a DLP audit.
 */
import { useState } from 'react';
import { X, Fingerprint, Play, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { classifyData, type ClassifyReport, type DataSeverity } from '@/services/api';
import { CARD, STRIP, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

function gradeCls(g: string): string {
  if (g === 'A' || g === 'B') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (g === 'C') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-red-700 bg-red-50 border-red-200';
}

function severityCls(s: DataSeverity): string {
  if (s === 'high') return 'text-red-700 bg-red-50 border-red-200';
  if (s === 'medium') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

export default function DataClassify({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [result, setResult] = useState<ClassifyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await classifyData(endpoints));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Data classification failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Fingerprint className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Data classification</h3>
          <span className="text-[11px] text-gray-400">PII/secrets + shadow APIs</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          <p className="text-[11.5px] text-gray-500">Scans the request/response bodies and URLs of {endpoints.length} endpoints for sensitive data.</p>

          <div className="flex items-center justify-end gap-2">
            {busy && <span className="text-[11px] text-gray-400">classifying…</span>}
            <button type="button" onClick={() => void run()} disabled={busy} className={PRIMARY_BTN}>
              {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {busy ? 'Classifying…' : 'Classify data'}
            </button>
          </div>

          {result && (
            <div className="space-y-3">
              {/* Grade + score + summary strip */}
              <div className="flex flex-wrap items-center gap-3">
                <span className={`inline-flex items-center justify-center w-12 h-12 rounded-xl border text-2xl font-bold ${gradeCls(result.grade)}`}>{result.grade}</span>
                <div>
                  <div className="text-[13px] font-semibold text-gray-900 tabular-nums">score {result.score}</div>
                  <div className="text-[11px] text-gray-400 tabular-nums">scanned {result.scanned}</div>
                </div>
                <span className="inline-flex items-center px-2 py-0.5 rounded border border-gray-200 bg-gray-50 text-[10.5px] font-medium text-gray-600">{result.source}</span>
                <div className="ml-auto flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums text-red-700 bg-red-50 border-red-200">{result.summary.high} high</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums text-amber-700 bg-amber-50 border-amber-200">{result.summary.medium} medium</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums text-gray-600 bg-gray-50 border-gray-200">{result.summary.low} low</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]">{result.summary.fields} fields</span>
                </div>
              </div>

              {/* Sensitivity map */}
              {result.sensitivity.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {result.sensitivity.map((s, i) => (
                    <span key={i} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] ${severityCls(s.severity)}`}>
                      {s.label} <span className="font-mono tabular-nums">×{s.count}</span>
                    </span>
                  ))}
                </div>
              )}

              {/* Shadow APIs */}
              {result.shadowApis.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Shadow APIs (seen but undocumented)</div>
                  <div className="flex flex-col gap-1">
                    {result.shadowApis.map((s, i) => (
                      <div key={i} className="text-[11.5px] font-mono text-gray-700">{s.method} {s.path}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Findings */}
              {result.findings.length > 0 && (
                <div className="space-y-2">
                  {result.findings.map((f, i) => (
                    <div key={i} className="rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] p-3">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10.5px] font-medium ${severityCls(f.severity)}`}>{f.category} · {f.severity}</span>
                        <span className="text-[12px] font-mono text-gray-800 min-w-0">{f.field}</span>
                        <span className="inline-flex items-center px-2 py-0.5 rounded border border-gray-200 bg-gray-50 text-[10px] text-gray-500">{f.location}</span>
                        <span className="ml-auto text-[10.5px] font-mono text-gray-400 min-w-0 truncate">{f.endpoint}</span>
                      </div>
                      {f.sample && <p className="text-[10.5px] text-gray-400 font-mono whitespace-pre-wrap break-words">{f.sample}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-[10px] text-gray-400">Field-name + value-shape detection. Capture a traffic session to also flag shadow APIs.</p>
        </div>
      </div>
    </div>
  );
}

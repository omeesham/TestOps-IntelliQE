/**
 * SpecAudit — 42Crunch-style static audit of an OpenAPI / Swagger definition.
 *
 * Scores a pasted spec on its own merits — security schemes, response/schema
 * validation, transport hygiene — and grades it (A–F) with an OWASP-tagged
 * findings list and an optional CI gate (min score / max critical / max high).
 * This inspects the definition only; it is distinct from the runtime security
 * scan that exercises the live endpoints.
 */
import { useState } from 'react';
import { X, FileSearch, Play, AlertTriangle, CheckCircle2, Ban } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { auditOpenApiSpec, type SpecAuditReport, type AuditFinding, type AuditSeverity } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const SEVERITY_ORDER: AuditSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function gradeCls(g: string): string {
  if (g === 'A' || g === 'B') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (g === 'C') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-red-700 bg-red-50 border-red-200';
}

function severityCls(s: string): string {
  if (s === 'critical' || s === 'high') return 'text-red-700 bg-red-50 border-red-200';
  if (s === 'medium') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

function scoreTone(n: number): { text: string; bg: string; bar: string } {
  if (n >= 75) return { text: 'text-emerald-700', bg: 'bg-emerald-50', bar: 'bg-emerald-500' };
  if (n >= 50) return { text: 'text-amber-700', bg: 'bg-amber-50', bar: 'bg-amber-500' };
  return { text: 'text-red-700', bg: 'bg-red-50', bar: 'bg-red-500' };
}

const CATEGORY_META: { key: 'security' | 'dataValidation' | 'transport'; label: string }[] = [
  { key: 'security', label: 'Security' },
  { key: 'dataValidation', label: 'Data validation' },
  { key: 'transport', label: 'Transport' },
];

export default function SpecAudit({ onClose }: { endpoints?: CatalogEndpoint[]; onClose: () => void }) {
  const [spec, setSpec] = useState('');
  const [minScore, setMinScore] = useState<string>('');
  const [maxCritical, setMaxCritical] = useState<string>('');
  const [maxHigh, setMaxHigh] = useState<string>('');
  const [result, setResult] = useState<SpecAuditReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      const gate: { minScore?: number; maxCritical?: number; maxHigh?: number } = {};
      if (minScore.trim() !== '') gate.minScore = Number(minScore);
      if (maxCritical.trim() !== '') gate.maxCritical = Number(maxCritical);
      if (maxHigh.trim() !== '') gate.maxHigh = Number(maxHigh);
      const hasGate = Object.keys(gate).length > 0;
      setResult(await auditOpenApiSpec(spec, hasGate ? gate : undefined));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Spec audit failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <FileSearch className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">OpenAPI security audit</h3>
          <span className="text-[11px] text-gray-400">42Crunch-style spec scoring</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          <div>
            <label className={LABEL}>OpenAPI / Swagger document (JSON or YAML)</label>
            <textarea
              rows={10}
              value={spec}
              onChange={(e) => { setSpec(e.target.value); setResult(null); }}
              placeholder="Paste your openapi.json / openapi.yaml…"
              className={`${INPUT} font-mono resize-y`}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={LABEL}>Min score</label>
              <input type="number" min={0} max={100} placeholder="no gate" value={minScore} onChange={(e) => setMinScore(e.target.value)} className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Max critical</label>
              <input type="number" min={0} placeholder="no gate" value={maxCritical} onChange={(e) => setMaxCritical(e.target.value)} className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Max high</label>
              <input type="number" min={0} placeholder="no gate" value={maxHigh} onChange={(e) => setMaxHigh(e.target.value)} className={INPUT} />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            {busy && <span className="text-[11px] text-gray-400">auditing spec…</span>}
            <button type="button" onClick={() => void run()} disabled={busy || spec.trim().length < 20} className={PRIMARY_BTN}>
              {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {busy ? 'Auditing…' : 'Run audit'}
            </button>
          </div>

          {result && (
            <div className="space-y-3">
              {/* Grade + score + title */}
              <div className="flex flex-wrap items-center gap-3">
                <span className={`inline-flex items-center justify-center w-12 h-12 rounded-xl border text-2xl font-bold ${gradeCls(result.grade)}`}>{result.grade}</span>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-gray-900 truncate">{result.title}</div>
                  <div className="text-[11px] text-gray-400 tabular-nums">score {result.score} · {result.version} · {result.operations} operations</div>
                </div>
              </div>

              {/* Category mini-bars */}
              <div className="grid grid-cols-3 gap-2">
                {CATEGORY_META.map(({ key, label }) => {
                  const v = Math.max(0, Math.min(100, result.categories[key]));
                  const tone = scoreTone(v);
                  return (
                    <div key={key} className={`rounded-lg border border-[#E9E5FB] p-2.5 ${tone.bg}`}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">{label}</span>
                        <span className={`text-[12px] font-bold tabular-nums ${tone.text}`}>{v}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-white/70 overflow-hidden">
                        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${v}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Severity summary chips */}
              <div className="flex flex-wrap gap-1.5">
                {SEVERITY_ORDER.map((s) => (
                  <span key={s} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums ${severityCls(s)}`}>
                    {result.summary[s] ?? 0} {s}
                  </span>
                ))}
              </div>

              {/* CI gate */}
              <div className="space-y-1.5">
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11.5px] font-medium ${result.gate.passed ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>
                  {result.gate.passed ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                  {result.gate.passed ? 'CI gate passed' : 'CI gate failed'}
                </span>
                {result.gate.reasons.length > 0 && (
                  <ul className="space-y-1">
                    {result.gate.reasons.map((r, i) => <li key={i} className="text-[11px] text-gray-500 flex gap-1.5"><span className="text-[#7C3AED]">•</span><span className="min-w-0">{r}</span></li>)}
                  </ul>
                )}
              </div>

              {/* Findings */}
              <div className="space-y-2">
                {result.findings.map((f: AuditFinding) => (
                  <div key={f.id} className="rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10.5px] font-medium ${severityCls(f.severity)}`}>{f.severity}</span>
                      {f.owasp && <span className="inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]">{f.owasp}</span>}
                    </div>
                    <p className="text-[11.5px] text-gray-700 whitespace-pre-wrap break-words">{f.message}</p>
                    {f.pointer && <p className="text-[10.5px] text-gray-400 font-mono truncate mt-1" title={f.pointer}>{f.pointer}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[10px] text-gray-400">Static audit of the definition — distinct from the runtime security scan.</p>
        </div>
      </div>
    </div>
  );
}

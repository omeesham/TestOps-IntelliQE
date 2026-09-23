/**
 * ContractCheck — the schema/contract validation dialog.
 *
 * Opt-in and standalone: it live-probes the endpoints handed to it and shows
 * how each response measures up to its contract — status, JSON body, and the
 * response schema (an explicit one, or one inferred from the imported example).
 * It reads the live API; it changes nothing in the catalogue or the pipeline.
 */
import { useEffect, useState } from 'react';
import { X, Loader2, CheckCircle2, XCircle, AlertTriangle, ShieldCheck, RefreshCw } from 'lucide-react';
import { validateApiContract, type ContractReport, type ContractResult } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, RAISED } from './format';
import type { CatalogEndpoint } from './types';

/** The subset of an endpoint the contract check needs. */
function toPayload(e: CatalogEndpoint) {
  return {
    id: e.id, title: e.title, method: e.method, url: e.url,
    headers: e.headers, auth: e.auth, body: e.body,
    expectedStatus: e.expectedStatus, expectedResponse: e.expectedResponse,
  };
}

function outcomeOf(r: ContractResult): 'pass' | 'fail' | 'unreachable' {
  if (!r.reachable) return 'unreachable';
  if (!r.statusOk || (r.schemaChecked && !r.schemaValid)) return 'fail';
  return 'pass';
}

export default function ContractCheck({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [report, setReport] = useState<ContractReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try {
      setReport(await validateApiContract(endpoints.map(toPayload)));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Validation failed.');
    } finally {
      setLoading(false);
    }
  };
  // Runs once when opened; the endpoints are fixed for the dialog's lifetime.
  useEffect(() => { void run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const s = report?.summary;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ShieldCheck className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Contract validation</h3>
          <span className="text-[11px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} · live-probed against their schema</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={() => void run()} disabled={loading} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF] disabled:opacity-40" title="Re-run">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]" title="Close"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {/* Summary */}
        {s && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
            <SummaryPill icon={CheckCircle2} label="Passed" value={s.passed} tone="good" />
            <SummaryPill icon={XCircle} label="Failed" value={s.failed} tone={s.failed ? 'bad' : 'muted'} />
            <SummaryPill icon={AlertTriangle} label="Unreachable" value={s.unreachable} tone={s.unreachable ? 'warn' : 'muted'} />
            <span className="ml-auto text-[11px] text-gray-400">{s.checkedSchema} schema-checked</span>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Loader2 className="w-4 h-4 animate-spin text-[#7C3AED]" />Probing {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'}…</div>
          ) : error ? (
            <div className="flex items-start gap-2 m-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
              <p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          ) : report ? (
            <div className="divide-y divide-gray-100">
              {report.results.map((r) => <ResultRow key={r.id} r={r} />)}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SummaryPill({ icon: Icon, label, value, tone }: { icon: React.ElementType; label: string; value: number; tone: 'good' | 'bad' | 'warn' | 'muted' }) {
  const cls = {
    good: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    bad: 'text-red-700 bg-red-50 border-red-200',
    warn: 'text-amber-700 bg-amber-50 border-amber-200',
    muted: 'text-gray-500 bg-gray-50 border-gray-200',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold ${cls} ${RAISED}`}>
      <Icon className="w-3.5 h-3.5" />{value} {label}
    </span>
  );
}

function ResultRow({ r }: { r: ContractResult }) {
  const outcome = outcomeOf(r);
  const dot = outcome === 'pass' ? 'bg-emerald-500' : outcome === 'fail' ? 'bg-red-500' : 'bg-amber-500';
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
        <MethodBadge method={r.method} />
        <span className="text-[12px] text-gray-800 min-w-0 flex-1 truncate" title={r.url}>{r.title}</span>
        {r.status !== undefined && <span className="font-mono text-[10.5px] text-gray-500 tabular-nums flex-shrink-0">{r.status}</span>}
        {r.elapsedMs !== undefined && <span className="font-mono text-[10px] text-gray-400 tabular-nums flex-shrink-0">{r.elapsedMs}ms</span>}
        {r.schemaChecked && (
          <span className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded border flex-shrink-0 ${r.schemaValid ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>
            schema {r.schemaValid ? 'ok' : 'drift'}
          </span>
        )}
      </div>
      {r.violations.length > 0 && (
        <ul className="mt-1 ml-4 space-y-0.5">
          {r.violations.slice(0, 8).map((v, i) => (
            <li key={i} className="flex gap-1.5 text-[11px] text-gray-600">
              <span className={`font-mono text-[9.5px] font-semibold uppercase px-1 rounded flex-shrink-0 ${v.kind === 'transport' ? 'text-amber-700 bg-amber-50' : 'text-red-700 bg-red-50'}`}>{v.kind}</span>
              <span className="min-w-0 font-mono">{v.message}</span>
            </li>
          ))}
          {r.violations.length > 8 && <li className="text-[10.5px] text-gray-400 ml-1">…and {r.violations.length - 8} more</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * FuzzTest — AI-guided fuzzing / property-based robustness.
 *
 * Derives boundary, type-confusion and malformed inputs from each endpoint's own
 * parameters, fires them one at a time, and reports where the API breaks: 5xx
 * crashes, leaked stack traces, reflected payloads, hangs and weak validation.
 * Opt-in and isolated from the pipeline; only read methods are fuzzed and write
 * methods are never replayed with mutated data.
 */
import { useEffect, useState } from 'react';
import { X, Bug, AlertTriangle, RefreshCw, CheckCircle2, ShieldAlert, Zap, Eye, Timer } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runApiFuzz, type FuzzReport, type FuzzFinding } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP } from './format';
import type { CatalogEndpoint } from './types';

const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
const KIND_ICON: Record<string, typeof Bug> = { 'server-error': ShieldAlert, 'info-leak': ShieldAlert, reflection: Eye, timeout: Timer, 'weak-validation': AlertTriangle };

export default function FuzzTest({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [report, setReport] = useState<FuzzReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try {
      setReport(await runApiFuzz(endpoints.map((e) => ({ id: e.id, title: e.title, method: e.method, url: e.url, headers: e.headers, auth: e.auth, queryParams: e.queryParams }))));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Fuzz run failed.');
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run(); }, []);

  const s = report?.summary;
  const issues = (report?.findings || []).filter((f) => f.severity !== 'info').sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const clean = (report?.findings || []).filter((f) => f.severity === 'info');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Bug className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Fuzz / property-based test</h3>
          <span className="text-[11px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} · non-destructive, read methods</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={() => void run()} disabled={loading} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF] disabled:opacity-40" title="Re-run">{loading ? <Spinner className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}</button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {s && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
            <Stat label="Crashes" value={s.crashes} tone="high" icon={ShieldAlert} />
            <Stat label="Leaks" value={s.leaks} tone="high" icon={ShieldAlert} />
            <Stat label="Reflections" value={s.reflections} tone="medium" icon={Eye} />
            <Stat label="Timeouts" value={s.timeouts} tone="medium" icon={Timer} />
            <Stat label="Weak validation" value={s.weakValidation} tone="low" icon={AlertTriangle} />
            <span className="ml-auto text-[11px] text-gray-400 inline-flex items-center gap-1"><Zap className="w-3.5 h-3.5" />{s.cases} payload{s.cases === 1 ? '' : 's'} fired</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Fuzzing {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} with boundary & malformed inputs…</div>
          ) : error ? (
            <div className="flex items-start gap-2 m-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>
          ) : report ? (
            <div>
              {issues.length === 0 ? (
                <div className="flex items-center gap-2 m-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-[12px] text-emerald-800"><CheckCircle2 className="w-4 h-4 text-emerald-600" />Every fuzzed input was handled cleanly — no crashes, leaks or reflections.</div>
              ) : (
                <div className="divide-y divide-gray-100">{issues.map((f, i) => <Finding key={i} f={f} />)}</div>
              )}
              {clean.length > 0 && (
                <details className="px-4 py-3 border-t border-gray-100">
                  <summary className="cursor-pointer text-[11px] font-medium text-gray-500 hover:text-[#7C3AED]">{clean.length} handled / skipped case{clean.length === 1 ? '' : 's'}</summary>
                  <div className="mt-2 divide-y divide-gray-50">{clean.slice(0, 60).map((f, i) => <Finding key={i} f={f} muted />)}</div>
                </details>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, icon: Icon }: { label: string; value: number; tone: 'high' | 'medium' | 'low'; icon: typeof Bug }) {
  const cls = {
    high: value ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-400 bg-gray-50 border-gray-200',
    medium: value ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-gray-400 bg-gray-50 border-gray-200',
    low: value ? 'text-gray-700 bg-gray-100 border-gray-300' : 'text-gray-400 bg-gray-50 border-gray-200',
  }[tone];
  return <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-semibold tabular-nums ${cls}`}><Icon className="w-3 h-3" />{value} {label}</span>;
}

function Finding({ f, muted = false }: { f: FuzzFinding; muted?: boolean }) {
  const sev = {
    high: 'text-red-700 bg-red-50 border-red-200',
    medium: 'text-amber-700 bg-amber-50 border-amber-200',
    low: 'text-gray-600 bg-gray-100 border-gray-300',
    info: 'text-blue-700 bg-blue-50 border-blue-200',
  }[f.severity];
  const Icon = KIND_ICON[f.kind];
  return (
    <div className={`px-4 py-2.5 ${muted ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 inline-flex items-center gap-1 ${sev}`}>{Icon && <Icon className="w-3 h-3" />}{f.kind}</span>
        <MethodBadge method={f.method} />
        <span className="text-[11.5px] text-gray-600 min-w-0 flex-1 truncate" title={f.url}>{f.title}</span>
        {f.status !== undefined && <span className="text-[10px] font-mono text-gray-400 flex-shrink-0">{f.status || '—'}</span>}
      </div>
      <p className="mt-1 ml-1 text-[11px] text-gray-600 leading-relaxed">{f.detail}</p>
      {f.param !== '—' && (
        <p className="mt-0.5 ml-1 text-[10px] text-gray-400 font-mono truncate">param <span className="text-gray-500">{f.param}</span> = <span className="text-gray-500">{f.payload === '' ? '(empty)' : f.payload}</span></p>
      )}
    </div>
  );
}

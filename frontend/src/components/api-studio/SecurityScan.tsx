/**
 * SecurityScan — the standalone OWASP-lite security dialog.
 *
 * Runs a bounded, non-destructive set of checks (broken auth, injection
 * handling, security headers, CORS, transport, info leaks) against the chosen
 * endpoints and lists findings by severity. Opt-in and isolated from the
 * pipeline; write endpoints are only header-inspected, never attacked.
 */
import { useEffect, useState } from 'react';
import { X, Loader2, ShieldAlert, AlertTriangle, RefreshCw, CheckCircle2 } from 'lucide-react';
import { runApiSecurityScan, type SecurityReport, type SecurityFinding } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP } from './format';
import type { CatalogEndpoint } from './types';

const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };

export default function SecurityScan({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [report, setReport] = useState<SecurityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try {
      setReport(await runApiSecurityScan(endpoints.map((e) => ({ id: e.id, title: e.title, method: e.method, url: e.url, headers: e.headers, auth: e.auth, body: e.body }))));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Security scan failed.');
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run(); }, []);

  const s = report?.summary;
  const vulnerable = (report?.findings || []).filter((f) => f.status === 'vulnerable')
    .sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]));
  const clean = (report?.findings || []).filter((f) => f.status !== 'vulnerable');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ShieldAlert className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Security scan</h3>
          <span className="text-[11px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} · non-destructive OWASP-lite</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={() => void run()} disabled={loading} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF] disabled:opacity-40" title="Re-run">{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}</button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {s && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
            <SevPill label="High" value={s.high} tone="high" />
            <SevPill label="Medium" value={s.medium} tone="medium" />
            <SevPill label="Low" value={s.low} tone="low" />
            <span className="ml-auto text-[11px] text-gray-400">{s.vulnerable} finding{s.vulnerable === 1 ? '' : 's'} across {s.endpoints} endpoint{s.endpoints === 1 ? '' : 's'}</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Loader2 className="w-4 h-4 animate-spin text-[#7C3AED]" />Scanning {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'}…</div>
          ) : error ? (
            <div className="flex items-start gap-2 m-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>
          ) : report ? (
            <div>
              {vulnerable.length === 0 ? (
                <div className="flex items-center gap-2 m-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-[12px] text-emerald-800"><CheckCircle2 className="w-4 h-4 text-emerald-600" />No vulnerabilities flagged by the checks that ran.</div>
              ) : (
                <div className="divide-y divide-gray-100">{vulnerable.map((f, i) => <Finding key={i} f={f} />)}</div>
              )}
              {clean.length > 0 && (
                <details className="px-4 py-3 border-t border-gray-100">
                  <summary className="cursor-pointer text-[11px] font-medium text-gray-500 hover:text-[#7C3AED]">{clean.length} passed / informational check{clean.length === 1 ? '' : 's'}</summary>
                  <div className="mt-2 divide-y divide-gray-50">{clean.map((f, i) => <Finding key={i} f={f} muted />)}</div>
                </details>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SevPill({ label, value, tone }: { label: string; value: number; tone: 'high' | 'medium' | 'low' }) {
  const cls = {
    high: value ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-400 bg-gray-50 border-gray-200',
    medium: value ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-gray-400 bg-gray-50 border-gray-200',
    low: value ? 'text-gray-700 bg-gray-100 border-gray-300' : 'text-gray-400 bg-gray-50 border-gray-200',
  }[tone];
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold tabular-nums ${cls}`}>{value} {label}</span>;
}

function Finding({ f, muted = false }: { f: SecurityFinding; muted?: boolean }) {
  const sev = {
    high: 'text-red-700 bg-red-50 border-red-200',
    medium: 'text-amber-700 bg-amber-50 border-amber-200',
    low: 'text-gray-600 bg-gray-100 border-gray-300',
    info: 'text-blue-700 bg-blue-50 border-blue-200',
  }[f.severity];
  return (
    <div className={`px-4 py-2.5 ${muted ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-2">
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${sev}`}>{f.severity}</span>
        <span className="text-[11px] font-mono font-semibold text-gray-700 flex-shrink-0">{f.check}</span>
        <MethodBadge method={f.method} />
        <span className="text-[11.5px] text-gray-600 min-w-0 flex-1 truncate" title={f.url}>{f.title}</span>
        {f.status === 'ok' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
        {f.status === 'skipped' && <span className="text-[9.5px] text-gray-400 flex-shrink-0">skipped</span>}
      </div>
      <p className="mt-1 ml-1 text-[11px] text-gray-600 leading-relaxed">{f.detail}</p>
    </div>
  );
}

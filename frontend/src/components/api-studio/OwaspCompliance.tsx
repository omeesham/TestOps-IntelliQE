/**
 * OwaspCompliance — the OWASP API Security Top-10 (2023) compliance pack.
 *
 * A boardroom-readable compliance posture for the chosen endpoints: one grade,
 * then all ten OWASP API categories with an honest per-category verdict
 * (pass / warn / fail / review / not assessed), how it was judged (dynamic probe
 * vs. static inventory heuristic), the endpoints it points at, and the exact
 * remediation. It reuses the non-destructive security scan and adds network-free
 * static checks — opt-in and isolated from the pipeline; write endpoints are
 * never attacked.
 */
import { useEffect, useState } from 'react';
import { X, ShieldCheck, AlertTriangle, RefreshCw, CheckCircle2, ShieldAlert, Search, MinusCircle, Radar, FileText } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runApiOwaspCompliance, type OwaspComplianceReport, type OwaspCategory, type OwaspStatus } from '@/services/api';
import { CARD, STRIP } from './format';
import type { CatalogEndpoint } from './types';

const STATUS_ORDER: Record<OwaspStatus, number> = { fail: 0, warn: 1, review: 2, pass: 3, not_assessed: 4 };

const STATUS_META: Record<OwaspStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  fail: { label: 'Fail', cls: 'text-red-700 bg-red-50 border-red-200', Icon: ShieldAlert },
  warn: { label: 'Warn', cls: 'text-amber-700 bg-amber-50 border-amber-200', Icon: AlertTriangle },
  review: { label: 'Review', cls: 'text-violet-700 bg-violet-50 border-violet-200', Icon: Search },
  pass: { label: 'Pass', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200', Icon: CheckCircle2 },
  not_assessed: { label: 'Not assessed', cls: 'text-gray-500 bg-gray-50 border-gray-200', Icon: MinusCircle },
};

function gradePalette(pct: number | null) {
  if (pct === null) return { text: 'text-gray-400', ring: '#D1D5DB', chip: 'text-gray-600 bg-gray-100 border-gray-200' };
  if (pct >= 80) return { text: 'text-emerald-600', ring: '#10B981', chip: 'text-emerald-700 bg-emerald-50 border-emerald-200' };
  if (pct >= 60) return { text: 'text-amber-600', ring: '#F59E0B', chip: 'text-amber-700 bg-amber-50 border-amber-200' };
  return { text: 'text-red-600', ring: '#EF4444', chip: 'text-red-700 bg-red-50 border-red-200' };
}

export default function OwaspCompliance({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [report, setReport] = useState<OwaspComplianceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try {
      setReport(await runApiOwaspCompliance(endpoints.map((e) => ({
        id: e.id, title: e.title, method: e.method, url: e.url, headers: e.headers, auth: e.auth, body: e.body,
        pathTemplate: e.pathTemplate, pathParams: e.pathParams, queryParams: e.queryParams, deprecated: e.deprecated,
      }))));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Compliance assessment failed.');
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run(); }, []);

  const s = report?.summary;
  const pct = s?.compliancePct ?? null;
  const g = gradePalette(pct);
  const R = 26, C = 2 * Math.PI * R;
  const dash = ((pct ?? 0) / 100) * C;
  const categories = [...(report?.categories || [])].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[86vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ShieldCheck className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">OWASP API Top-10</h3>
          <span className="text-[11px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} · 2023 compliance pack</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={() => void run()} disabled={loading} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF] disabled:opacity-40" title="Re-run">{loading ? <Spinner className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}</button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {s && (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-[#EDE9FE] flex-shrink-0">
            <div className="relative flex-shrink-0">
              <svg viewBox="0 0 64 64" className="w-16 h-16 -rotate-90">
                <circle cx="32" cy="32" r={R} fill="none" stroke="#EDE9FE" strokeWidth="6" />
                <circle cx="32" cy="32" r={R} fill="none" stroke={g.ring} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${dash} ${C}`} />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className={`text-[15px] font-bold tabular-nums leading-none ${g.text}`}>{pct === null ? '—' : `${pct}%`}</span>
              </div>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center justify-center w-6 h-6 rounded-lg border text-[13px] font-bold ${g.chip}`}>{s.grade ?? '—'}</span>
                <span className="text-[12.5px] font-semibold text-gray-900">Compliance grade {s.grade ?? 'n/a'}</span>
              </div>
              <p className="text-[10.5px] text-gray-500 mt-1">{s.assessed} of {s.total} categories assessed · {s.notAssessed} not assessable automatically</p>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <CountPill label="Pass" value={s.passed} tone="pass" />
              <CountPill label="Warn" value={s.warned} tone="warn" />
              <CountPill label="Fail" value={s.failed} tone="fail" />
              <CountPill label="Review" value={s.review} tone="review" />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Assessing {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} against the OWASP API Top-10…</div>
          ) : error ? (
            <div className="flex items-start gap-2 m-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>
          ) : report ? (
            <div className="divide-y divide-gray-100">
              {categories.map((c) => <CategoryRow key={c.id} c={c} />)}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CountPill({ label, value, tone }: { label: string; value: number; tone: OwaspStatus }) {
  const m = STATUS_META[tone];
  const cls = value ? m.cls : 'text-gray-400 bg-gray-50 border-gray-200';
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold tabular-nums ${cls}`}>{value} {label}</span>;
}

function CategoryRow({ c }: { c: OwaspCategory }) {
  const m = STATUS_META[c.status];
  const Icon = m.Icon;
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 inline-flex items-center gap-1 ${m.cls}`}><Icon className="w-3 h-3" />{m.label}</span>
        <span className="text-[10px] font-mono font-semibold text-gray-400 flex-shrink-0">{c.id}</span>
        <span className="text-[12.5px] font-semibold text-gray-800 min-w-0 flex-1 truncate" title={c.name}>{c.name}</span>
        {c.assessment !== 'none' && (
          <span className="text-[9px] uppercase tracking-wide text-gray-400 flex items-center gap-1 flex-shrink-0" title={c.assessment === 'dynamic' ? 'Judged by a live, non-destructive probe' : 'Judged by static analysis of the catalogue'}>
            {c.assessment === 'dynamic' ? <Radar className="w-3 h-3" /> : <FileText className="w-3 h-3" />}{c.assessment}
          </span>
        )}
      </div>
      <p className="mt-1.5 ml-0.5 text-[11.5px] text-gray-600 leading-relaxed">{c.summary}</p>

      {c.affected.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {c.affected.slice(0, 6).map((a, i) => (
            <span key={i} className="inline-flex max-w-[220px] truncate px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-[10px] text-gray-600" title={a}>{a}</span>
          ))}
          {c.affected.length > 6 && <span className="px-1.5 py-0.5 text-[10px] text-gray-400">+{c.affected.length - 6} more</span>}
        </div>
      )}

      {c.evidence.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[10.5px] font-medium text-gray-500 hover:text-[#7C3AED]">Evidence ({c.evidence.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {c.evidence.map((ev, i) => (
              <li key={i} className="flex gap-1.5 text-[10.5px] text-gray-500 leading-relaxed"><span className="text-gray-300 mt-px flex-shrink-0">›</span><span className="min-w-0">{ev}</span></li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-1.5 ml-0.5 text-[10.5px] text-gray-500 leading-relaxed"><span className="font-semibold text-gray-600">Fix:</span> {c.remediation}</p>
    </div>
  );
}

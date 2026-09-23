/**
 * ContractDrift — contract-drift maintenance.
 *
 * Opt-in and standalone. Live-probes the endpoints and compares each response
 * against the catalogue's stored expectations (status + example shape). Where
 * they have drifted, it offers a one-click "adopt" that writes the live value
 * back into the catalogue via the normal endpoint edit — so future generated
 * tests assert against today's contract. It reads the live API and edits only
 * catalogue metadata; the generate → execute → heal pipeline is untouched.
 */
import { useEffect, useState } from 'react';
import { X, Loader2, RefreshCw, GitPullRequestArrow, AlertTriangle, CheckCircle2, Check } from 'lucide-react';
import { scanApiDrift, type DriftReport, type DriftResult } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, RAISED, INSET } from './format';
import type { CatalogEndpoint } from './types';

function toPayload(e: CatalogEndpoint) {
  return { id: e.id, title: e.title, method: e.method, url: e.url, headers: e.headers, auth: e.auth, body: e.body, expectedStatus: e.expectedStatus, expectedResponse: e.expectedResponse };
}

export default function ContractDrift({ endpoints, onAdopt, onClose }: {
  endpoints: CatalogEndpoint[];
  onAdopt: (id: string, patch: { expectedStatus?: number; expectedResponse?: string }) => void;
  onClose: () => void;
}) {
  const [report, setReport] = useState<DriftReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adopted, setAdopted] = useState<Record<string, boolean>>({});

  const run = async () => {
    setLoading(true); setError(''); setReport(null); setAdopted({});
    try { setReport(await scanApiDrift(endpoints.map(toPayload))); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Drift scan failed.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const adopt = (r: DriftResult) => {
    const patch: { expectedStatus?: number; expectedResponse?: string } = {};
    if (r.suggestedStatus !== undefined) patch.expectedStatus = r.suggestedStatus;
    if (r.suggestedResponse !== undefined) patch.expectedResponse = r.suggestedResponse;
    if (Object.keys(patch).length === 0) return;
    onAdopt(r.id, patch);
    setAdopted((prev) => ({ ...prev, [r.id]: true }));
  };

  const s = report?.summary;
  const drifted = report?.results.filter((r) => r.reachable && (r.statusDrift || r.shapeDrift)) || [];
  const rest = report?.results.filter((r) => !(r.reachable && (r.statusDrift || r.shapeDrift))) || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <GitPullRequestArrow className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Contract drift</h3>
          <span className="text-[11px] text-gray-400">live vs. the catalogue's stored expectations</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={() => void run()} disabled={loading} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF] disabled:opacity-40" title="Re-scan">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
            <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {s && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
            <Pill icon={AlertTriangle} label="Drifted" value={s.drifted} tone={s.drifted ? 'bad' : 'muted'} />
            <Pill icon={CheckCircle2} label="In sync" value={s.clean} tone="good" />
            {s.unreachable > 0 && <Pill icon={AlertTriangle} label="Unreachable" value={s.unreachable} tone="warn" />}
            {s.noExpectation > 0 && <span className="ml-auto text-[11px] text-gray-400">{s.noExpectation} with no stored expectation</span>}
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Loader2 className="w-4 h-4 animate-spin text-[#7C3AED]" />Comparing {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} against the catalogue…</div>
          ) : error ? (
            <div className="flex items-start gap-2 m-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          ) : report ? (
            <div>
              {drifted.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                  <CheckCircle2 className="w-7 h-7 text-emerald-400" />
                  <p className="text-[12.5px] text-gray-500">No drift — every stored expectation still matches the live API.</p>
                </div>
              )}
              <div className="divide-y divide-gray-100">
                {drifted.map((r) => <DriftRow key={r.id} r={r} adopted={!!adopted[r.id]} onAdopt={() => adopt(r)} />)}
                {rest.map((r) => <QuietRow key={r.id} r={r} />)}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Pill({ icon: Icon, label, value, tone }: { icon: React.ElementType; label: string; value: number; tone: 'good' | 'bad' | 'warn' | 'muted' }) {
  const cls = {
    good: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    bad: 'text-red-700 bg-red-50 border-red-200',
    warn: 'text-amber-700 bg-amber-50 border-amber-200',
    muted: 'text-gray-500 bg-gray-50 border-gray-200',
  }[tone];
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold ${cls} ${RAISED}`}><Icon className="w-3.5 h-3.5" />{value} {label}</span>;
}

function DriftRow({ r, adopted, onAdopt }: { r: DriftResult; adopted: boolean; onAdopt: () => void }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full flex-shrink-0 bg-red-500" />
        <MethodBadge method={r.method} />
        <span className="text-[12px] text-gray-800 min-w-0 flex-1 truncate" title={r.url}>{r.title}</span>
        {r.statusDrift && <span className="font-mono text-[10px] text-red-600 tabular-nums flex-shrink-0">{r.storedStatus}→{r.liveStatus}</span>}
        {adopted ? (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-emerald-700 flex-shrink-0"><Check className="w-3.5 h-3.5" />Adopted</span>
        ) : (
          <button type="button" onClick={onAdopt} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[#DDD6FE] text-[10.5px] font-semibold text-[#6D28D9] bg-[#F5F3FF] hover:bg-[#EDE9FE] flex-shrink-0 ${RAISED}`}>
            <GitPullRequestArrow className="w-3 h-3" />Adopt live
          </button>
        )}
      </div>
      {r.changes.length > 0 && (
        <ul className="mt-1 ml-4 space-y-0.5">
          {r.changes.slice(0, 8).map((c, i) => (
            <li key={i} className="flex gap-1.5 text-[11px] text-gray-600">
              <span className={`font-mono text-[9.5px] font-semibold uppercase px-1 rounded flex-shrink-0 ${c.kind === 'added' ? 'text-emerald-700 bg-emerald-50' : c.kind === 'removed' ? 'text-red-700 bg-red-50' : 'text-amber-700 bg-amber-50'}`}>{c.kind}</span>
              <span className="min-w-0 font-mono"><span className="text-gray-800">{c.path}</span>{c.detail && <span className="text-gray-400"> {c.detail}</span>}</span>
            </li>
          ))}
          {r.changes.length > 8 && <li className="text-[10.5px] text-gray-400 ml-1">…and {r.changes.length - 8} more</li>}
        </ul>
      )}
      {r.suggestedResponse && !adopted && (
        <pre className={`mt-1.5 ml-4 font-mono text-[10.5px] text-gray-600 bg-[#FCFBFF] border border-[#E4E0F5] rounded-md p-2 max-h-28 overflow-auto ${INSET}`}>{r.suggestedResponse.slice(0, 600)}{r.suggestedResponse.length > 600 ? '\n…' : ''}</pre>
      )}
    </div>
  );
}

function QuietRow({ r }: { r: DriftResult }) {
  const state = !r.reachable ? 'unreachable' : (!r.hasStoredStatus && !r.hasStoredShape) ? 'none' : 'clean';
  const dot = state === 'clean' ? 'bg-emerald-500' : state === 'unreachable' ? 'bg-amber-500' : 'bg-gray-300';
  return (
    <div className="px-4 py-2 flex items-center gap-2 opacity-80">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
      <MethodBadge method={r.method} />
      <span className="text-[12px] text-gray-700 min-w-0 flex-1 truncate" title={r.url}>{r.title}</span>
      <span className="text-[10px] text-gray-400 flex-shrink-0">{state === 'clean' ? 'in sync' : state === 'unreachable' ? 'unreachable' : 'no expectation'}</span>
    </div>
  );
}

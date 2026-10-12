/**
 * AuthzDeep — deep authorization & data-exposure testing (multi-role).
 *
 * Goes beyond the BOLA/BFLA access matrix to probe the OWASP API classes that
 * hinge on what the response leaks and what a request can mutate: excessive
 * data exposure (API3), mass assignment (API6), broken-auth writes (API2) and
 * HTTP method tampering (API5). The tester defines two or more identities (the
 * first is the resource owner); each selected check runs across the catalog
 * per identity. State-changing probes are gated behind an explicit opt-in.
 * Opt-in and isolated from the pipeline.
 */
import { useState } from 'react';
import { X, ShieldHalf, ShieldAlert, AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runApiAuthzDeepScan, type DeepAuthzReport, type DeepAuthzFinding, type DeepAuthzCheck, type AuthzIdentityInput } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };

const CHECK_LABELS: Record<DeepAuthzCheck, string> = {
  'excessive-data': 'Excessive data exposure (API3)',
  'mass-assignment': 'Mass assignment (API6)',
  'unauth-write': 'Broken-auth write (API2)',
  'method-tamper': 'Method tampering (API5)',
};
const ALL_CHECKS = Object.keys(CHECK_LABELS) as DeepAuthzCheck[];

type IdentityRow = { label: string; type: string; value: string; headerName: string };
const blankIdentity = (label: string): IdentityRow => ({ label, type: 'bearer', value: '', headerName: '' });

export default function AuthzDeep({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [identities, setIdentities] = useState<IdentityRow[]>([blankIdentity('owner'), blankIdentity('user-b')]);
  const [checks, setChecks] = useState<DeepAuthzCheck[]>(ALL_CHECKS);
  const [allowWrites, setAllowWrites] = useState(false);
  const [report, setReport] = useState<DeepAuthzReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const setRow = (i: number, patch: Partial<IdentityRow>) => setIdentities((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setIdentities((rows) => [...rows, blankIdentity(`role-${rows.length + 1}`)]);
  const delRow = (i: number) => setIdentities((rows) => rows.filter((_, j) => j !== i));
  const toggleCheck = (c: DeepAuthzCheck) => setChecks((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try {
      const ids: AuthzIdentityInput[] = identities
        .filter((r) => r.label.trim())
        .map((r) => ({ label: r.label.trim(), auth: r.type === 'none' ? { type: 'none' } : { type: r.type, value: r.value, headerName: r.headerName || undefined } }));
      setReport(await runApiAuthzDeepScan(
        endpoints.map((e) => ({ id: e.id, title: e.title, method: e.method, url: e.url, headers: e.headers, body: e.body, owner: undefined })),
        ids,
        { allowWrites, checks },
      ));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Deep authorization scan failed.');
    } finally { setLoading(false); }
  };

  const s = report?.summary;
  const vulnerable = (report?.findings || []).filter((f) => f.status === 'vulnerable').sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const rest = (report?.findings || []).filter((f) => f.status !== 'vulnerable');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ShieldHalf className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Deep authorization & data-exposure</h3>
          <span className="text-[11px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} · {identities.length} identities</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Identities */}
        <div className="px-4 py-3 border-b border-[#EDE9FE] flex-shrink-0 space-y-2">
          <div className="flex items-center justify-between">
            <span className={LABEL + ' mb-0'}>Identities (first is the resource owner)</span>
            <button type="button" onClick={addRow} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6D28D9] hover:text-[#5B21B6]"><Plus className="w-3.5 h-3.5" />Add identity</button>
          </div>
          {identities.map((r, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} placeholder="label" className={`${FIELD} w-28 flex-shrink-0`} />
              <select value={r.type} onChange={(e) => setRow(i, { type: e.target.value })} className={`${FIELD} w-24 flex-shrink-0`}>
                <option value="bearer">Bearer</option>
                <option value="apikey">API key</option>
                <option value="basic">Basic</option>
                <option value="none">No auth</option>
              </select>
              {r.type !== 'none' && <input value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder={r.type === 'basic' ? 'user:pass' : 'token / key'} className={INPUT} type="password" />}
              {r.type === 'apikey' && <input value={r.headerName} onChange={(e) => setRow(i, { headerName: e.target.value })} placeholder="X-API-Key" className={`${FIELD} w-28 flex-shrink-0`} />}
              <button type="button" onClick={() => delRow(i)} disabled={identities.length <= 2} className="p-1 rounded text-gray-300 hover:text-red-500 disabled:opacity-30 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}

          {/* Checks */}
          <div className="pt-1">
            <span className={LABEL + ' mb-1'}>Checks to run</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {ALL_CHECKS.map((c) => (
                <label key={c} className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer">
                  <input type="checkbox" checked={checks.includes(c)} onChange={() => toggleCheck(c)} className="rounded border-gray-300" />
                  {CHECK_LABELS[c]}
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <label className="flex items-start gap-1.5 text-[11px] text-gray-500 cursor-pointer max-w-md">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="rounded border-gray-300 mt-0.5 flex-shrink-0" />
              <span><span className="font-medium text-gray-600">Allow writes</span> — mass-assignment, broken-auth-write and method-tampering send real state-changing requests</span>
            </label>
            <button type="button" onClick={() => void run()} disabled={loading || checks.length === 0} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <ShieldAlert className="w-3.5 h-3.5" />}Run scan
            </button>
          </div>
        </div>

        {s && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
            <SevPill label="High" value={s.high} tone="high" />
            <SevPill label="Medium" value={s.medium} tone="medium" />
            <SevPill label="Low" value={s.low} tone="low" />
            <span className="text-[11px] text-gray-400">{s.writesFired} write{s.writesFired === 1 ? '' : 's'} fired</span>
            <span className="ml-auto text-[11px] text-gray-400">{s.vulnerable} finding{s.vulnerable === 1 ? '' : 's'} across {s.endpoints} endpoint{s.endpoints === 1 ? '' : 's'}</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Running {checks.length} check{checks.length === 1 ? '' : 's'} across {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'}…</div>
          ) : error ? (
            <div className="flex items-start gap-2 m-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>
          ) : report ? (
            <div>
              {report.notes && report.notes.length > 0 && (
                <div className="px-4 pt-3 space-y-0.5">
                  {report.notes.map((n, i) => <p key={i} className="text-[11px] text-gray-400 leading-relaxed">{n}</p>)}
                </div>
              )}
              {vulnerable.length === 0 ? (
                <div className="flex items-center gap-2 m-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-[12px] text-emerald-800"><CheckCircle2 className="w-4 h-4 text-emerald-600" />No exposure or privilege flaws flagged across the selected checks.</div>
              ) : (
                <div className="divide-y divide-gray-100">{vulnerable.map((f, i) => <Finding key={i} f={f} />)}</div>
              )}
              {rest.length > 0 && (
                <details className="px-4 py-3 border-t border-gray-100">
                  <summary className="cursor-pointer text-[11px] font-medium text-gray-500 hover:text-[#7C3AED]">{rest.length} passed / informational check{rest.length === 1 ? '' : 's'}</summary>
                  <div className="mt-2 divide-y divide-gray-50">{rest.map((f, i) => <Finding key={i} f={f} muted />)}</div>
                </details>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
              <ShieldHalf className="w-7 h-7 text-gray-300" />
              <p className="text-[12.5px] text-gray-500 max-w-sm">Give each identity real credentials, pick the checks, then <span className="text-gray-700 font-medium">Run scan</span>. The first identity is treated as the resource owner; responses are inspected for leaked fields and mutable attributes.</p>
            </div>
          )}
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

function Finding({ f, muted = false }: { f: DeepAuthzFinding; muted?: boolean }) {
  const sev = {
    high: 'text-red-700 bg-red-50 border-red-200',
    medium: 'text-amber-700 bg-amber-50 border-amber-200',
    low: 'text-gray-600 bg-gray-100 border-gray-300',
    info: 'text-blue-700 bg-blue-50 border-blue-200',
  }[f.severity];
  const ev = f.evidence;
  return (
    <div className={`px-4 py-2.5 ${muted ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-2">
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${sev}`}>{f.severity}</span>
        <span className="text-[11px] font-mono font-semibold text-gray-700 flex-shrink-0 uppercase">{f.check}</span>
        <MethodBadge method={f.method} />
        <span className="text-[11.5px] text-gray-600 min-w-0 flex-1 truncate" title={f.url}>{f.title}</span>
        <span className="text-[10px] text-gray-400 flex-shrink-0">{f.category}</span>
        {f.status === 'ok' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
        {f.status === 'skipped' && <span className="text-[9.5px] text-gray-400 flex-shrink-0">skipped</span>}
      </div>
      <p className="mt-1 ml-1 text-[11px] text-gray-600 leading-relaxed">{f.detail}</p>
      {ev && (ev.request || ev.response || (ev.fields && ev.fields.length > 0)) && (
        <div className="mt-1.5 ml-1 space-y-1">
          {ev.request && <pre className="text-[10px] font-mono bg-gray-50 border border-gray-200 rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all text-gray-600 max-h-24">{ev.request.slice(0, 600)}</pre>}
          {ev.response && <pre className="text-[10px] font-mono bg-gray-50 border border-gray-200 rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all text-gray-600 max-h-24">{ev.response.slice(0, 600)}</pre>}
          {ev.fields && ev.fields.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {ev.fields.map((fld, i) => (
                <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700">{fld}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {f.identities && f.identities.length > 0 && (
        <div className="mt-1 ml-1 flex flex-wrap gap-1.5">
          {f.identities.map((who, i) => (
            <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-50 border border-gray-200 text-gray-600">{who}</span>
          ))}
        </div>
      )}
    </div>
  );
}

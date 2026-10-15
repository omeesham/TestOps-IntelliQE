/**
 * OnPremDeploy — on-prem / air-gapped packaging + data-residency posture.
 *
 * Emits the deployment artifacts to run IntelliQE inside the customer's own
 * boundary (Docker Compose / Helm values / air-gapped .env) and assesses the
 * endpoint catalogue against a data-residency policy: which target hosts sit
 * outside the allowed regions, and which would breach an air-gapped no-egress
 * boundary. Region inference is an honest heuristic — it flags what to verify.
 */
import { useEffect, useState } from 'react';
import { X, HardDrive, Play, AlertTriangle, Download, CheckCircle2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { listResidencyRegions, planDeployment, type DeployMode, type ResidencyRegion, type DeployPlan } from '@/services/api';
import { downloadText } from './generators';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const MODES: { id: DeployMode; label: string; desc: string }[] = [
  { id: 'docker', label: 'Docker Compose', desc: 'Self-hosted, single host' },
  { id: 'kubernetes', label: 'Kubernetes / Helm', desc: 'Cluster, region-pinned nodes' },
  { id: 'airgapped', label: 'Air-gapped', desc: 'No egress · self-hosted LLM' },
];

function statusCls(s: string): string {
  if (s === 'allowed') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (s === 'disallowed') return 'text-red-700 bg-red-50 border-red-200';
  if (s === 'egress') return 'text-red-700 bg-red-50 border-red-200';
  return 'text-amber-700 bg-amber-50 border-amber-200';
}
const MIME: Record<string, string> = { yaml: 'text/yaml', ini: 'text/plain', json: 'application/json' };

export default function OnPremDeploy({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [regions, setRegions] = useState<ResidencyRegion[]>([]);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<DeployMode>('docker');
  const [llmBaseUrl, setLlmBaseUrl] = useState('');
  const [imageTag, setImageTag] = useState('latest');
  const [result, setResult] = useState<DeployPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { regions: list } = await listResidencyRegions();
        setRegions(list);
      } catch (e: any) {
        setError(e?.response?.data?.error || e?.message || 'Could not load regions.');
      } finally { setLoading(false); }
    })();
  }, []);

  const toggle = (id: string) => setAllowed((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const run = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await planDeployment({ mode, allowedRegions: [...allowed], endpoints, llmBaseUrl: llmBaseUrl.trim() || undefined, imageTag: imageTag.trim() || undefined }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not build the deployment plan.');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <HardDrive className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">On-prem / air-gapped &amp; data residency</h3>
          <span className="text-[11px] text-gray-400">self-host + region policy</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : (
            <>
              <div>
                <label className={LABEL}>Deployment mode</label>
                <div className="grid grid-cols-3 gap-2">
                  {MODES.map((m) => (
                    <button key={m.id} type="button" onClick={() => { setMode(m.id); setResult(null); }} className={`text-left rounded-lg border px-3 py-2 transition-colors ${mode === m.id ? 'border-[#7C3AED] bg-[#F5F3FF]' : 'border-gray-200 hover:bg-gray-50'}`}>
                      <span className="block text-[12px] font-medium text-gray-800">{m.label}</span>
                      <span className="block text-[10.5px] text-gray-400">{m.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className={LABEL}>Allowed data-residency regions</label>
                <div className="flex flex-wrap gap-1.5">
                  {regions.map((r) => (
                    <button key={r.id} type="button" onClick={() => { toggle(r.id); setResult(null); }} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] transition-colors ${allowed.has(r.id) ? 'border-[#7C3AED] bg-[#F5F3FF] text-[#6D28D9]' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                      {allowed.has(r.id) && <CheckCircle2 className="w-3 h-3" />}{r.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-400 mt-1">None selected ⇒ every region allowed (residency check only flags air-gap egress).</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Image tag</label>
                  <input value={imageTag} onChange={(e) => setImageTag(e.target.value)} placeholder="latest" className={INPUT} />
                </div>
                {mode === 'airgapped' && (
                  <div>
                    <label className={LABEL}>Self-hosted LLM base URL</label>
                    <input value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} placeholder="http://your-private-llm:8000/v1" className={INPUT} />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                {busy && <span className="text-[11px] text-gray-400">building plan…</span>}
                <button type="button" onClick={() => void run()} disabled={busy} className={PRIMARY_BTN}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {busy ? 'Building…' : 'Build deployment plan'}
                </button>
              </div>

              {result && (
                <div className="space-y-3">
                  {/* Residency posture */}
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11.5px] font-medium ${result.residency.compliant ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>
                      {result.residency.compliant ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                      {result.residency.compliant ? 'Residency OK' : 'Residency issues'}
                    </span>
                    <div className="ml-auto flex flex-wrap gap-1.5 text-[10.5px] font-mono tabular-nums">
                      <span className="px-2 py-0.5 rounded border text-emerald-700 bg-emerald-50 border-emerald-200">{result.residency.summary.allowed} allowed</span>
                      <span className="px-2 py-0.5 rounded border text-red-700 bg-red-50 border-red-200">{result.residency.summary.disallowed} disallowed</span>
                      <span className="px-2 py-0.5 rounded border text-red-700 bg-red-50 border-red-200">{result.residency.summary.egress} egress</span>
                      <span className="px-2 py-0.5 rounded border text-amber-700 bg-amber-50 border-amber-200">{result.residency.summary.unknown} unknown</span>
                    </div>
                  </div>

                  {result.residency.findings.length > 0 && (
                    <div className="space-y-1.5">
                      {result.residency.findings.map((f) => (
                        <div key={f.host} className="flex items-start gap-2 rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] px-3 py-2">
                          <span className="font-mono text-[11.5px] text-gray-700 min-w-0 flex-1 truncate" title={f.host}>{f.host} <span className="text-gray-400">· {f.endpoints}</span></span>
                          <span className="text-[10px] text-gray-400">{f.regionLabel}</span>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10.5px] font-medium ${statusCls(f.status)}`}>{f.status}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Artifacts */}
                  <div>
                    <label className={LABEL}>Generated artifacts</label>
                    <div className="space-y-1.5">
                      {result.artifacts.map((a) => (
                        <div key={a.path} className="flex items-center gap-2 rounded-lg border border-[#E9E5FB] bg-white px-3 py-2">
                          <span className="font-mono text-[11.5px] text-gray-700 min-w-0 flex-1 truncate">{a.path}</span>
                          <span className="text-[10px] uppercase tracking-wide text-gray-400">{a.language}</span>
                          <button type="button" onClick={() => downloadText(a.path.split('/').pop() || a.path, a.content, MIME[a.language] || 'text/plain')} className={SECONDARY_BTN}><Download className="w-3.5 h-3.5" />Download</button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Checklist */}
                  {result.checklist.length > 0 && (
                    <div>
                      <label className={LABEL}>Go-live checklist</label>
                      <ul className="space-y-1">
                        {result.checklist.map((c, i) => <li key={i} className="text-[11.5px] text-gray-600 flex gap-1.5"><span className="text-[#7C3AED]">•</span><span className="min-w-0">{c}</span></li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <p className="text-[10px] text-gray-400">Region inference is a host heuristic, not geolocation — confirm where each service runs.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

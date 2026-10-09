/**
 * EvidenceExport — compliance-evidence export for a finished run.
 *
 * Pick a run and the standards to assess, preview the assembled evidence (run
 * stats + compliance posture + sign-off + approval + failing cases), then
 * download it as a PDF (or a print-ready HTML document if the server's PDF
 * library isn't installed). Read-only — it assembles existing data into a file.
 */
import { useEffect, useState } from 'react';
import { FileCheck2, X, Download, Eye, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { listApiRuns, previewEvidence, exportEvidence, type EvidenceDoc } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN, formatDuration } from './format';

const STANDARDS = [
  { id: 'pci', label: 'PCI-DSS' },
  { id: 'hipaa', label: 'HIPAA' },
  { id: 'gdpr', label: 'GDPR' },
  { id: 'psd2', label: 'PSD2' },
];
const gradeColor = (g: string) => ({ A: '#15803d', B: '#16a34a', C: '#ca8a04', D: '#ea580c', F: '#dc2626' }[g] || '#64748b');

export default function EvidenceExport({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [runs, setRuns] = useState<any[]>([]);
  const [runId, setRunId] = useState('');
  const [standards, setStandards] = useState<string[]>(STANDARDS.map((s) => s.id));
  const [doc, setDoc] = useState<EvidenceDoc | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const res = await listApiRuns(1, 20);
        const items = Array.isArray(res?.items) ? res.items : [];
        setRuns(items);
        if (items.length) setRunId(String(items[0].runId ?? items[0].id ?? ''));
      } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    })();
  }, []);

  const toggleStd = (id: string) => setStandards((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const preview = async () => {
    if (!runId) return;
    setPreviewing(true); setError(''); setDoc(null);
    try { setDoc(await previewEvidence(runId, standards)); }
    catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setPreviewing(false); }
  };

  const download = async (format: 'pdf' | 'html') => {
    if (!runId) return;
    setDownloading(format); setError('');
    try {
      const blob = await exportEvidence(runId, { standards, format });
      const ext = blob.type.includes('pdf') ? 'pdf' : 'html';
      if (format === 'pdf' && ext === 'html') toast.info('PDF library not installed', 'Downloaded a print-ready HTML document instead — use the browser Print → Save as PDF.');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `evidence-${runId}.${ext}`; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally { setDownloading(''); }
  };

  const s = doc?.run.stats;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <FileCheck2 className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Compliance-evidence export</h3>
          <span className="text-[11px] text-gray-400">run + compliance + sign-off → PDF</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div>
            <label className={LABEL}>Finished run</label>
            <select value={runId} onChange={(e) => { setRunId(e.target.value); setDoc(null); }} className={INPUT} disabled={!runs.length}>
              {runs.length === 0 && <option value="">No runs yet</option>}
              {runs.map((r, i) => <option key={r.runId ?? r.id ?? i} value={String(r.runId ?? r.id ?? '')}>{(r.title || r.runId || 'Run')} — {r.stats?.passRate ?? '–'}%</option>)}
            </select>
          </div>

          <div>
            <label className={LABEL}>Standards to assess</label>
            <div className="flex flex-wrap gap-2">
              {STANDARDS.map((st) => (
                <label key={st.id} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] cursor-pointer ${standards.includes(st.id) ? 'border-[#DDD6FE] bg-[#F5F3FF] text-[#6D28D9]' : 'border-gray-200 text-gray-500'}`}>
                  <input type="checkbox" checked={standards.includes(st.id)} onChange={() => toggleStd(st.id)} className="w-3.5 h-3.5" />{st.label}
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void preview()} disabled={previewing || !runId} className={SECONDARY_BTN}>{previewing ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}Preview</button>
            <button type="button" onClick={() => void download('pdf')} disabled={!!downloading || !runId} className={PRIMARY_BTN}>{downloading === 'pdf' ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}Download PDF</button>
            <button type="button" onClick={() => void download('html')} disabled={!!downloading || !runId} className={SECONDARY_BTN}>{downloading === 'html' ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}HTML</button>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {/* Preview */}
          {doc && (
            <div className="space-y-3 pt-1">
              <div className={`${CARD} p-3`}>
                <p className="text-[12px] font-semibold text-gray-800 mb-1">{doc.run.title}</p>
                {s ? (
                  <div className="flex flex-wrap gap-2 text-[11.5px]">
                    <span className="px-2 py-0.5 rounded border bg-gray-50 border-gray-200 font-mono tabular-nums">{s.passRate}% pass</span>
                    <span className="px-2 py-0.5 rounded border bg-emerald-50 border-emerald-200 text-emerald-700 font-mono tabular-nums">{s.passed} passed</span>
                    <span className="px-2 py-0.5 rounded border bg-red-50 border-red-200 text-red-700 font-mono tabular-nums">{s.failed} failed</span>
                    <span className="px-2 py-0.5 rounded border bg-amber-50 border-amber-200 text-amber-700 font-mono tabular-nums">{s.broken} broken</span>
                    <span className="px-2 py-0.5 rounded border bg-gray-50 border-gray-200 font-mono tabular-nums">{formatDuration(s.durationMs)}</span>
                  </div>
                ) : <p className="text-[11px] text-gray-400">No execution report found for this run.</p>}
              </div>

              {doc.compliance.length > 0 && (
                <div>
                  <p className={LABEL}>Compliance posture</p>
                  <div className="flex flex-wrap gap-2">
                    {doc.compliance.map((c) => (
                      <span key={c.pack} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-gray-200 text-[11.5px]">
                        {c.label} <b style={{ color: gradeColor(c.grade) }}>{c.grade}</b> <span className="text-gray-400 tabular-nums">{c.score}%</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-4 text-[11.5px]">
                <span className="text-gray-600">Sign-off: <span className="font-semibold">{doc.signoff.status || 'none'}</span> ({doc.signoff.count})</span>
                <span className="text-gray-600">Approval: <span className="font-semibold">{doc.approval.status}</span>{doc.approval.workflowName ? ` · ${doc.approval.workflowName}` : ''}</span>
              </div>

              <div>
                <p className={LABEL}>Failing cases ({doc.failures.length})</p>
                {doc.failures.length === 0 ? (
                  <p className="text-[11.5px] text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" />No failing cases.</p>
                ) : (
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {doc.failures.slice(0, 50).map((f) => (
                      <div key={f.id} className="flex items-start gap-1.5 text-[11.5px]"><XCircle className="w-3.5 h-3.5 text-red-500 mt-px flex-shrink-0" /><span className="text-gray-600"><b>{f.id}</b> {f.title}</span></div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * AutoMaintenance — autonomous test maintenance.
 *
 * Opt-in and standalone. Scans the catalogue two ways at once: live contract
 * drift (stored expectations vs. today's responses) AND coverage gaps
 * (endpoints seen in recorded traffic but never tested). The two feeds merge
 * into one reviewable changeset of proposals — adopt a drifted status, adopt a
 * drifted response, or add a missing endpoint. The reviewer ticks what to keep
 * and applies it straight into the catalogue (edit / add), or exports the whole
 * changeset as Markdown. It only reads the live API and edits catalogue
 * metadata; the generate → execute → heal pipeline is untouched.
 */
import { useEffect, useState } from 'react';
import { X, Wrench, Play, Download, Sparkles, AlertTriangle, CheckCircle2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  planApiMaintenance,
  listCaptureSessions,
  type MaintenancePlan,
  type MaintenanceProposal,
  type CaptureSession,
} from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { Catalog } from './hooks/useCatalog';

const SEVERITY_CLS: Record<MaintenanceProposal['severity'], string> = {
  high: 'text-red-700 bg-red-50 border-red-200',
  medium: 'text-amber-700 bg-amber-50 border-amber-200',
  low: 'text-gray-600 bg-gray-50 border-gray-200',
};

const KIND_LABELS: Record<MaintenanceProposal['kind'], string> = {
  'adopt-status': 'Adopt status',
  'adopt-response': 'Adopt response',
  'add-endpoint': 'Add endpoint',
};

/** Blob + <a download> — trigger a client-side file download. */
function triggerDownload(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** A simple Markdown rendering of the plan — title, summary line, one section per proposal. */
function changesetMarkdown(plan: MaintenancePlan): string {
  const s = plan.summary;
  const lines: string[] = [
    '# API maintenance changeset',
    '',
    `Summary: ${s.proposals} proposal${s.proposals === 1 ? '' : 's'} — ${s.adoptStatus} status, ${s.adoptResponse} response, ${s.addEndpoint} new endpoint${s.addEndpoint === 1 ? '' : 's'} (${s.drifted} drifted, ${s.gaps} gaps).`,
  ];
  if (plan.narrative) {
    lines.push('', plan.narrative);
  }
  for (const p of plan.proposals) {
    lines.push(
      '',
      `## ${p.title}`,
      `- Kind: ${KIND_LABELS[p.kind]}`,
      `- Severity: ${p.severity}`,
      `- Endpoint: ${p.method} ${p.url}`,
      `- Rationale: ${p.rationale}`,
    );
  }
  return lines.join('\n');
}

export default function AutoMaintenance({ catalog, onClose }: { catalog: Catalog; onClose: () => void }) {
  const toast = useToast();
  const [sessions, setSessions] = useState<CaptureSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [explain, setExplain] = useState(false);
  const [plan, setPlan] = useState<MaintenancePlan | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    listCaptureSessions()
      .then((r) => setSessions(r.sessions.filter((s) => s.entryCount > 0)))
      .catch(() => {});
  }, []);

  const scan = async () => {
    setLoading(true);
    setError('');
    setPlan(null);
    try {
      const payload = catalog.endpoints.map((e) => ({
        id: e.id,
        title: e.title,
        method: e.method,
        url: e.url,
        headers: e.headers,
        auth: e.auth,
        body: e.body,
        expectedStatus: e.expectedStatus,
        expectedResponse: e.expectedResponse,
      }));
      const result = await planApiMaintenance(payload, { sessionId: sessionId || undefined, explain });
      setPlan(result);
      const next: Record<string, boolean> = {};
      for (const p of result.proposals) next[p.id] = true;
      setSelected(next);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Maintenance scan failed.');
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id: string) => setSelected((prev) => ({ ...prev, [id]: !prev[id] }));

  const selectedCount = plan ? plan.proposals.filter((p) => selected[p.id]).length : 0;

  const applySelected = () => {
    if (!plan) return;
    const chosen = plan.proposals.filter((p) => selected[p.id]);
    if (!chosen.length) return;
    let edits = 0;
    const toAdd: unknown[] = [];
    for (const p of chosen) {
      if (p.kind === 'adopt-status' && p.endpointId) {
        catalog.updateEndpoint(p.endpointId, { expectedStatus: p.patch?.expectedStatus });
        edits++;
      } else if (p.kind === 'adopt-response' && p.endpointId) {
        catalog.updateEndpoint(p.endpointId, { expectedResponse: p.patch?.expectedResponse });
        edits++;
      } else if (p.kind === 'add-endpoint' && p.addEndpoint) {
        toAdd.push(p.addEndpoint);
      }
    }
    if (toAdd.length) {
      catalog.addEndpoints(toAdd, { method: 'capture', name: 'Maintenance', format: 'Maintenance', parser: 'maintenance' });
    }
    toast.success(
      'Changeset applied',
      `${edits} edit${edits === 1 ? '' : 's'} · ${toAdd.length} endpoint${toAdd.length === 1 ? '' : 's'} added.`,
    );
    onClose();
  };

  const exportChangeset = () => {
    if (!plan) return;
    triggerDownload('api-maintenance-changeset.md', changesetMarkdown(plan), 'text/markdown');
  };

  const s = plan?.summary;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Wrench className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Autonomous maintenance</h3>
          <span className="text-[11px] text-gray-400">drift + gaps → a reviewable changeset</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0 flex-1">
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[180px]">
              <label className={LABEL}>Recorded traffic</label>
              <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} className={INPUT}>
                <option value="">All recordings</option>
                {sessions.map((sess) => <option key={sess.id} value={sess.id}>{sess.name} · {sess.entryCount} req</option>)}
              </select>
            </div>
            <label className="flex items-center gap-1.5 text-[12px] text-gray-600 py-2 cursor-pointer select-none">
              <input type="checkbox" checked={explain} onChange={(e) => setExplain(e.target.checked)} className="accent-[#7C3AED]" />
              Explain
            </label>
            <button type="button" onClick={() => void scan()} disabled={loading} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              Scan
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
              <p className="text-[12px] text-red-700">{error}</p>
            </div>
          )}

          {plan && s && (
            <div className="space-y-3">
              {plan.narrative && (
                <div className="flex items-start gap-2 px-3 py-2 bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg">
                  <Sparkles className="w-4 h-4 text-[#7C3AED] flex-shrink-0 mt-px" />
                  <p className="text-[12px] text-[#4C1D95] leading-relaxed">{plan.narrative}</p>
                </div>
              )}

              <div className="flex flex-wrap gap-1.5 text-[11.5px]">
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-600">{s.proposals} proposal{s.proposals === 1 ? '' : 's'}</span>
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]">{s.adoptStatus} status</span>
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]">{s.adoptResponse} response</span>
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]">{s.addEndpoint} new</span>
              </div>

              {plan.proposals.length === 0 ? (
                <p className="text-[13px] text-emerald-700 font-medium flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />Everything is current — no drift and no untested traffic.
                </p>
              ) : (
                <div className="space-y-2">
                  {plan.proposals.map((p) => (
                    <label key={p.id} className="flex items-start gap-2.5 px-3 py-2.5 border border-[#E9E5FB] rounded-lg cursor-pointer hover:border-[#DDD6FE]">
                      <input
                        type="checkbox"
                        checked={!!selected[p.id]}
                        onChange={() => toggle(p.id)}
                        className="mt-0.5 accent-[#7C3AED]"
                      />
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide ${SEVERITY_CLS[p.severity]}`}>{p.severity}</span>
                          <span className="text-[10.5px] font-medium text-gray-500">{KIND_LABELS[p.kind]}</span>
                          <MethodBadge method={p.method} />
                          <span className="text-[11.5px] font-mono text-gray-600 truncate">{p.url}</span>
                        </div>
                        <div className="text-[12.5px] font-medium text-gray-900">{p.title}</div>
                        <div className="text-[11.5px] text-gray-500 leading-relaxed">{p.rationale}</div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {plan && plan.proposals.length > 0 && (
          <div className={`flex items-center justify-end gap-2 px-4 py-3 border-t border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
            <button type="button" onClick={exportChangeset} className={SECONDARY_BTN}>
              <Download className="w-3.5 h-3.5" />Export changeset
            </button>
            <button type="button" onClick={applySelected} disabled={selectedCount === 0} className={PRIMARY_BTN}>
              <CheckCircle2 className="w-3.5 h-3.5" />Apply selected ({selectedCount})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

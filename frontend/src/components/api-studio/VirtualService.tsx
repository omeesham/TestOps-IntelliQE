/**
 * VirtualService — stateful, fault-injecting virtual dependencies.
 *
 * Stands up a programmable mock for an upstream the system-under-test calls.
 * Each service has an ordered list of rules: a `when` matcher (method, path,
 * body, header, query, or a stored-state equality) picks the first match, and
 * its `respond` block returns a status, headers and a templated body — with an
 * optional injected fault (abort, malformed, server-500, timeout). Rules can
 * read and write a small per-service state bag, so the mock can model a stateful
 * dependency across calls. The service is reachable at a tenant-scoped public
 * URL; everything here is opt-in and touches nothing in the pipeline.
 */
import { useEffect, useState } from 'react';
import { X, Boxes, Plus, Trash2, AlertTriangle, Save, RotateCcw } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { listVirtualServices, createVirtualService, updateVirtualService, deleteVirtualService, type VirtualService, type VirtualRule } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN, BRAND_CHIP, MUTED_CHIP, prettyJson } from './format';
import { CopyButton, EmptyState } from './primitives';

export default function VirtualService({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [services, setServices] = useState<VirtualService[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [rulesText, setRulesText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const selected = services.find((s) => s.id === selectedId) || null;
  const publicUrl = selected ? `${origin}/vs/${selected.token}` : '';

  const populate = (svc: VirtualService | null) => {
    setName(svc?.name ?? '');
    setEnabled(svc?.enabled ?? true);
    setRulesText(svc ? prettyJson(JSON.stringify(svc.rules ?? [])) : '');
  };

  const load = async (selectId?: string) => {
    const { services: list } = await listVirtualServices();
    setServices(list);
    const next = (selectId && list.find((s) => s.id === selectId)) || list.find((s) => s.id === selectedId) || list[0] || null;
    setSelectedId(next?.id || '');
    populate(next);
  };

  useEffect(() => {
    (async () => {
      try { await load(); }
      catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Could not load virtual services.'); }
      finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectSvc = (svc: VirtualService) => { setSelectedId(svc.id); populate(svc); setError(''); };

  const create = async () => {
    setBusy(true); setError('');
    try {
      const { service } = await createVirtualService({ name: 'New virtual service' });
      await load(service.id);
      toast.success('Virtual service created', service.name);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not create a virtual service.');
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (!selected) return;
    let parsed: VirtualRule[];
    try {
      parsed = JSON.parse(rulesText);
      if (!Array.isArray(parsed)) throw new Error('not an array');
    } catch {
      setError('Rules must be valid JSON array');
      return;
    }
    setBusy(true); setError('');
    try {
      const { service } = await updateVirtualService(selected.id, { name: name.trim() || selected.name, rules: parsed, enabled });
      await load(service.id);
      toast.success('Saved', service.name);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save the virtual service.');
    } finally { setBusy(false); }
  };

  const resetState = async () => {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      const { service } = await updateVirtualService(selected.id, { resetState: true });
      await load(service.id);
      toast.success('State reset', service.name);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not reset state.');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete virtual service "${selected.name}"? This revokes its public URL.`)) return;
    setBusy(true); setError('');
    try {
      await deleteVirtualService(selected.id);
      await load();
      toast.success('Virtual service deleted');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not delete the virtual service.');
    } finally { setBusy(false); }
  };

  const stateEntries = selected ? Object.entries(selected.state || {}) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Boxes className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Service virtualization</h3>
          <span className="text-[11px] text-gray-400">stateful, fault-injecting virtual dependencies</span>
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
            <div className="flex gap-3">
              {/* List */}
              <div className="w-52 flex-shrink-0 space-y-2">
                <button type="button" onClick={() => void create()} disabled={busy} className={`${SECONDARY_BTN} w-full justify-center`}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}New
                </button>
                {services.length === 0 ? (
                  <div className="text-[11px] text-gray-400 text-center py-4">No virtual services yet.</div>
                ) : (
                  <div className="space-y-1">
                    {services.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => selectSvc(s)}
                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-left transition-colors ${s.id === selectedId ? 'bg-[#F5F3FF] border-[#DDD6FE]' : 'bg-white border-gray-100 hover:bg-gray-50'}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.enabled ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                        <span className="flex-1 min-w-0 truncate text-[12px] text-gray-700">{s.name}</span>
                        <span className="text-[10px] text-gray-400 font-mono tabular-nums">{s.hitCount}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Detail */}
              <div className="flex-1 min-w-0">
                {!selected ? (
                  <EmptyState icon={Boxes} title="No virtual service selected" hint="Create one on the left to stand up a programmable, stateful mock dependency." />
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label className={LABEL}>Name</label>
                      <input value={name} onChange={(e) => { setName(e.target.value); setError(''); }} className={INPUT} placeholder="Virtual service name" />
                    </div>

                    <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
                      <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-3.5 h-3.5" />
                      Enabled
                    </label>

                    <div>
                      <label className={LABEL}>Public URL</label>
                      <div className="flex items-center gap-1.5">
                        <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-2 py-1.5">{publicUrl}</code>
                        <CopyButton text={publicUrl} />
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <label className={`${LABEL} mb-0`}>Rules (JSON array)</label>
                      <button type="button" onClick={() => void resetState()} disabled={busy} className="inline-flex items-center gap-1 text-[11px] text-[#6D28D9] hover:underline disabled:opacity-40">
                        <RotateCcw className="w-3.5 h-3.5" />Reset state
                      </button>
                    </div>
                    <textarea
                      value={rulesText}
                      onChange={(e) => { setRulesText(e.target.value); setError(''); }}
                      rows={14}
                      spellCheck={false}
                      className={`${INPUT} font-mono text-[11px] leading-[1.5] resize-y`}
                      placeholder='[{"when":{"method":"GET","pathPattern":"/users/*"},"respond":{"status":200,"body":"{\"id\":\"{{uuid}}\"}"}}]'
                    />

                    <p className="text-[10px] text-gray-400 leading-relaxed">
                      Each rule: <code className="font-mono">when</code> {'{'}method, pathPattern, bodyContains, header, query, stateEquals{'}'} → <code className="font-mono">respond</code> {'{'}status, headers, body, delayMs, fault{'}'} plus optional <code className="font-mono">setState</code>. Templates: <code className="font-mono">{'{{request.body.x}}'}</code> <code className="font-mono">{'{{state.k}}'}</code> <code className="font-mono">{'{{uuid}}'}</code> <code className="font-mono">{'{{now}}'}</code>. Faults: abort, malformed, server-500, timeout.
                    </p>

                    <div>
                      <label className={LABEL}>State ({stateEntries.length}) · {selected.hitCount} hits</label>
                      {stateEntries.length === 0 ? (
                        <p className="text-[11px] text-gray-400">No state set yet.</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {stateEntries.map(([k, v]) => (
                            <span key={k} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono ${BRAND_CHIP}`}>
                              {k}=<span className={`px-1 rounded ${MUTED_CHIP}`}>{String(v)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button type="button" onClick={() => void remove()} disabled={busy} className={SECONDARY_BTN}>
                        <Trash2 className="w-3.5 h-3.5" />Delete
                      </button>
                      <button type="button" onClick={() => void save()} disabled={busy} className={PRIMARY_BTN}>
                        {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save
                      </button>
                    </div>
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

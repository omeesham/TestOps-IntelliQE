/**
 * MockServer — publish endpoints as a live, hosted stub.
 *
 * Opt-in and standalone. "Publish" takes the selected endpoints and serves them
 * back at a public, unguessable URL (/mock/{id}/<path>) returning each
 * endpoint's stored example status + body. A system-under-test can point at
 * that URL when the real dependency is unavailable. Toggling disables the URL
 * without deleting; deleting revokes it. Nothing here touches the pipeline.
 */
import { useEffect, useState } from 'react';
import { X, ServerCog, Plus, Trash2, Copy, Check, Power, AlertTriangle, Link2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listMockServers, createMockServer, toggleMockServer, deleteMockServer, type MockServer as Mock,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import { MethodBadge } from './primitives';
import type { CatalogEndpoint } from './types';

export default function MockServer({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [mocks, setMocks] = useState<Mock[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const urlFor = (m: Mock) => `${origin}/mock/${m.mockId}`;

  const refresh = async () => {
    const { mocks: list } = await listMockServers();
    setMocks(list);
  };

  useEffect(() => {
    (async () => {
      try { await refresh(); }
      catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Could not load mocks.'); }
      finally { setLoading(false); }
    })();
  }, []);

  const publish = async () => {
    if (!endpoints.length) { setError('No endpoints selected to publish.'); return; }
    setBusy(true); setError('');
    try {
      const { mock } = await createMockServer(
        name.trim(),
        endpoints.map((e) => ({ method: e.method, url: e.url, expectedStatus: e.expectedStatus, expectedResponse: e.expectedResponse })),
      );
      setName('');
      await refresh();
      toast.success('Mock published', `${mock.routeCount} route${mock.routeCount === 1 ? '' : 's'} live at /mock/${mock.mockId.slice(0, 8)}…`);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not publish mock.');
    } finally { setBusy(false); }
  };

  const toggle = async (m: Mock) => {
    setBusy(true);
    try { await toggleMockServer(m.id, !m.enabled); await refresh(); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Toggle failed.'); }
    finally { setBusy(false); }
  };

  const remove = async (m: Mock) => {
    setBusy(true);
    try { await deleteMockServer(m.id); await refresh(); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Delete failed.'); }
    finally { setBusy(false); }
  };

  const copy = async (m: Mock) => {
    try { await navigator.clipboard.writeText(urlFor(m)); setCopied(m.id); setTimeout(() => setCopied(null), 1500); }
    catch { /* clipboard blocked */ }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ServerCog className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Hosted mock server</h3>
          <span className="text-[11px] text-gray-400">publish endpoints as a live stub</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Publish */}
          <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3">
            <label className={LABEL}>Publish {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} as a mock</label>
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <input value={name} onChange={(e) => { setName(e.target.value); setError(''); }} placeholder="Mock name (optional)" className={INPUT} />
              </div>
              <button type="button" onClick={() => void publish()} disabled={busy || !endpoints.length} className={PRIMARY_BTN}>
                {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Publish
              </button>
            </div>
            <p className="text-[10.5px] text-gray-400 mt-1.5">Each endpoint replies with its expected status + example response. Point your system-under-test at the generated URL. The URL is public but unguessable — disable or delete to revoke.</p>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : mocks.length === 0 ? (
            <div className="text-center py-6 text-[12px] text-gray-400">No mocks yet — publish your selected endpoints above.</div>
          ) : (
            <div className="space-y-2">
              {mocks.map((m) => (
                <div key={m.id} className="border border-[#E9E5FB] rounded-lg p-3">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${m.enabled ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    <span className="text-[12.5px] font-semibold text-gray-800 truncate">{m.name}</span>
                    <span className="text-[10.5px] text-gray-400">{m.routeCount} route{m.routeCount === 1 ? '' : 's'} · {m.hitCount} hit{m.hitCount === 1 ? '' : 's'}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <button type="button" onClick={() => void toggle(m)} disabled={busy} className={`p-1 rounded ${m.enabled ? 'text-emerald-600 hover:bg-emerald-50' : 'text-gray-400 hover:bg-gray-100'}`} title={m.enabled ? 'Disable' : 'Enable'}><Power className="w-3.5 h-3.5" /></button>
                      <button type="button" onClick={() => void remove(m)} disabled={busy} className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete (revokes URL)"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 mt-2">
                    <Link2 className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                    <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] rounded px-2 py-1">{urlFor(m)}</code>
                    <button type="button" onClick={() => void copy(m)} className={SECONDARY_BTN}>{copied === m.id ? <><Check className="w-3.5 h-3.5" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}</button>
                  </div>
                  {m.routes.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {m.routes.slice(0, 8).map((r, i) => (
                        <span key={i} className="inline-flex items-center gap-1 text-[10px] text-gray-500">
                          <MethodBadge method={r.method} /><span className="font-mono">{r.path}</span>
                        </span>
                      ))}
                      {m.routes.length > 8 && <span className="text-[10px] text-gray-400">+{m.routes.length - 8} more</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

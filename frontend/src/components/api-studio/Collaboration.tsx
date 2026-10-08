/**
 * Collaboration — test-level comments and version history.
 *
 * Standalone and opt-in. Pick an endpoint; its stable "test key" is
 * `METHOD url`, so comments and version snapshots follow the test even as the
 * endpoint's details are edited. Two tabs:
 *   • Comments — a threaded discussion on the selected test.
 *   • Versions — save the endpoint's current shape as a numbered snapshot, then
 *     compare any two with a field-level diff.
 *
 * Nothing here touches the generation/execute/heal pipeline.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, MessagesSquare, AlertTriangle, Trash2, Send, Save, GitCompare } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listApiComments, addApiComment, deleteApiComment,
  listApiVersions, saveApiVersion, deleteApiVersion, getApiVersionDiff,
  type ApiTestComment, type ApiTestVersion, type ApiFieldDiff,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN, relativeTime } from './format';
import { MethodBadge } from './primitives';
import type { CatalogEndpoint } from './types';

type Tab = 'comments' | 'versions';

const tabBtn = (active: boolean) =>
  `px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
    active ? 'bg-[#F5F3FF] text-[#6D28D9] border border-[#DDD6FE]' : 'text-gray-500 hover:text-[#7C3AED]'
  }`;

const diffTone = (change: ApiFieldDiff['change']) =>
  change === 'added' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
  : change === 'removed' ? 'text-red-700 bg-red-50 border-red-200'
  : 'text-amber-700 bg-amber-50 border-amber-200';

export default function Collaboration({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string>(endpoints[0]?.id ?? '');
  const [tab, setTab] = useState<Tab>('comments');
  const [comments, setComments] = useState<ApiTestComment[]>([]);
  const [versions, setVersions] = useState<ApiTestVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [label, setLabel] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [diff, setDiff] = useState<ApiFieldDiff[] | null>(null);

  const selected = useMemo(() => endpoints.find((e) => e.id === selectedId), [endpoints, selectedId]);
  const testKey = selected ? `${selected.method} ${selected.url}` : '';

  const reload = useCallback(async (key: string) => {
    if (!key) { setComments([]); setVersions([]); return; }
    setLoading(true); setError('');
    try {
      const [c, v] = await Promise.all([listApiComments(key), listApiVersions(key)]);
      setComments(c.comments);
      setVersions(v.versions);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not load collaboration data.');
    } finally { setLoading(false); }
  }, []);

  // Load (and reset the compare picker) on mount and whenever the test key changes.
  useEffect(() => { setDiff(null); setFromId(''); setToId(''); void reload(testKey); }, [testKey, reload]);

  const postComment = async () => {
    const body = draft.trim();
    if (!body || !testKey) return;
    setBusy(true); setError('');
    try {
      await addApiComment(testKey, body);
      setDraft('');
      const { comments: list } = await listApiComments(testKey);
      setComments(list);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not add the comment.');
    } finally { setBusy(false); }
  };

  const removeComment = async (id: string) => {
    setBusy(true); setError('');
    try {
      await deleteApiComment(id);
      setComments((prev) => prev.filter((c) => c.id !== id));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not delete the comment.');
    } finally { setBusy(false); }
  };

  const saveVersion = async () => {
    if (!selected || !testKey) return;
    setBusy(true); setError('');
    try {
      const snapshot = {
        method: selected.method,
        url: selected.url,
        headers: JSON.stringify(selected.headers || []),
        auth: selected.auth?.type || 'none',
        body: selected.body || '',
        expectedStatus: selected.expectedStatus ?? '',
        expectedResponse: selected.expectedResponse || '',
      };
      await saveApiVersion({ testKey, label: label.trim() || undefined, snapshot });
      setLabel('');
      const { versions: list } = await listApiVersions(testKey);
      setVersions(list);
      toast.success('Snapshot saved');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save the version.');
    } finally { setBusy(false); }
  };

  const removeVersion = async (id: string) => {
    setBusy(true); setError('');
    try {
      await deleteApiVersion(id);
      setVersions((prev) => prev.filter((v) => v.id !== id));
      setDiff(null);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not delete the version.');
    } finally { setBusy(false); }
  };

  const compare = async () => {
    if (!fromId || !toId) return;
    setBusy(true); setError(''); setDiff(null);
    try {
      const res = await getApiVersionDiff(fromId, toId);
      setDiff(res.diff);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not compare the versions.');
    } finally { setBusy(false); }
  };

  const versionLabel = (v: ApiTestVersion) => v.label || `Version ${v.versionNo}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <MessagesSquare className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Collaboration</h3>
          <span className="text-[11px] text-gray-400">comments &amp; version history</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {!endpoints.length ? (
            <div className="text-center py-10">
              <MessagesSquare className="w-8 h-8 text-[#C4B5FD] mx-auto mb-2" />
              <p className="text-[12.5px] text-gray-600 font-medium">No endpoints in the catalogue yet.</p>
              <p className="text-[11px] text-gray-400 mt-1">Import an API to start commenting on and versioning its tests.</p>
            </div>
          ) : (
            <>
              {/* Endpoint picker — the test key follows the selection */}
              <div>
                <label className={LABEL}>Endpoint</label>
                <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className={INPUT}>
                  {endpoints.map((ep) => <option key={ep.id} value={ep.id}>{ep.method} {ep.title || ep.url}</option>)}
                </select>
                {selected && (
                  <div className="flex items-center gap-2 mt-1.5">
                    <MethodBadge method={selected.method} />
                    <span className="text-[11px] font-mono text-gray-500 truncate min-w-0" title={testKey}>{selected.url}</span>
                  </div>
                )}
              </div>

              {/* Tabs */}
              <div className="flex items-center gap-1 border-b border-[#EDE9FE] pb-2">
                <button type="button" onClick={() => setTab('comments')} className={tabBtn(tab === 'comments')}>
                  Comments{comments.length ? ` · ${comments.length}` : ''}
                </button>
                <button type="button" onClick={() => setTab('versions')} className={tabBtn(tab === 'versions')}>
                  Versions{versions.length ? ` · ${versions.length}` : ''}
                </button>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-10 text-gray-400"><Spinner className="w-5 h-5" /></div>
              ) : tab === 'comments' ? (
                <div className="space-y-3">
                  <div className="space-y-2 max-h-72 overflow-y-auto">
                    {comments.length === 0 ? (
                      <p className="text-[12px] text-gray-400 text-center py-6">No comments yet.</p>
                    ) : comments.map((c) => (
                      <div key={c.id} className="rounded-lg border border-[#E9E5FB] bg-white px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-semibold text-gray-800 truncate min-w-0">{c.author}</span>
                          <span className="text-[10.5px] text-gray-400 flex-shrink-0">{relativeTime(c.createdAt)}</span>
                          <button type="button" onClick={() => void removeComment(c.id)} disabled={busy} className="ml-auto flex-shrink-0 p-1 rounded text-gray-300 hover:text-red-500" title="Delete comment"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                        <p className="text-[12.5px] text-gray-700 mt-1 whitespace-pre-wrap break-words">{c.body}</p>
                      </div>
                    ))}
                  </div>

                  {/* Composer */}
                  <div className="space-y-1.5">
                    <textarea
                      value={draft}
                      onChange={(e) => { setDraft(e.target.value); setError(''); }}
                      rows={3}
                      placeholder="Add a comment…"
                      className={`${INPUT} resize-y`}
                    />
                    <div className="flex justify-end">
                      <button type="button" onClick={() => void postComment()} disabled={busy || !draft.trim()} className={PRIMARY_BTN}>
                        {busy ? <Spinner className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}Comment
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Save current as version */}
                  <div className="flex items-end gap-2">
                    <div className="flex-1 min-w-0">
                      <label className={LABEL}>Save current as version</label>
                      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional) — e.g. before auth change" className={INPUT} />
                    </div>
                    <button type="button" onClick={() => void saveVersion()} disabled={busy || !selected} className={SECONDARY_BTN}>
                      {busy ? <Spinner className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}Save snapshot
                    </button>
                  </div>

                  {/* Version list */}
                  <div className="space-y-2 max-h-56 overflow-y-auto">
                    {versions.length === 0 ? (
                      <p className="text-[12px] text-gray-400 text-center py-6">No versions saved yet.</p>
                    ) : versions.map((v) => (
                      <div key={v.id} className="flex items-center gap-2 rounded-lg border border-[#E9E5FB] bg-white px-3 py-2">
                        <span className="inline-flex items-center justify-center min-w-[2rem] px-1.5 py-0.5 rounded bg-[#F5F3FF] border border-[#DDD6FE] text-[11px] font-mono font-semibold text-[#6D28D9] flex-shrink-0">v{v.versionNo}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[12.5px] font-medium text-gray-800 truncate">{versionLabel(v)}</p>
                          <p className="text-[10.5px] text-gray-400 truncate">{v.author} · {relativeTime(v.createdAt)}</p>
                        </div>
                        <button type="button" onClick={() => void removeVersion(v.id)} disabled={busy} className="flex-shrink-0 p-1 rounded text-gray-300 hover:text-red-500" title="Delete version"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    ))}
                  </div>

                  {/* Compare two versions */}
                  {versions.length >= 2 && (
                    <div className="rounded-lg border border-[#E9E5FB] p-3 space-y-2">
                      <div className="flex items-end gap-2">
                        <div className="flex-1 min-w-0">
                          <label className={LABEL}>From</label>
                          <select value={fromId} onChange={(e) => setFromId(e.target.value)} className={INPUT}>
                            <option value="">Select…</option>
                            {versions.map((v) => <option key={v.id} value={v.id}>v{v.versionNo} · {versionLabel(v)}</option>)}
                          </select>
                        </div>
                        <div className="flex-1 min-w-0">
                          <label className={LABEL}>To</label>
                          <select value={toId} onChange={(e) => setToId(e.target.value)} className={INPUT}>
                            <option value="">Select…</option>
                            {versions.map((v) => <option key={v.id} value={v.id}>v{v.versionNo} · {versionLabel(v)}</option>)}
                          </select>
                        </div>
                        <button type="button" onClick={() => void compare()} disabled={busy || !fromId || !toId} className={SECONDARY_BTN}>
                          {busy ? <Spinner className="w-3.5 h-3.5" /> : <GitCompare className="w-3.5 h-3.5" />}Compare
                        </button>
                      </div>

                      {diff && (
                        diff.length === 0 ? (
                          <p className="text-[12px] text-gray-400 text-center py-3">No differences between these versions.</p>
                        ) : (
                          <div className="space-y-1.5">
                            {diff.map((d, i) => (
                              <div key={`${d.field}-${i}`} className={`rounded-md border px-2.5 py-1.5 ${diffTone(d.change)}`}>
                                <div className="flex items-center gap-2">
                                  <span className="text-[10.5px] font-semibold uppercase tracking-wide">{d.change}</span>
                                  <span className="text-[12px] font-mono break-all">{d.field}</span>
                                </div>
                                {(d.before !== undefined || d.after !== undefined) && (
                                  <div className="mt-1 flex items-center gap-2 text-[11px] font-mono break-all">
                                    {d.before !== undefined && <span className="line-through opacity-70">{d.before || '∅'}</span>}
                                    {d.before !== undefined && d.after !== undefined && <span className="opacity-50">→</span>}
                                    {d.after !== undefined && <span>{d.after || '∅'}</span>}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

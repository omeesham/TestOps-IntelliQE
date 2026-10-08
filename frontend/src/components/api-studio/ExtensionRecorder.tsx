/**
 * ExtensionRecorder — one-click browser capture.
 *
 * Guides the user through installing a tiny Chrome/Edge DevTools extension that
 * streams the API traffic a page makes straight into a capture session. The
 * panel hands over the three things the extension needs — the backend origin,
 * the session's ingest URL, and the bearer token — and downloads the unpacked
 * extension files.
 *
 * After recording, the session is converted to endpoints in the Traffic capture
 * tool. Nothing here touches the generation/execute/heal pipeline.
 */
import { useCallback, useEffect, useState } from 'react';
import { X, Chrome, AlertTriangle, Plus, RefreshCw, Download, Copy, Check, FileCode } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  getRecorderExtension, listCaptureSessions, createCaptureSession,
  type RecorderExtensionFile, type CaptureSession,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';

const codeBox =
  'flex items-center gap-2 px-2.5 py-2 rounded-lg bg-[#F5F3FF] border border-[#DDD6FE] font-mono text-[11px] text-[#4F46E5] break-all';

export default function ExtensionRecorder({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const token = typeof window !== 'undefined' ? (sessionStorage.getItem('intelliqe_token') || '') : '';
  const [base, setBase] = useState(typeof window !== 'undefined' ? window.location.origin : '');
  const [sessions, setSessions] = useState<CaptureSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [files, setFiles] = useState<RecorderExtensionFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [copied, setCopied] = useState<'ingest' | 'token' | null>(null);
  const [error, setError] = useState('');

  const refreshSessions = useCallback(async () => {
    const { sessions: list } = await listCaptureSessions();
    setSessions(list);
    return list;
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true); setError('');
      try {
        const list = await refreshSessions();
        if (list.length) {
          setSessionId((prev) => prev || list[0].id);
        } else {
          // No sessions — stand one up so the ingest URL is ready immediately.
          const { session } = await createCaptureSession();
          setSessions([session]);
          setSessionId(session.id);
        }
      } catch (e: any) {
        setError(e?.response?.data?.error || e?.message || 'Could not load capture sessions.');
      } finally { setLoading(false); }
      // The extension file list is a nicety; the download button works even if this fails.
      try {
        const { files: fs } = await getRecorderExtension();
        setFiles(fs);
      } catch { /* ignore — names shown only when available */ }
    })();
  }, [refreshSessions]);

  const newSession = async () => {
    setBusy(true); setError('');
    try {
      const { session } = await createCaptureSession();
      await refreshSessions();
      setSessionId(session.id);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not create a session.');
    } finally { setBusy(false); }
  };

  const ingestUrl = sessionId ? `${base.replace(/\/$/, '')}/api/api-automation/capture/sessions/${sessionId}/ingest` : '';

  const copy = async (which: 'ingest' | 'token', text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
    } catch { /* clipboard blocked — the value is on screen and selectable */ }
  };

  const download = async () => {
    setDownloading(true); setError('');
    try {
      let fs = files;
      if (!fs.length) { const res = await getRecorderExtension(); fs = res.files; setFiles(fs); }
      for (const f of fs) {
        const blob = new Blob([f.content], { type: f.contentType || 'text/plain' });
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = f.path;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      }
      toast.success('Extension files downloaded', `${fs.length} file${fs.length === 1 ? '' : 's'} saved.`);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not download the extension files.');
    } finally { setDownloading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Chrome className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Browser recorder</h3>
          <span className="text-[11px] text-gray-400">record API traffic from DevTools</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {!token && (
            <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-px" />
              <p className="text-[12px] text-amber-700 min-w-0">No session token found. Sign in again, then reopen this panel so the extension can authenticate.</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400"><Spinner className="w-5 h-5" /></div>
          ) : (
            <>
              {/* Backend origin */}
              <div>
                <label className={LABEL}>Backend URL</label>
                <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="http://localhost:3001" className={INPUT} />
                <p className="text-[10.5px] text-gray-400 mt-1">
                  The origin the extension posts to. In dev the backend usually runs on <span className="font-mono">:3001</span> — if the SPA is proxied, use the backend origin, not the app's.
                </p>
              </div>

              {/* Session picker */}
              <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                  <label className={LABEL}>Capture session</label>
                  <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} className={INPUT} disabled={!sessions.length}>
                    {!sessions.length && <option value="">No sessions yet</option>}
                    {sessions.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.entryCount} req</option>)}
                  </select>
                </div>
                <button type="button" onClick={() => void newSession()} disabled={busy} className={SECONDARY_BTN} title="Start a new capture session">
                  {busy ? <Spinner className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}New session
                </button>
                <button type="button" onClick={() => void refreshSessions()} disabled={busy} className={SECONDARY_BTN} title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
              </div>

              {/* Ingest URL + bearer token */}
              <div className="space-y-2">
                <div>
                  <label className={LABEL}>Ingest URL</label>
                  <div className={codeBox}>
                    <span className="min-w-0 flex-1">{ingestUrl || 'Select or create a session above'}</span>
                    <button type="button" onClick={() => void copy('ingest', ingestUrl)} disabled={!ingestUrl} className="flex-shrink-0 inline-flex items-center gap-1 text-[#6D28D9] hover:underline disabled:opacity-40">
                      {copied === 'ingest' ? <><Check className="w-3.5 h-3.5" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}
                    </button>
                  </div>
                </div>
                <div>
                  <label className={LABEL}>Bearer token</label>
                  <div className={codeBox}>
                    <span className="min-w-0 flex-1">{token || 'Not signed in'}</span>
                    <button type="button" onClick={() => void copy('token', token)} disabled={!token} className="flex-shrink-0 inline-flex items-center gap-1 text-[#6D28D9] hover:underline disabled:opacity-40">
                      {copied === 'token' ? <><Check className="w-3.5 h-3.5" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}
                    </button>
                  </div>
                </div>
              </div>

              {/* Install steps */}
              <div className="rounded-lg border border-[#E9E5FB] bg-[#FAF9FE] p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">Install the DevTools extension</p>
                <ol className="space-y-1.5 text-[12px] text-gray-700 list-decimal list-inside">
                  <li>Download the extension files (button below) into an empty folder.</li>
                  <li>Open <span className="font-mono text-[#6D28D9]">chrome://extensions</span> and turn on <strong>Developer mode</strong>.</li>
                  <li>Click <strong>Load unpacked</strong> and pick that folder.</li>
                  <li>Open DevTools (<span className="font-mono">F12</span>) and switch to the <strong>IntelliQE</strong> panel.</li>
                  <li>Paste the Backend URL, Ingest URL and Bearer token above, then click <strong>Start</strong>.</li>
                </ol>
              </div>

              {/* Download */}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void download()} disabled={downloading} className={PRIMARY_BTN}>
                  {downloading ? <Spinner className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}Download extension files
                </button>
                {files.length > 0 && <span className="text-[11px] text-gray-400">{files.length} file{files.length === 1 ? '' : 's'}</span>}
              </div>

              {files.length > 0 && (
                <div className="border border-[#E9E5FB] rounded-lg divide-y divide-gray-100 max-h-40 overflow-y-auto">
                  {files.map((f) => (
                    <div key={f.path} className="flex items-center gap-2 px-2.5 py-1.5 text-[11.5px]">
                      <FileCode className="w-3.5 h-3.5 text-[#A78BFA] flex-shrink-0" />
                      <span className="font-mono text-gray-700 truncate min-w-0" title={f.path}>{f.path}</span>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-[11px] text-gray-400 leading-relaxed">
                After recording, open this session in the <strong className="text-gray-500 font-medium">Traffic capture</strong> tool and convert the captured calls into endpoints.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

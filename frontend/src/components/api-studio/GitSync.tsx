/**
 * GitSync — push/pull the endpoint catalogue as test-as-code.
 *
 * Standalone: serialise the current catalogue to a JSON file in a Git repo
 * (push), or fetch the committed version back for review (pull). Pull never
 * overwrites the live catalogue — it hands the text back for manual import.
 * Nothing here touches the pipeline.
 */
import { useState, useEffect } from 'react';
import { FolderGit2, X, AlertTriangle, Save, UploadCloud, DownloadCloud, ExternalLink } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { getGitSyncConfig, saveGitSyncConfig, pushToGit, pullFromGit, type GitSyncConfigView } from '@/services/api';
import { CodeBlock, CopyButton } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const DEFAULT_PATH = 'intelliqe/api-catalogue.json';

export default function GitSync({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [provider, setProvider] = useState<'github' | 'gitlab'>('github');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [path, setPath] = useState(DEFAULT_PATH);
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pushResult, setPushResult] = useState<{ url: string; path: string; branch: string } | null>(null);
  const [pullResult, setPullResult] = useState<{ content: string; path: string; branch: string } | null>(null);

  const apply = (c: GitSyncConfigView) => {
    setProvider(c.provider === 'gitlab' ? 'gitlab' : 'github');
    setRepo(c.repo || '');
    setBranch(c.branch || 'main');
    setPath(c.path || DEFAULT_PATH);
    setHost(c.host || '');
    setHasToken(c.hasToken);
  };

  useEffect(() => {
    (async () => {
      try { apply(await getGitSyncConfig()); }
      catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Could not load the Git-sync config.'); }
      finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setBusy('save'); setError('');
    try {
      apply(await saveGitSyncConfig({ provider, repo: repo.trim(), branch: branch.trim() || 'main', path: path.trim() || DEFAULT_PATH, host: provider === 'gitlab' ? host.trim() : '', token: token || undefined }));
      setToken('');
      toast.success('Config saved');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save the config.');
    } finally { setBusy(''); }
  };

  const push = async () => {
    setBusy('push'); setError(''); setPushResult(null);
    try {
      const r = await pushToGit(JSON.stringify(endpoints, null, 2));
      setPushResult({ url: r.url, path: r.path, branch: r.branch });
      toast.success('Catalogue pushed');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not push the catalogue.');
    } finally { setBusy(''); }
  };

  const pull = async () => {
    setBusy('pull'); setError(''); setPullResult(null);
    try {
      setPullResult(await pullFromGit());
      toast.success('Pulled from Git');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not pull from Git.');
    } finally { setBusy(''); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <FolderGit2 className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Git-synced tests</h3>
          <span className="text-[11px] text-gray-400">push/pull the catalogue as test-as-code</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Provider</label>
                  <select value={provider} onChange={(e) => setProvider(e.target.value as 'github' | 'gitlab')} className={INPUT}>
                    <option value="github">GitHub</option>
                    <option value="gitlab">GitLab</option>
                  </select>
                </div>
                <div>
                  <label className={LABEL}>Repo</label>
                  <input value={repo} onChange={(e) => setRepo(e.target.value)} className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Branch</label>
                  <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Path</label>
                  <input value={path} onChange={(e) => setPath(e.target.value)} placeholder={DEFAULT_PATH} className={`${INPUT} font-mono text-[11px]`} />
                </div>
                {provider === 'gitlab' && (
                  <div>
                    <label className={LABEL}>Host</label>
                    <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://gitlab.com" className={INPUT} />
                  </div>
                )}
                <div>
                  <label className={LABEL}>Token</label>
                  <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={hasToken ? '•••• leave blank to keep' : ''} className={INPUT} />
                </div>
              </div>

              <div className="flex items-center justify-end">
                <button type="button" onClick={() => void save()} disabled={busy !== ''} className={PRIMARY_BTN}>
                  {busy === 'save' ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
                <span className="inline-flex items-center px-2 py-0.5 rounded border bg-gray-50 border-gray-200 text-gray-600">{provider}</span>
                <span className="font-mono truncate min-w-0">{path || DEFAULT_PATH}</span>
                <span>· {branch || 'main'}</span>
                <span className="ml-auto tabular-nums">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'}</span>
              </div>

              <div className="flex items-center gap-2 pt-1 border-t border-[#EDE9FE]">
                <button type="button" onClick={() => void push()} disabled={busy !== ''} className={PRIMARY_BTN}>
                  {busy === 'push' ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}Push catalogue
                </button>
                <button type="button" onClick={() => void pull()} disabled={busy !== ''} className={SECONDARY_BTN}>
                  {busy === 'pull' ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <DownloadCloud className="w-3.5 h-3.5" />}Pull
                </button>
              </div>

              {pushResult && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <a href={pushResult.url} target="_blank" rel="noreferrer" className="flex-1 min-w-0 inline-flex items-center gap-1 truncate text-[11px] font-mono text-[#6D28D9] bg-white border border-[#DDD6FE] rounded px-2 py-1.5 hover:underline">
                      <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" /><span className="truncate">{pushResult.url}</span>
                    </a>
                    <CopyButton text={pushResult.url} />
                  </div>
                  <p className="text-[11px] text-emerald-700"><span className="font-mono">{pushResult.path}</span> · {pushResult.branch}</p>
                </div>
              )}

              {pullResult && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <label className={`${LABEL} mb-0`}>Pulled</label>
                    <span className="text-[10.5px] text-gray-400 font-mono truncate min-w-0">{pullResult.path} · {pullResult.branch}</span>
                    <CopyButton text={pullResult.content} className="ml-auto" />
                  </div>
                  <div className="border border-[#E4E0F5] rounded-lg bg-[#FCFBFF] p-3 max-h-64 overflow-auto">
                    <CodeBlock code={pullResult.content} />
                  </div>
                  <p className="text-[10.5px] text-gray-400">Review and import manually — pull does not overwrite your catalogue.</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

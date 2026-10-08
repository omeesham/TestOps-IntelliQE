/**
 * RemediationPr — open a GitHub or GitLab pull/merge request with a changeset.
 *
 * Standalone: assemble a set of file paths and contents, point it at a repo and
 * branch, and it opens a PR/MR carrying those changes. The token is passed to
 * the backend for the single call and is not stored. Nothing here touches the
 * catalogue or the pipeline.
 */
import { useState } from 'react';
import { GitPullRequestArrow, X, AlertTriangle, Plus, Trash2, ExternalLink, CheckCircle2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { openRemediationPr, type RemediationResult } from '@/services/api';
import { CopyButton } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';

type FileRow = { path: string; content: string };

export default function RemediationPr({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [provider, setProvider] = useState<'github' | 'gitlab'>('github');
  const [token, setToken] = useState('');
  const [repo, setRepo] = useState('');
  const [host, setHost] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [branch, setBranch] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<FileRow[]>([{ path: '', content: '' }]);
  const [result, setResult] = useState<RemediationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const setFile = (i: number, patch: Partial<FileRow>) => setFiles((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const addFile = () => setFiles((prev) => [...prev, { path: '', content: '' }]);
  const removeFile = (i: number) => setFiles((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));

  const canSubmit = token.trim() !== '' && repo.trim() !== '' && title.trim() !== '' && files.some((f) => f.path.trim() !== '');

  const open = async () => {
    setLoading(true); setError(''); setResult(null);
    try {
      const payload = {
        provider,
        token: token.trim(),
        repo: repo.trim(),
        host: provider === 'gitlab' ? host.trim() || undefined : undefined,
        baseBranch: baseBranch.trim() || undefined,
        branch: branch.trim() || undefined,
        title: title.trim(),
        body: body.trim() || undefined,
        files: files.filter((f) => f.path.trim() !== '').map((f) => ({ path: f.path.trim(), content: f.content })),
      };
      setResult(await openRemediationPr(payload));
      toast.success('Request opened');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not open the request.');
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <GitPullRequestArrow className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Remediation PR</h3>
          <span className="text-[11px] text-gray-400">open a GitHub/GitLab PR with a changeset</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Provider</label>
              <select value={provider} onChange={(e) => setProvider(e.target.value as 'github' | 'gitlab')} className={INPUT}>
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>Token</label>
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} className={INPUT} />
              <p className="text-[10px] text-gray-400 mt-1">used once, not stored</p>
            </div>
          </div>

          <div>
            <label className={LABEL}>Repo</label>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} className={INPUT} />
            <p className="text-[10px] text-gray-400 mt-1">github: owner/repo · gitlab: group/project or numeric id</p>
          </div>

          {provider === 'gitlab' && (
            <div>
              <label className={LABEL}>Host</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://gitlab.com" className={INPUT} />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Base branch (optional)</label>
              <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Branch (optional)</label>
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="intelliqe/maintenance-…" className={INPUT} />
            </div>
          </div>

          <div>
            <label className={LABEL}>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
          </div>
          <div>
            <label className={LABEL}>Body</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} className={`${INPUT} resize-y`} />
          </div>

          {/* Files */}
          <div>
            <label className={LABEL}>Files</label>
            <div className="space-y-2">
              {files.map((f, i) => (
                <div key={i} className="rounded-lg border border-[#E9E5FB] p-2 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <input value={f.path} onChange={(e) => setFile(i, { path: e.target.value })} placeholder="path/to/file.ts" className={`${INPUT} font-mono text-[11px] py-1`} />
                    <button type="button" onClick={() => removeFile(i)} disabled={files.length <= 1} className="p-1 rounded text-gray-400 hover:text-red-500 disabled:opacity-30"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                  <textarea value={f.content} onChange={(e) => setFile(i, { content: e.target.value })} rows={4} placeholder="file contents" className={`${INPUT} font-mono text-[11px] resize-y`} />
                </div>
              ))}
            </div>
            <button type="button" onClick={addFile} className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[#6D28D9] hover:underline"><Plus className="w-3.5 h-3.5" />Add file</button>
          </div>

          <div className="flex items-center justify-end">
            <button type="button" onClick={() => void open()} disabled={loading || !canSubmit} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <GitPullRequestArrow className="w-3.5 h-3.5" />}
              {provider === 'gitlab' ? 'Open MR' : 'Open PR'}
            </button>
          </div>

          {result && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span className="text-[12.5px] font-semibold text-emerald-700">{result.provider} request opened · {result.filesCommitted} file{result.filesCommitted === 1 ? '' : 's'} committed</span>
              </div>
              <div className="flex items-center gap-1.5">
                <a href={result.url} target="_blank" rel="noreferrer" className="flex-1 min-w-0 inline-flex items-center gap-1 truncate text-[11px] font-mono text-[#6D28D9] bg-white border border-[#DDD6FE] rounded px-2 py-1.5 hover:underline">
                  <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" /><span className="truncate">{result.url}</span>
                </a>
                <CopyButton text={result.url} />
              </div>
              <p className="text-[11px] text-emerald-700">branch: <span className="font-mono">{result.branch}</span></p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

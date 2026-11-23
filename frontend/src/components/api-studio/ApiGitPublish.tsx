/**
 * ApiGitPublish — push the API test-as-code to a connected git repository.
 *
 * Unlike the catalogue git-sync (GitHub/GitLab only), this uses the shared
 * provider layer, so API automation can push to GitHub, GitLab, Bitbucket
 * (Cloud + Server/DC) AND Azure DevOps Repos — whichever repo is connected
 * under System Configuration → Code Repositories. Provider is auto-detected
 * from the repo URL; the push opens a PR/MR (or a direct commit on GitHub).
 */
import { useState } from 'react';
import { X, GitBranch, AlertTriangle, ExternalLink, UploadCloud } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { publishApiTestsToGit, type ApiGitPublishResult } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';

export default function ApiGitPublish({ endpoints, onClose }: { endpoints: unknown[]; onClose: () => void }) {
  const [branch, setBranch] = useState('');
  const [title, setTitle] = useState('');
  const [scriptsPath, setScriptsPath] = useState('tests/api');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ApiGitPublishResult | null>(null);

  const count = Array.isArray(endpoints) ? endpoints.length : 0;

  const push = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      const res = await publishApiTestsToGit({
        catalogue: JSON.stringify(endpoints ?? [], null, 2),
        branch: branch.trim() || undefined,
        title: title.trim() || undefined,
        scriptsPath: scriptsPath.trim() || undefined,
      });
      setResult(res);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Push failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-lg max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <UploadCloud className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Push to repository</h3>
          <span className="text-[11px] text-gray-400">GitHub · GitLab · Bitbucket · Azure DevOps</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <p className="text-[12px] text-gray-600">
            Pushes the API catalogue as test-as-code to the repository connected under <span className="font-medium">System Configuration → Code Repositories</span>. The provider is detected from the repo URL — GitHub, GitLab, Bitbucket (Cloud or Server), or Azure DevOps Repos.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL}>Subfolder</label>
              <input value={scriptsPath} onChange={(e) => setScriptsPath(e.target.value)} className={INPUT} placeholder="tests/api" />
            </div>
            <div>
              <label className={LABEL}>Branch (optional)</label>
              <input value={branch} onChange={(e) => setBranch(e.target.value)} className={INPUT} placeholder="auto: intelliqe/tests-…" />
            </div>
          </div>
          <div>
            <label className={LABEL}>PR / MR title (optional)</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} placeholder="IntelliQE: API tests" />
          </div>

          <button type="button" onClick={() => void push()} disabled={busy || count === 0} className={`${PRIMARY_BTN} w-full justify-center`}>
            {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
            Push {count} endpoint{count === 1 ? '' : 's'} as test-as-code
          </button>

          {result && (
            <div className="px-3 py-2.5 rounded-lg bg-emerald-50 border border-emerald-200 space-y-1">
              <p className="text-[12.5px] font-semibold text-emerald-800">Pushed to {result.provider} ({result.mode === 'pr' ? 'pull/merge request' : 'direct commit'})</p>
              <p className="text-[11.5px] text-emerald-700">{result.fileCount} file(s) on branch <span className="font-mono">{result.branch}</span>.</p>
              {result.prUrl && (
                <a href={result.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-[#6D28D9] hover:underline">
                  Open {result.mode === 'pr' ? `#${result.prNumber}` : 'branch'} <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * PostmanImportWizard — the pre-commit Postman import flow.
 *
 * Unlike the generic method forms (which parse-and-commit in one step), Postman
 * import stages a PREVIEW first: the collection is parsed server-side and the
 * user reviews the folder tree, request count, variables (secrets masked), auth
 * mapping, and an imported/skipped/failed breakdown BEFORE anything lands in the
 * catalogue. On Confirm, endpoints are committed (via the shared `onImported`
 * path → catalogue + readiness review) and, optionally, the collection's +
 * environment's variables are mapped into an IntelliQE environment under a chosen
 * conflict strategy (skip / update / create new).
 *
 * Secrets are never displayed — secret variable values render masked, and auth is
 * shown by type/scope only, never with its value.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { UploadCloud, FileJson, X, FolderTree, ChevronRight, KeyRound, CheckCircle2, AlertTriangle, XCircle, ArrowRight, Layers, Workflow } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { importPostmanPlan, importPostmanSteps, type PostmanPlanResponse, type PostmanFolderNode, type MergedVariable, type ApiFlowSeed } from '@/services/api';
import { CARD, PRIMARY_BTN, SECONDARY_BTN, INPUT, LABEL, THEAD } from './format';
import { useApiEnvironments } from './hooks/useApiEnvironments';
import type { ApiEnvironment } from './types';

type Strategy = 'skip' | 'update' | 'new';
type Target = string | '__new__' | '__none__';

const METHOD_HUE: Record<string, string> = {
  GET: '#10B981', POST: '#F97316', PUT: '#6366F1', PATCH: '#EAB308', DELETE: '#EF4444', HEAD: '#64748B', OPTIONS: '#64748B',
};

/** One folder (and its requests + sub-folders), rendered recursively. */
function FolderBranch({ node, depth }: { node: PostmanFolderNode; depth: number }) {
  return (
    <div style={{ marginLeft: depth ? 14 : 0 }} className="border-l border-gray-100 pl-2">
      <div className="flex items-center gap-1.5 py-0.5 text-[12px] font-semibold text-gray-700">
        <FolderTree className="w-3.5 h-3.5 text-[#7C3AED]" />{node.name}
        <span className="text-[10.5px] font-normal text-gray-400">({node.requests.length})</span>
      </div>
      {node.requests.map((r, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5 pl-5 text-[11.5px]">
          <span className="font-mono font-semibold w-12 flex-shrink-0" style={{ color: METHOD_HUE[r.method] || '#64748B' }}>{r.method}</span>
          <span className="text-gray-600 truncate" title={r.url}>{r.name}</span>
          <span className="text-gray-300 font-mono truncate hidden sm:inline" title={r.url}>{r.url}</span>
        </div>
      ))}
      {node.folders.map((f, i) => <FolderBranch key={i} node={f} depth={depth + 1} />)}
    </div>
  );
}

export default function PostmanImportWizard({
  environment, onImported, onEnvironmentsChanged, onImportAsFlow, onClose,
}: {
  /** Active environment — seeds the default mapping target. */
  environment?: ApiEnvironment | null;
  /** Commit the parsed endpoints through the shared import path (catalogue + readiness). */
  onImported: (name: string, res: PostmanPlanResponse) => void;
  /** Tell the app to refresh its environment list after a mapping write. */
  onEnvironmentsChanged?: () => void;
  /** Hand the collection to the Flow Builder as a runnable flow (steps keep the
   *  scripts' assertions + variable chaining). When omitted, the action is hidden. */
  onImportAsFlow?: (seed: ApiFlowSeed) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const envStore = useApiEnvironments();
  const [collectionFile, setCollectionFile] = useState<File | null>(null);
  const [envFile, setEnvFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<PostmanPlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [committing, setCommitting] = useState(false);
  const [flowLoading, setFlowLoading] = useState(false);

  const [target, setTarget] = useState<Target>('__none__');
  const [strategy, setStrategy] = useState<Strategy>('skip');
  const [newEnvName, setNewEnvName] = useState('');

  const collRef = useRef<HTMLInputElement>(null);
  const envRef = useRef<HTMLInputElement>(null);

  const parse = useCallback(async () => {
    if (!collectionFile) return;
    setLoading(true); setError('');
    try {
      const res = await importPostmanPlan(collectionFile, envFile || undefined);
      setPlan(res);
      // Default the mapping: if an environment is active, map into it; else create new.
      if (res.variables.length) {
        setTarget(environment?.id || '__new__');
        setNewEnvName(res.suggestedEnvironmentName || res.collection.name || 'Imported environment');
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not read that Postman collection.');
    } finally { setLoading(false); }
  }, [collectionFile, envFile, environment]);

  const mapVars = target !== '__none__' && !!plan && plan.variables.length > 0;

  const confirm = useCallback(async () => {
    if (!plan || !collectionFile) return;
    setCommitting(true);
    try {
      // When mapping variables, RE-UPLOAD the files so the environment write
      // happens server-side from the real values — the browser never holds the
      // plaintext secrets (the preview blanked them). The apply response carries
      // the same endpoints, so we commit from it.
      let committed: PostmanPlanResponse = plan;
      if (mapVars) {
        committed = await importPostmanPlan(collectionFile, envFile || undefined, {
          strategy: target === '__new__' ? 'new' : strategy,
          ...(target === '__new__' ? { name: newEnvName.trim() || plan.collection.name } : { targetId: target }),
        });
        const applied = committed.applied || [];
        const added = applied.filter((a) => a.action === 'added').length;
        const updated = applied.filter((a) => a.action === 'updated').length;
        const skipped = applied.filter((a) => a.action === 'skipped').length;
        await envStore.reload();
        onEnvironmentsChanged?.();
        toast.success('Variables mapped', `${added} added · ${updated} updated · ${skipped} kept`);
      }
      // Commit the endpoints (if any) through the shared catalogue + readiness path.
      if (committed.summary?.imported) onImported(collectionFile.name, committed);
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not complete the import.');
    } finally { setCommitting(false); }
  }, [plan, collectionFile, envFile, mapVars, target, strategy, newEnvName, envStore, toast, onImported, onEnvironmentsChanged, onClose]);

  // Hand the same collection to the Flow Builder as a runnable flow. Uses the flow
  // importer (/flows/import-postman), so each step keeps the assertions + variable
  // chaining parsed from the collection's test / pre-request scripts.
  const importAsFlow = useCallback(async () => {
    if (!plan || !collectionFile || !onImportAsFlow) return;
    setFlowLoading(true); setError('');
    try {
      const text = await collectionFile.text();
      const { steps, variables, warnings } = await importPostmanSteps(text);
      if (!steps.length) { setError('That collection has no requests to build a flow from.'); return; }
      onImportAsFlow({ name: plan.collection.name, steps, variables, warnings });
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not build a flow from that collection.');
    } finally { setFlowLoading(false); }
  }, [plan, collectionFile, onImportAsFlow, onClose]);

  const summary = plan?.summary;
  const problems = useMemo(() => (plan?.items || []).filter((i) => i.outcome !== 'imported'), [plan]);

  /* ── Upload step ── */
  if (!plan) {
    return (
      <div className={`${CARD} p-4`}>
        <Header onClose={onClose} />
        <p className="text-[12px] text-gray-500 mb-3">Postman Collection v2.0 / v2.1 (JSON). Optionally add a Postman environment export to map its variables.</p>

        <FilePick label="Collection file" hint=".postman_collection.json" file={collectionFile} inputRef={collRef} onPick={setCollectionFile} />
        <div className="h-2" />
        <FilePick label="Environment file (optional)" hint=".postman_environment.json" file={envFile} inputRef={envRef} onPick={setEnvFile} />

        {error && <p className="mt-3 text-[12px] text-red-600 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}
        <div className="mt-4 flex items-center gap-2">
          <button type="button" disabled={!collectionFile || loading} onClick={() => void parse()} className={PRIMARY_BTN}>
            {loading ? <Spinner /> : <UploadCloud className="w-3.5 h-3.5" />}Preview import
          </button>
          <button type="button" onClick={onClose} className={SECONDARY_BTN}>Cancel</button>
        </div>
      </div>
    );
  }

  /* ── Preview step ── */
  return (
    <div className={`${CARD} p-4 space-y-4`}>
      <Header onClose={onClose} />

      {/* Collection summary */}
      <div className="rounded-lg border border-[#DDD6FE] bg-[#F5F3FF] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <FileJson className="w-4 h-4 text-[#7C3AED]" />
          <span className="text-[13px] font-semibold text-gray-900">{plan.collection.name}</span>
          <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-white border border-[#DDD6FE] text-[#6D28D9]">{plan.format}</span>
          <span className="text-[11px] text-gray-500">{plan.collection.requestCount} request{plan.collection.requestCount === 1 ? '' : 's'}</span>
        </div>
        {plan.collection.description && <p className="mt-1 text-[11.5px] text-gray-500 line-clamp-2">{plan.collection.description}</p>}
      </div>

      {/* Imported / skipped / failed */}
      {summary && (
        <div className="flex flex-wrap gap-2">
          <Stat icon={<CheckCircle2 className="w-3.5 h-3.5" />} tone="ok" n={summary.imported} label="imported" />
          <Stat icon={<AlertTriangle className="w-3.5 h-3.5" />} tone="warn" n={summary.skipped} label="skipped" />
          <Stat icon={<XCircle className="w-3.5 h-3.5" />} tone="err" n={summary.failed} label="failed" />
        </div>
      )}

      {/* Folder tree */}
      <section>
        <p className={LABEL}><FolderTree className="w-3.5 h-3.5 inline mr-1" />Structure</p>
        <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-100 p-2">
          {plan.collection.rootRequests.length > 0 && (
            <FolderBranch node={{ name: plan.collection.name, requests: plan.collection.rootRequests, folders: [] }} depth={0} />
          )}
          {plan.collection.folders.map((f, i) => <FolderBranch key={i} node={f} depth={0} />)}
          {!plan.collection.folders.length && !plan.collection.rootRequests.length && <p className="text-[11.5px] text-gray-400">No requests found.</p>}
        </div>
      </section>

      {/* Auth mapping */}
      {plan.collection.auth.length > 0 && (
        <section>
          <p className={LABEL}><KeyRound className="w-3.5 h-3.5 inline mr-1" />Authentication</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {plan.collection.auth.map((a, i) => (
              <li key={i} className="px-2 py-0.5 rounded-md text-[10.5px] bg-gray-50 border border-gray-200 text-gray-600">
                <span className="font-medium text-gray-800">{a.scope}</span>: {a.type === 'none' ? 'No Auth' : a.type}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10.5px] text-gray-400">Secrets are never displayed — auth values map into each endpoint but are shown by type only.</p>
        </section>
      )}

      {/* Variables + environment mapping */}
      {plan.variables.length > 0 && (
        <section>
          <p className={LABEL}><Layers className="w-3.5 h-3.5 inline mr-1" />Variables ({plan.variables.length})</p>
          <div className="mt-1 border border-gray-100 rounded-md overflow-hidden">
            <table className="w-full text-[11px]">
              <thead className={`text-gray-500 ${THEAD}`}><tr><th className="text-left px-2 py-1 font-medium">Key</th><th className="text-left px-2 py-1 font-medium">Value</th><th className="text-left px-2 py-1 font-medium">Source</th></tr></thead>
              <tbody>
                {plan.variables.map((v: MergedVariable) => (
                  <tr key={v.key} className="border-t border-gray-100">
                    <td className="px-2 py-1 font-mono text-gray-700">{v.key}{v.secret && <KeyRound className="w-3 h-3 inline ml-1 text-amber-500" />}</td>
                    <td className="px-2 py-1 font-mono text-gray-500">{v.secret ? '••••••••' : (v.value || <span className="text-gray-300">—</span>)}</td>
                    <td className="px-2 py-1 text-gray-500">{v.source}{v.conflict && <span className="text-amber-600"> (overrode collection)</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-2.5 rounded-lg border border-gray-100 p-2.5 space-y-2">
            <div>
              <label className={LABEL} htmlFor="pm-env-target">Map variables into</label>
              <select id="pm-env-target" className={INPUT} value={target} onChange={(e) => setTarget(e.target.value as Target)}>
                <option value="__none__">Don't map variables (import endpoints only)</option>
                <option value="__new__">Create a new environment…</option>
                {envStore.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            {target === '__new__' && (
              <div>
                <label className={LABEL} htmlFor="pm-env-name">New environment name</label>
                <input id="pm-env-name" className={INPUT} value={newEnvName} onChange={(e) => setNewEnvName(e.target.value)} placeholder="Imported environment" />
              </div>
            )}
            {target !== '__none__' && target !== '__new__' && (
              <div>
                <span className={LABEL}>On conflict</span>
                <div className="flex gap-3 mt-0.5">
                  <label className="flex items-center gap-1.5 text-[12px] text-gray-700"><input type="radio" name="pm-strategy" checked={strategy === 'skip'} onChange={() => setStrategy('skip')} />Keep existing</label>
                  <label className="flex items-center gap-1.5 text-[12px] text-gray-700"><input type="radio" name="pm-strategy" checked={strategy === 'update'} onChange={() => setStrategy('update')} />Overwrite</label>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Skipped / failed detail */}
      {problems.length > 0 && (
        <section>
          <p className={LABEL}>Items needing attention ({problems.length})</p>
          <ul className="mt-1 max-h-40 overflow-y-auto space-y-0.5">
            {problems.map((it, i) => (
              <li key={i} className="text-[11px] flex gap-1.5">
                <span className={it.outcome === 'failed' ? 'text-red-600' : 'text-amber-600'}>{it.outcome === 'failed' ? '✗' : '○'}</span>
                <span className="min-w-0"><span className="font-medium text-gray-700">{[...it.folderPath, it.name].join(' / ')}</span> — {it.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Warnings */}
      {!!plan.warnings?.length && (
        <ul className="space-y-0.5">
          {plan.warnings.slice(0, 6).map((w, i) => <li key={i} className="text-[11px] text-amber-700 flex gap-1.5"><span>•</span><span className="min-w-0">{w}</span></li>)}
          {plan.warnings.length > 6 && <li className="text-[11px] text-gray-400">…and {plan.warnings.length - 6} more</li>}
        </ul>
      )}

      {error && <p className="text-[12px] text-red-600 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}

      <div className="flex items-center gap-2 pt-1">
        <button type="button" disabled={committing || !(plan.summary?.imported || mapVars)} onClick={() => void confirm()} className={PRIMARY_BTN}>
          {committing ? <Spinner /> : <CheckCircle2 className="w-3.5 h-3.5" />}
          {plan.summary?.imported
            ? `Confirm import (${plan.summary.imported})`
            : mapVars ? 'Map variables' : 'Confirm import'}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        {onImportAsFlow && (
          <button
            type="button"
            disabled={flowLoading || committing || !plan.collection.requestCount}
            onClick={() => void importAsFlow()}
            className={SECONDARY_BTN}
            title="Open these requests as a runnable flow in the Flow Builder — assertions and variable captures from the collection's scripts come across as checks and extracts."
          >
            {flowLoading ? <Spinner /> : <Workflow className="w-3.5 h-3.5" />}Import as runnable flow
          </button>
        )}
        <button type="button" onClick={() => { setPlan(null); setError(''); }} className={SECONDARY_BTN}>Back</button>
      </div>
    </div>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="w-7 h-7 rounded-lg flex items-center justify-center bg-[#FFF7ED] border border-[#FED7AA]"><FileJson className="w-4 h-4 text-[#F97316]" /></span>
      <h3 className="text-[13px] font-semibold text-gray-900">Import Postman Collection</h3>
      <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
    </div>
  );
}

function FilePick({ label, hint, file, inputRef, onPick }: { label: string; hint: string; file: File | null; inputRef: React.RefObject<HTMLInputElement | null>; onPick: (f: File | null) => void }) {
  return (
    <div>
      <span className={LABEL}>{label}</span>
      <div className="mt-0.5 flex items-center gap-2">
        <input ref={inputRef} type="file" accept=".json" className="hidden" onChange={(e) => onPick(e.target.files?.[0] || null)} />
        <button type="button" onClick={() => inputRef.current?.click()} className={SECONDARY_BTN}>
          <UploadCloud className="w-3.5 h-3.5" />{file ? 'Replace' : 'Choose file'}
        </button>
        {file
          ? <span className="text-[12px] text-gray-700 flex items-center gap-1.5 min-w-0"><FileJson className="w-3.5 h-3.5 text-[#F97316] flex-shrink-0" /><span className="truncate">{file.name}</span><span className="text-gray-400">({Math.ceil(file.size / 1024)} KB)</span><button type="button" onClick={() => onPick(null)} className="text-gray-400 hover:text-red-500"><X className="w-3.5 h-3.5" /></button></span>
          : <span className="text-[11.5px] text-gray-400">{hint}</span>}
      </div>
    </div>
  );
}

function Stat({ icon, tone, n, label }: { icon: React.ReactNode; tone: 'ok' | 'warn' | 'err'; n: number; label: string }) {
  const cls = tone === 'ok' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : tone === 'warn' ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-semibold border ${cls}`}>{icon}{n} {label}</span>;
}

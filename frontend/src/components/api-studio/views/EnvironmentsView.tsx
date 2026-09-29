/**
 * EnvironmentsView — test-environment management.
 *
 * An environment is a base URL plus a set of variables. Endpoints reference
 * values with `{{name}}` placeholders; the environment supplies them. Secret
 * values are stored AES-encrypted server-side and come back masked — a masked
 * value left unchanged in the form keeps the stored secret.
 *
 * Self-contained: it reads and writes environments directly through the API
 * service, so it touches neither the catalogue nor the run pipeline.
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Server, Star, Trash2, Pencil, Save, X, Lock, Eye, EyeOff } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  listApiEnvironments, createApiEnvironment, updateApiEnvironment, deleteApiEnvironment,
} from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';
import Loader from '@/components/feedback/Loader';
import {
  CARD, THEAD, PRIMARY_BTN, SECONDARY_BTN, FIELD, INPUT, LABEL,
  BRAND_CHIP, MUTED_CHIP, relativeTime,
} from '../format';
import { EmptyState } from '../primitives';
import type { ApiEnvironment, EnvVariable } from '../types';

/** Sensible starting variables for a fresh environment. */
const SUGGESTED: EnvVariable[] = [
  { key: 'token', value: '', secret: true },
  { key: 'apiKey', value: '', secret: true },
];

/** Server row → the shape the view renders, defensively. */
function mapEnv(e: any): ApiEnvironment {
  return {
    id: String(e?.id ?? ''),
    name: String(e?.name ?? ''),
    baseUrl: String(e?.baseUrl ?? ''),
    variables: Array.isArray(e?.variables)
      ? e.variables.map((v: any) => ({ key: String(v?.key ?? ''), value: String(v?.value ?? ''), secret: !!v?.secret }))
      : [],
    isDefault: !!e?.isDefault,
    createdBy: e?.createdBy,
    createdAt: String(e?.createdAt ?? ''),
    updatedAt: String(e?.updatedAt ?? ''),
  };
}

export default function EnvironmentsView() {
  const toast = useToast();
  const [environments, setEnvironments] = useState<ApiEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<ApiEnvironment> | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const { environments: list } = await listApiEnvironments();
      setEnvironments((Array.isArray(list) ? list : []).map(mapEnv));
    } catch (err) {
      toast.fromError(err);
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { void reload(); }, [reload]);

  const save = async (env: { id?: string; name: string; baseUrl: string; variables: EnvVariable[]; isDefault: boolean }) => {
    if (!env.name.trim()) { toast.warning('Name required', 'Give the environment a name.'); return; }
    setSaving(true);
    try {
      const variables = env.variables.filter((v) => v.key.trim());
      if (env.id) await updateApiEnvironment(env.id, { name: env.name.trim(), baseUrl: env.baseUrl, variables, isDefault: env.isDefault });
      else await createApiEnvironment({ name: env.name.trim(), baseUrl: env.baseUrl, variables, isDefault: env.isDefault });
      setEditing(null);
      await reload();
      toast.success('Environment saved', env.name.trim());
    } catch (err) { toast.fromError(err); }
    finally { setSaving(false); }
  };

  const remove = async (env: ApiEnvironment) => {
    if (!window.confirm(`Delete environment "${env.name}"?`)) return;
    try { await deleteApiEnvironment(env.id); await reload(); toast.success('Environment deleted', env.name); }
    catch (err) { toast.fromError(err); }
  };

  const makeDefault = async (env: ApiEnvironment) => {
    try { await updateApiEnvironment(env.id, { isDefault: true }); await reload(); toast.success('Default environment set', env.name); }
    catch (err) { toast.fromError(err); }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-gray-900">Environments</h2>
            <p className="text-[11.5px] text-gray-500">A base URL and a set of key / value variables for each target you test against.</p>
          </div>
          {!editing && <button type="button" onClick={() => setEditing({ name: '', baseUrl: '', variables: SUGGESTED, isDefault: environments.length === 0 })} className={`ml-auto ${PRIMARY_BTN}`}><Plus className="w-3.5 h-3.5" />New environment</button>}
        </div>

        {editing && <EnvForm key={editing.id || 'new'} initial={editing} saving={saving} onCancel={() => setEditing(null)} onSave={save} />}

        {loading && environments.length === 0 ? (
          <Loader.Block label="Loading environments" />
        ) : environments.length === 0 ? (
          !editing && <EmptyState icon={Server} title="No environments yet" hint="Create one per target (dev, staging, prod) with its base URL and credentials. Mark one as the default." />
        ) : (
          <div className={`${CARD} overflow-hidden`}>
            <table className="w-full table-fixed text-[12.5px]">
              <thead className={`text-[10.5px] uppercase tracking-wide text-gray-500 ${THEAD}`}>
                <tr>
                  <th className="w-[22%] text-left px-4 py-2.5 font-semibold">Name</th>
                  <th className="w-[30%] text-left px-4 py-2.5 font-semibold">Base URL</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Variables</th>
                  <th className="w-[120px] text-left px-4 py-2.5 font-semibold">Updated</th>
                  <th className="w-[190px] text-right px-4 py-2.5 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {environments.map((env) => (
                  <tr key={env.id} className="border-t border-gray-100 align-top">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-semibold text-gray-900 truncate" title={env.name}>{env.name}</span>
                        {env.isDefault && <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9.5px] font-semibold flex-shrink-0 ${BRAND_CHIP}`}><Star className="w-2.5 h-2.5" />Default</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11.5px] text-gray-700 truncate" title={env.baseUrl}>{env.baseUrl || <span className="font-sans text-gray-400">Endpoints keep their own host</span>}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {env.variables.length === 0 ? <span className="text-[11.5px] text-gray-400">None</span> : env.variables.map((v) => (
                          <span key={v.key} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10.5px] ${MUTED_CHIP}`}>{v.secret && <Lock className="w-2.5 h-2.5" />}{v.key}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[11.5px] text-gray-500 whitespace-nowrap">{relativeTime(env.updatedAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {!env.isDefault && <button type="button" onClick={() => makeDefault(env)} className="px-2 py-1 rounded text-[11.5px] font-medium text-[#7C3AED] hover:bg-[#F5F3FF]">Set default</button>}
                        <button type="button" onClick={() => setEditing(env)} className="p-1.5 rounded text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]" title="Edit" aria-label={`Edit ${env.name}`}><Pencil className="w-3.5 h-3.5" /></button>
                        <button type="button" onClick={() => remove(env)} className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete" aria-label={`Delete ${env.name}`}><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function EnvForm({ initial, saving, onCancel, onSave }: { initial: Partial<ApiEnvironment>; saving: boolean; onCancel: () => void; onSave: (env: { id?: string; name: string; baseUrl: string; variables: EnvVariable[]; isDefault: boolean }) => void }) {
  const [name, setName] = useState(initial.name || '');
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl || '');
  const [isDefault, setIsDefault] = useState(!!initial.isDefault);
  const [vars, setVars] = useState<EnvVariable[]>(initial.variables?.length ? initial.variables : [{ key: '', value: '', secret: false }]);
  // Row indexes whose secret value is currently shown as plain text.
  const [shown, setShown] = useState<Set<number>>(new Set());
  const update = (i: number, patch: Partial<EnvVariable>) => setVars((p) => p.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const toggleShown = (i: number) => setShown((p) => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const removeVar = (i: number) => { setVars((p) => p.filter((_, j) => j !== i)); setShown(new Set()); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave({ id: initial.id, name, baseUrl: baseUrl.trim(), variables: vars, isDefault }); }} className={CARD}>
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-200">
        <h3 className="text-[13px] font-semibold text-gray-900">{initial.id ? 'Edit environment' : 'New environment'}</h3>
        <button type="button" onClick={onCancel} aria-label="Close" className="ml-auto p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100"><X className="w-4 h-4" /></button>
      </div>

      <div className="px-5 py-4 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
          <div><label className={LABEL}>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Staging" className={INPUT} autoFocus /></div>
          <div><label className={LABEL}>Base URL</label><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging-api.acme.com/v1" spellCheck={false} className={`${INPUT} font-mono`} /></div>
        </div>
        <label className="inline-flex items-center gap-2 text-[12px] text-gray-700 cursor-pointer"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC]" />Use as the default environment</label>

        <div>
          <label className={LABEL}>Variables</label>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full table-fixed text-[12px]">
              <thead className={`text-[10.5px] uppercase tracking-wide text-gray-500 ${THEAD}`}>
                <tr>
                  <th className="w-[32%] text-left px-3 py-2 font-semibold">Key</th>
                  <th className="text-left px-3 py-2 font-semibold">Value</th>
                  <th className="w-[84px] text-center px-3 py-2 font-semibold">Secret</th>
                  <th className="w-[48px] px-3 py-2"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {vars.map((v, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-3 py-2"><input value={v.key} onChange={(e) => update(i, { key: e.target.value.replace(/[^\w.-]/g, '') })} placeholder="key" aria-label={`Variable ${i + 1} key`} spellCheck={false} className={`${FIELD} w-full font-mono`} /></td>
                    <td className="px-3 py-2">
                      <div className="relative">
                        <input value={v.value} onChange={(e) => update(i, { value: e.target.value })} type={v.secret && !shown.has(i) ? 'password' : 'text'} autoComplete="off" placeholder={v.secret ? 'stored encrypted' : 'value'} aria-label={`Variable ${i + 1} value`} spellCheck={false} className={`${FIELD} w-full font-mono ${v.secret ? 'pr-8' : ''}`} />
                        {v.secret && <button type="button" onClick={() => toggleShown(i)} title={shown.has(i) ? 'Hide value' : 'Show value'} aria-label={shown.has(i) ? 'Hide value' : 'Show value'} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED]">{shown.has(i) ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}</button>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center"><input type="checkbox" checked={v.secret} onChange={(e) => update(i, { secret: e.target.checked })} title="Secret values are stored encrypted and masked" aria-label={`Variable ${i + 1} is secret`} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC]" /></td>
                    <td className="px-3 py-2 text-center"><button type="button" onClick={() => removeVar(i)} title="Remove variable" aria-label={`Remove variable ${i + 1}`} className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"><Trash2 className="w-3.5 h-3.5" /></button></td>
                  </tr>
                ))}
                {vars.length === 0 && <tr className="border-t border-gray-100"><td colSpan={4} className="px-3 py-4 text-center text-[11.5px] text-gray-400">No variables yet.</td></tr>}
              </tbody>
            </table>
            <div className="border-t border-gray-100 px-3 py-2">
              <button type="button" onClick={() => setVars((p) => [...p, { key: '', value: '', secret: false }])} className="inline-flex items-center gap-1 text-[12px] font-medium text-[#7C3AED] hover:underline"><Plus className="w-3.5 h-3.5" />Add variable</button>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">Use a variable in an endpoint as <code className="font-mono">{'{{key}}'}</code>. These keys set up sign-in automatically: <code className="font-mono">token</code> (Bearer), <code className="font-mono">apiKey</code> (API key header), <code className="font-mono">basicAuth</code> (user:password). A masked secret left unchanged keeps its stored value.</p>
        </div>
      </div>

      <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50/60 rounded-b-lg">
        <button type="button" onClick={onCancel} className={SECONDARY_BTN}>Cancel</button>
        <button type="submit" disabled={saving} className={PRIMARY_BTN}>{saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save environment</button>
      </div>
    </form>
  );
}

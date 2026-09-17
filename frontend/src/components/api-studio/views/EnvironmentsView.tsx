/**
 * EnvironmentsView — test-environment management.
 *
 * An environment is a base URL plus variables. Endpoints use `{{name}}`
 * placeholders; at run time the active environment fills them in and
 * re-homes every URL on its base. Secret values are stored encrypted and
 * come back masked — they are only resolved server-side for a run.
 */
import { useState } from 'react';
import { Plus, Server, Star, Trash2, Pencil, Save, X, Lock, Check, Loader2 } from 'lucide-react';
import { useToast } from '@/components/feedback/ToastProvider';
import { CARD, CARD_HOVER, TILE, TILE_ACTIVE, CHIP_3D, PRIMARY_BTN, SECONDARY_BTN, INPUT, LABEL, BRAND_CHIP, MUTED_CHIP, relativeTime } from '../format';
import { EmptyState } from '../primitives';
import type { Catalog } from '../hooks/useCatalog';
import type { ApiEnvironment, EnvVariable } from '../types';

import Loader from '@/components/feedback/Loader';
const SUGGESTED: EnvVariable[] = [
  { key: 'token', value: '', secret: true },
  { key: 'apiKey', value: '', secret: true },
];

export default function EnvironmentsView({ catalog }: { catalog: Catalog }) {
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<ApiEnvironment> | null>(null);
  const [saving, setSaving] = useState(false);
  const { environments, activeEnvId, setActiveEnvId, envLoading } = catalog;

  const save = async (env: { id?: string; name: string; baseUrl: string; variables: EnvVariable[]; isDefault: boolean }) => {
    if (!env.name.trim()) { toast.warning('Name required', 'Give the environment a name.'); return; }
    setSaving(true);
    try {
      const saved = await catalog.saveEnvironment({ ...env, variables: env.variables.filter((v) => v.key.trim()) });
      setEditing(null);
      if (!activeEnvId) setActiveEnvId(saved.id);
      toast.success('Environment saved', saved.name);
    } catch (err) { toast.fromError(err); }
    finally { setSaving(false); }
  };
  const remove = async (env: ApiEnvironment) => {
    if (!window.confirm(`Delete environment "${env.name}"?`)) return;
    try { await catalog.removeEnvironment(env.id); toast.success('Environment deleted', env.name); }
    catch (err) { toast.fromError(err); }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-gray-900">Environments</h2>
            <p className="text-[11.5px] text-gray-500">Base URL + variables per target. Use <code className="font-mono bg-gray-100 px-1 rounded">{'{{token}}'}</code>-style placeholders in endpoints; the active environment fills them at run time.</p>
          </div>
          <button type="button" onClick={() => setEditing({ name: '', baseUrl: '', variables: SUGGESTED, isDefault: environments.length === 0 })} className={`ml-auto ${PRIMARY_BTN}`}><Plus className="w-3.5 h-3.5" />New environment</button>
        </div>

        {editing && <EnvForm initial={editing} saving={saving} onCancel={() => setEditing(null)} onSave={save} />}

        {envLoading && environments.length === 0 ? (
          <Loader.Block label="Loading environments" />
        ) : environments.length === 0 && !editing ? (
          <EmptyState icon={Server} title="No environments yet" hint="Create one per target (dev, staging, prod) with its base URL and credentials. Runs, the CLI and the public API can all pick one." />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {environments.map((env) => {
              const active = env.id === activeEnvId;
              return (
                <div key={env.id} className={`${CARD_HOVER} p-4 ${active ? 'border-[#A5B4FC] ring-2 ring-[#EDE9FE]' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${active ? TILE_ACTIVE : TILE}`}><Server className={`w-3.5 h-3.5 ${active ? 'text-white' : 'text-[#7C3AED]'}`} /></span>
                    <h3 className="text-[13px] font-semibold text-gray-900">{env.name}</h3>
                    {env.isDefault && <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9.5px] font-semibold ${BRAND_CHIP}`}><Star className="w-2.5 h-2.5" />Default</span>}
                    {active && <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9.5px] font-semibold text-emerald-700 bg-emerald-50 border-emerald-200"><Check className="w-2.5 h-2.5" />Active</span>}
                    <div className="ml-auto flex items-center gap-0.5">
                      <button type="button" onClick={() => setEditing(env)} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                      <button type="button" onClick={() => remove(env)} className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                  <p className="mt-1.5 font-mono text-[11.5px] text-gray-700 truncate">{env.baseUrl || <span className="text-gray-300">no base URL — endpoints keep their own host</span>}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {env.variables.length === 0 ? <span className="text-[10.5px] text-gray-400">No variables</span> : env.variables.map((v) => (
                      <span key={v.key} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10px] ${MUTED_CHIP}`}>{v.secret && <Lock className="w-2.5 h-2.5" />}{v.key}</span>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-[10.5px] text-gray-400">Updated {relativeTime(env.updatedAt)}</span>
                    {!active && <button type="button" onClick={() => setActiveEnvId(env.id)} className={`ml-auto ${SECONDARY_BTN}`}>Use for runs</button>}
                    {active && <button type="button" onClick={() => setActiveEnvId(null)} className={`ml-auto ${SECONDARY_BTN}`}>Deactivate</button>}
                  </div>
                </div>
              );
            })}
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
  const update = (i: number, patch: Partial<EnvVariable>) => setVars((p) => p.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave({ id: initial.id, name, baseUrl: baseUrl.trim(), variables: vars, isDefault }); }} className={`${CARD} p-4 space-y-3`}>
      <div className="flex items-center gap-2"><h3 className="text-[12.5px] font-semibold text-gray-900">{initial.id ? 'Edit environment' : 'New environment'}</h3><button type="button" onClick={onCancel} className="ml-auto p-1 text-gray-400 hover:text-[#7C3AED]"><X className="w-4 h-4" /></button></div>
      <div className="grid grid-cols-[220px_1fr_auto] gap-3 items-end">
        <div><label className={LABEL}>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Staging" className={INPUT} autoFocus /></div>
        <div><label className={LABEL}>Base URL</label><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://staging-api.acme.com/v1" spellCheck={false} className={`${INPUT} font-mono`} /></div>
        <label className="flex items-center gap-1.5 text-[11.5px] text-gray-600 pb-2 cursor-pointer"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC]" />Default</label>
      </div>
      <div>
        <label className={LABEL}>Variables</label>
        <div className="space-y-1">
          {vars.map((v, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input value={v.key} onChange={(e) => update(i, { key: e.target.value.replace(/[^\w.-]/g, '') })} placeholder="token" spellCheck={false} className={`${INPUT} font-mono w-[200px]`} />
              <input value={v.value} onChange={(e) => update(i, { value: e.target.value })} type={v.secret ? 'password' : 'text'} autoComplete="off" placeholder={v.secret ? 'stored encrypted' : 'value'} spellCheck={false} className={`${INPUT} font-mono flex-1`} />
              <button type="button" onClick={() => update(i, { secret: !v.secret })} title={v.secret ? 'Secret — stored encrypted, masked in the UI' : 'Plain value'} className={`p-1.5 rounded border transition-all active:translate-y-px ${CHIP_3D} ${v.secret ? 'bg-gradient-to-b from-[#F5F3FF] to-[#EDE9FE] border-[#DDD6FE] text-[#6D28D9]' : 'bg-white border-gray-200 text-gray-400 hover:text-[#7C3AED]'}`}><Lock className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => setVars((p) => p.filter((_, j) => j !== i))} className="p-1.5 text-gray-300 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <button type="button" onClick={() => setVars((p) => [...p, { key: '', value: '', secret: false }])} className="inline-flex items-center gap-1 text-[11px] font-medium text-[#7C3AED]"><Plus className="w-3 h-3" />Add variable</button>
        </div>
        <p className="mt-1.5 text-[10.5px] text-gray-400 leading-relaxed">Conventional names resolve auth automatically: <code className="font-mono">token</code> → Bearer, <code className="font-mono">apiKey</code> → API key header, <code className="font-mono">basicAuth</code> (user:password) → Basic. A masked secret left unchanged keeps its stored value.</p>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={SECONDARY_BTN}>Cancel</button>
        <button type="submit" disabled={saving} className={PRIMARY_BTN}>{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save</button>
      </div>
    </form>
  );
}

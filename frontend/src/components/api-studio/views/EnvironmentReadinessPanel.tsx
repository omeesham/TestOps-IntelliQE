/**
 * EnvironmentReadinessPanel — configure and preview the pre-run readiness gate
 * for one environment (roadmap Feature 5 / Gate 4).
 *
 * Readiness is OPT-IN: until "Enable" is on, nothing gates a run. When enabled,
 * active checks (base URL reachable, health paths, dependencies, required vars,
 * an authenticated probe, production write-safety) run before a run against this
 * environment and, with "Block runs on failure", stop it with
 * `environment_not_ready` — so an environment problem never masquerades as a pile
 * of product-defect test failures. "Check now" previews the checks on demand.
 */
import { useEffect, useState } from 'react';
import { X, Activity, Save, ShieldAlert, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import {
  getApiReadinessConfig, saveApiReadinessConfig, checkApiReadiness,
  type ApiReadinessConfig, type ApiReadinessResult,
} from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';
import { CARD, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from '../format';
import type { ApiEnvironment } from '../types';

const DEFAULTS: ApiReadinessConfig = {
  enabled: false, blockOnFail: true, checkBaseUrl: true,
  healthPaths: [], dependencies: [], requiredVars: [],
  checkAuth: false, authType: 'bearer', authHeaderName: undefined, authProbePath: undefined,
  production: false, blockWritesOnProduction: true,
};

const toLines = (a: string[]) => a.join('\n');
const fromLines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export default function EnvironmentReadinessPanel({ env, onClose }: { env: ApiEnvironment; onClose: () => void }) {
  const toast = useToast();
  const [cfg, setCfg] = useState<ApiReadinessConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ApiReadinessResult | null>(null);

  useEffect(() => {
    let alive = true;
    getApiReadinessConfig(env.id)
      .then((r) => { if (alive) setCfg({ ...DEFAULTS, ...r.config }); })
      .catch((err) => toast.fromError(err))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [env.id]);

  const patch = (p: Partial<ApiReadinessConfig>) => setCfg((c) => ({ ...c, ...p }));

  const save = async () => {
    setSaving(true);
    try { const { config } = await saveApiReadinessConfig(env.id, cfg); setCfg({ ...DEFAULTS, ...config }); toast.success('Readiness saved', env.name); }
    catch (err) { toast.fromError(err); }
    finally { setSaving(false); }
  };

  const check = async () => {
    setChecking(true); setResult(null);
    try { const { readiness } = await checkApiReadiness(env.id); setResult(readiness); }
    catch (err) { toast.fromError(err); }
    finally { setChecking(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-[640px] max-h-[88vh] overflow-y-auto p-5`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Readiness gate — {env.name}</h3>
          <button type="button" onClick={onClose} className="ml-auto p-1 text-gray-400 hover:text-[#7C3AED]"><X className="w-4 h-4" /></button>
        </div>

        {loading ? (
          <div className="py-10 text-center text-gray-400 text-[12px]"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-4">
              <Toggle label="Enable readiness gate" checked={cfg.enabled} onChange={(v) => patch({ enabled: v })} />
              <Toggle label="Block runs on failure" checked={cfg.blockOnFail} onChange={(v) => patch({ blockOnFail: v })} />
              <Toggle label="Base URL reachable" checked={cfg.checkBaseUrl} onChange={(v) => patch({ checkBaseUrl: v })} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className={LABEL}>Health paths (one per line)</label>
                <textarea value={toLines(cfg.healthPaths)} onChange={(e) => patch({ healthPaths: fromLines(e.target.value) })} rows={2} placeholder="/health&#10;/ready" spellCheck={false} className={`${INPUT} font-mono resize-y`} />
              </div>
              <div>
                <label className={LABEL}>Dependency URLs (one per line)</label>
                <textarea value={toLines(cfg.dependencies)} onChange={(e) => patch({ dependencies: fromLines(e.target.value) })} rows={2} placeholder="https://auth.acme.com/health" spellCheck={false} className={`${INPUT} font-mono resize-y`} />
              </div>
              <div>
                <label className={LABEL}>Required variables (one per line)</label>
                <textarea value={toLines(cfg.requiredVars)} onChange={(e) => patch({ requiredVars: fromLines(e.target.value) })} rows={2} placeholder="token&#10;baseUrl" spellCheck={false} className={`${INPUT} font-mono resize-y`} />
              </div>
              <div className="space-y-2">
                <Toggle label="Auth probe" checked={cfg.checkAuth} onChange={(v) => patch({ checkAuth: v })} />
                {cfg.checkAuth && (
                  <div className="space-y-1.5">
                    <select value={cfg.authType} onChange={(e) => patch({ authType: e.target.value as ApiReadinessConfig['authType'] })} className={INPUT}>
                      <option value="bearer">Bearer token</option>
                      <option value="basic">Basic</option>
                      <option value="apikey">API key</option>
                    </select>
                    <input value={cfg.authProbePath || ''} onChange={(e) => patch({ authProbePath: e.target.value })} placeholder="/api/v1/me" spellCheck={false} className={`${INPUT} font-mono`} />
                    {cfg.authType === 'apikey' && <input value={cfg.authHeaderName || ''} onChange={(e) => patch({ authHeaderName: e.target.value })} placeholder="X-API-Key" spellCheck={false} className={`${INPUT} font-mono`} />}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-4 pt-1 border-t border-gray-100">
              <Toggle label="Production environment" checked={cfg.production} onChange={(v) => patch({ production: v })} />
              {cfg.production && <Toggle label="Block runs that write" checked={cfg.blockWritesOnProduction} onChange={(v) => patch({ blockWritesOnProduction: v })} />}
            </div>

            {result && (
              <div className={`rounded-lg border p-3 ${result.ready ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
                <div className="flex items-center gap-1.5 text-[12px] font-semibold mb-1.5">
                  {result.ready ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                  <span className={result.ready ? 'text-emerald-800' : 'text-red-800'}>
                    {result.ready ? 'Ready' : 'Not ready'}{result.blocked ? ' — would block runs' : ''}
                  </span>
                </div>
                {result.checks.length === 0 ? (
                  <p className="text-[11px] text-gray-500">No checks enabled.</p>
                ) : (
                  <ul className="space-y-1">
                    {result.checks.map((c) => (
                      <li key={c.id} className="flex items-start gap-1.5 text-[11.5px]">
                        {c.pass ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-px flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-red-600 mt-px flex-shrink-0" />}
                        <span className="text-gray-700">{c.label} — <span className="text-gray-500 font-mono">{c.actual}</span></span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={check} disabled={checking} className={SECONDARY_BTN}>
                {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}Check now
              </button>
              <button type="button" onClick={save} disabled={saving} className={PRIMARY_BTN}>
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[11.5px] text-gray-600 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC]" />
      {label}
    </label>
  );
}

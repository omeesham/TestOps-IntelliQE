/**
 * CloudLab — the cloud browser/device lab.
 *
 * Runs the same UI checks as the API+UI hybrid test, but on HOSTED real browsers
 * in a provider grid (BrowserStack / LambdaTest) or any raw Playwright WebSocket
 * endpoint (Sauce Labs, Selenium Grid, Moon, a self-hosted grid) — so one set of
 * checks runs across a MATRIX of browser/OS combinations and comes back with a
 * pass/fail + screenshot per target. Two tabs: Providers (connection configs,
 * credentials stored encrypted + masked) and Run matrix. Opt-in and standalone:
 * it touches nothing in the catalogue or the generate → execute → heal pipeline.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  MonitorSmartphone, X, Plus, Trash2, Play, Save, Plug, Power,
  AlertTriangle, CheckCircle2, XCircle, Globe,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listCloudLabs, saveCloudLab, deleteCloudLab, testCloudLab, runCloudMatrix,
  type CloudLabConfig, type CloudProvider, type CloudTarget, type CloudRunResult, type UiCheck,
} from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, formatDuration } from './format';

type Tab = 'providers' | 'run';

const PROVIDER_LABELS: Record<CloudProvider, string> = {
  browserstack: 'BrowserStack',
  lambdatest: 'LambdaTest',
  custom: 'Custom (Playwright WS endpoint)',
};
const PROVIDERS: CloudProvider[] = ['browserstack', 'lambdatest', 'custom'];

const UI_CHECK_LABELS: Record<UiCheck['kind'], string> = {
  textPresent: 'Text present',
  textAbsent: 'Text absent',
  selectorPresent: 'Selector present',
  selectorCount: 'Selector count',
  titleContains: 'Title contains',
  urlContains: 'URL contains',
};
const SELECTOR_KINDS = new Set<UiCheck['kind']>(['selectorPresent', 'selectorCount']);
const TEXT_KINDS = new Set<UiCheck['kind']>(['textPresent', 'textAbsent', 'titleContains', 'urlContains']);

const TARGET_PRESETS: { label: string; target: CloudTarget }[] = [
  { label: 'Chrome · Windows 11', target: { browser: 'chrome', browserVersion: 'latest', os: 'Windows', osVersion: '11' } },
  { label: 'Edge · Windows 11', target: { browser: 'edge', browserVersion: 'latest', os: 'Windows', osVersion: '11' } },
  { label: 'Firefox · Windows 11', target: { browser: 'playwright-firefox', browserVersion: 'latest', os: 'Windows', osVersion: '11' } },
  { label: 'Chrome · macOS', target: { browser: 'chrome', browserVersion: 'latest', os: 'OS X', osVersion: 'Sonoma' } },
  { label: 'WebKit (Safari) · macOS', target: { browser: 'playwright-webkit', browserVersion: 'latest', os: 'OS X', osVersion: 'Sonoma' } },
];

interface EditUiCheck { _k: string; kind: UiCheck['kind']; selector: string; text: string; count: string }
interface EditTarget { _k: string; browser: string; browserVersion: string; os: string; osVersion: string }

let _seq = 0;
const nextKey = (p: string) => `${p}-${Date.now().toString(36)}-${(_seq++).toString(36)}`;
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

function toUiCheck(c: EditUiCheck): UiCheck {
  const out: UiCheck = { kind: c.kind };
  if (SELECTOR_KINDS.has(c.kind)) out.selector = c.selector.trim();
  if (c.kind === 'selectorCount') out.count = Number(c.count) || 0;
  if (TEXT_KINDS.has(c.kind)) out.text = c.text;
  return out;
}
function toTarget(t: EditTarget): CloudTarget {
  const out: CloudTarget = {};
  if (t.browser.trim()) out.browser = t.browser.trim();
  if (t.browserVersion.trim()) out.browserVersion = t.browserVersion.trim();
  if (t.os.trim()) out.os = t.os.trim();
  if (t.osVersion.trim()) out.osVersion = t.osVersion.trim();
  return out;
}
const presetToEdit = (t: CloudTarget): EditTarget => ({
  _k: nextKey('t'), browser: t.browser || '', browserVersion: t.browserVersion || '', os: t.os || '', osVersion: t.osVersion || '',
});
const blankTarget = (): EditTarget => ({ _k: nextKey('t'), browser: 'chrome', browserVersion: 'latest', os: 'Windows', osVersion: '11' });

export default function CloudLab({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('providers');

  const [labs, setLabs] = useState<CloudLabConfig[]>([]);

  // provider form
  const [fId, setFId] = useState('');
  const [fName, setFName] = useState('');
  const [fProvider, setFProvider] = useState<CloudProvider>('browserstack');
  const [fUsername, setFUsername] = useState('');
  const [fAccessKey, setFAccessKey] = useState('');
  const [fWsEndpoint, setFWsEndpoint] = useState('');
  const [fEnabled, setFEnabled] = useState(true);
  const [savingCfg, setSavingCfg] = useState(false);
  const [testingId, setTestingId] = useState('');
  const [cfgError, setCfgError] = useState('');

  // run
  const [runConfigId, setRunConfigId] = useState('');
  const [url, setUrl] = useState('');
  const [targets, setTargets] = useState<EditTarget[]>([blankTarget()]);
  const [checks, setChecks] = useState<EditUiCheck[]>([]);
  const [presetSel, setPresetSel] = useState('');
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<CloudRunResult | null>(null);
  const [runError, setRunError] = useState('');

  const editingExisting = !!fId;
  const current = labs.find((l) => l.id === fId);

  const refresh = async () => {
    try {
      const list = await listCloudLabs();
      setLabs(list);
      setRunConfigId((prev) => prev || list.find((l) => l.enabled)?.id || '');
    } catch { /* a missing list should not block the editor */ }
  };
  useEffect(() => { void refresh(); }, []);

  const resetForm = () => {
    setFId(''); setFName(''); setFProvider('browserstack'); setFUsername(''); setFAccessKey(''); setFWsEndpoint(''); setFEnabled(true); setCfgError('');
  };
  const editConfig = (c: CloudLabConfig) => {
    setFId(c.id); setFName(c.name); setFProvider(c.provider); setFUsername(c.username);
    setFAccessKey(''); setFWsEndpoint(''); setFEnabled(c.enabled); setCfgError('');
  };

  const saveConfig = async () => {
    if (!fName.trim()) { setCfgError('Give this provider connection a name.'); return; }
    if (fProvider !== 'custom' && !fUsername.trim()) { setCfgError('Enter the provider username.'); return; }
    setSavingCfg(true); setCfgError('');
    try {
      const saved = await saveCloudLab({
        id: fId || undefined,
        name: fName.trim(),
        provider: fProvider,
        username: fUsername.trim(),
        accessKey: fAccessKey.trim() || undefined,
        wsEndpoint: fWsEndpoint.trim() || undefined,
        enabled: fEnabled,
      });
      toast.success('Cloud lab saved', `“${saved.name}” saved.`);
      await refresh();
      setFId(saved.id); setFAccessKey(''); setFWsEndpoint('');
    } catch (e: any) {
      const msg = e?.response?.data?.error || e?.message || 'Request failed.';
      setCfgError(msg); toast.error('Save failed', msg);
    } finally { setSavingCfg(false); }
  };

  const removeConfig = async (id: string) => {
    try {
      await deleteCloudLab(id);
      if (fId === id) resetForm();
      if (runConfigId === id) setRunConfigId('');
      await refresh();
      toast.success('Cloud lab deleted');
    } catch (e: any) {
      toast.error('Delete failed', e?.response?.data?.error || e?.message || 'Request failed.');
    }
  };

  const testConfig = async (id: string) => {
    setTestingId(id);
    try {
      const r = await testCloudLab(id);
      if (r.ok) toast.success('Connection OK', r.detail);
      else toast.error('Connection failed', r.detail);
    } catch (e: any) {
      toast.error('Connection failed', e?.response?.data?.error || e?.message || 'Request failed.');
    } finally { setTestingId(''); }
  };

  // run editors
  const addCheck = () => setChecks((p) => [...p, { _k: nextKey('u'), kind: 'textPresent', selector: '', text: '', count: '' }]);
  const setCheck = (k: string, p: Partial<EditUiCheck>) => setChecks((prev) => prev.map((c) => (c._k === k ? { ...c, ...p } : c)));
  const delCheck = (k: string) => setChecks((prev) => prev.filter((c) => c._k !== k));
  const patchTarget = (k: string, p: Partial<EditTarget>) => setTargets((prev) => prev.map((t) => (t._k === k ? { ...t, ...p } : t)));
  const delTarget = (k: string) => setTargets((prev) => prev.filter((t) => t._k !== k));

  const runMatrix = async () => {
    if (!runConfigId) { setRunError('Select a provider connection to run on.'); return; }
    if (!url.trim()) { setRunError('Enter a URL to open.'); return; }
    setRunning(true); setRunError(''); setRunResult(null);
    try {
      const res = await runCloudMatrix({
        configId: runConfigId,
        url: url.trim(),
        targets: targets.map(toTarget),
        checks: checks.map(toUiCheck),
      });
      setRunResult(res);
    } catch (e: any) {
      setRunError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally { setRunning(false); }
  };

  const enabledLabs = labs.filter((l) => l.enabled);
  const TAB_BTN = (active: boolean) =>
    `px-3 h-8 text-[12px] font-medium rounded-md ${active ? 'bg-[#7C3AED] text-white' : 'text-gray-500 hover:text-[#7C3AED] hover:bg-[#F5F3FF]'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <MonitorSmartphone className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Cloud browser/device lab</h3>
          <span className="text-[11px] text-gray-400">run UI checks on hosted real browsers across a matrix</span>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" onClick={() => setTab('providers')} className={TAB_BTN(tab === 'providers')}>Providers</button>
            <button type="button" onClick={() => setTab('run')} className={TAB_BTN(tab === 'run')}>Run matrix</button>
            <button type="button" onClick={onClose} className="ml-1 p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* ───────────── PROVIDERS ───────────── */}
          {tab === 'providers' && (
            <>
              {labs.length > 0 && (
                <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 overflow-hidden">
                  {labs.map((l) => (
                    <div key={l.id} className={`flex items-center gap-2 px-3 py-1.5 ${fId === l.id ? 'bg-[#F5F3FF]' : ''}`}>
                      <button type="button" onClick={() => editConfig(l)} className="flex-1 min-w-0 text-left flex items-baseline gap-2">
                        <span className="text-[12px] font-medium text-gray-800 truncate">{l.name}</span>
                        <span className="text-[10.5px] text-gray-400 whitespace-nowrap flex-shrink-0">
                          {PROVIDER_LABELS[l.provider]}{l.username ? ` · ${l.username}` : ''}{l.provider === 'custom' ? (l.hasWsEndpoint ? ' · endpoint set' : ' · no endpoint') : (l.hasAccessKey ? ' · key set' : ' · no key')}
                        </span>
                      </button>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${l.enabled ? 'bg-[#DCFCE7] text-[#15803D]' : 'bg-gray-100 text-gray-400'}`}>{l.enabled ? 'enabled' : 'disabled'}</span>
                      <button type="button" onClick={() => void testConfig(l.id)} disabled={testingId === l.id} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] flex-shrink-0" title="Test connection">
                        {testingId === l.id ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                      </button>
                      <button type="button" onClick={() => void removeConfig(l.id)} className="p-1 rounded text-gray-400 hover:text-red-500 flex-shrink-0" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}

              <div className={`${CARD} p-3 space-y-2.5`}>
                <div className="flex items-center justify-between">
                  <h4 className="text-[12px] font-semibold text-gray-800">{editingExisting ? `Edit “${current?.name || ''}”` : 'Add a provider connection'}</h4>
                  {editingExisting && <button type="button" onClick={resetForm} className="text-[11px] text-[#7C3AED] hover:underline">＋ New connection</button>}
                </div>

                <div className="flex gap-2">
                  <div className="flex-1 min-w-0">
                    <label className={LABEL}>Name</label>
                    <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="BrowserStack — team key" className={INPUT} />
                  </div>
                  <div>
                    <label className={LABEL}>Provider</label>
                    <select value={fProvider} onChange={(e) => setFProvider(e.target.value as CloudProvider)} className={FIELD}>
                      {PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
                    </select>
                  </div>
                </div>

                {fProvider === 'custom' ? (
                  <div>
                    <label className={LABEL}>Playwright WebSocket endpoint</label>
                    <input value={fWsEndpoint} onChange={(e) => setFWsEndpoint(e.target.value)} placeholder={current?.hasWsEndpoint ? '•••••••• (unchanged — type to replace)' : 'wss://…/playwright?caps=…'} className={`${INPUT} font-mono`} />
                    <p className="text-[11px] text-gray-400 mt-1">Any <code className="font-mono text-[#6D28D9]">ws://</code> / <code className="font-mono text-[#6D28D9]">wss://</code> endpoint that speaks Playwright CDP — Sauce Labs, a Selenium/Moon grid, or a self-hosted one. Capabilities live inside the URL; the target fields below are ignored for custom.</p>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <div className="flex-1 min-w-0">
                      <label className={LABEL}>Username</label>
                      <input value={fUsername} onChange={(e) => setFUsername(e.target.value)} placeholder="your-provider-username" className={INPUT} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <label className={LABEL}>Access key</label>
                      <input type="password" value={fAccessKey} onChange={(e) => setFAccessKey(e.target.value)} placeholder={current?.hasAccessKey ? '•••••••• (unchanged — type to replace)' : 'access key'} className={INPUT} autoComplete="off" />
                    </div>
                  </div>
                )}

                {cfgError && (
                  <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                    <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{cfgError}</p>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setFEnabled((v) => !v)} className={`inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 h-8 rounded-md border ${fEnabled ? 'border-[#DDD6FE] text-[#6D28D9] bg-[#F5F3FF]' : 'border-gray-200 text-gray-400'}`}>
                    <Power className="w-3.5 h-3.5" />{fEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                  <button type="button" onClick={() => void saveConfig()} disabled={savingCfg} className={SECONDARY_BTN}>{savingCfg ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save</button>
                  {editingExisting && <button type="button" onClick={() => void testConfig(fId)} disabled={testingId === fId} className={SECONDARY_BTN}>{testingId === fId ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}Test connection</button>}
                </div>
                <p className="text-[11px] text-gray-400">Credentials are encrypted at rest and only ever returned masked. “Test connection” opens a single cloud session to <span className="font-mono">example.com</span> to confirm the key/endpoint works.</p>
              </div>
            </>
          )}

          {/* ───────────── RUN MATRIX ───────────── */}
          {tab === 'run' && (
            <>
              {enabledLabs.length === 0 ? (
                <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-px" />
                  <p className="text-[12px] text-amber-800">Add and enable a provider connection on the <button type="button" onClick={() => setTab('providers')} className="font-semibold underline">Providers</button> tab first.</p>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[180px]">
                      <label className={LABEL}>Provider connection</label>
                      <select value={runConfigId} onChange={(e) => setRunConfigId(e.target.value)} className={FIELD}>
                        {enabledLabs.map((l) => <option key={l.id} value={l.id}>{l.name} · {PROVIDER_LABELS[l.provider]}</option>)}
                      </select>
                    </div>
                    <div className="flex-1 min-w-[200px]">
                      <label className={LABEL}>URL to open</label>
                      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.example.com/orders" className={INPUT} />
                    </div>
                    <button type="button" onClick={() => void runMatrix()} disabled={running || !url.trim()} className={PRIMARY_BTN}>
                      {running ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}{running ? 'Running…' : 'Run matrix'}
                    </button>
                  </div>

                  {/* Targets */}
                  <div className={`${CARD} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-gray-800">Targets <span className="text-[10.5px] font-normal text-gray-400">({targets.length}/6)</span></span>
                      <div className="flex items-center gap-2">
                        <select
                          value={presetSel}
                          onChange={(e) => { const p = TARGET_PRESETS.find((x) => x.label === e.target.value); if (p && targets.length < 6) setTargets((prev) => [...prev, presetToEdit(p.target)]); setPresetSel(''); }}
                          className={FIELD}
                        >
                          <option value="">＋ preset…</option>
                          {TARGET_PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
                        </select>
                        <button type="button" onClick={() => targets.length < 6 && setTargets((prev) => [...prev, blankTarget()])} disabled={targets.length >= 6} className="text-[11px] text-[#7C3AED] hover:underline inline-flex items-center gap-0.5 disabled:opacity-40"><Plus className="w-3 h-3" />Add</button>
                      </div>
                    </div>
                    <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-1.5 items-center">
                      <span className={`${LABEL} mb-0`}>Browser</span>
                      <span className={`${LABEL} mb-0`}>Version</span>
                      <span className={`${LABEL} mb-0`}>OS</span>
                      <span className={`${LABEL} mb-0`}>OS version</span>
                      <span />
                      {targets.map((t) => (
                        <FragmentRow key={t._k}>
                          <input value={t.browser} onChange={(e) => patchTarget(t._k, { browser: e.target.value })} placeholder="chrome" className={FIELD} />
                          <input value={t.browserVersion} onChange={(e) => patchTarget(t._k, { browserVersion: e.target.value })} placeholder="latest" className={FIELD} />
                          <input value={t.os} onChange={(e) => patchTarget(t._k, { os: e.target.value })} placeholder="Windows" className={FIELD} />
                          <input value={t.osVersion} onChange={(e) => patchTarget(t._k, { osVersion: e.target.value })} placeholder="11" className={FIELD} />
                          <button type="button" onClick={() => delTarget(t._k)} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                        </FragmentRow>
                      ))}
                    </div>
                    <p className="text-[11px] text-gray-400">Field names follow your provider's Playwright capabilities (BrowserStack &amp; LambdaTest differ slightly). Leave a row blank to use the provider's default browser. Custom endpoints ignore these — caps live in the WS URL.</p>
                  </div>

                  {/* Checks */}
                  <div className={`${CARD} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-gray-800">Checks</span>
                      <button type="button" onClick={addCheck} className="text-[11px] text-[#7C3AED] hover:underline inline-flex items-center gap-0.5"><Plus className="w-3 h-3" />Add check</button>
                    </div>
                    {checks.length === 0 && <p className="text-[11px] text-gray-400">Add a check to assert what the page shows on each browser. With no checks, a target counts as failed (nothing was asserted).</p>}
                    <div className="space-y-1.5">
                      {checks.map((c) => (
                        <div key={c._k} className="flex gap-1.5 items-center">
                          <select value={c.kind} onChange={(e) => setCheck(c._k, { kind: e.target.value as UiCheck['kind'] })} className={`${FIELD} flex-shrink-0`}>
                            {(Object.keys(UI_CHECK_LABELS) as UiCheck['kind'][]).map((k) => <option key={k} value={k}>{UI_CHECK_LABELS[k]}</option>)}
                          </select>
                          {SELECTOR_KINDS.has(c.kind) && <input value={c.selector} onChange={(e) => setCheck(c._k, { selector: e.target.value })} placeholder=".order-status" className={`${FIELD} flex-1 min-w-0 font-mono`} />}
                          {c.kind === 'selectorCount' && <input value={c.count} onChange={(e) => setCheck(c._k, { count: e.target.value })} placeholder="count" inputMode="numeric" className={`${FIELD} w-20 flex-shrink-0`} />}
                          {TEXT_KINDS.has(c.kind) && <input value={c.text} onChange={(e) => setCheck(c._k, { text: e.target.value })} placeholder={c.kind === 'urlContains' ? '/orders/' : c.kind === 'titleContains' ? 'Orders' : 'Shipped'} className={`${FIELD} flex-1 min-w-0`} />}
                          <button type="button" onClick={() => delCheck(c._k)} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {runError && (
                    <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{runError}</p>
                    </div>
                  )}

                  {/* Results */}
                  {runResult && (
                    <div className="space-y-3 pt-1">
                      <div className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border ${runResult.passed ? 'bg-[#F0FDF4] border-[#BBF7D0]' : 'bg-red-50 border-red-200'}`}>
                        {runResult.passed ? <CheckCircle2 className="w-5 h-5 text-[#15803D]" /> : <XCircle className="w-5 h-5 text-red-600" />}
                        <span className={`text-[13px] font-semibold ${runResult.passed ? 'text-[#15803D]' : 'text-red-700'}`}>
                          {runResult.passedCount}/{runResult.total} targets passed
                        </span>
                        <span className="ml-auto text-[11px] text-gray-500 tabular-nums">{formatDuration(runResult.durationMs)}</span>
                      </div>
                      <div className="grid gap-2.5 sm:grid-cols-2">
                        {runResult.results.map((tr, i) => (
                          <div key={i} className={`border rounded-lg overflow-hidden ${tr.passed ? 'border-[#BBF7D0]' : tr.reached ? 'border-red-200' : 'border-amber-200'}`}>
                            <div className={`flex items-center gap-1.5 px-2.5 h-9 ${tr.passed ? 'bg-[#F0FDF4]' : tr.reached ? 'bg-red-50' : 'bg-amber-50'}`}>
                              <Globe className="w-3.5 h-3.5 text-[#7C3AED] flex-shrink-0" />
                              <span className="text-[12px] font-medium text-gray-800 truncate">{tr.label}</span>
                              <span className="ml-auto text-[10.5px] text-gray-400 tabular-nums flex-shrink-0">{formatDuration(tr.durationMs)}</span>
                              {tr.reached ? (tr.passed ? <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />) : <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />}
                            </div>
                            <div className="p-2.5 space-y-1.5">
                              {tr.error ? (
                                <p className="text-[11.5px] text-red-600">{tr.error}</p>
                              ) : (
                                <>
                                  {tr.title && <p className="text-[11px] text-gray-500">Title: <span className="text-gray-700">{clip(tr.title)}</span></p>}
                                  {tr.checks.length === 0 && <p className="text-[11px] text-gray-400">Reached — no checks configured.</p>}
                                  {tr.checks.map((c, j) => (
                                    <div key={j} className="flex items-start gap-1.5 text-[11.5px]">
                                      {c.pass ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-px flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-red-500 mt-px flex-shrink-0" />}
                                      <span className={c.pass ? 'text-gray-600' : 'text-red-600'}>{c.label}{c.detail ? <span className="text-gray-400"> · {c.detail}</span> : null}</span>
                                    </div>
                                  ))}
                                  {tr.screenshotBase64 && <img src={`data:image/png;base64,${tr.screenshotBase64}`} alt={`${tr.label} screenshot`} className="rounded border max-w-full max-h-48 object-contain" />}
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Small helper so each target's inputs sit on one grid row without extra wrappers. */
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

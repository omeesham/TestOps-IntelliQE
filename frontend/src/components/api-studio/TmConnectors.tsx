/**
 * TmConnectors — native test-management connectors with bidirectional export.
 *
 * Register TestRail / Xray / Zephyr Scale / qTest connections (credentials
 * stored encrypted, shown only as masked field names), test them, then push a
 * finished run's results out to the tool or pull its test cases back in for
 * review. Opt-in and standalone — it talks to the external tool's REST API and
 * touches nothing in the pipeline.
 */
import { useEffect, useState } from 'react';
import { Share2, X, Trash2, Plug, Upload, Download, Save, AlertTriangle, CheckCircle2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listTmConnectors, saveTmConnector, deleteTmConnector, testTmConnector, exportRunToTm, importTmCases, listApiRuns,
  type TmConnector, type TmVendor, type TmImportedCase,
} from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';

const VENDOR_LABELS: Record<TmVendor, string> = { testrail: 'TestRail', xray: 'Xray (Jira Cloud)', zephyr: 'Zephyr Scale', qtest: 'qTest' };
const VENDORS: TmVendor[] = ['testrail', 'xray', 'zephyr', 'qtest'];
const AUTH_FIELDS: Record<TmVendor, { key: string; label: string; secret: boolean }[]> = {
  testrail: [{ key: 'email', label: 'Email', secret: false }, { key: 'apiKey', label: 'API key', secret: true }],
  xray: [{ key: 'clientId', label: 'Client ID', secret: false }, { key: 'clientSecret', label: 'Client secret', secret: true }],
  zephyr: [{ key: 'token', label: 'API token', secret: true }],
  qtest: [{ key: 'token', label: 'Bearer token', secret: true }],
};
const BASE_PLACEHOLDER: Record<TmVendor, string> = {
  testrail: 'https://your-org.testrail.io', xray: 'https://xray.cloud.getxray.app (default)',
  zephyr: 'https://api.zephyrscale.smartbear.com/v2 (default)', qtest: 'https://your-org.qtestnet.com',
};
const PROJECT_PLACEHOLDER: Record<TmVendor, string> = { testrail: 'project id (e.g. 5)', xray: 'Jira project key (e.g. PAY)', zephyr: 'Jira project key (e.g. PAY)', qtest: 'project id (e.g. 101)' };

interface Form { id?: string; vendor: TmVendor; name: string; baseUrl: string; projectKey: string; auth: Record<string, string> }
const blankForm = (): Form => ({ vendor: 'testrail', name: '', baseUrl: '', projectKey: '', auth: {} });

export default function TmConnectors({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [connectors, setConnectors] = useState<TmConnector[]>([]);
  const [form, setForm] = useState<Form>(blankForm());
  const [savingCfg, setSavingCfg] = useState(false);
  const [testingId, setTestingId] = useState('');
  const [error, setError] = useState('');

  const [runs, setRuns] = useState<any[]>([]);
  const [opConnId, setOpConnId] = useState('');
  const [opRunId, setOpRunId] = useState('');
  const [busy, setBusy] = useState('');
  const [imported, setImported] = useState<TmImportedCase[] | null>(null);

  const refresh = async () => {
    try {
      const list = await listTmConnectors();
      setConnectors(list);
      setOpConnId((prev) => prev || list.find((c) => c.enabled)?.id || '');
    } catch { /* list is a convenience */ }
  };
  useEffect(() => {
    void refresh();
    void listApiRuns(1, 20).then((r) => {
      const items = Array.isArray(r?.items) ? r.items : [];
      setRuns(items);
      if (items.length) setOpRunId(String(items[0].runId ?? items[0].id ?? ''));
    }).catch(() => { /* runs are a convenience */ });
  }, []);

  const current = connectors.find((c) => c.id === form.id);
  const editingExisting = !!form.id;

  const editConnector = (c: TmConnector) => setForm({ id: c.id, vendor: c.vendor, name: c.name, baseUrl: c.baseUrl, projectKey: c.projectKey, auth: {} });
  const setVendor = (v: TmVendor) => setForm((p) => ({ ...p, vendor: v, auth: {} }));
  const setAuth = (k: string, v: string) => setForm((p) => ({ ...p, auth: { ...p.auth, [k]: v } }));

  const save = async () => {
    if (!form.name.trim()) { setError('Give the connector a name.'); return; }
    setSavingCfg(true); setError('');
    try {
      const saved = await saveTmConnector({ id: form.id, vendor: form.vendor, name: form.name.trim(), baseUrl: form.baseUrl.trim() || undefined, projectKey: form.projectKey.trim() || undefined, auth: form.auth });
      toast.success('Connector saved', `“${saved.name}” saved.`);
      setForm({ ...blankForm(), vendor: form.vendor });
      await refresh();
    } catch (e: any) {
      const msg = e?.response?.data?.error || e?.message || 'Request failed.';
      setError(msg); toast.error('Save failed', msg);
    } finally { setSavingCfg(false); }
  };
  const remove = async (id: string) => {
    try { await deleteTmConnector(id); if (form.id === id) setForm(blankForm()); if (opConnId === id) setOpConnId(''); await refresh(); toast.success('Connector deleted'); }
    catch (e: any) { toast.error('Delete failed', e?.response?.data?.error || e?.message || 'Request failed.'); }
  };
  const test = async (id: string) => {
    setTestingId(id);
    try { const r = await testTmConnector(id); r.ok ? toast.success('Connection OK', r.detail) : toast.error('Connection failed', r.detail); }
    catch (e: any) { toast.error('Connection failed', e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setTestingId(''); }
  };

  const doExport = async () => {
    if (!opConnId || !opRunId) { setError('Pick a connector and a run.'); return; }
    setBusy('export'); setError(''); setImported(null);
    try {
      const r = await exportRunToTm(opConnId, opRunId);
      r.ok ? toast.success('Exported', r.detail) : toast.error('Export issue', r.detail);
    } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setBusy(''); }
  };
  const doImport = async () => {
    if (!opConnId) { setError('Pick a connector.'); return; }
    setBusy('import'); setError(''); setImported(null);
    try {
      const r = await importTmCases(opConnId, 100);
      setImported(r.cases);
      r.ok ? toast.success('Imported', r.detail) : toast.error('Import issue', r.detail);
    } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setBusy(''); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Share2 className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Test-management connectors</h3>
          <span className="text-[11px] text-gray-400">TestRail · Xray · Zephyr · qTest</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {connectors.length > 0 && (
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 overflow-hidden">
              {connectors.map((c) => (
                <div key={c.id} className={`flex items-center gap-2 px-3 py-1.5 ${form.id === c.id ? 'bg-[#F5F3FF]' : ''}`}>
                  <button type="button" onClick={() => editConnector(c)} className="flex-1 min-w-0 text-left flex items-baseline gap-2">
                    <span className="text-[12px] font-medium text-gray-800 truncate">{c.name}</span>
                    <span className="text-[10.5px] text-gray-400 whitespace-nowrap flex-shrink-0">{VENDOR_LABELS[c.vendor]}{c.projectKey ? ` · ${c.projectKey}` : ''}{c.authFields.length ? ' · creds set' : ' · no creds'}</span>
                  </button>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${c.enabled ? 'bg-[#DCFCE7] text-[#15803D]' : 'bg-gray-100 text-gray-400'}`}>{c.enabled ? 'on' : 'off'}</span>
                  <button type="button" onClick={() => void test(c.id)} disabled={testingId === c.id} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] flex-shrink-0" title="Test">{testingId === c.id ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}</button>
                  <button type="button" onClick={() => void remove(c.id)} className="p-1 rounded text-gray-400 hover:text-red-500 flex-shrink-0" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
          )}

          {/* Editor */}
          <div className={`${CARD} p-3 space-y-2.5`}>
            <div className="flex items-center justify-between">
              <h4 className="text-[12px] font-semibold text-gray-800">{editingExisting ? `Edit “${current?.name || ''}”` : 'Add a connector'}</h4>
              {editingExisting && <button type="button" onClick={() => setForm(blankForm())} className="text-[11px] text-[#7C3AED] hover:underline">＋ New</button>}
            </div>
            <div className="flex gap-2">
              <div className="flex-1 min-w-0"><label className={LABEL}>Name</label><input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Release TestRail" className={INPUT} /></div>
              <div><label className={LABEL}>Vendor</label><select value={form.vendor} onChange={(e) => setVendor(e.target.value as TmVendor)} className={FIELD}>{VENDORS.map((v) => <option key={v} value={v}>{VENDOR_LABELS[v]}</option>)}</select></div>
            </div>
            <div className="flex gap-2">
              <div className="flex-1 min-w-0"><label className={LABEL}>Base URL</label><input value={form.baseUrl} onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))} placeholder={BASE_PLACEHOLDER[form.vendor]} className={`${INPUT} font-mono`} /></div>
              <div className="w-48"><label className={LABEL}>Project</label><input value={form.projectKey} onChange={(e) => setForm((p) => ({ ...p, projectKey: e.target.value }))} placeholder={PROJECT_PLACEHOLDER[form.vendor]} className={INPUT} /></div>
            </div>
            <div className="flex gap-2">
              {AUTH_FIELDS[form.vendor].map((f) => (
                <div key={f.key} className="flex-1 min-w-0">
                  <label className={LABEL}>{f.label}</label>
                  <input type={f.secret ? 'password' : 'text'} autoComplete="off" value={form.auth[f.key] || ''} onChange={(e) => setAuth(f.key, e.target.value)} placeholder={editingExisting && current?.authFields.includes(f.key) ? '•••••••• (unchanged)' : f.label} className={INPUT} />
                </div>
              ))}
            </div>
            {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p></div>}
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void save()} disabled={savingCfg} className={SECONDARY_BTN}>{savingCfg ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save</button>
              {editingExisting && <button type="button" onClick={() => void test(form.id!)} disabled={testingId === form.id} className={SECONDARY_BTN}>{testingId === form.id ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}Test</button>}
            </div>
            <p className="text-[11px] text-gray-400">Credentials are encrypted at rest and never returned. Leave a credential blank when editing to keep the stored value.</p>
          </div>

          {/* Export / import */}
          <div className={`${CARD} p-3 space-y-2.5`}>
            <h4 className="text-[12px] font-semibold text-gray-800">Export results / import cases</h4>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[160px]"><label className={LABEL}>Connector</label>
                <select value={opConnId} onChange={(e) => setOpConnId(e.target.value)} className={FIELD}>
                  <option value="">choose…</option>
                  {connectors.filter((c) => c.enabled).map((c) => <option key={c.id} value={c.id}>{c.name} · {VENDOR_LABELS[c.vendor]}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-[160px]"><label className={LABEL}>Run to export</label>
                <select value={opRunId} onChange={(e) => setOpRunId(e.target.value)} className={FIELD} disabled={!runs.length}>
                  {runs.length === 0 && <option value="">No runs yet</option>}
                  {runs.map((r, i) => <option key={r.runId ?? r.id ?? i} value={String(r.runId ?? r.id ?? '')}>{(r.title || r.runId || 'Run')} — {r.stats?.passRate ?? '–'}%</option>)}
                </select>
              </div>
              <button type="button" onClick={() => void doExport()} disabled={!!busy || !opConnId || !opRunId} className={PRIMARY_BTN}>{busy === 'export' ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}Export</button>
              <button type="button" onClick={() => void doImport()} disabled={!!busy || !opConnId} className={SECONDARY_BTN}>{busy === 'import' ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}Import cases</button>
            </div>
            {imported && (
              <div className="border border-gray-100 rounded-lg max-h-48 overflow-y-auto divide-y divide-gray-100">
                {imported.length === 0 ? <p className="text-[11.5px] text-gray-400 px-3 py-2">No cases returned.</p> : imported.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[11.5px]"><CheckCircle2 className="w-3.5 h-3.5 text-[#7C3AED] flex-shrink-0" /><span className="font-mono text-gray-500 flex-shrink-0">{c.externalId}</span><span className="text-gray-700 truncate">{c.title}</span></div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-gray-400">Export auto-creates the external run/execution. Xray &amp; qTest create tests from case names; TestRail &amp; Zephyr post per-case results when a case carries the tool's id/key (otherwise the run/cycle is created and those cases are reported as skipped).</p>
          </div>
        </div>
      </div>
    </div>
  );
}

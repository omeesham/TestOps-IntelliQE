/**
 * ApiTestConnectors — native connectors for the "API Testing" tool catalogue.
 *
 * These tools connect three different ways, so the editor adapts to the vendor:
 *   • Postman  — a Postman API key; lists collections.
 *   • Pact     — a Pact Broker URL + Bearer token or Basic auth; lists pacts.
 *   • SoapUI / Insomnia / Bruno / Hoppscotch / Karate / REST Assured — their
 *     collections/tests live in Git, so the connection is a Git host
 *     (GitHub/GitLab) + token, and "List repositories" connects to the repos.
 *
 * Credentials stored encrypted, shown only as masked field names. Mirrors
 * CiCdConnectors / TmConnectors.
 */
import { useEffect, useState } from 'react';
import { Webhook, X, Trash2, Plug, Save, AlertTriangle, RefreshCw, CheckSquare, Square, Link2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listApiTestConnectors, saveApiTestConnector, deleteApiTestConnector, testApiTestConnector, listApiTestRepos,
  type ApiTestConnector, type ApiTestVendor, type ApiTestKind, type ApiTestRepo, type GitHost,
} from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, SECONDARY_BTN } from './format';

const VENDOR_LABELS: Record<ApiTestVendor, string> = {
  postman: 'Postman', soapui: 'SoapUI / ReadyAPI', insomnia: 'Insomnia', bruno: 'Bruno',
  hoppscotch: 'Hoppscotch', karate: 'Karate', restassured: 'REST Assured', pact: 'Pact',
};
const VENDORS: ApiTestVendor[] = ['postman', 'soapui', 'insomnia', 'bruno', 'hoppscotch', 'karate', 'restassured', 'pact'];
const VENDOR_KIND: Record<ApiTestVendor, ApiTestKind> = {
  postman: 'apikey', pact: 'broker',
  soapui: 'git', insomnia: 'git', bruno: 'git', hoppscotch: 'git', karate: 'git', restassured: 'git',
};
const REPO_NOUN: Record<ApiTestKind, string> = { apikey: 'collections', broker: 'pacts', git: 'repositories' };
const GIT_HOSTS: { v: GitHost; label: string }[] = [{ v: 'github', label: 'GitHub' }, { v: 'gitlab', label: 'GitLab' }];

interface Form { id?: string; vendor: ApiTestVendor; name: string; baseUrl: string; orgKey: string; gitHost: GitHost; auth: Record<string, string> }
const blankForm = (): Form => ({ vendor: 'postman', name: '', baseUrl: '', orgKey: '', gitHost: 'github', auth: {} });

export default function ApiTestConnectors({ onClose, initialVendor }: { onClose: () => void; initialVendor?: ApiTestVendor }) {
  const toast = useToast();
  const [connectors, setConnectors] = useState<ApiTestConnector[]>([]);
  const [form, setForm] = useState<Form>(() => (initialVendor ? { ...blankForm(), vendor: initialVendor } : blankForm()));
  const [savingCfg, setSavingCfg] = useState(false);
  const [testingId, setTestingId] = useState('');
  const [error, setError] = useState('');

  const [repoConnId, setRepoConnId] = useState('');
  const [repos, setRepos] = useState<ApiTestRepo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [linking, setLinking] = useState(false);

  const refresh = async () => {
    try {
      const list = await listApiTestConnectors();
      setConnectors(list);
      setRepoConnId((prev) => prev || list.find((c) => c.enabled)?.id || '');
    } catch { /* list is a convenience */ }
  };
  useEffect(() => { void refresh(); }, []);

  const current = connectors.find((c) => c.id === form.id);
  const editingExisting = !!form.id;
  const repoConn = connectors.find((c) => c.id === repoConnId);
  const kind = VENDOR_KIND[form.vendor];

  const editConnector = (c: ApiTestConnector) => setForm({ id: c.id, vendor: c.vendor, name: c.name, baseUrl: c.baseUrl, orgKey: c.orgKey, gitHost: (c.gitHost || 'github') as GitHost, auth: {} });
  const setVendor = (v: ApiTestVendor) => setForm((p) => ({ ...p, vendor: v, auth: {} }));
  const setAuth = (k: string, v: string) => setForm((p) => ({ ...p, auth: { ...p.auth, [k]: v } }));
  const authSet = (k: string) => editingExisting && current?.authFields.includes(k);
  const secretPlaceholder = (k: string, label: string) => (authSet(k) ? '•••••••• (unchanged)' : label);

  const save = async () => {
    if (!form.name.trim()) { setError('Give the connector a name.'); return; }
    if (kind === 'broker' && !form.baseUrl.trim() && !current?.baseUrl) { setError('Pact needs a broker URL.'); return; }
    setSavingCfg(true); setError('');
    try {
      const saved = await saveApiTestConnector({
        id: form.id, vendor: form.vendor, name: form.name.trim(),
        baseUrl: form.baseUrl.trim() || undefined, orgKey: form.orgKey.trim() || undefined,
        gitHost: kind === 'git' ? form.gitHost : undefined, auth: form.auth,
      });
      toast.success('Connector saved', `“${saved.name}” saved.`);
      setForm({ ...blankForm(), vendor: form.vendor });
      await refresh();
    } catch (e: any) {
      const msg = e?.response?.data?.error || e?.message || 'Request failed.';
      setError(msg); toast.error('Save failed', msg);
    } finally { setSavingCfg(false); }
  };
  const remove = async (id: string) => {
    try { await deleteApiTestConnector(id); if (form.id === id) setForm(blankForm()); if (repoConnId === id) { setRepoConnId(''); setRepos(null); } await refresh(); toast.success('Connector deleted'); }
    catch (e: any) { toast.error('Delete failed', e?.response?.data?.error || e?.message || 'Request failed.'); }
  };
  const test = async (id: string) => {
    setTestingId(id);
    try { const r = await testApiTestConnector(id); r.ok ? toast.success('Connection OK', r.detail) : toast.error('Connection failed', r.detail); }
    catch (e: any) { toast.error('Connection failed', e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setTestingId(''); }
  };

  const loadRepos = async () => {
    if (!repoConnId) { setError('Pick a connector.'); return; }
    setLoadingRepos(true); setError(''); setRepos(null);
    try {
      const r = await listApiTestRepos(repoConnId, 200);
      setRepos(r.repos);
      setPicked(new Set((repoConn?.linkedRepos || []).map((x) => x.id)));
      r.ok ? toast.success('Loaded', r.detail) : toast.error('Could not list', r.detail);
    } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setLoadingRepos(false); }
  };
  const togglePick = (id: string) => setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const saveLinks = async () => {
    if (!repoConn || !repos) return;
    setLinking(true); setError('');
    try {
      const linkedRepos = repos.filter((r) => picked.has(r.id));
      await saveApiTestConnector({ id: repoConn.id, vendor: repoConn.vendor, name: repoConn.name, baseUrl: repoConn.baseUrl, orgKey: repoConn.orgKey, gitHost: (repoConn.gitHost || undefined) as GitHost | undefined, linkedRepos });
      toast.success('Linked', `Linked ${linkedRepos.length} ${REPO_NOUN[repoConn.kind]}.`);
      await refresh();
    } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); toast.error('Link failed', e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setLinking(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Webhook className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">API-testing tool connectors</h3>
          <span className="text-[11px] text-gray-400">Postman · Pact · Bruno · Karate · …</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {connectors.length > 0 && (
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 overflow-hidden">
              {connectors.map((c) => (
                <div key={c.id} className={`flex items-center gap-2 px-3 py-1.5 ${form.id === c.id ? 'bg-[#F5F3FF]' : ''}`}>
                  <button type="button" onClick={() => editConnector(c)} className="flex-1 min-w-0 text-left flex items-baseline gap-2">
                    <span className="text-[12px] font-medium text-gray-800 truncate">{c.name}</span>
                    <span className="text-[10.5px] text-gray-400 whitespace-nowrap flex-shrink-0">{VENDOR_LABELS[c.vendor]}{c.linkedRepos.length ? ` · ${c.linkedRepos.length} linked` : ''}{c.authFields.length ? ' · creds set' : ' · no creds'}</span>
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
              <div className="flex-1 min-w-0"><label className={LABEL}>Name</label><input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Payments API tests" className={INPUT} /></div>
              <div><label className={LABEL}>Tool</label><select value={form.vendor} onChange={(e) => setVendor(e.target.value as ApiTestVendor)} className={FIELD}>{VENDORS.map((v) => <option key={v} value={v}>{VENDOR_LABELS[v]}</option>)}</select></div>
            </div>

            {/* apikey — Postman */}
            {kind === 'apikey' && (
              <div className="flex gap-2">
                <div className="flex-1 min-w-0"><label className={LABEL}>API key</label><input type="password" autoComplete="off" value={form.auth.apiKey || ''} onChange={(e) => setAuth('apiKey', e.target.value)} placeholder={secretPlaceholder('apiKey', 'Postman API key')} className={INPUT} /></div>
              </div>
            )}

            {/* broker — Pact */}
            {kind === 'broker' && (
              <>
                <div><label className={LABEL}>Broker URL</label><input value={form.baseUrl} onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))} placeholder="https://your-org.pactflow.io" className={`${INPUT} font-mono`} /></div>
                <div className="flex gap-2">
                  <div className="flex-1 min-w-0"><label className={LABEL}>Bearer token</label><input type="password" autoComplete="off" value={form.auth.token || ''} onChange={(e) => setAuth('token', e.target.value)} placeholder={secretPlaceholder('token', 'PactFlow token (or use Basic below)')} className={INPUT} /></div>
                </div>
                <div className="flex gap-2">
                  <div className="flex-1 min-w-0"><label className={LABEL}>Username</label><input autoComplete="off" value={form.auth.username || ''} onChange={(e) => setAuth('username', e.target.value)} placeholder={authSet('username') ? '•••••••• (unchanged)' : 'Basic auth (optional)'} className={INPUT} /></div>
                  <div className="flex-1 min-w-0"><label className={LABEL}>Password</label><input type="password" autoComplete="off" value={form.auth.password || ''} onChange={(e) => setAuth('password', e.target.value)} placeholder={secretPlaceholder('password', 'Basic auth (optional)')} className={INPUT} /></div>
                </div>
              </>
            )}

            {/* git — the rest */}
            {kind === 'git' && (
              <>
                <div className="flex gap-2">
                  <div><label className={LABEL}>Git host</label><select value={form.gitHost} onChange={(e) => setForm((p) => ({ ...p, gitHost: e.target.value as GitHost }))} className={FIELD}>{GIT_HOSTS.map((g) => <option key={g.v} value={g.v}>{g.label}</option>)}</select></div>
                  <div className="flex-1 min-w-0"><label className={LABEL}>{form.gitHost === 'gitlab' ? 'Group' : 'Org'} (optional)</label><input value={form.orgKey} onChange={(e) => setForm((p) => ({ ...p, orgKey: e.target.value }))} placeholder={form.gitHost === 'gitlab' ? 'group path' : 'org login'} className={INPUT} /></div>
                </div>
                <div className="flex gap-2">
                  <div className="flex-1 min-w-0"><label className={LABEL}>Base URL (optional)</label><input value={form.baseUrl} onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))} placeholder={form.gitHost === 'gitlab' ? 'https://gitlab.com (or self-managed)' : 'https://api.github.com (or Enterprise)'} className={`${INPUT} font-mono`} /></div>
                  <div className="flex-1 min-w-0"><label className={LABEL}>Access token</label><input type="password" autoComplete="off" value={form.auth.token || ''} onChange={(e) => setAuth('token', e.target.value)} placeholder={secretPlaceholder('token', 'Personal access token')} className={INPUT} /></div>
                </div>
                <p className="text-[11px] text-gray-400">{VENDOR_LABELS[form.vendor]} collections/tests live in Git — connect the host that holds them, then link the repositories.</p>
              </>
            )}

            {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p></div>}
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void save()} disabled={savingCfg} className={SECONDARY_BTN}>{savingCfg ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save</button>
              {editingExisting && <button type="button" onClick={() => void test(form.id!)} disabled={testingId === form.id} className={SECONDARY_BTN}>{testingId === form.id ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}Test</button>}
            </div>
            <p className="text-[11px] text-gray-400">Credentials are encrypted at rest and never returned. Leave a credential blank when editing to keep the stored value.</p>
          </div>

          {/* Collections / pacts / repositories */}
          <div className={`${CARD} p-3 space-y-2.5`}>
            <h4 className="text-[12px] font-semibold text-gray-800">Link {repoConn ? REPO_NOUN[repoConn.kind] : 'repositories'}</h4>
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0"><label className={LABEL}>Connector</label>
                <select value={repoConnId} onChange={(e) => { setRepoConnId(e.target.value); setRepos(null); }} className={`${FIELD} w-full`}>
                  <option value="">choose…</option>
                  {connectors.filter((c) => c.enabled).map((c) => <option key={c.id} value={c.id}>{c.name} · {VENDOR_LABELS[c.vendor]}</option>)}
                </select>
              </div>
              <button type="button" onClick={() => void loadRepos()} disabled={loadingRepos || !repoConnId} className={`${SECONDARY_BTN} flex-shrink-0`}>{loadingRepos ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}List {repoConn ? REPO_NOUN[repoConn.kind] : 'repos'}</button>
            </div>
            {repos && (
              <>
                <div className="border border-gray-100 rounded-lg max-h-56 overflow-y-auto divide-y divide-gray-100">
                  {repos.length === 0 ? <p className="text-[11.5px] text-gray-400 px-3 py-2">None returned for these credentials.</p> : repos.map((r) => {
                    const on = picked.has(r.id);
                    return (
                      <button type="button" key={r.id} onClick={() => togglePick(r.id)} className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${on ? 'bg-[#F5F3FF]' : 'hover:bg-gray-50'}`}>
                        {on ? <CheckSquare className="w-3.5 h-3.5 text-[#7C3AED] flex-shrink-0" /> : <Square className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />}
                        <span className="text-[11.5px] text-gray-700 truncate flex-1 min-w-0">{r.name}</span>
                        {r.url && <span className="text-[10px] text-gray-400 font-mono truncate max-w-[40%]">{r.url}</span>}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => void saveLinks()} disabled={linking} className={SECONDARY_BTN}>{linking ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}Link {picked.size} selected</button>
                  <span className="text-[11px] text-gray-400">{picked.size} of {repos.length} selected</span>
                </div>
              </>
            )}
            <p className="text-[11px] text-gray-400">Lists what the credentials can see and saves your selection to the connector.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

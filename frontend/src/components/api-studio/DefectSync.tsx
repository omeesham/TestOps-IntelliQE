/**
 * DefectSync — tracker integration & defect automation (Modules 4 & 5).
 *
 * One component, two providers (Jira / Azure DevOps), selected by `provider`.
 * Three panels against the tenant's existing connection:
 *  • Sync defects — turn API-test failures into tracker defects. A stable
 *    signature dedupes: a recurring failure comments the existing issue; a new
 *    one files a defect. "Dry run" (default on) previews with NO tracker writes.
 *  • Browse — read projects/issues of any type.
 *  • History — the sync audit trail + defect links (signature → issue).
 *
 * Opt-in, standalone; a run never files defects on its own. Creating real issues
 * is an explicit, non-dry-run action the user takes here.
 */
import { useEffect, useState } from 'react';
import {
  X, Bug, Search, History, Plus, Trash2, AlertTriangle, ExternalLink, FlaskConical,
  CheckCircle2, RefreshCw, Loader2, ListChecks,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  getJiraIssues, syncJiraDefects, listJiraDefectLinks, listJiraSyncHistory,
  getAzureWorkItems, syncAzureDefects, listAzureDefectLinks, listAzureSyncHistory,
  type JiraIssueSummary, type RunFailure, type SyncDefectResult, type SyncDefectResponse,
  type JiraSyncHistoryRow, type JiraDefectLink,
} from '@/services/api';
import { CARD, STRIP, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, relativeTime, methodColor } from './format';
import { EmptyState } from './primitives';

export type DefectProvider = 'jira' | 'azure';

interface ProviderCfg {
  name: string;
  issueNoun: string;        // "issue" / "work item"
  issueTypes: string[];
  fetchIssues: (opts?: { types?: string[] }) => Promise<{ issues: JiraIssueSummary[] }>;
  sync: (input: { failures: RunFailure[]; runId?: string; runTitle?: string; dryRun?: boolean }) => Promise<SyncDefectResponse>;
  listLinks: (runId?: string) => Promise<{ links: JiraDefectLink[] }>;
  listHistory: () => Promise<{ history: JiraSyncHistoryRow[] }>;
}

const PROVIDERS: Record<DefectProvider, ProviderCfg> = {
  jira: {
    name: 'Jira', issueNoun: 'issue', issueTypes: ['Epic', 'Story', 'Task', 'Sub-task', 'Bug'],
    fetchIssues: getJiraIssues, sync: syncJiraDefects, listLinks: listJiraDefectLinks, listHistory: listJiraSyncHistory,
  },
  azure: {
    name: 'Azure DevOps', issueNoun: 'work item', issueTypes: ['Epic', 'Feature', 'User Story', 'Task', 'Bug'],
    fetchIssues: getAzureWorkItems, sync: syncAzureDefects, listLinks: listAzureDefectLinks, listHistory: listAzureSyncHistory,
  },
};

type Tab = 'sync' | 'browse' | 'history';

export default function DefectSync({ provider, onClose }: { provider: DefectProvider; onClose: () => void }) {
  const cfg = PROVIDERS[provider];
  const [tab, setTab] = useState<Tab>('sync');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-5xl h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Bug className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">{cfg.name} sync &amp; defects</h3>
          <span className="text-[11px] text-gray-400">Failures → tracked defects · dedupe · audit trail</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex items-center gap-1 px-3 pt-2.5 border-b border-[#EDE9FE] flex-shrink-0">
          <TabBtn active={tab === 'sync'} onClick={() => setTab('sync')} icon={Bug} label="Sync defects" />
          <TabBtn active={tab === 'browse'} onClick={() => setTab('browse')} icon={Search} label={`Browse ${cfg.name}`} />
          <TabBtn active={tab === 'history'} onClick={() => setTab('history')} icon={History} label="History" />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {tab === 'sync' && <SyncPanel cfg={cfg} />}
          {tab === 'browse' && <BrowsePanel provider={provider} cfg={cfg} />}
          {tab === 'history' && <HistoryPanel cfg={cfg} />}
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: React.ElementType; label: string }) {
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-t-lg border-b-2 transition-colors ${active ? 'border-[#7C3AED] text-[#6D28D9]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
      <Icon className="w-3.5 h-3.5" />{label}
    </button>
  );
}

/* ── Sync defects ── */
type FailureRow = RunFailure & { _k: number };
let _rowKey = 1;

function SyncPanel({ cfg }: { cfg: ProviderCfg }) {
  const toast = useToast();
  const [rows, setRows] = useState<FailureRow[]>([{ _k: _rowKey++, title: '', method: '', url: '', error: '' }]);
  const [runTitle, setRunTitle] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SyncDefectResult[] | null>(null);
  const [summary, setSummary] = useState<{ created: number; updated: number; skipped: number; total: number } | null>(null);
  const [wasDry, setWasDry] = useState(true);
  const [error, setError] = useState('');

  const update = (k: number, patch: Partial<RunFailure>) => setRows((rs) => rs.map((r) => (r._k === k ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { _k: _rowKey++, title: '', method: '', url: '', error: '' }]);
  const delRow = (k: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r._k !== k) : rs));

  const failures = rows.map((r) => ({ title: r.title.trim(), method: r.method?.trim() || undefined, url: r.url?.trim() || undefined, error: r.error?.trim() || undefined })).filter((f) => f.title);

  const run = async () => {
    setBusy(true); setError(''); setResults(null); setSummary(null);
    try {
      const res = await cfg.sync({ failures, runTitle: runTitle.trim() || undefined, dryRun });
      setResults(res.results); setSummary(res.summary); setWasDry(res.dryRun);
      if (!res.dryRun) toast.success('Defects synced', `${res.summary.created} created · ${res.summary.updated} updated`);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Sync failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="p-5 space-y-4">
      <div className="rounded-lg border border-[#E9E5FF] bg-[#FAF9FE] px-3.5 py-2.5 text-[11.5px] text-gray-600 leading-relaxed">
        Enter the failures to raise as {cfg.name} defects. A stable signature dedupes them — a recurring failure comments its existing {cfg.issueNoun} instead of filing a duplicate. <span className="font-semibold text-gray-700">Dry run previews the decisions without writing to {cfg.name}.</span>
      </div>

      <div>
        <label className={LABEL}>Run label (optional)</label>
        <input value={runTitle} onChange={(e) => setRunTitle(e.target.value)} placeholder="e.g. Nightly API regression · 2026-10-30" className={`${FIELD} w-full max-w-md`} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className={`${LABEL} mb-0`}>Failures</label>
          <button type="button" onClick={addRow} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6D28D9] hover:text-[#5B21B6]"><Plus className="w-3.5 h-3.5" />Add failure</button>
        </div>
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r._k} className="grid grid-cols-[72px_1fr_1fr_28px] gap-2 items-start">
              <input value={r.method} onChange={(e) => update(r._k, { method: e.target.value })} placeholder="GET" className={`${FIELD} w-full uppercase`} />
              <input value={r.url} onChange={(e) => update(r._k, { url: e.target.value })} placeholder="https://api…/users/42" className={`${FIELD} w-full font-mono text-[11px]`} />
              <div className="space-y-1">
                <input value={r.title} onChange={(e) => update(r._k, { title: e.target.value })} placeholder="Failure title (required)" className={`${FIELD} w-full`} />
                <input value={r.error} onChange={(e) => update(r._k, { error: e.target.value })} placeholder="Error / assertion message (optional)" className={`${FIELD} w-full text-[11px]`} />
              </div>
              <button type="button" onClick={() => delRow(r._k)} className="p-1.5 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 mt-0.5"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      </div>

      {error && <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>}

      <div className="flex items-center gap-3">
        <label className="inline-flex items-center gap-1.5 text-[12px] text-gray-600 cursor-pointer">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="rounded border-gray-300" />
          <FlaskConical className="w-3.5 h-3.5 text-[#7C3AED]" />Dry run (preview, no {cfg.name} writes)
        </label>
        <button type="button" onClick={() => void run()} disabled={busy || failures.length === 0} className={`${dryRun ? SECONDARY_BTN : PRIMARY_BTN} ml-auto`}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : dryRun ? <FlaskConical className="w-3.5 h-3.5" /> : <Bug className="w-3.5 h-3.5" />}
          {dryRun ? 'Preview sync' : `Create / update ${failures.length} defect${failures.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {summary && results && (
        <div className="rounded-xl border border-[#ECE9F8] overflow-hidden">
          <div className={`flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#EDE9FE] ${wasDry ? 'bg-[#F5F3FF]' : 'bg-emerald-50'}`}>
            {wasDry ? <FlaskConical className="w-4 h-4 text-[#7C3AED]" /> : <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
            <span className="text-[12px] font-semibold text-gray-800">{wasDry ? 'Preview' : 'Synced'}</span>
            <Chip label={wasDry ? 'would create' : 'created'} value={summary.created} tone="good" />
            <Chip label={wasDry ? 'would update' : 'updated'} value={summary.updated} tone="warn" />
            <Chip label="skipped" value={summary.skipped} tone="muted" />
          </div>
          <div className="divide-y divide-gray-100">
            {results.map((r, i) => (
              <div key={i} className="flex items-center gap-2.5 px-4 py-2">
                <ActionBadge action={r.action} />
                <span className="text-[12px] text-gray-800 min-w-0 flex-1 truncate" title={r.title}>{r.title}</span>
                {r.occurrence && r.occurrence > 1 && <span className="text-[10.5px] text-gray-400">×{r.occurrence}</span>}
                {r.issueKey && (r.issueUrl
                  ? <a href={r.issueUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6D28D9] hover:underline">{r.issueKey}<ExternalLink className="w-3 h-3" /></a>
                  : <span className="text-[11px] font-semibold text-gray-500">{r.issueKey}</span>)}
                {r.error && <span className="text-[10.5px] text-gray-400 truncate max-w-[180px]" title={r.error}>{r.error}</span>}
                <code className="text-[9.5px] text-gray-300 font-mono flex-shrink-0">{r.signature}</code>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ActionBadge({ action }: { action: SyncDefectResult['action'] }) {
  const map: Record<SyncDefectResult['action'], string> = {
    created: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    updated: 'text-amber-700 bg-amber-50 border-amber-200',
    'would-create': 'text-emerald-700 bg-emerald-50 border-emerald-200',
    'would-update': 'text-amber-700 bg-amber-50 border-amber-200',
    skipped: 'text-gray-500 bg-gray-50 border-gray-200',
  };
  return <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${map[action]}`}>{action.replace('-', ' ')}</span>;
}

function Chip({ label, value, tone }: { label: string; value: number; tone: 'good' | 'warn' | 'muted' }) {
  const cls = {
    good: value ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-gray-400 bg-gray-50 border-gray-200',
    warn: value ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-gray-400 bg-gray-50 border-gray-200',
    muted: 'text-gray-500 bg-gray-50 border-gray-200',
  }[tone];
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold tabular-nums ${cls}`}>{value} {label}</span>;
}

/* ── Browse ── */
function BrowsePanel({ provider, cfg }: { provider: DefectProvider; cfg: ProviderCfg }) {
  const [types, setTypes] = useState<string[]>([]);
  const [issues, setIssues] = useState<JiraIssueSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError(''); setIssues(null);
    try {
      const res = await cfg.fetchIssues({ types: types.length ? types : undefined });
      setIssues(res.issues);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not load issues.');
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); /* initial load */ }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleType = (t: string) => setTypes((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]));

  return (
    <div className="p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {cfg.issueTypes.map((t) => (
          <button key={t} type="button" onClick={() => toggleType(t)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${types.includes(t) ? 'text-white bg-[#7C3AED] border-[#7C3AED]' : 'text-gray-600 bg-white border-gray-200 hover:border-[#C7BAF5]'}`}>
            {t}
          </button>
        ))}
        <button type="button" onClick={() => void load()} disabled={loading} className={`${SECONDARY_BTN} ml-auto`}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Refresh
        </button>
      </div>

      {error && <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
      ) : issues && issues.length === 0 ? (
        <EmptyState icon={Search} title={`No ${cfg.issueNoun}s`} hint="Try different types, or check the linked project in System Configuration." />
      ) : issues ? (
        <div className="rounded-xl border border-[#ECE9F8] divide-y divide-gray-100">
          {issues.map((i) => (
            <div key={i.key} className="flex items-center gap-2.5 px-4 py-2">
              <span className="text-[10px] font-bold text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-1.5 py-0.5 flex-shrink-0">{i.key}</span>
              <span className="text-[9px] font-semibold uppercase text-gray-500 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5 flex-shrink-0">{i.type}</span>
              <span className="text-[12px] text-gray-800 min-w-0 flex-1 truncate" title={i.summary}>{i.summary}</span>
              {i.status && <span className="text-[10.5px] text-gray-500 flex-shrink-0">{i.status}</span>}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── History + links ── */
function HistoryPanel({ cfg }: { cfg: ProviderCfg }) {
  const [history, setHistory] = useState<JiraSyncHistoryRow[] | null>(null);
  const [links, setLinks] = useState<JiraDefectLink[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [h, l] = await Promise.all([cfg.listHistory(), cfg.listLinks()]);
      setHistory(h.history); setLinks(l.links);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not load history.');
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="flex items-center justify-center py-16 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>;
  if (error) return <div className="p-5"><div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div></div>;

  return (
    <div className="p-5 space-y-5">
      <section>
        <div className="flex items-center gap-2 mb-2"><ListChecks className="w-4 h-4 text-[#7C3AED]" /><h4 className="text-[12px] font-bold text-gray-800">Defect links</h4><span className="text-[11px] text-gray-400">{links?.length || 0}</span></div>
        {links && links.length > 0 ? (
          <div className="rounded-xl border border-[#ECE9F8] divide-y divide-gray-100">
            {links.map((l) => (
              <div key={l.id} className="flex items-center gap-2.5 px-4 py-2">
                {l.method && <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${methodColor(l.method)}`}>{l.method}</span>}
                <span className="text-[12px] text-gray-800 min-w-0 flex-1 truncate" title={l.title}>{l.title || l.url || l.signature}</span>
                {l.occurrenceCount > 1 && <span className="text-[10.5px] text-gray-400 flex-shrink-0">×{l.occurrenceCount}</span>}
                <span className="text-[10px] text-gray-400 flex-shrink-0">{l.status}</span>
                {l.issueKey && (l.issueUrl
                  ? <a href={l.issueUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6D28D9] hover:underline flex-shrink-0">{l.issueKey}<ExternalLink className="w-3 h-3" /></a>
                  : <span className="text-[11px] font-semibold text-gray-500 flex-shrink-0">{l.issueKey}</span>)}
              </div>
            ))}
          </div>
        ) : <p className="text-[11.5px] text-gray-400">No defect links yet.</p>}
      </section>

      <section>
        <div className="flex items-center gap-2 mb-2"><History className="w-4 h-4 text-[#7C3AED]" /><h4 className="text-[12px] font-bold text-gray-800">Sync history</h4><span className="text-[11px] text-gray-400">{history?.length || 0}</span></div>
        {history && history.length > 0 ? (
          <div className="rounded-xl border border-[#ECE9F8] divide-y divide-gray-100">
            {history.map((h) => (
              <div key={h.id} className="flex items-center gap-2.5 px-4 py-2">
                {h.dryRun && <span className="text-[9px] font-bold uppercase text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-1.5 py-0.5 flex-shrink-0">dry run</span>}
                <span className="text-[12px] text-gray-800 min-w-0 flex-1 truncate">{h.runTitle || 'Defect sync'}</span>
                <span className="text-[10.5px] text-emerald-600 flex-shrink-0">+{h.createdCount}</span>
                <span className="text-[10.5px] text-amber-600 flex-shrink-0">~{h.updatedCount}</span>
                <span className="text-[10.5px] text-gray-400 flex-shrink-0">{h.skippedCount} skipped</span>
                <span className="text-[10.5px] text-gray-400 flex-shrink-0">{relativeTime(h.createdAt)}</span>
              </div>
            ))}
          </div>
        ) : <p className="text-[11.5px] text-gray-400">No syncs recorded yet.</p>}
      </section>
    </div>
  );
}

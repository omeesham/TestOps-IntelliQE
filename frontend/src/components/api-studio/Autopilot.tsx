/**
 * Autopilot — autonomous closed-loop agent.
 *
 * The workspace watching itself. On a schedule (or on demand) the agent
 * re-reads the current catalogue, detects drift and coverage gaps, generates
 * and runs the affected tests, heals what it can, and — if the quality gate
 * passes — either surfaces a reviewable changeset ("suggest") or opens a PR
 * automatically ("autonomous"). Opt-in, gated, and fully auditable: every
 * cycle is recorded and awaiting-approval cycles wait for a human.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Infinity as InfinityIcon, Play, GitPullRequestArrow, Check, X, AlertTriangle, Settings, Activity, RefreshCw } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  getAutopilotConfig,
  saveAutopilotConfig,
  listAutopilotCycles,
  runAutopilotNow,
  approveAutopilotCycle,
  rejectAutopilotCycle,
  type AutopilotConfigView,
  type AutopilotCycle,
  type AutopilotMode,
} from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const errMsg = (err: any): string => err?.response?.data?.error || err?.message || 'Something went wrong.';

type Tab = 'settings' | 'activity';

type Draft = {
  enabled: boolean;
  mode: AutopilotMode;
  autoGenerate: boolean;
  intervalMinutes: number;
  minPassRate: number;
  environmentId: string;
  gitProvider: 'github' | 'gitlab';
  gitRepo: string;
  gitBaseBranch: string;
  gitHost: string;
  gitToken: string;
};

const draftFromConfig = (c: AutopilotConfigView): Draft => ({
  enabled: c.enabled,
  mode: c.mode,
  autoGenerate: c.autoGenerate,
  intervalMinutes: c.intervalMinutes,
  minPassRate: c.gate?.minPassRate ?? 0,
  environmentId: c.environmentId ?? '',
  gitProvider: c.git?.provider ?? 'github',
  gitRepo: c.git?.repo ?? '',
  gitBaseBranch: c.git?.baseBranch ?? '',
  gitHost: c.git?.host ?? '',
  gitToken: '',
});

const STATUS_META: Record<AutopilotCycle['status'], { label: string; cls: string }> = {
  pr_opened: { label: 'PR opened', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  passed_clean: { label: 'Passed clean', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  awaiting_approval: { label: 'Awaiting approval', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  error: { label: 'Error', cls: 'text-red-700 bg-red-50 border-red-200' },
  no_change: { label: 'No change', cls: 'text-gray-500 bg-gray-50 border-gray-200' },
  dismissed: { label: 'Dismissed', cls: 'text-gray-500 bg-gray-50 border-gray-200' },
};

function fmtWhen(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

export default function Autopilot({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('settings');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [config, setConfig] = useState<AutopilotConfigView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cycles, setCycles] = useState<AutopilotCycle[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  const [running, setRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionId, setActionId] = useState('');
  const [actionError, setActionError] = useState('');

  const refreshCycles = useCallback(async () => {
    setRefreshing(true);
    try {
      setCycles(await listAutopilotCycles(50));
    } catch (err: any) {
      setActionError(errMsg(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [cfg, cyc] = await Promise.all([getAutopilotConfig(), listAutopilotCycles(50)]);
        if (!alive) return;
        setConfig(cfg);
        setDraft(draftFromConfig(cfg));
        setCycles(cyc);
      } catch (err: any) {
        if (alive) setError(errMsg(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError('');
    setSaved(false);
    try {
      const repo = draft.gitRepo.trim();
      const git = repo
        ? {
            provider: draft.gitProvider,
            repo,
            ...(draft.gitBaseBranch.trim() ? { baseBranch: draft.gitBaseBranch.trim() } : {}),
            ...(draft.gitProvider === 'gitlab' && draft.gitHost.trim() ? { host: draft.gitHost.trim() } : {}),
            ...(draft.gitToken.trim() ? { token: draft.gitToken.trim() } : {}),
          }
        : null;
      const next = await saveAutopilotConfig({
        enabled: draft.enabled,
        mode: draft.mode,
        autoGenerate: draft.autoGenerate,
        intervalMinutes: Math.max(15, Math.round(draft.intervalMinutes || 0)),
        gate: { minPassRate: Math.min(100, Math.max(0, Math.round(draft.minPassRate || 0))) },
        endpoints: endpoints.map((e) => ({ method: e.method, url: e.url, title: e.title, headers: e.headers, auth: e.auth, body: e.body })),
        environmentId: draft.environmentId.trim() || undefined,
        git,
      });
      setConfig(next);
      setDraft(draftFromConfig(next));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setSaveError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setActionError('');
    try {
      await runAutopilotNow();
      await refreshCycles();
      try { setConfig(await getAutopilotConfig()); } catch { /* status line is best-effort */ }
    } catch (err: any) {
      setActionError(errMsg(err));
    } finally {
      setRunning(false);
    }
  };

  const decide = async (id: string, fn: (id: string) => Promise<AutopilotCycle>) => {
    setActionId(id);
    setActionError('');
    try {
      await fn(id);
      await refreshCycles();
    } catch (err: any) {
      setActionError(errMsg(err));
    } finally {
      setActionId('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <InfinityIcon className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Autopilot — autonomous closed-loop agent</h3>
          <span className="text-[11px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} watched</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 pt-2.5 border-b border-[#EDE9FE] flex-shrink-0">
          <TabButton active={tab === 'settings'} onClick={() => setTab('settings')} icon={<Settings className="w-3.5 h-3.5" />} label="Settings" />
          <TabButton active={tab === 'activity'} onClick={() => setTab('activity')} icon={<Activity className="w-3.5 h-3.5" />} label="Activity" count={cycles.length} />
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Loading Autopilot…</div>
          ) : error ? (
            <div className="flex items-start gap-2 m-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>
          ) : tab === 'settings' && draft ? (
            <SettingsTab
              draft={draft}
              patch={patch}
              config={config}
              endpointCount={endpoints.length}
              saving={saving}
              saved={saved}
              saveError={saveError}
              onSave={() => void save()}
            />
          ) : (
            <ActivityTab
              cycles={cycles}
              running={running}
              refreshing={refreshing}
              actionId={actionId}
              actionError={actionError}
              onRunNow={() => void runNow()}
              onRefresh={() => void refreshCycles()}
              onApprove={(id) => void decide(id, approveAutopilotCycle)}
              onDismiss={(id) => void decide(id, rejectAutopilotCycle)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold rounded-t-md border-b-2 -mb-px transition-colors ${active ? 'text-[#6D28D9] border-[#7C3AED]' : 'text-gray-500 border-transparent hover:text-[#7C3AED]'}`}
    >
      {icon}{label}
      {typeof count === 'number' && count > 0 && <span className="text-[10px] font-mono text-gray-400">{count}</span>}
    </button>
  );
}

/* ── Settings ─────────────────────────────────────────────────────────────── */

function SettingsTab({
  draft, patch, config, endpointCount, saving, saved, saveError, onSave,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  config: AutopilotConfigView | null;
  endpointCount: number;
  saving: boolean;
  saved: boolean;
  saveError: string;
  onSave: () => void;
}) {
  return (
    <div className="px-4 py-3.5 space-y-4">
      {/* Enabled */}
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })} className="mt-0.5 rounded border-gray-300" />
        <span className="min-w-0">
          <span className="block text-[12.5px] font-semibold text-gray-800">Enabled</span>
          <span className="block text-[11px] text-gray-500">Run the closed loop on the interval below. When off, Autopilot never runs on its own — you can still Run now from the Activity tab.</span>
        </span>
      </label>

      {/* Mode */}
      <div className="space-y-1.5">
        <span className={LABEL}>Mode</span>
        <ModeOption
          selected={draft.mode === 'suggest'}
          onClick={() => patch({ mode: 'suggest' })}
          title="Suggest"
          desc="Surface a reviewable changeset; never opens a PR automatically."
        />
        <ModeOption
          selected={draft.mode === 'autonomous'}
          onClick={() => patch({ mode: 'autonomous' })}
          title="Autonomous"
          desc="Open a reviewed PR automatically when the gate passes."
        />
      </div>

      {/* Auto-generate */}
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={draft.autoGenerate} onChange={(e) => patch({ autoGenerate: e.target.checked })} className="mt-0.5 rounded border-gray-300" />
        <span className="min-w-0">
          <span className="block text-[12.5px] font-semibold text-gray-800">Auto-generate &amp; run tests on detected change</span>
          <span className="block text-[11px] text-gray-500">When drift or a coverage gap is found, generate the affected tests and execute them in the same cycle.</span>
        </span>
      </label>

      {/* Interval + gate */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Interval (minutes)</label>
          <input
            type="number"
            min={15}
            value={draft.intervalMinutes}
            onChange={(e) => patch({ intervalMinutes: Number(e.target.value) })}
            className={INPUT}
          />
          <p className="mt-1 text-[10.5px] text-gray-400">Minimum 15 minutes.</p>
        </div>
        <div>
          <label className={LABEL}>Gate: minimum pass rate %</label>
          <input
            type="number"
            min={0}
            max={100}
            value={draft.minPassRate}
            onChange={(e) => patch({ minPassRate: Number(e.target.value) })}
            className={INPUT}
          />
          <p className="mt-1 text-[10.5px] text-gray-400">A PR / clean pass needs at least this pass rate.</p>
        </div>
      </div>

      {/* Watching */}
      <div className="px-3 py-2 rounded-lg bg-[#F5F3FF] border border-[#DDD6FE] text-[11.5px] text-[#5B21B6]">
        Watching <span className="font-semibold tabular-nums">{endpointCount}</span> endpoint{endpointCount === 1 ? '' : 's'} (the current catalogue). Saving snapshots them for Autopilot.
      </div>

      {/* Environment */}
      <div>
        <label className={LABEL}>Environment ID <span className="font-normal normal-case text-gray-400">(optional)</span></label>
        <input value={draft.environmentId} onChange={(e) => patch({ environmentId: e.target.value })} placeholder="env-…" className={INPUT} />
      </div>

      {/* Git */}
      <div className="space-y-2 pt-1 border-t border-gray-100">
        <div className="flex items-center gap-1.5 pt-2">
          <GitPullRequestArrow className="w-3.5 h-3.5 text-[#7C3AED]" />
          <span className="text-[12px] font-semibold text-gray-800">Git — for opening PRs</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Provider</label>
            <select value={draft.gitProvider} onChange={(e) => patch({ gitProvider: e.target.value as 'github' | 'gitlab' })} className={INPUT}>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
            </select>
          </div>
          <div>
            <label className={LABEL}>Repo</label>
            <input value={draft.gitRepo} onChange={(e) => patch({ gitRepo: e.target.value })} placeholder="owner/repo" className={INPUT} />
          </div>
          <div>
            <label className={LABEL}>Base branch <span className="font-normal normal-case text-gray-400">(optional)</span></label>
            <input value={draft.gitBaseBranch} onChange={(e) => patch({ gitBaseBranch: e.target.value })} placeholder="main" className={INPUT} />
          </div>
          {draft.gitProvider === 'gitlab' && (
            <div>
              <label className={LABEL}>Host <span className="font-normal normal-case text-gray-400">(optional)</span></label>
              <input value={draft.gitHost} onChange={(e) => patch({ gitHost: e.target.value })} placeholder="gitlab.example.com" className={INPUT} />
            </div>
          )}
          <div className="col-span-2">
            <label className={LABEL}>Token</label>
            <input
              type="password"
              value={draft.gitToken}
              onChange={(e) => patch({ gitToken: e.target.value })}
              placeholder={config?.git?.tokenMasked ? '•••• saved — type to replace' : 'personal access token'}
              className={INPUT}
            />
            {!draft.gitRepo.trim() && <p className="mt-1 text-[10.5px] text-gray-400">Leave the repo blank to clear the Git connection.</p>}
          </div>
        </div>
      </div>

      {/* Status line */}
      {config && (config.nextRunAt || config.lastRunAt || config.lastStatus || config.lastSummary) && (
        <div className="text-[11px] text-gray-400 space-y-0.5 pt-1 border-t border-gray-100">
          {config.nextRunAt && <div>Next run: <span className="text-gray-500">{fmtWhen(config.nextRunAt)}</span></div>}
          {config.lastRunAt && <div>Last run: <span className="text-gray-500">{fmtWhen(config.lastRunAt)}</span>{config.lastStatus ? <> · <span className="text-gray-500">{config.lastStatus}</span></> : null}</div>}
          {config.lastSummary && <div className="text-gray-500">{config.lastSummary}</div>}
        </div>
      )}

      {saveError && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{saveError}</p></div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button type="button" onClick={onSave} disabled={saving} className={PRIMARY_BTN}>
          {saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}Save settings
        </button>
        {saved && <span className="inline-flex items-center gap-1 text-[11.5px] text-emerald-600"><Check className="w-3.5 h-3.5" />Saved</span>}
      </div>
    </div>
  );
}

function ModeOption({ selected, onClick, title, desc }: { selected: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left flex items-start gap-2.5 px-3 py-2 rounded-lg border transition-colors ${selected ? 'border-[#7C3AED] bg-[#F5F3FF]' : 'border-gray-200 hover:border-[#C4B5FD]'}`}
    >
      <span className={`mt-0.5 w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${selected ? 'border-[#7C3AED] bg-[#7C3AED]' : 'border-gray-300'}`} />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-gray-800">{title}</span>
        <span className="block text-[11px] text-gray-500">{desc}</span>
      </span>
    </button>
  );
}

/* ── Activity ─────────────────────────────────────────────────────────────── */

function ActivityTab({
  cycles, running, refreshing, actionId, actionError, onRunNow, onRefresh, onApprove, onDismiss,
}: {
  cycles: AutopilotCycle[];
  running: boolean;
  refreshing: boolean;
  actionId: string;
  actionError: string;
  onRunNow: () => void;
  onRefresh: () => void;
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="px-4 py-3.5 space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onRunNow} disabled={running} className={PRIMARY_BTN}>
          {running ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Run now
        </button>
        <button type="button" onClick={onRefresh} disabled={refreshing || running} className={SECONDARY_BTN}>
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />Refresh
        </button>
        {running && <span className="text-[11px] text-gray-400">A cycle can take a while — detecting, generating, running, healing…</span>}
      </div>

      {actionError && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{actionError}</p></div>
      )}

      {cycles.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-14 px-6 text-center">
          <Activity className="w-7 h-7 text-gray-300" />
          <p className="text-[12.5px] text-gray-500 max-w-sm">No cycles yet. <span className="text-gray-700 font-medium">Run now</span> to trigger one, or enable Autopilot in Settings to run on a schedule.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {cycles.map((c) => (
            <CycleCard
              key={c.id}
              c={c}
              busy={actionId === c.id}
              onApprove={() => onApprove(c.id)}
              onDismiss={() => onDismiss(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CycleCard({ c, busy, onApprove, onDismiss }: { c: AutopilotCycle; busy: boolean; onApprove: () => void; onDismiss: () => void }) {
  const meta = STATUS_META[c.status];
  const affected = c.affectedEndpoints.slice(0, 8);
  const extra = c.affectedEndpoints.length - affected.length;

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3.5 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${meta.cls}`}>{meta.label}</span>
        <span className="text-[10.5px] font-mono text-gray-400">{c.trigger}</span>
        <span className="ml-auto text-[10.5px] text-gray-400">{fmtWhen(c.createdAt)}</span>
      </div>

      <div className="text-[11px] text-gray-600">
        discovered: drift <span className="font-semibold tabular-nums text-gray-800">{c.discovered.drift}</span> · gaps <span className="font-semibold tabular-nums text-gray-800">{c.discovered.gaps}</span> · affected <span className="font-semibold tabular-nums text-gray-800">{c.discovered.affected}</span>
      </div>

      {c.run && (
        <div className="flex flex-wrap gap-1.5 text-[10.5px] font-mono">
          <Stat label="total" value={c.run.total} />
          <Stat label="passed" value={c.run.passed} tone="emerald" />
          <Stat label="failed" value={c.run.failed} tone={c.run.failed > 0 ? 'red' : undefined} />
          <Stat label="pass" value={`${c.run.passRate}%`} />
          <Stat label="healed" value={c.run.healed} />
        </div>
      )}

      {c.decision && <p className="text-[11.5px] text-gray-600 leading-relaxed">{c.decision}</p>}

      {c.error && (
        <p className="text-[11px] text-red-600 leading-relaxed">{c.error}</p>
      )}

      {c.changeset && (
        <p className="text-[11px] text-gray-500"><span className="font-mono text-gray-600">{c.changeset.path}</span> — {c.changeset.summary}</p>
      )}

      {affected.length > 0 && (
        <div className="space-y-1">
          {affected.map((a, i) => (
            <div key={i} className="flex items-center gap-1.5 min-w-0">
              <MethodBadge method={a.method} />
              <span className="text-[11px] font-mono text-gray-600 truncate flex-shrink-0 max-w-[45%]" title={a.url}>{a.url}</span>
              <span className="text-[11px] text-gray-400 truncate min-w-0" title={a.reason}>— {a.reason}</span>
            </div>
          ))}
          {extra > 0 && <div className="text-[10.5px] text-gray-400">+{extra} more</div>}
        </div>
      )}

      {c.prUrl && (
        <a href={c.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[#6D28D9] hover:text-[#5B21B6]">
          <GitPullRequestArrow className="w-3.5 h-3.5" />View PR ↗
        </a>
      )}

      {c.status === 'awaiting_approval' && (
        <div className="flex items-center gap-2 pt-1">
          <button type="button" onClick={onApprove} disabled={busy} className={PRIMARY_BTN}>
            {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <GitPullRequestArrow className="w-3.5 h-3.5" />}Approve &amp; open PR
          </button>
          <button type="button" onClick={onDismiss} disabled={busy} className={SECONDARY_BTN}>
            <X className="w-3.5 h-3.5" />Dismiss
          </button>
        </div>
      )}

      {(c.decidedAt || c.decidedBy) && (
        <div className="text-[10px] text-gray-400 pt-0.5">
          {c.decidedBy ? `by ${c.decidedBy}` : ''}{c.decidedBy && c.decidedAt ? ' · ' : ''}{c.decidedAt ? fmtWhen(c.decidedAt) : ''}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: 'emerald' | 'red' }) {
  const cls = tone === 'emerald'
    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : tone === 'red'
      ? 'text-red-700 bg-red-50 border-red-200'
      : 'text-gray-600 bg-gray-50 border-gray-200';
  return <span className={`px-1.5 py-0.5 rounded border ${cls}`}>{String(value)} {label}</span>;
}

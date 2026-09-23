/**
 * API Automation — the dashboard shell.
 *
 *   Import · Endpoints · Scenarios · Runs · Report · Environments · Developer
 *   … with Overview pinned below them.
 *
 * Two hooks own everything: `useCatalog` (what the workspace knows — endpoints,
 * profile, strategy) and `useApiRun` (the pipeline in flight).
 * The shell routes between views, shows the stage rail while a run is live,
 * and keeps the activity log one click away.
 */
import { useEffect, useState } from 'react';
import {
  ChevronLeft, Plug, RotateCcw, Activity, Loader2, AlertTriangle, X, ListChecks, ArrowRight, Play,
  LayoutDashboard, Upload, Layers, FileCheck2, PlayCircle, BarChart3, Code2, Sparkles, Blocks, Server,
} from 'lucide-react';
import { useCatalog } from './hooks/useCatalog';
import { useApiRun } from './hooks/useApiRun';
import StageRail from './StageRail';
import ScenariosTab from './ScenariosTab';
import ReportTab from './ReportTab';
import OverviewView from './views/OverviewView';
import ImportView from './views/ImportView';
import IntegrationsView from './views/IntegrationsView';
import EndpointsView from './views/EndpointsView';
import RunsView from './views/RunsView';
import EnvironmentsView from './views/EnvironmentsView';
import DeveloperView from './views/DeveloperView';
import ActivityPanel from './ActivityPanel';
import { EmptyState } from './primitives';
import { PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { NavView, Phase } from './types';

import Loader from '@/components/feedback/Loader';
interface ApiStudioProps { onExit?: () => void }

interface NavItem { id: NavView; label: string; icon: React.ElementType }

/** The workflow, top to bottom, in the order you walk it. */
const NAV: NavItem[] = [
  { id: 'import', label: 'Import', icon: Upload },
  { id: 'integrations', label: 'Integrations', icon: Blocks },
  { id: 'endpoints', label: 'Endpoints', icon: Layers },
  { id: 'scenarios', label: 'Scenarios', icon: FileCheck2 },
  { id: 'runs', label: 'Runs', icon: PlayCircle },
  { id: 'report', label: 'Report', icon: BarChart3 },
  { id: 'environments', label: 'Environments', icon: Server },
  { id: 'developer', label: 'Developer', icon: Code2 },
];

/**
 * Pinned to the foot of the rail. Overview is where you stand back and look at
 * the workspace as a whole, so it sits below the steps rather than ahead of
 * them — it is still the view the shell opens on.
 */
const NAV_PINNED: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
];

/** One row of the nav rail — the same key-cap treatment wherever it appears. */
function NavButton({ item, active, count, live, onClick }: {
  item: NavItem; active: boolean; count?: number; live: boolean; onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mx-2 my-0.5 flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-left transition-all duration-150 border ${active
        ? 'bg-gradient-to-b from-white to-[#F5F3FF] text-[#6D28D9] border-[#E4DDFB] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),inset_3px_0_0_0_#7C3AED,0_2px_0_0_#DDD6FE,0_8px_16px_-8px_rgba(76,29,149,0.45)] -translate-y-px'
        : 'text-gray-600 border-transparent hover:bg-white hover:text-[#7C3AED] hover:border-[#EDE9FE] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_0_0_#EDE9FE,0_6px_12px_-8px_rgba(76,29,149,0.35)] hover:-translate-y-px active:translate-y-0 active:shadow-none'}`}
    >
      <Icon className={`w-4 h-4 flex-shrink-0 ${active ? 'text-[#7C3AED]' : 'text-gray-400'}`} />
      <span className="flex-1 truncate">{item.label}</span>
      {live ? <Loader2 className="w-3 h-3 text-[#7C3AED] animate-spin flex-shrink-0" /> : count ? <span className={`px-1.5 rounded-md text-[10px] font-mono tabular-nums flex-shrink-0 shadow-[inset_0_1px_2px_rgba(30,27,75,0.10)] ${active ? 'bg-[#EDE9FE] text-[#6D28D9]' : 'bg-gray-100 text-gray-500'}`}>{count}</span> : null}
    </button>
  );
}

/** Every view the shell can show — a stale stored value outside it falls back to Overview. */
const VIEWS = new Set<string>([...NAV, ...NAV_PINNED].map((n) => n.id));

export default function ApiStudio({ onExit }: ApiStudioProps) {
  const catalog = useCatalog();
  const [view, setView] = useState<NavView>(() => {
    const stored = sessionStorage.getItem('intelliqe_api_view');
    return stored && VIEWS.has(stored) ? (stored as NavView) : 'overview';
  });
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [overviewKey, setOverviewKey] = useState(0);

  /* Follow the run: design → scenarios, execute → runs, finished → report.
     A run in flight also opens the log so a long stage is never a silent spinner. */
  const onPhase = (p: Phase) => {
    if (p === 'generating' || p === 'review') setView('scenarios');
    else if (p === 'automating' || p === 'executing' || p === 'healing') setView('runs');
    else if (p === 'report') { setView('report'); setOverviewKey((k) => k + 1); }
    if (p === 'generating' || p === 'automating') setActivityOpen(true);
  };
  const run = useApiRun({ onPhase });

  useEffect(() => { try { sessionStorage.setItem('intelliqe_api_view', view); } catch { /* ignore */ } }, [view]);

  const navigate = (v: NavView) => { setView(v); if (v !== 'runs') setOpenRunId(null); };

  /* Surfaced on the collapsed strip so a problem is visible while it is closed. */
  const logErrors = run.logs.filter((l) => l.level === 'error').length;
  const logIssues = logErrors + run.logs.filter((l) => l.level === 'warn').length;
  const openRun = (id: string) => { setOpenRunId(id); setView('runs'); };

  const design = () => run.runScenarios({ endpoints: catalog.selectedEndpoints, strategy: catalog.strategy, profile: catalog.profile });

  const counts: Partial<Record<NavView, number>> = {
    endpoints: catalog.endpoints.length,
    scenarios: run.scenarios.length,
  };

  return (
    <div data-surface="3d" className="h-full flex flex-col min-h-0 bg-[#F4F2FC] bg-[radial-gradient(1200px_500px_at_15%_-10%,rgba(139,92,246,0.14),transparent_60%),radial-gradient(900px_400px_at_100%_0%,rgba(99,102,241,0.12),transparent_55%)]">
      {/* ── Top bar ── */}
      <header className="relative z-20 flex items-center gap-2 px-3 h-12 bg-gradient-to-b from-white to-[#FCFBFF] border-b border-[#E9E5FB] flex-shrink-0 shadow-[0_1px_0_rgba(255,255,255,0.9),0_6px_18px_-12px_rgba(76,29,149,0.45)]">
        {onExit && (
          <button type="button" onClick={onExit} title="Back to automation types" className="p-1.5 -ml-1 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF] transition-colors"><ChevronLeft className="w-4 h-4" /></button>
        )}
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#8B5CF6] to-[#6366F1] flex items-center justify-center flex-shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_3px_0_0_#4338CA,0_8px_16px_-6px_rgba(124,58,237,0.6)] ring-1 ring-white/40"><Plug className="w-3.5 h-3.5 text-white" /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[13px] font-semibold text-gray-900 leading-tight truncate">API Automation</h1>
          <p className="text-[10px] text-gray-400 leading-tight truncate hidden md:block">Import any API · understand its pattern · design, run, heal and report — automatically</p>
        </div>

        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {run.started && (
            <button type="button" onClick={() => { run.resetRun(); setView('endpoints'); }} className={SECONDARY_BTN} title="Start a fresh run"><RotateCcw className="w-3.5 h-3.5" /><span className="hidden lg:inline">New run</span></button>
          )}
          {run.phase === 'review' ? (
            <button type="button" onClick={() => void run.runSuite()} disabled={run.selected.size === 0} className={`${PRIMARY_BTN} whitespace-nowrap`}>Run {run.selected.size} scenario{run.selected.size === 1 ? '' : 's'}<ArrowRight className="w-3.5 h-3.5" /></button>
          ) : run.finished ? (
            <button type="button" onClick={() => void run.runSuite()} disabled={run.selected.size === 0} title="Run the same scenarios again — use New run to design a fresh suite" className={`${PRIMARY_BTN} whitespace-nowrap`}><Play className="w-3.5 h-3.5" />Re-run {run.selected.size}</button>
          ) : (
            <button type="button" onClick={design} disabled={run.running || catalog.selectedEndpoints.length === 0} title={catalog.selectedEndpoints.length === 0 ? 'Select endpoints in the catalogue first' : `Design scenarios for ${catalog.selectedEndpoints.length} selected endpoint${catalog.selectedEndpoints.length === 1 ? '' : 's'}`} className={`${PRIMARY_BTN} whitespace-nowrap`}>
              {run.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {run.running ? 'Designing…' : <>Design<span className="hidden lg:inline"> scenarios</span>{catalog.selectedEndpoints.length ? ` (${catalog.selectedEndpoints.length})` : ''}</>}
            </button>
          )}
        </div>
      </header>

      {run.started && (
        <StageRail
          stages={run.stages}
          push={{
            onPushToRepo: run.handlePushToRepo,
            pushState: run.pushState,
            canPush: run.specs.length > 0 && run.selected.size > 0,
            show: run.finished,
          }}
        />
      )}

      {run.phase === 'review' && view === 'scenarios' && (
        <div className="relative z-10 flex items-center gap-2 px-4 py-2 bg-gradient-to-b from-[#F5F3FF] to-[#EDE9FE] border-b border-[#DDD6FE] flex-shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_4px_12px_-10px_rgba(76,29,149,0.4)]">
          <ListChecks className="w-4 h-4 text-[#7C3AED] flex-shrink-0" />
          <p className="text-[12px] text-[#4C1D95] min-w-0"><span className="font-semibold">{run.scenarios.length} scenarios designed.</span> Review them and deselect anything you don't want — then run the suite. Automation, execution, healing and the report run straight through from there.</p>
        </div>
      )}

      {run.runError && (
        <div className="relative z-10 flex items-start gap-2 px-4 py-2 bg-gradient-to-b from-red-50 to-[#FEE9E9] border-b border-red-200 flex-shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_4px_12px_-10px_rgba(239,68,68,0.4)]">
          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
          <p className="text-[12px] text-red-700 min-w-0">{run.runError}</p>
          <button type="button" onClick={() => run.setRunError('')} className="ml-auto text-red-400 hover:text-red-600 flex-shrink-0"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* ── Workspace ── */}
      <div className="flex-1 flex min-h-0">
        {/* Nav rail */}
        <nav className="relative z-10 w-[172px] flex-shrink-0 border-r border-[#E9E5FB] bg-gradient-to-b from-white to-[#FAFAFE] py-2 flex flex-col shadow-[6px_0_18px_-14px_rgba(76,29,149,0.45)]">
          {NAV.map((n) => (
            <NavButton key={n.id} item={n} active={view === n.id} count={counts[n.id]} live={n.id === 'runs' && run.running} onClick={() => navigate(n.id)} />
          ))}

          {/* Pinned foot of the rail. */}
          <div className="mt-auto pt-2 flex flex-col">
            <div className="mx-3 mb-1 border-t border-[#EDE9FE] shadow-[0_1px_0_rgba(255,255,255,0.9)]" />
            {NAV_PINNED.map((n) => (
              <NavButton key={n.id} item={n} active={view === n.id} count={counts[n.id]} live={false} onClick={() => navigate(n.id)} />
            ))}
          </div>
        </nav>

        {/* Content */}
        <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-white/55 shadow-[inset_0_2px_6px_-4px_rgba(30,27,75,0.18)]">
          {view === 'overview' && <OverviewView catalog={catalog} onNavigate={navigate} onOpenRun={openRun} refreshKey={overviewKey} />}
          {view === 'import' && <ImportView catalog={catalog} onOpenCatalogue={() => navigate('endpoints')} log={run.log} />}
          {view === 'integrations' && <IntegrationsView />}
          {view === 'endpoints' && <EndpointsView catalog={catalog} running={run.running} onDesign={design} onImport={() => navigate('import')} scenarios={run.scenarios} />}
          {view === 'scenarios' && (
            run.scenarios.length === 0 && run.phase !== 'generating' ? (
              <div className="h-full flex flex-col">
                <EmptyState icon={FileCheck2} title="No scenarios designed yet" hint={catalog.selectedEndpoints.length ? `${catalog.selectedEndpoints.length} endpoints are selected — design scenarios and they land here for review before anything is automated.` : 'Select endpoints in the catalogue, then design scenarios. Every scenario stops here for review before anything is automated.'} />
                <div className="flex justify-center -mt-10 pb-10">
                  {catalog.selectedEndpoints.length ? <button type="button" onClick={design} className={PRIMARY_BTN}><Sparkles className="w-3.5 h-3.5" />Design scenarios for {catalog.selectedEndpoints.length}</button> : <button type="button" onClick={() => navigate('endpoints')} className={PRIMARY_BTN}>Open the catalogue<ArrowRight className="w-3.5 h-3.5" /></button>}
                </div>
              </div>
            ) : run.phase === 'generating' && run.scenarios.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-8">
                <Loader size="lg" label={`Designing scenarios for ${run.runEndpoints.length} endpoint${run.runEndpoints.length === 1 ? '' : 's'}`} hint={run.stages.find((s) => s.key === 'scenarios')?.detail?.replace(/…$/, '') || 'Reading the pattern profile, the strategy layers and every endpoint\'s contract. Large catalogues take a few minutes — progress is in the activity log.'} />
              </div>
            ) : (
              <ScenariosTab scenarios={run.scenarios} selected={run.selected} editable={run.phase === 'review' || run.finished} onToggle={run.toggleScenario} onSelectAll={run.selectScenarios} onClearAll={run.clearScenarios} />
            )
          )}
          {view === 'runs' && <RunsView run={run} openRunId={openRunId} onOpenRun={setOpenRunId} onShowReport={() => navigate('report')} />}
          {view === 'report' && (
            <ReportTab report={run.report} rows={run.rows} scenarios={run.scenarios} endpointLabel={run.runLabel} onExport={run.handleExport} exporting={run.exporting} canExport={!!run.testRunId} onPushToRepo={run.handlePushToRepo} pushState={run.pushState} canPush={run.specs.length > 0 && run.selected.size > 0} runId={run.testRunId || undefined} />
          )}
          {view === 'environments' && <EnvironmentsView />}
          {view === 'developer' && <DeveloperView />}
        </main>

        {/* Activity — collapses to a strip */}
        {!activityOpen && (
          <button type="button" onClick={() => setActivityOpen(true)} title="Show the activity log" className="w-9 flex-shrink-0 flex flex-col items-center gap-2 pt-2.5 border-l border-[#E9E5FB] bg-gradient-to-b from-white to-[#FAFAFE] hover:to-[#F5F3FF] transition-colors group shadow-[-6px_0_18px_-14px_rgba(76,29,149,0.45)]">
            <Activity className={`w-3.5 h-3.5 ${run.running ? 'text-[#7C3AED]' : 'text-gray-400 group-hover:text-[#7C3AED]'}`} />
            {run.running && <Loader2 className="w-3 h-3 text-[#7C3AED] animate-spin" />}
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 group-hover:text-[#7C3AED] [writing-mode:vertical-rl]">Activity</span>
            {logIssues > 0
              ? <span title={`${logIssues} warning${logIssues === 1 ? '' : 's'} or error${logIssues === 1 ? '' : 's'} in the log`} className={`px-1 rounded text-[9px] font-mono font-semibold ${logErrors > 0 ? 'text-red-600 bg-red-50' : 'text-amber-700 bg-amber-50'}`}>{logIssues}</span>
              : run.logs.length > 0 ? <span className="text-[9px] font-mono text-gray-400">{run.logs.length}</span> : null}
          </button>
        )}
        <aside className={`relative z-20 w-[300px] flex-shrink-0 flex-col border-l border-[#E9E5FB] bg-gradient-to-b from-white to-[#FCFBFF] min-h-0 shadow-[-6px_0_18px_-14px_rgba(76,29,149,0.45)] ${activityOpen ? 'flex' : 'hidden'}`}>
          <ActivityPanel run={run} onClose={() => setActivityOpen(false)} />
        </aside>
      </div>
    </div>
  );
}

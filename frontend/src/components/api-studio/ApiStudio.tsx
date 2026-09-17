/**
 * API Automation — the dashboard shell.
 *
 *   Overview · Import · Endpoints · Scenarios · Runs · Report · Environments · Developer
 *
 * Two hooks own everything: `useCatalog` (what the workspace knows — endpoints,
 * profile, strategy, environments) and `useApiRun` (the pipeline in flight).
 * The shell routes between views, shows the stage rail while a run is live,
 * and keeps the activity log one click away.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Plug, RotateCcw, Activity, Loader2, AlertTriangle, X, ListChecks, ArrowRight, Play,
  LayoutDashboard, Upload, Layers, FileCheck2, PlayCircle, BarChart3, Server, Code2, Sparkles,
} from 'lucide-react';
import { useCatalog } from './hooks/useCatalog';
import { useApiRun } from './hooks/useApiRun';
import StageRail from './StageRail';
import ScenariosTab from './ScenariosTab';
import ReportTab from './ReportTab';
import OverviewView from './views/OverviewView';
import ImportView from './views/ImportView';
import EndpointsView from './views/EndpointsView';
import RunsView from './views/RunsView';
import EnvironmentsView from './views/EnvironmentsView';
import DeveloperView from './views/DeveloperView';
import { EmptyState } from './primitives';
import { clock, PRIMARY_BTN, SECONDARY_BTN, INPUT, STRIP } from './format';
import type { NavView, Phase } from './types';

import Loader from '@/components/feedback/Loader';
interface ApiStudioProps { onExit?: () => void }

const NAV: { id: NavView; label: string; icon: React.ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'import', label: 'Import', icon: Upload },
  { id: 'endpoints', label: 'Endpoints', icon: Layers },
  { id: 'scenarios', label: 'Scenarios', icon: FileCheck2 },
  { id: 'runs', label: 'Runs', icon: PlayCircle },
  { id: 'report', label: 'Report', icon: BarChart3 },
  { id: 'environments', label: 'Environments', icon: Server },
  { id: 'developer', label: 'Developer', icon: Code2 },
];

export default function ApiStudio({ onExit }: ApiStudioProps) {
  const catalog = useCatalog();
  const [view, setView] = useState<NavView>(() => (sessionStorage.getItem('intelliqe_api_view') as NavView) || 'overview');
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [overviewKey, setOverviewKey] = useState(0);
  const logEndRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => { if (activityOpen) logEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [run.logs.length, activityOpen]);

  const navigate = (v: NavView) => { setView(v); if (v !== 'runs') setOpenRunId(null); };
  const openRun = (id: string) => { setOpenRunId(id); setView('runs'); };

  const design = () => run.runScenarios({ endpoints: catalog.selectedEndpoints, strategy: catalog.strategy, profile: catalog.profile, environment: catalog.activeEnv });

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
        <div className="min-w-0">
          <h1 className="text-[13px] font-semibold text-gray-900 leading-tight">API Automation</h1>
          <p className="text-[10px] text-gray-400 leading-tight">Import any API · understand its pattern · design, run, heal and report — automatically</p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Environment selector */}
          <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <Server className="w-3.5 h-3.5 text-gray-400" />
            <select value={catalog.activeEnvId || ''} onChange={(e) => catalog.setActiveEnvId(e.target.value || null)} disabled={run.running} className={`${INPUT} w-auto py-1 pr-6`}>
              <option value="">No environment</option>
              {catalog.environments.map((env) => <option key={env.id} value={env.id}>{env.name}{env.isDefault ? ' (default)' : ''}</option>)}
            </select>
          </label>

          {run.started && (
            <button type="button" onClick={() => { run.resetRun(); setView('endpoints'); }} className={SECONDARY_BTN}><RotateCcw className="w-3.5 h-3.5" />New run</button>
          )}
          {run.phase === 'review' ? (
            <button type="button" onClick={() => void run.runSuite()} disabled={run.selected.size === 0} className={PRIMARY_BTN}>Run {run.selected.size} scenario{run.selected.size === 1 ? '' : 's'}<ArrowRight className="w-3.5 h-3.5" /></button>
          ) : run.finished ? (
            <button type="button" onClick={() => void run.runSuite()} disabled={run.selected.size === 0} title="Run the same scenarios again — use New run to design a fresh suite" className={PRIMARY_BTN}><Play className="w-3.5 h-3.5" />Re-run {run.selected.size}</button>
          ) : (
            <button type="button" onClick={design} disabled={run.running || catalog.selectedEndpoints.length === 0} title={catalog.selectedEndpoints.length === 0 ? 'Select endpoints in the catalogue first' : ''} className={PRIMARY_BTN}>
              {run.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {run.running ? 'Designing…' : `Design scenarios${catalog.selectedEndpoints.length ? ` (${catalog.selectedEndpoints.length})` : ''}`}
            </button>
          )}
        </div>
      </header>

      {run.started && <StageRail stages={run.stages} />}

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
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = view === n.id;
            const count = counts[n.id];
            const live = n.id === 'runs' && run.running;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => navigate(n.id)}
                className={`mx-2 my-0.5 flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-left transition-all duration-150 border ${active
                  ? 'bg-gradient-to-b from-white to-[#F5F3FF] text-[#6D28D9] border-[#E4DDFB] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),inset_3px_0_0_0_#7C3AED,0_2px_0_0_#DDD6FE,0_8px_16px_-8px_rgba(76,29,149,0.45)] -translate-y-px'
                  : 'text-gray-600 border-transparent hover:bg-white hover:text-[#7C3AED] hover:border-[#EDE9FE] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_0_0_#EDE9FE,0_6px_12px_-8px_rgba(76,29,149,0.35)] hover:-translate-y-px active:translate-y-0 active:shadow-none'}`}
              >
                <Icon className={`w-4 h-4 ${active ? 'text-[#7C3AED]' : 'text-gray-400'}`} />
                <span className="flex-1">{n.label}</span>
                {live ? <Loader2 className="w-3 h-3 text-[#7C3AED] animate-spin" /> : count ? <span className={`px-1.5 rounded-md text-[10px] font-mono tabular-nums shadow-[inset_0_1px_2px_rgba(30,27,75,0.10)] ${active ? 'bg-[#EDE9FE] text-[#6D28D9]' : 'bg-gray-100 text-gray-500'}`}>{count}</span> : null}
              </button>
            );
          })}
          <div className="mt-auto px-4 pb-2 text-[10px] text-gray-400 leading-relaxed">
            {catalog.activeEnv ? <>Env: <span className="text-gray-600">{catalog.activeEnv.name}</span></> : 'No environment active'}
          </div>
        </nav>

        {/* Content */}
        <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-white/55 shadow-[inset_0_2px_6px_-4px_rgba(30,27,75,0.18)]">
          {view === 'overview' && <OverviewView catalog={catalog} onNavigate={navigate} onOpenRun={openRun} refreshKey={overviewKey} />}
          {view === 'import' && <ImportView catalog={catalog} onOpenCatalogue={() => navigate('endpoints')} log={run.log} />}
          {view === 'endpoints' && <EndpointsView catalog={catalog} running={run.running} onDesign={design} onImport={() => navigate('import')} />}
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
            <ReportTab report={run.report} rows={run.rows} scenarios={run.scenarios} endpointLabel={run.runLabel} onExport={run.handleExport} exporting={run.exporting} canExport={!!run.testRunId} onPushToRepo={run.handlePushToRepo} pushState={run.pushState} canPush={run.specs.length > 0 && run.selected.size > 0} />
          )}
          {view === 'environments' && <EnvironmentsView catalog={catalog} />}
          {view === 'developer' && <DeveloperView />}
        </main>

        {/* Activity — collapses to a strip */}
        {!activityOpen && (
          <button type="button" onClick={() => setActivityOpen(true)} title="Show the activity log" className="w-9 flex-shrink-0 flex flex-col items-center gap-2 pt-2.5 border-l border-[#E9E5FB] bg-gradient-to-b from-white to-[#FAFAFE] hover:to-[#F5F3FF] transition-colors group shadow-[-6px_0_18px_-14px_rgba(76,29,149,0.45)]">
            <Activity className={`w-3.5 h-3.5 ${run.running ? 'text-[#7C3AED]' : 'text-gray-400 group-hover:text-[#7C3AED]'}`} />
            {run.running && <Loader2 className="w-3 h-3 text-[#7C3AED] animate-spin" />}
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 group-hover:text-[#7C3AED] [writing-mode:vertical-rl]">Activity</span>
            {run.logs.length > 0 && <span className="text-[9px] font-mono text-gray-400">{run.logs.length}</span>}
          </button>
        )}
        <aside className={`relative z-10 w-[280px] flex-shrink-0 flex-col border-l border-[#E9E5FB] bg-gradient-to-b from-white to-[#FCFBFF] min-h-0 shadow-[-6px_0_18px_-14px_rgba(76,29,149,0.45)] ${activityOpen ? 'flex' : 'hidden'}`}>
          <div className={`flex items-center gap-1.5 px-3 h-9 flex-shrink-0 ${STRIP}`}>
            <Activity className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">Activity</span>
            {run.running && <Loader2 className="w-3 h-3 text-[#7C3AED] animate-spin" />}
            <button type="button" onClick={() => setActivityOpen(false)} title="Hide the activity log" className="ml-auto text-gray-300 hover:text-[#7C3AED] transition-colors"><ChevronRight className="w-3.5 h-3.5" /></button>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-1">
            {run.logs.length === 0 ? (
              <EmptyState icon={Activity} title="Nothing yet" hint="Imports and every run stage report what they are doing here." />
            ) : (
              run.logs.map((l) => (
                <div key={l.id} className="flex gap-1.5 text-[11px] leading-relaxed">
                  <span className="font-mono text-[9.5px] text-gray-300 tabular-nums pt-px flex-shrink-0">{clock(l.at)}</span>
                  <span className={`min-w-0 ${l.level === 'ok' ? 'text-emerald-700' : l.level === 'warn' ? 'text-amber-700' : l.level === 'error' ? 'text-red-600' : 'text-gray-600'}`}>
                    <span className="font-mono text-[9.5px] uppercase text-gray-400 mr-1">{l.stage}</span>{l.text}
                  </span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </aside>
      </div>
    </div>
  );
}

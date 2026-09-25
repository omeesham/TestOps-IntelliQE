/**
 * API Automation — the module shell.
 *
 *   Overview · Endpoints · Scenarios · Runs · Reports · Environments
 *
 * A first-class IntelliQE page: it wears the app's own chrome (the global
 * sidebar names it, the global header titles it) and, inside, a native toolbar
 * + horizontal tab bar — no second sidebar, no stacked header. Import is a
 * primary call-to-action that opens a modal.
 *
 * Two hooks own everything: `useCatalog` (what the workspace knows — endpoints,
 * profile, strategy) and `useApiRun` (the pipeline in flight). The shell routes
 * between tabs and follows a live run through its stages.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  RotateCcw, AlertTriangle, X, ListChecks, ArrowRight, Upload,
  LayoutDashboard, Layers, FileCheck2, PlayCircle, BarChart3, Server,
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
import { EmptyState } from './primitives';
import { PRIMARY_BTN, SECONDARY_BTN } from './format';
import PageTabs, { type TabItem } from '@/components/ui/PageTabs';
import Loader from '@/components/feedback/Loader';
import type { NavView, Phase } from './types';

/** The tabs, left to right, in the order you walk the workflow. */
const TAB_IDS = new Set<NavView>(['overview', 'endpoints', 'scenarios', 'runs', 'report', 'environments']);

export default function ApiStudio() {
  const catalog = useCatalog();
  const [view, setView] = useState<NavView>(() => {
    const stored = sessionStorage.getItem('intelliqe_api_view');
    return stored && TAB_IDS.has(stored as NavView) ? (stored as NavView) : 'overview';
  });
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [overviewKey, setOverviewKey] = useState(0);

  /* Follow the run: design → scenarios, execute → runs, finished → report. */
  const onPhase = (p: Phase) => {
    if (p === 'generating' || p === 'review') setView('scenarios');
    else if (p === 'automating' || p === 'executing' || p === 'healing') setView('runs');
    else if (p === 'report') { setView('report'); setOverviewKey((k) => k + 1); }
  };
  const run = useApiRun({ onPhase });

  useEffect(() => { try { sessionStorage.setItem('intelliqe_api_view', view); } catch { /* ignore */ } }, [view]);

  /* One navigator for tabs and for in-view links. Import is a modal, not a tab,
     so a request to "go to import" opens the modal over whatever tab is showing. */
  const navigate = (v: NavView) => {
    if (v === 'import') { setImportOpen(true); return; }
    setView(v);
    if (v !== 'runs') setOpenRunId(null);
  };

  const openRun = (id: string) => { setOpenRunId(id); setView('runs'); };

  const design = () => run.runScenarios({ endpoints: catalog.selectedEndpoints, strategy: catalog.strategy, profile: catalog.profile });

  const sel = catalog.selectedEndpoints.length;

  const tabs: TabItem[] = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'endpoints', label: 'Endpoints', icon: Layers, count: catalog.endpoints.length || undefined },
    { id: 'scenarios', label: 'Scenarios', icon: FileCheck2, count: run.scenarios.length || undefined },
    { id: 'runs', label: 'Runs', icon: PlayCircle },
    { id: 'report', label: 'Reports', icon: BarChart3 },
    { id: 'environments', label: 'Environments', icon: Server },
  ];
  const activeTab: NavView = TAB_IDS.has(view) ? view : 'overview';

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* ── Chrome: toolbar + tabs (padded to align with each view's own gutter) ── */}
      <div className="flex-shrink-0 px-6 pt-5">
        <div className="flex items-center gap-3">
          <PageTabs tabs={tabs} active={activeTab} onChange={(id) => navigate(id as NavView)} ariaLabel="API Automation sections" className="min-w-0" />
          {run.started && (
            <button type="button" onClick={() => { run.resetRun(); setView('endpoints'); }} className={`${SECONDARY_BTN} ml-auto flex-shrink-0`} title="Start a fresh run"><RotateCcw className="w-3.5 h-3.5" /><span className="hidden lg:inline">New run</span></button>
          )}
        </div>

        {run.started && (
          <div className="mt-3">
            <StageRail
              stages={run.stages}
              push={{
                onPushToRepo: run.handlePushToRepo,
                pushState: run.pushState,
                canPush: run.specs.length > 0 && run.selected.size > 0,
                show: run.finished,
              }}
            />
          </div>
        )}

        {run.phase === 'review' && view === 'scenarios' && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-purple-50 border border-purple-100">
            <ListChecks className="w-4 h-4 text-[#7C3AED] flex-shrink-0" />
            <p className="text-sm text-purple-800 min-w-0"><span className="font-semibold">{run.scenarios.length} scenarios designed.</span> Review them and deselect anything you don't want — then run the suite. Automation, execution, healing and the report run straight through from there.</p>
            <button type="button" onClick={() => void run.runSuite()} title="Run the selected scenarios through automation, execution, healing and the report" className={`${PRIMARY_BTN} ml-auto flex-shrink-0 whitespace-nowrap`}>
              Run {run.selected.size} scenario{run.selected.size === 1 ? '' : 's'}
            </button>
          </div>
        )}

        {run.runError && (
          <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-xl bg-red-50 border border-red-200">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
            <p className="text-sm text-red-700 min-w-0">{run.runError}</p>
            <button type="button" onClick={() => run.setRunError('')} aria-label="Dismiss" className="ml-auto text-red-400 hover:text-red-600 flex-shrink-0"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}
      </div>

      {/* ── Active tab ── */}
      <div role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`} className="flex-1 min-h-0 mt-4">
        {view === 'overview' && <OverviewView catalog={catalog} onNavigate={navigate} onOpenRun={openRun} refreshKey={overviewKey} />}
        {view === 'endpoints' && <EndpointsView catalog={catalog} running={run.running} onDesign={design} onImport={() => setImportOpen(true)} scenarios={run.scenarios} />}
        {view === 'scenarios' && (
          run.scenarios.length === 0 && run.phase !== 'generating' ? (
            <div className="h-full flex flex-col">
              <EmptyState icon={FileCheck2} title="No scenarios designed yet" hint={sel ? `${sel} endpoints are selected — design scenarios and they land here for review before anything is automated.` : 'Select endpoints in the catalogue, then design scenarios. Every scenario stops here for review before anything is automated.'} />
              <div className="flex justify-center -mt-10 pb-10">
                {sel ? <button type="button" onClick={design} className={PRIMARY_BTN}>Testcase generation for {sel}</button> : <button type="button" onClick={() => setView('endpoints')} className={PRIMARY_BTN}>Open the catalogue<ArrowRight className="w-3.5 h-3.5" /></button>}
              </div>
            </div>
          ) : run.phase === 'generating' && run.scenarios.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-8">
              <Loader size="lg" label={`Designing scenarios for ${run.runEndpoints.length} endpoint${run.runEndpoints.length === 1 ? '' : 's'}`} hint={run.stages.find((s) => s.key === 'scenarios')?.detail?.replace(/…$/, '') || 'Reading the pattern profile, the strategy layers and every endpoint\'s contract. Large catalogues take a few minutes.'} />
            </div>
          ) : (
            <ScenariosTab scenarios={run.scenarios} selected={run.selected} editable={run.phase === 'review' || run.finished} onToggle={run.toggleScenario} onSelectAll={run.selectScenarios} onClearAll={run.clearScenarios} />
          )
        )}
        {view === 'runs' && <RunsView run={run} openRunId={openRunId} onOpenRun={setOpenRunId} onShowReport={() => navigate('report')} />}
        {view === 'report' && (
          <ReportTab report={run.report} rows={run.rows} scenarios={run.scenarios} onExport={run.handleExport} exporting={run.exporting} canExport={!!run.testRunId} onPushToRepo={run.handlePushToRepo} pushState={run.pushState} canPush={run.specs.length > 0 && run.selected.size > 0} />
        )}
        {view === 'environments' && <EnvironmentsView />}
      </div>

      {/* ── Import API — modal ── */}
      {importOpen && (
        <ImportModal onClose={() => setImportOpen(false)}>
          <ImportView catalog={catalog} onOpenCatalogue={() => { setImportOpen(false); setView('endpoints'); }} log={run.log} />
        </ImportModal>
      )}
    </div>
  );
}

/** The Import dialog frame — native modal chrome (overlay + floating sheet),
    Escape to close, focus moved in on open. The body scrolls; ImportView fills it. */
function ImportModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { window.clearTimeout(t); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Import API"
        tabIndex={-1}
        className="relative w-full max-w-[920px] my-4 bg-white rounded-2xl shadow-2xl max-h-[90vh] flex flex-col min-h-0 outline-none"
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center flex-shrink-0"><Upload className="w-4 h-4 text-white" /></span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-gray-900 leading-tight">Import API</h2>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 flex-shrink-0"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}

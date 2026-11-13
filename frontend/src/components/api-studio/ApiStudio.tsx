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
  LayoutDashboard, Layers, FileCheck2, PlayCircle, BarChart3, Server, RefreshCw, Wrench, FileSearch,
} from 'lucide-react';
import { useCatalog, toCatalogEndpoint } from './hooks/useCatalog';
import { useApiRun } from './hooks/useApiRun';
import EndpointEditor, { clearImportHistory } from './EndpointEditor';
import { useApiEnvironments, envRunKey } from './hooks/useApiEnvironments';
import StageRail from './StageRail';
import ScenariosTab from './ScenariosTab';
import ReportTab from './ReportTab';
import OverviewView from './views/OverviewView';
import ImportView from './views/ImportView';
import EndpointsView from './views/EndpointsView';
import StoryGen from './StoryGen';
import RunsView from './views/RunsView';
import EnvironmentsView from './views/EnvironmentsView';
import EnvironmentPicker from './views/EnvironmentPicker';
import ApiToolsLauncher from './ApiToolsLauncher';
import { validateApiEndpoints, type ApiValidationReport } from './apiValidation';
import { ValidationGateModal } from './ValidationReport';
import ReadinessReview from './ReadinessReview';
import { EmptyState } from './primitives';
import { PRIMARY_BTN, SECONDARY_BTN } from './format';
import PageTabs, { type TabItem } from '@/components/ui/PageTabs';
import { useAuth } from '@/contexts/AuthContext';
import { getAccessPermissions, importApiFiles } from '@/services/api';
import Loader from '@/components/feedback/Loader';
import type { NavView, Phase, CatalogEndpoint, StrategyLayerId } from './types';
import type { ApiFlowSeed } from '@/services/api';

/** The tabs, left to right, in the order you walk the workflow. */
const TAB_IDS = new Set<NavView>(['overview', 'endpoints', 'requirements', 'scenarios', 'runs', 'report', 'environments', 'tools']);

export default function ApiStudio() {
  const catalog = useCatalog();
  const envStore = useApiEnvironments();
  const [view, setView] = useState<NavView>(() => {
    const stored = sessionStorage.getItem('intelliqe_api_view');
    return stored && TAB_IDS.has(stored as NavView) ? (stored as NavView) : 'overview';
  });
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [overviewKey, setOverviewKey] = useState(0);
  /** Seed for the Tools gallery search — set when a caller deep-links to a
      capability (e.g. an Overview feature chip), cleared on a plain Tools visit. */
  const [toolsSeed, setToolsSeed] = useState('');
  /** A flow handed from the import wizard to the Flow Builder (Tools tab). */
  const [flowSeed, setFlowSeed] = useState<ApiFlowSeed | null>(null);

  /* Follow the run: design → scenarios, execute → runs, finished → report. */
  const onPhase = (p: Phase) => {
    if (p === 'generating' || p === 'review') setView('scenarios');
    else if (p === 'automating' || p === 'executing' || p === 'healing') setView('runs');
    else if (p === 'report') { setView('report'); setOverviewKey((k) => k + 1); }
  };
  const run = useApiRun({ onPhase });

  /* IQE-043.2 — role-based access. Load the current user's effective permissions
     (admin ⇒ everything) and gate the action entry points. The backend enforces
     the same permissions on the routes; this just avoids dead clicks and shows
     why. Until the map loads (null) we allow, so the UI never flickers blocked. */
  const { user } = useAuth();
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);
  useEffect(() => {
    let alive = true;
    getAccessPermissions()
      .then((r) => {
        if (!alive) return;
        const all = (r.catalog || []).map((p) => p.key);
        const perms = user?.role === 'admin' ? all : (r.roles?.[user?.role || ''] || []);
        setMyPerms(new Set(perms));
      })
      .catch(() => { if (alive) setMyPerms(null); });
    return () => { alive = false; };
  }, [user?.role]);
  const can = (perm: string): boolean => myPerms === null || user?.role === 'admin' || myPerms.has(perm);

  useEffect(() => { try { sessionStorage.setItem('intelliqe_api_view', view); } catch { /* ignore */ } }, [view]);

  /* Once an end-to-end run completes (the flow reaches the Report stage), wipe the
     cached workspace — catalogue, selection, derived profile, strategy and the
     import history — so the next API starts from a clean slate. Fires once per
     completion (latched, reset when a new run starts); the on-screen report, held
     in the run's own in-memory state, is untouched, as are auth, the active
     environment and UI preferences. */
  const clearedForRunRef = useRef(false);
  useEffect(() => {
    if (run.phase === 'report') {
      if (!clearedForRunRef.current) {
        clearedForRunRef.current = true;
        catalog.clearCache();
        clearImportHistory();
        run.log('run', 'End-to-end run complete — cleared the cached workspace (catalogue, selection, imports). The report below is kept.', 'ok');
      }
    } else if (run.phase === 'idle' || run.phase === 'generating') {
      clearedForRunRef.current = false;
    }
  }, [run.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /* One navigator for tabs and for in-view links. Import is a modal, not a tab,
     so a request to "go to import" opens the modal over whatever tab is showing. */
  const navigate = (v: NavView, toolsSearch?: string) => {
    if (v === 'import') {
      if (!can('api.import')) { run.log('import', `Your role (${user?.role || 'unknown'}) is not allowed to import APIs.`, 'error'); return; }
      setImportOpen(true); return;
    }
    if (v === 'tools') setToolsSeed(toolsSearch ?? '');
    setView(v);
    if (v !== 'runs') setOpenRunId(null);
  };

  const openRun = (id: string) => { setOpenRunId(id); setView('runs'); };

  /* The actual kickoff — split out so the validation gate can defer it. */
  const startGeneration = (endpoints: CatalogEndpoint[]) => {
    if (!can('api.run')) { run.log('run', `Your role (${user?.role || 'unknown'}) is not allowed to run or generate tests.`, 'error'); return; }
    run.runScenarios({ endpoints, strategy: catalog.strategy, profile: catalog.profile, environment: envStore.activeEnvironment });
  };

  /* Generation gate — re-validate the endpoints against the active environment
     before a run starts. A clean set runs straight through; anything with
     errors/warnings opens the "proceed anyway" dialog, which carries the exact
     endpoint list it validated so proceeding runs precisely that set. */
  const [genGate, setGenGate] = useState<{ report: ApiValidationReport; endpoints: CatalogEndpoint[] } | null>(null);
  /* The strict readiness review — the reviewer gate that must pass before any
     planning. Holds the ids under review so the modal re-grades the live
     catalogue as the reviewer edits or removes items. */
  const [review, setReview] = useState<{ ids: string[] } | null>(null);

  /* Once endpoints are readiness-approved, the lighter env gate still runs so a
     run never starts on unresolved {{vars}} or a placeholder host. */
  const proceedToPlan = (list: CatalogEndpoint[]) => {
    if (list.length === 0) return;
    const report = validateApiEndpoints(list, envStore.activeEnvironment);
    if (report.errorCount > 0 || report.warningCount > 0) { setGenGate({ report, endpoints: list }); return; }
    startGeneration(list);
  };

  /* `endpoints` defaults to the catalogue selection; the Array.isArray guard lets
     this double as an onClick handler (which would pass a SyntheticEvent). The
     manual "Automate" path calls it with its own single-endpoint list. Strict
     gate: anything not fully documented opens the readiness review first. */
  const design = (endpoints: CatalogEndpoint[] = catalog.selectedEndpoints) => {
    const list = Array.isArray(endpoints) ? endpoints : catalog.selectedEndpoints;
    if (list.length === 0) return;
    // Always open the readiness review so the reviewer accepts or rejects every
    // imported endpoint before planning — even when all are already documented.
    setReview({ ids: list.map((e) => e.id) });
  };
  /** Open the readiness review explicitly (from the import outcome panel). */
  const openReview = (list: CatalogEndpoint[]) => {
    if (list.length) setReview({ ids: list.map((e) => e.id) });
  };

  /* Manual "Automate": save the hand-authored request to the catalogue, then run
     the regular pipeline for exactly that endpoint. A request the user already
     fired a successful live Send against (`opts.tested`) is proven against the
     real API, so it bypasses the strict readiness review and goes straight to the
     lighter env gate — automation proceeds as usual. An untested request still
     goes through the full readiness review first. */
  const automateManual = (ep: Omit<CatalogEndpoint, 'id' | 'importedAt'>, opts?: { tested?: boolean }) => {
    setManualOpen(false);
    catalog.addEndpoints([ep], { method: 'manual', name: ep.title, format: 'manual', parser: 'manual' });
    const entry = toCatalogEndpoint(ep, 'manual');
    if (opts?.tested) proceedToPlan([entry]);
    else design([entry]);
  };

  const sel = catalog.selectedEndpoints.length;

  /* A run is grounded in the environment it was designed against. When the active
     environment (or its variables) changes after design, re-resolve the run's
     data against it live — deterministically, no model call — so the scenarios
     and the executable specs always match the selected environment. */
  const activeEnvName = envStore.noneSelected ? 'No environment' : (envStore.activeEnvironment?.name || 'No environment');
  const activeEnvKey = envRunKey(envStore.activeEnvironment);
  useEffect(() => {
    if (!run.runCases.length || run.running) return;
    if (!run.runEnvKey || run.runEnvKey === activeEnvKey) return;
    void run.reresolve(envStore.activeEnvironment);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEnvKey, run.runEnvKey, run.runCases.length, run.running]);

  const tabs: TabItem[] = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'endpoints', label: 'Endpoints', icon: Layers, count: catalog.endpoints.length || undefined },
    { id: 'requirements', label: 'Requirements', icon: FileSearch },
    { id: 'scenarios', label: 'Scenarios', icon: FileCheck2, count: run.scenarios.length || undefined },
    { id: 'runs', label: 'Runs', icon: PlayCircle },
    { id: 'report', label: 'Reports', icon: BarChart3 },
    { id: 'environments', label: 'Environments', icon: Server },
    { id: 'tools', label: 'Tools', icon: Wrench },
  ];
  const activeTab: NavView = TAB_IDS.has(view) ? view : 'overview';

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* ── Chrome: toolbar + tabs (padded to align with each view's own gutter) ── */}
      <div className="flex-shrink-0 px-6 pt-6 pb-1 relative z-10">
        <div className="flex items-center gap-3">
          <PageTabs tabs={tabs} active={activeTab} onChange={(id) => navigate(id as NavView)} ariaLabel="API Automation sections" className="min-w-0" />
          <div className="ml-auto flex items-center gap-2 flex-shrink-0">
            <EnvironmentPicker store={envStore} onManage={() => setView('environments')} />
            {run.started && (
              <button type="button" onClick={() => { run.resetRun(); catalog.clearCatalog(); setView('endpoints'); }} className={SECONDARY_BTN} title="Start a fresh run — clears the imported endpoints and the previous run"><RotateCcw className="w-3.5 h-3.5" /><span className="hidden lg:inline">New run</span></button>
            )}
          </div>
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

        {run.reresolving && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-purple-50 border border-purple-100">
            <RefreshCw className="w-4 h-4 text-[#7C3AED] flex-shrink-0 animate-spin" />
            <p className="text-sm text-purple-800 min-w-0">Re-resolving test data against <span className="font-semibold">{activeEnvName}</span>…</p>
          </div>
        )}

        {run.phase === 'review' && view === 'scenarios' && !run.reresolving && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-purple-50 border border-purple-100">
            <ListChecks className="w-4 h-4 text-[#7C3AED] flex-shrink-0" />
            <p className="text-sm text-purple-800 min-w-0"><span className="font-semibold">{run.scenarios.length} scenarios are ready.</span> Select what you want to run and launch the suite. Automation, execution, healing, and reporting{run.runEnvName ? <> · resolved against <span className="font-semibold">{run.runEnvName}</span></> : null}</p>
            <button type="button" onClick={() => void run.runSuite()} title="Run the selected scenarios through automation, execution, healing and the report" className={`${PRIMARY_BTN} ml-auto flex-shrink-0 whitespace-nowrap`}>
              Automate {run.selected.size} scenario{run.selected.size === 1 ? '' : 's'}
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
        {view === 'overview' && <OverviewView catalog={catalog} onNavigate={navigate} onOpenRun={openRun} onOpenManual={() => setManualOpen(true)} refreshKey={overviewKey} />}
        {view === 'endpoints' && <EndpointsView catalog={catalog} running={run.running} onDesign={design} onImport={() => navigate('import')} scenarios={run.scenarios} canImport={can('api.import')} canRun={can('api.run')} />}
        {view === 'requirements' && (
          <StoryGen
            embedded
            endpoints={catalog.endpoints}
            environment={envStore.activeEnvironment}
            onMineEndpoints={async (file) => {
              const res = await importApiFiles([file], 'auto');
              const { added, duplicates, total } = catalog.addEndpoints(res.endpoints || [], { method: 'file', name: file.name, format: res.format || 'document', parser: res.parser || 'llm', profile: res.profile });
              return { added, duplicates, total };
            }}
            onApply={(brief, approvedUrls) => {
              // The Requirement Agent's reviewed brief grounds planning: coverage,
              // layers and the requirements text land on the strategy (threaded into
              // designApiScenarios), and planning proceeds on exactly the approved
              // endpoints — a rejected requirement is never planned.
              catalog.setStrategy({ coverage: brief.coverage, layers: brief.layers as StrategyLayerId[], requirements: brief.requirements });
              const approved = approvedUrls.length ? catalog.endpoints.filter((e) => approvedUrls.includes(e.url)) : catalog.endpoints;
              if (can('api.run')) design(approved.length ? approved : catalog.endpoints);
            }}
            onClose={() => navigate('endpoints')}
          />
        )}
        {view === 'scenarios' && (
          run.scenarios.length === 0 && run.phase !== 'generating' ? (
            <div className="h-full flex flex-col">
              <EmptyState icon={FileCheck2} title="No scenarios designed yet" hint={sel ? `${sel} endpoints are selected — design scenarios and they land here for review before anything is automated.` : 'Select endpoints in the catalogue, then design scenarios. Every scenario stops here for review before anything is automated.'} />
              <div className="flex justify-center -mt-10 pb-10">
                {sel ? <button type="button" onClick={() => design()} className={PRIMARY_BTN}>Testcase generation for {sel}</button> : <button type="button" onClick={() => setView('endpoints')} className={PRIMARY_BTN}>Open the catalogue<ArrowRight className="w-3.5 h-3.5" /></button>}
              </div>
            </div>
          ) : run.phase === 'generating' && run.scenarios.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-8">
              <Loader size="lg" label={`Designing scenarios for ${run.runEndpoints.length} endpoint${run.runEndpoints.length === 1 ? '' : 's'}`} />
            </div>
          ) : (
            <ScenariosTab scenarios={run.scenarios} selected={run.selected} editable={run.phase === 'review' || run.finished} onToggle={run.toggleScenario} onSelectAll={run.selectScenarios} onClearAll={run.clearScenarios} onDelete={run.deleteScenario} onUpdate={run.updateScenario} />
          )
        )}
        {view === 'runs' && <RunsView run={run} openRunId={openRunId} onOpenRun={setOpenRunId} onShowReport={() => navigate('report')} />}
        {view === 'report' && (
          <ReportTab report={run.report} rows={run.rows} scenarios={run.scenarios} onExport={run.handleExport} exporting={run.exporting} canExport={!!run.testRunId} onPushToRepo={run.handlePushToRepo} pushState={run.pushState} canPush={run.specs.length > 0 && run.selected.size > 0} />
        )}
        {view === 'environments' && <EnvironmentsView store={envStore} />}
        {view === 'tools' && <ApiToolsLauncher key={`tools:${toolsSeed}`} catalog={catalog} scenarios={run.scenarios} initialSearch={toolsSeed} onNavigate={navigate} environment={envStore.activeEnvironment} initialFlow={flowSeed} onConsumeFlow={() => setFlowSeed(null)} />}
      </div>

      {/* ── Import API — modal ── */}
      {importOpen && (
        <ImportModal onClose={() => setImportOpen(false)}>
          <ImportView catalog={catalog} onOpenCatalogue={() => { setImportOpen(false); setView('endpoints'); }} log={run.log} environment={envStore.activeEnvironment} onEnvironmentsChanged={() => { void envStore.reload(); }} onOpenStory={() => { setImportOpen(false); navigate('tools', 'story'); }} onImportFlow={(seed) => { setImportOpen(false); setFlowSeed(seed); navigate('tools'); }} onReview={(ids) => { setImportOpen(false); setView('endpoints'); if (ids && ids.length) setReview({ ids }); else openReview(catalog.selectedEndpoints); }} />
        </ImportModal>
      )}

      {/* ── Manual HTTP request — a right-hand drawer; "Automate" runs the pipeline ── */}
      {manualOpen && (
        <EndpointEditor
          title="Manual HTTP request"
          allowImport
          environment={envStore.activeEnvironment}
          onImported={(eps, folderName) => {
            const r = catalog.addEndpoints(eps, { method: 'manual', name: folderName, format: 'imported', parser: 'imported' });
            run.log('import', `${folderName}: ${r.added} endpoint${r.added === 1 ? '' : 's'} imported`, 'ok');
          }}
          onClose={() => setManualOpen(false)}
          onSave={(ep) => {
            const r = catalog.addEndpoints([ep], { method: 'manual', name: ep.title, format: 'manual', parser: 'manual' });
            setManualOpen(false);
            run.log('import', `${ep.method} ${ep.url} added to the catalogue`, 'ok');
            if (r.added) setView('endpoints');
          }}
          onAutomate={automateManual}
        />
      )}

      {/* ── Strict readiness review — the reviewer gate before planning ── */}
      {review && (
        <ReadinessReview
          catalog={catalog}
          endpointIds={review.ids}
          onClose={() => setReview(null)}
          onProceed={(eps) => { setReview(null); proceedToPlan(eps); }}
        />
      )}

      {/* ── Generation gate — validate selected endpoints before a run ── */}
      {genGate && (
        <ValidationGateModal
          report={genGate.report}
          onProceed={() => { const eps = genGate.endpoints; setGenGate(null); startGeneration(eps); }}
          onCancel={() => { setGenGate(null); setView('endpoints'); }}
        />
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

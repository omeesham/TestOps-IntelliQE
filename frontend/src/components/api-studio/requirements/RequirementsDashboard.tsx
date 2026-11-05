/**
 * RequirementsDashboard — the shared body of the Requirements Management
 * surface: it loads the two live aggregates (integration dashboard + integrated
 * matrix) against a selected run and renders the five tabs
 *
 *   BRD Management · FRD Management · Requirements Analysis · API Mapping · Test Case Generation
 *
 * Both entry points reuse it: the full-page `/requirements` route and the modal
 * opened from the API Automation Tools gallery. It fills its parent (h-full flex
 * column) so each host supplies the frame (page header, or modal chrome).
 *
 * Read-only / additive: composes existing services; no pipeline, schema, auth or
 * tenant changes.
 */
import { useEffect, useState } from 'react';
import { RefreshCw, Loader2, AlertTriangle, ClipboardList, ClipboardCheck, ScanSearch, Link2, FlaskConical } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import {
  getIntegrationDashboard, getIntegratedMatrix, listApiRuns,
  type IntegrationDashboard as Dash, type IntegratedMatrix,
} from '@/services/api';
import { FIELD, SECONDARY_BTN } from '../format';
import PageTabs, { type TabItem } from '@/components/ui/PageTabs';
import BrdManagementTab from './BrdManagementTab';
import FrdManagementTab from './FrdManagementTab';
import RequirementsAnalysisTab from './RequirementsAnalysisTab';
import ApiMappingTab from './ApiMappingTab';
import TestGenerationTab from './TestGenerationTab';
import type { RmTabProps } from './util';

export type RmView = 'brd' | 'frd' | 'analysis' | 'mapping' | 'generation';
const VIEW_KEY = 'intelliqe_rm_view';
const VIEWS: RmView[] = ['brd', 'frd', 'analysis', 'mapping', 'generation'];

export default function RequirementsDashboard({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const username = user?.username || '';

  const [view, setView] = useState<RmView>(() => {
    const stored = sessionStorage.getItem(VIEW_KEY) as RmView | null;
    return stored && VIEWS.includes(stored) ? stored : 'brd';
  });
  const [runs, setRuns] = useState<any[]>([]);
  const [runId, setRunId] = useState('');
  const [dash, setDash] = useState<Dash | null>(null);
  const [matrix, setMatrix] = useState<IntegratedMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { try { sessionStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ } }, [view]);

  const load = async (rid?: string) => {
    setLoading(true); setError('');
    try {
      const [d, m] = await Promise.all([
        getIntegrationDashboard(rid || undefined),
        getIntegratedMatrix(rid || undefined),
      ]);
      setDash(d); setMatrix(m);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not load the dashboard.');
    } finally { setLoading(false); }
  };

  useEffect(() => {
    void load();
    void listApiRuns(1, 20).then((r) => setRuns(Array.isArray(r?.items) ? r.items : [])).catch(() => { /* convenience */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadGlobal = () => load(runId);

  const tabs: TabItem[] = [
    { id: 'brd', label: 'BRD Management', icon: ClipboardList, count: dash?.requirements.brdReqs || undefined },
    { id: 'frd', label: 'FRD Management', icon: ClipboardCheck, count: dash?.requirements.frdReqs || undefined },
    { id: 'analysis', label: 'Requirements Analysis', icon: ScanSearch, count: dash?.requirements.total || undefined },
    { id: 'mapping', label: 'API Mapping', icon: Link2, count: matrix?.rows.filter((r) => r.endpoints.length > 0).length || undefined },
    { id: 'generation', label: 'Test Case Generation', icon: FlaskConical, count: matrix?.rows.reduce((n, r) => n + r.cases.length, 0) || undefined },
  ];

  const tabProps: RmTabProps = { runId, dash, matrix, loadingGlobal: loading, username, reloadGlobal, onClose, onNavigate: (v) => setView(v) };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Tabs + run controls */}
      <div className="px-4 sm:px-6 pt-3 pb-1 flex-shrink-0 flex items-center gap-2 flex-wrap">
        <PageTabs tabs={tabs} active={view} onChange={(id) => setView(id as RmView)} ariaLabel="Requirements Management sections" className="min-w-0" />
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          <select value={runId} onChange={(e) => { setRunId(e.target.value); void load(e.target.value); }} className={`${FIELD} max-w-[180px] hidden sm:block`} title="Measure coverage against a specific run">
            <option value="">Latest run</option>
            {runs.map((r, i) => <option key={r.runId ?? i} value={String(r.runId ?? '')}>{r.title || r.runId || 'Run'}</option>)}
          </select>
          <button type="button" onClick={() => void load(runId)} disabled={loading} className={SECONDARY_BTN} title="Refresh">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}<span className="hidden md:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Body */}
      <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pb-6 pt-3">
        {error && (
          <div className="mb-4 flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
            <p className="text-[12px] text-red-700 min-w-0">{error}</p>
          </div>
        )}
        {view === 'brd' && <BrdManagementTab {...tabProps} />}
        {view === 'frd' && <FrdManagementTab {...tabProps} />}
        {view === 'analysis' && <RequirementsAnalysisTab {...tabProps} />}
        {view === 'mapping' && <ApiMappingTab {...tabProps} />}
        {view === 'generation' && <TestGenerationTab {...tabProps} />}
      </div>
    </div>
  );
}

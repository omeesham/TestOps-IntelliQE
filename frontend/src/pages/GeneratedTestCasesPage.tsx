import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Trash2, Edit3, Plus, Eye, Download, FileText, X, Check, Clock,
  Tag, User, Calendar, Hash, AlertTriangle, CheckCircle2, Circle,
  MoreHorizontal, Copy, ExternalLink, Filter,
} from 'lucide-react';
import {
  listTestRuns, getTestRun, updateTestCase, addTestCase, deleteTestCase, deleteTestRun, exportTestCases,
  generateScriptsForRun, downloadArtifactZip, listTestCaseFacets,
} from '@/services/api';

const TAG_VOCAB = ['POSITIVE', 'NEGATIVE', 'E2E', 'UI', 'API', 'SMOKE', 'REGRESSION'] as const;
type TagName = typeof TAG_VOCAB[number];
import { Code2, Loader2, Database, BarChart3 } from 'lucide-react';
import TestDataTab from '@/components/test-data/TestDataTab';
import ReportsTab from '@/components/test-data/ReportsTab';

/* ── Types ── */
interface TestRun {
  id: string; username: string; story_key: string | null; story_title: string | null;
  source: string | null; columns: string[]; created_at: string; tenant_id: string;
  module?: string | null; submodule?: string | null;
  test_case_count: number; generated_count: number; approved_count: number; scripted_count: number;
}
interface TestCase {
  id: string; test_run_id: string; tc_number: string; title: string; steps: string[];
  expected: string; priority: string; type: string; feature: string; precondition: string;
  status: string; sort_order: number; created_at: string;
  module?: string | null; submodule?: string | null; tags?: string[];
}
interface Pagination { page: number; limit: number; total: number; totalPages: number; }

/* ── Colors ── */
const PRIORITY_COLORS: Record<string, string> = {
  P0: 'bg-red-100 text-red-700 border border-red-200',
  P1: 'bg-orange-100 text-orange-700 border border-orange-200',
  P2: 'bg-yellow-100 text-yellow-700 border border-yellow-200',
  P3: 'bg-green-100 text-green-700 border border-green-200',
};
const TYPE_COLORS: Record<string, string> = {
  positive: 'bg-emerald-50 text-emerald-700',
  negative: 'bg-red-50 text-red-700',
  edge: 'bg-amber-50 text-amber-700',
  e2e: 'bg-blue-50 text-blue-700',
  smoke: 'bg-blue-50 text-blue-700',
  regression: 'bg-blue-50 text-blue-700',
  security: 'bg-rose-50 text-rose-700',
};
const STATUS_CONFIG: Record<string, { bg: string; icon: any; label: string }> = {
  generated: { bg: 'bg-gray-100 text-gray-600', icon: Clock, label: 'Generated' },
  reviewed:  { bg: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2, label: 'Reviewed' },
  approved:  { bg: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2, label: 'Reviewed' },
  scripted:  { bg: 'bg-blue-100 text-blue-700', icon: FileText, label: 'Scripted' },
  executed:  { bg: 'bg-blue-100 text-blue-700', icon: Check, label: 'Executed' },
  failed:    { bg: 'bg-red-100 text-red-700', icon: AlertTriangle, label: 'Failed' },
};

export default function GeneratedTestCasesPage() {
  const navigate = useNavigate();

  /* ── List view state ── */
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [moduleFilter, setModuleFilter] = useState('');
  const [submoduleFilter, setSubmoduleFilter] = useState('');
  const [tagFilters, setTagFilters] = useState<Set<TagName>>(new Set());
  const [facets, setFacets] = useState<{ modules: string[]; submodules: { module: string; name: string }[]; tags: string[] }>({ modules: [], submodules: [], tags: [] });
  const [detailTagFilters, setDetailTagFilters] = useState<Set<TagName>>(new Set());

  /* ── Detail view state ── */
  const [selectedRun, setSelectedRun] = useState<TestRun | null>(null);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandedTcId, setExpandedTcId] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!expandedTcId) return;
    const handler = (e: MouseEvent) => {
      if (tableRef.current && !tableRef.current.contains(e.target as Node)) {
        setExpandedTcId(null);
        setEditingTc(null);
        setEditDraft(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [expandedTcId]);
  const [editingTc, setEditingTc] = useState<TestCase | null>(null);
  const [editDraft, setEditDraft] = useState<any>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addDraft, setAddDraft] = useState({ title: '', steps: [''], expected: '', priority: 'P1', type: 'positive', feature: '', precondition: '' });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmDeleteType, setConfirmDeleteType] = useState<'run' | 'case'>('run');
  const [tcPage, setTcPage] = useState(1);
  const [tcPageSize, setTcPageSize] = useState(10);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);
  const [selectedTcIds, setSelectedTcIds] = useState<Set<string>>(new Set());
  const [generatingScripts, setGeneratingScripts] = useState(false);
  const [detailTab, setDetailTab] = useState<'cases' | 'data' | 'reports'>('cases');

  /* ── Fetch test runs ── */
  const fetchRuns = useCallback(async (page = 1, limit = 10) => {
    setLoading(true);
    try {
      const tagsArr = Array.from(tagFilters);
      const res = await listTestRuns({
        page, limit,
        search: search || undefined,
        module: moduleFilter || undefined,
        submodule: submoduleFilter || undefined,
        tag: tagsArr.length > 0 ? tagsArr : undefined,
      });
      const runsList = res.runs || [];
      const pg = res.pagination || { page, limit, total: 0, totalPages: 0 };
      // If the requested page is now empty but there are still results, snap back to page 1
      if (runsList.length === 0 && pg.total > 0 && page > 1) {
        const fallback = await listTestRuns({ page: 1, limit, search: search || undefined });
        setRuns(fallback.runs || []);
        setPagination(fallback.pagination || { page: 1, limit, total: 0, totalPages: 0 });
      } else {
        setRuns(runsList);
        setPagination(pg);
      }
    } catch (err) {
      console.error('Failed to load test runs:', err);
    } finally {
      setLoading(false);
    }
  }, [search, moduleFilter, submoduleFilter, tagFilters]);

  useEffect(() => { fetchRuns(1, pagination.limit); }, [search, moduleFilter, submoduleFilter, tagFilters]);
  useEffect(() => { fetchRuns(1, 10); }, []);
  useEffect(() => {
    listTestCaseFacets().then(setFacets).catch((e) => console.error('Failed to load facets:', e));
  }, []);

  /* ── Fetch test cases for a run ── */
  const openRunDetail = async (run: TestRun) => {
    setSelectedRun(run);
    setDetailLoading(true);
    setTcPage(1);
    setSelectedTcIds(new Set());
    setDetailTagFilters(new Set());
    try {
      const res = await getTestRun(run.id);
      setTestCases(res.testCases || []);
    } catch (err) {
      console.error('Failed to load test cases:', err);
    } finally {
      setDetailLoading(false);
    }
  };

  /* ── Re-fetch cases when detail tag filter changes ── */
  useEffect(() => {
    if (!selectedRun) return;
    const tagsArr = Array.from(detailTagFilters);
    getTestRun(selectedRun.id, { tag: tagsArr.length > 0 ? tagsArr : undefined })
      .then((res) => setTestCases(res.testCases || []))
      .catch((err) => console.error('Failed to filter test cases:', err));
  }, [detailTagFilters, selectedRun?.id]);

  const closeDetail = () => { setSelectedRun(null); setTestCases([]); setEditingTc(null); setShowAddForm(false); setSelectedTcIds(new Set()); setDetailTab('cases'); };

  /* ── Review toggle (checkbox) ── */
  const handleToggleReview = async (tc: TestCase) => {
    if (!selectedRun) return;
    const newStatus = (tc.status === 'reviewed' || tc.status === 'approved') ? 'generated' : 'reviewed';
    try {
      await updateTestCase(selectedRun.id, tc.id, { status: newStatus });
      setTestCases(prev => prev.map(t => t.id === tc.id ? { ...t, status: newStatus } : t));
    } catch (err) {
      console.error('Review toggle failed:', err);
    }
  };

  /* ── Bulk review ── */
  const handleBulkReview = async () => {
    if (!selectedRun || selectedTcIds.size === 0) return;
    try {
      await Promise.all(
        Array.from(selectedTcIds).map(id =>
          updateTestCase(selectedRun.id, id, { status: 'reviewed' })
        )
      );
      setTestCases(prev => prev.map(t => selectedTcIds.has(t.id) ? { ...t, status: 'reviewed' } : t));
      setSelectedTcIds(new Set());
    } catch (err) {
      console.error('Bulk review failed:', err);
    }
  };

  /* ── Generate Scripts handler ── */
  const handleGenerateScripts = async () => {
    if (!selectedRun) return;
    setGeneratingScripts(true);
    try {
      const result = await generateScriptsForRun(selectedRun.id);
      if (result.ok) {
        // Refresh test cases (status updated to 'scripted')
        const res = await getTestRun(selectedRun.id);
        setTestCases(res.testCases || []);
        // Navigate to automation scripts page filtered by this run
        navigate(`/automation-scripts?runId=${selectedRun.id}`);
      }
    } catch (err: any) {
      console.error('Generate scripts failed:', err);
      alert(err?.response?.data?.error || 'Failed to generate scripts. Make sure test cases are reviewed first.');
    } finally {
      setGeneratingScripts(false);
    }
  };

  /* ── CRUD handlers ── */
  const handleUpdateTc = async () => {
    if (!editingTc || !editDraft || !selectedRun) return;
    try {
      await updateTestCase(selectedRun.id, editingTc.id, {
        title: editDraft.title, steps: editDraft.steps, expected: editDraft.expected,
        priority: editDraft.priority, type: editDraft.type, feature: editDraft.feature,
        precondition: editDraft.precondition, status: editDraft.status,
      });
      const res = await getTestRun(selectedRun.id);
      setTestCases(res.testCases || []);
      setEditingTc(null); setEditDraft(null);
    } catch (err) { console.error('Update failed:', err); }
  };

  const handleAddTc = async () => {
    if (!selectedRun) return;
    try {
      await addTestCase(selectedRun.id, addDraft);
      const res = await getTestRun(selectedRun.id);
      setTestCases(res.testCases || []);
      setShowAddForm(false);
      setAddDraft({ title: '', steps: [''], expected: '', priority: 'P1', type: 'positive', feature: '', precondition: '' });
    } catch (err) { console.error('Add failed:', err); }
  };

  const handleDeleteTc = async (caseId: string) => {
    if (!selectedRun) return;
    try {
      await deleteTestCase(selectedRun.id, caseId);
      setTestCases(prev => prev.filter(tc => tc.id !== caseId));
      setConfirmDelete(null);
    } catch (err) { console.error('Delete failed:', err); }
  };

  const handleDeleteRun = async (runId: string) => {
    try {
      await deleteTestRun(runId);
      setConfirmDelete(null);
      if (selectedRun?.id === runId) closeDetail();
      // If this was the last item on the current page, jump back a page (or to 1)
      const isLastOnPage = runs.length === 1 && pagination.page > 1;
      const targetPage = isLastOnPage ? pagination.page - 1 : pagination.page;
      fetchRuns(targetPage, pagination.limit);
    } catch (err) { console.error('Delete run failed:', err); }
  };

  const handleExport = async (runId: string, format: string) => {
    try {
      const response = await exportTestCases(runId, format);
      const blob = new Blob([response.data], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url;
      a.download = `testcases-${format}-${runId.slice(0, 8)}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch (err) { console.error('Export failed:', err); }
  };

  /* ── Paginated test cases ── */
  const paginatedTcs = testCases.slice((tcPage - 1) * tcPageSize, tcPage * tcPageSize);
  const tcTotalPages = Math.ceil(testCases.length / tcPageSize);

  /* ── Derived counts ── */
  const reviewedCount = testCases.filter(tc => tc.status === 'reviewed' || tc.status === 'approved').length;
  const totalTcCount = runs.reduce((s, r) => s + (Number(r.test_case_count) || 0), 0);
  const totalReviewed = runs.reduce((s, r) => s + (Number(r.approved_count) || 0), 0);
  const totalScripted = runs.reduce((s, r) => s + (Number(r.scripted_count) || 0), 0);

  /* ── Select All for current page ── */
  const allPageSelected = paginatedTcs.length > 0 && paginatedTcs.every(tc => selectedTcIds.has(tc.id));
  const toggleSelectAll = () => {
    if (allPageSelected) {
      const newSet = new Set(selectedTcIds);
      paginatedTcs.forEach(tc => newSet.delete(tc.id));
      setSelectedTcIds(newSet);
    } else {
      const newSet = new Set(selectedTcIds);
      paginatedTcs.forEach(tc => newSet.add(tc.id));
      setSelectedTcIds(newSet);
    }
  };

  /* ── Confirm Delete Modal ── */
  const ConfirmModal = () => {
    if (!confirmDelete) return null;
    return (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setConfirmDelete(null)}>
        <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">Confirm Delete</h3>
              <p className="text-sm text-gray-500">
                {confirmDeleteType === 'run' ? 'This will delete the entire test suite and all test cases.' : 'This will permanently delete this test case.'}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
            <button onClick={() => confirmDeleteType === 'run' ? handleDeleteRun(confirmDelete) : handleDeleteTc(confirmDelete)}
              className="px-4 py-2 text-sm text-white bg-red-600 rounded-lg hover:bg-red-700">Delete</button>
          </div>
        </div>
      </div>
    );
  };

  /* ══════════════════════════════════════════
     DETAIL VIEW — Single test run with all cases
     ══════════════════════════════════════════ */
  if (selectedRun) {
    return (
      <div className="-m-6 p-4 space-y-3">
        <ConfirmModal />

        {/* Back + Header */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <button onClick={closeDetail} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500">
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div>
                <div className="flex items-center gap-2">
                  {selectedRun.story_key && (
                    <span className="px-2.5 py-1 rounded-md bg-blue-50 text-blue-700 text-xs font-bold font-mono border border-blue-200">
                      {selectedRun.story_key}
                    </span>
                  )}
                  <h2 className="text-lg font-bold text-gray-900">{selectedRun.story_title || 'Manual Test Suite'}</h2>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowAddForm(true)} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#155dfc] text-white rounded-lg hover:bg-[#124fd6] transition">
                <Plus className="w-3.5 h-3.5" /> Add Test Case
              </button>
              <button
                onClick={handleGenerateScripts}
                disabled={generatingScripts || reviewedCount === 0}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
                title={reviewedCount === 0 ? 'Review test cases first' : `Generate scripts for ${reviewedCount} reviewed test cases`}
              >
                {generatingScripts ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Code2 className="w-3.5 h-3.5" />}
                {generatingScripts ? 'Generating...' : 'Generate Scripts'}
              </button>
              <div className="relative">
                <button onClick={() => setActionMenuId(actionMenuId === 'export' ? null : 'export')} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50">
                  <Download className="w-3.5 h-3.5" /> Export
                </button>
                {actionMenuId === 'export' && (
                  <div className="absolute right-0 mt-1 w-40 bg-white border border-gray-200 rounded-lg shadow-lg z-20">
                    {['csv', 'jira', 'testrail'].map(fmt => (
                      <button key={fmt} onClick={() => { handleExport(selectedRun.id, fmt); setActionMenuId(null); }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 capitalize">{fmt === 'csv' ? 'Excel CSV' : fmt === 'jira' ? 'Jira / Xray' : 'TestRail'}</button>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => { setConfirmDelete(selectedRun.id); setConfirmDeleteType('run'); }}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100">
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            </div>
          </div>

        </div>

        {/* Module / submodule badges + tag filter */}
        <div className="flex items-center gap-2 flex-wrap bg-white border border-gray-100 rounded-xl px-3 py-2 shadow-sm">
          {selectedRun.module && (
            <span className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-xs font-medium border border-blue-100">Module: {selectedRun.module}</span>
          )}
          {selectedRun.submodule && (
            <span className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-xs font-medium border border-blue-100">Submodule: {selectedRun.submodule}</span>
          )}
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <Filter className="w-4 h-4 text-gray-400" />
            <span className="text-xs font-semibold text-gray-500">Tags:</span>
            {TAG_VOCAB.map((tag) => {
              const active = detailTagFilters.has(tag);
              return (
                <button
                  key={tag}
                  onClick={() => {
                    const next = new Set(detailTagFilters);
                    if (active) next.delete(tag); else next.add(tag);
                    setDetailTagFilters(next);
                  }}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                    active ? 'bg-[#155dfc] text-white border-[#155dfc]' : 'bg-white text-gray-600 border-gray-200 hover:border-[#155dfc] hover:text-[#155dfc]'
                  }`}
                >
                  {tag}
                </button>
              );
            })}
            {detailTagFilters.size > 0 && (
              <button onClick={() => setDetailTagFilters(new Set())} className="text-xs text-gray-500 hover:text-[#155dfc] underline">Clear</button>
            )}
          </div>
        </div>

        {/* Bulk actions bar */}
        {selectedTcIds.size > 0 && (
          <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-2xl px-4 py-3">
            <span className="text-sm font-medium text-blue-700">{selectedTcIds.size} selected</span>
            <button onClick={handleBulkReview} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700">
              <CheckCircle2 className="w-3.5 h-3.5" /> Mark as Reviewed
            </button>
            <button onClick={() => setSelectedTcIds(new Set())} className="text-xs text-gray-500 hover:text-gray-700">Clear selection</button>
          </div>
        )}

        {/* Add Test Case Form */}
        {showAddForm && (
          <div className="bg-white border border-blue-200 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-sm">Add New Test Case</h3>
              <button onClick={() => setShowAddForm(false)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-[10px] font-medium text-gray-500 uppercase">Title / Scenario</label>
                <input value={addDraft.title} onChange={e => setAddDraft({ ...addDraft, title: e.target.value })} className="w-full mt-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-300 outline-none" placeholder="e.g. Verify login with valid credentials" />
              </div>
              <div>
                <label className="text-[10px] font-medium text-gray-500 uppercase">Priority</label>
                <select value={addDraft.priority} onChange={e => setAddDraft({ ...addDraft, priority: e.target.value })} className="w-full mt-1 px-3 py-2 text-sm border border-gray-200 rounded-lg">
                  {['P0','P1','P2','P3'].map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] font-medium text-gray-500 uppercase">Type</label>
                <select value={addDraft.type} onChange={e => setAddDraft({ ...addDraft, type: e.target.value })} className="w-full mt-1 px-3 py-2 text-sm border border-gray-200 rounded-lg">
                  {['positive','negative','edge','e2e','smoke','regression','security'].map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-medium text-gray-500 uppercase">Feature</label>
                <input value={addDraft.feature} onChange={e => setAddDraft({ ...addDraft, feature: e.target.value })} className="w-full mt-1 px-3 py-2 text-sm border border-gray-200 rounded-lg" placeholder="e.g. Authentication" />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-medium text-gray-500 uppercase">Test Steps</label>
                {addDraft.steps.map((step, idx) => (
                  <div key={idx} className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] text-gray-400 w-4">{idx + 1}.</span>
                    <input value={step} onChange={e => { const s = [...addDraft.steps]; s[idx] = e.target.value; setAddDraft({ ...addDraft, steps: s }); }}
                      className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg" placeholder={`Step ${idx + 1}`} />
                    {addDraft.steps.length > 1 && (
                      <button onClick={() => setAddDraft({ ...addDraft, steps: addDraft.steps.filter((_: any, i: number) => i !== idx) })} className="text-red-400 hover:text-red-600"><X className="w-3.5 h-3.5" /></button>
                    )}
                  </div>
                ))}
                <button onClick={() => setAddDraft({ ...addDraft, steps: [...addDraft.steps, ''] })} className="text-xs text-blue-600 mt-1 hover:underline">+ Add Step</button>
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-medium text-gray-500 uppercase">Expected Result</label>
                <textarea value={addDraft.expected} onChange={e => setAddDraft({ ...addDraft, expected: e.target.value })} rows={2} className="w-full mt-1 px-3 py-2 text-sm border border-gray-200 rounded-lg" placeholder="Expected outcome" />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-medium text-gray-500 uppercase">Precondition</label>
                <input value={addDraft.precondition} onChange={e => setAddDraft({ ...addDraft, precondition: e.target.value })} className="w-full mt-1 px-3 py-2 text-sm border border-gray-200 rounded-lg" placeholder="e.g. User must be logged in" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowAddForm(false)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
              <button onClick={handleAddTc} disabled={!addDraft.title.trim()} className="px-4 py-2 text-sm text-white bg-[#155dfc] rounded-lg hover:bg-[#124fd6] disabled:opacity-40">Add Test Case</button>
            </div>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex gap-1 bg-white rounded-2xl border border-gray-100 shadow-sm px-2 pt-2">
          {[
            { key: 'cases' as const, label: 'Test Cases', icon: FileText, count: testCases.length },
            { key: 'data' as const, label: 'Test Data', icon: Database },
            { key: 'reports' as const, label: 'Reports & Export', icon: BarChart3 },
          ].map(({ key, label, icon: Icon, count }) => (
            <button
              key={key}
              onClick={() => setDetailTab(key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors border-b-2 ${
                detailTab === key
                  ? 'border-[#155dfc] text-[#155dfc] bg-blue-50'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
              {count !== undefined && (
                <span className={`ml-1 text-xs px-1.5 py-0.5 rounded-full ${detailTab === key ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>{count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Test Data Tab */}
        {detailTab === 'data' && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <TestDataTab runId={selectedRun.id} />
          </div>
        )}

        {/* Reports Tab */}
        {detailTab === 'reports' && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <ReportsTab runId={selectedRun.id} />
          </div>
        )}

        {/* Test Cases Table */}
        {detailTab === 'cases' && (detailLoading ? (
          <div className="bg-white rounded-2xl p-12 text-center text-gray-400 animate-pulse">Loading test cases...</div>
        ) : (
          <div ref={tableRef} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="px-3 py-1.5 w-10">
                    <input type="checkbox" checked={allPageSelected} onChange={toggleSelectAll}
                      className="w-4 h-4 rounded border-gray-300 text-[#155dfc] focus:ring-blue-300 cursor-pointer" />
                  </th>
                  <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap w-24">TC #</th>
                  <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Test Scenario</th>
                  <th className="text-center px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap w-16">Priority</th>
                  <th className="text-center px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap w-24">Type</th>
                  <th className="text-center px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap w-24">Review</th>
                  <th className="text-center px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginatedTcs.map(tc => {
                  const isReviewed = tc.status === 'reviewed' || tc.status === 'approved';
                  const statusCfg = STATUS_CONFIG[tc.status] || STATUS_CONFIG.generated;
                  return (
                    <tr key={tc.id} className={`border-b border-gray-50 hover:bg-gray-50/50 ${isReviewed ? 'bg-emerald-50/30' : ''}`}>
                      <td className="px-3 py-1.5">
                        <input type="checkbox" checked={selectedTcIds.has(tc.id)}
                          onChange={() => {
                            const newSet = new Set(selectedTcIds);
                            if (newSet.has(tc.id)) newSet.delete(tc.id); else newSet.add(tc.id);
                            setSelectedTcIds(newSet);
                          }}
                          className="w-4 h-4 rounded border-gray-300 text-[#155dfc] focus:ring-blue-300 cursor-pointer" />
                      </td>
                      <td className="px-3 py-1.5 text-sm font-mono text-gray-500 whitespace-nowrap">{tc.tc_number}</td>
                      <td className="px-3 py-1.5">
                        <button onClick={() => setExpandedTcId(expandedTcId === tc.id ? null : tc.id)} className="text-left w-full">
                          <span className="text-sm text-gray-700">{tc.title}</span>
                        </button>
                        {expandedTcId === tc.id && !editingTc && (
                          <div className="mt-3 space-y-3 text-xs text-gray-600 border-t border-gray-100 pt-3">
                            {tc.precondition && <div><span className="font-semibold text-gray-500">Precondition:</span> {tc.precondition}</div>}
                            {(tc.steps || []).length > 0 && (
                              <div>
                                <span className="font-semibold text-gray-500">Steps:</span>
                                <ol className="list-decimal list-inside mt-1 space-y-0.5">
                                  {(tc.steps || []).map((s: string, i: number) => <li key={i}>{s}</li>)}
                                </ol>
                              </div>
                            )}
                            {tc.expected && <div><span className="font-semibold text-gray-500">Expected:</span> {tc.expected}</div>}
                          </div>
                        )}
                        {editingTc?.id === tc.id && editDraft && (
                          <div className="mt-3 space-y-2 border-t border-blue-100 pt-3">
                            <input value={editDraft.title} onChange={e => setEditDraft({ ...editDraft, title: e.target.value })} className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg" />
                            <div className="grid grid-cols-3 gap-2">
                              <select value={editDraft.priority} onChange={e => setEditDraft({ ...editDraft, priority: e.target.value })} className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg">
                                {['P0','P1','P2','P3'].map(p => <option key={p} value={p}>{p}</option>)}
                              </select>
                              <select value={editDraft.type} onChange={e => setEditDraft({ ...editDraft, type: e.target.value })} className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg">
                                {['positive','negative','edge','e2e','smoke','regression','security'].map(t => <option key={t} value={t}>{t}</option>)}
                              </select>
                              <select value={editDraft.status} onChange={e => setEditDraft({ ...editDraft, status: e.target.value })} className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg">
                                {['generated','reviewed','scripted','executed','failed'].map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </div>
                            <input value={editDraft.feature} onChange={e => setEditDraft({ ...editDraft, feature: e.target.value })} placeholder="Feature" className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg" />
                            <input value={editDraft.precondition} onChange={e => setEditDraft({ ...editDraft, precondition: e.target.value })} placeholder="Precondition" className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg" />
                            {(editDraft.steps || []).map((step: string, idx: number) => (
                              <div key={idx} className="flex items-center gap-1">
                                <span className="text-[10px] text-gray-400 w-4">{idx+1}.</span>
                                <input value={step} onChange={e => { const s = [...editDraft.steps]; s[idx] = e.target.value; setEditDraft({ ...editDraft, steps: s }); }}
                                  className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded-lg" />
                                {editDraft.steps.length > 1 && (
                                  <button onClick={() => setEditDraft({ ...editDraft, steps: editDraft.steps.filter((_: any, i: number) => i !== idx) })} className="text-red-400"><X className="w-3 h-3" /></button>
                                )}
                              </div>
                            ))}
                            <button onClick={() => setEditDraft({ ...editDraft, steps: [...editDraft.steps, ''] })} className="text-[10px] text-blue-600 hover:underline">+ Add Step</button>
                            <textarea value={editDraft.expected} onChange={e => setEditDraft({ ...editDraft, expected: e.target.value })} rows={2} placeholder="Expected Result" className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg" />
                            <div className="flex justify-end gap-2">
                              <button onClick={() => { setEditingTc(null); setEditDraft(null); }} className="px-3 py-1.5 text-xs text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
                              <button onClick={handleUpdateTc} className="px-3 py-1.5 text-xs text-white bg-[#155dfc] rounded-lg hover:bg-[#124fd6]">Save</button>
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-center"><span className={`px-2 py-0.5 rounded-md text-sm ${PRIORITY_COLORS[tc.priority] || 'bg-gray-100 text-gray-600'}`}>{tc.priority}</span></td>
                      <td className="px-3 py-1.5 text-center"><span className={`px-2 py-0.5 rounded-md text-sm capitalize ${TYPE_COLORS[tc.type] || 'bg-gray-100 text-gray-600'}`}>{tc.type}</span></td>
                      <td className="px-3 py-1.5 text-center">
                        <button onClick={() => handleToggleReview(tc)} className="flex items-center justify-center mx-auto gap-1 group/rev" title={isReviewed ? 'Mark as pending' : 'Mark as reviewed'}>
                          {isReviewed ? (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700 text-sm">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Reviewed
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-100 text-gray-500 text-sm group-hover/rev:bg-emerald-50 group-hover/rev:text-emerald-600 transition">
                              <Circle className="w-3.5 h-3.5" /> Pending
                            </span>
                          )}
                        </button>
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button onClick={() => setExpandedTcId(expandedTcId === tc.id ? null : tc.id)}
                            className="p-1.5 rounded-md hover:bg-blue-50 text-blue-500" title="View details"><Eye className="w-3.5 h-3.5" /></button>
                          <button onClick={() => { setEditingTc(tc); setEditDraft({ title: tc.title, steps: tc.steps || [''], expected: tc.expected, priority: tc.priority, type: tc.type, feature: tc.feature, precondition: tc.precondition, status: tc.status }); setExpandedTcId(tc.id); }}
                            className="p-1.5 rounded-md hover:bg-amber-50 text-amber-600" title="Edit"><Edit3 className="w-3.5 h-3.5" /></button>
                          <button onClick={() => { setConfirmDelete(tc.id); setConfirmDeleteType('case'); }}
                            className="p-1.5 rounded-md hover:bg-red-50 text-red-500" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {testCases.length > 0 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-xs text-gray-500">
                <div className="flex items-center gap-2">
                  <span>Rows</span>
                  <select value={tcPageSize} onChange={e => { setTcPageSize(Number(e.target.value)); setTcPage(1); }} className="border border-gray-200 rounded px-2 py-1 text-xs">
                    {[10, 15, 20, 25].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-4">
                  <span>Showing {(tcPage-1)*tcPageSize+1}–{Math.min(tcPage*tcPageSize, testCases.length)} of {testCases.length}</span>
                  <span className="flex items-center gap-1"><Hash className="w-3 h-3 text-gray-400" /> Total: <strong className="text-gray-700">{testCases.length}</strong></span>
                  <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-3 h-3" /> Reviewed: <strong>{reviewedCount}</strong></span>
                  <span className="flex items-center gap-1 text-amber-600"><Clock className="w-3 h-3" /> Pending: <strong>{testCases.length - reviewedCount}</strong></span>
                </div>
                <div className="flex items-center gap-1">
                  <button disabled={tcPage <= 1} onClick={() => setTcPage(1)} className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronsLeft className="w-3.5 h-3.5" /></button>
                  <button disabled={tcPage <= 1} onClick={() => setTcPage(tcPage - 1)} className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronLeft className="w-3.5 h-3.5" /></button>
                  <span className="px-2 py-1 bg-[#155dfc] text-white rounded text-[10px] font-bold">{tcPage}</span>
                  <button disabled={tcPage >= tcTotalPages} onClick={() => setTcPage(tcPage + 1)} className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronRight className="w-3.5 h-3.5" /></button>
                  <button disabled={tcPage >= tcTotalPages} onClick={() => setTcPage(tcTotalPages)} className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronsRight className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  /* ══════════════════════════════════════════
     LIST VIEW — All test runs
     ══════════════════════════════════════════ */
  return (
    <div className="-m-6 p-4 space-y-3">
      <ConfirmModal />

      {/* Unified toolbar: Generate · Module · Submodule · Search */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => navigate('/chat')}
          className="inline-flex items-center gap-1.5 h-9 px-3.5 bg-[#155dfc] hover:bg-[#124fd6] text-white rounded-md text-sm font-medium transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Generate New
        </button>

        <div className="h-6 w-px bg-gray-200 mx-1" />

        <select
          value={moduleFilter}
          onChange={(e) => { setModuleFilter(e.target.value); setSubmoduleFilter(''); }}
          className="h-9 px-3 pr-8 bg-white border border-gray-200 rounded-md text-sm text-gray-700 outline-none hover:border-gray-300 focus:border-[#155dfc] focus:ring-1 focus:ring-[#155dfc]/20 transition-colors"
        >
          <option value="">All modules</option>
          {facets.modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>

        <select
          value={submoduleFilter}
          onChange={(e) => setSubmoduleFilter(e.target.value)}
          disabled={!moduleFilter}
          className="h-9 px-3 pr-8 bg-white border border-gray-200 rounded-md text-sm text-gray-700 outline-none hover:border-gray-300 focus:border-[#155dfc] focus:ring-1 focus:ring-[#155dfc]/20 disabled:bg-gray-50 disabled:text-gray-400 disabled:hover:border-gray-200 transition-colors"
        >
          <option value="">All submodules</option>
          {facets.submodules
            .filter((s) => !moduleFilter || s.module === moduleFilter)
            .map((s) => <option key={`${s.module}/${s.name}`} value={s.name}>{s.name}</option>)}
        </select>

        {(moduleFilter || submoduleFilter) && (
          <button
            onClick={() => { setModuleFilter(''); setSubmoduleFilter(''); }}
            className="text-xs text-gray-500 hover:text-[#155dfc] px-1.5"
          >
            Clear
          </button>
        )}

        <div className="relative ml-auto w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by Jira ID, story title, user…"
            className="w-full h-9 pl-9 pr-3 bg-white border border-gray-200 rounded-md text-sm text-gray-700 placeholder:text-gray-400 outline-none hover:border-gray-300 focus:border-[#155dfc] focus:ring-1 focus:ring-[#155dfc]/20 transition-colors"
          />
        </div>
      </div>

      {/* Test Runs Table */}
      {loading ? (
        <div className="bg-white rounded-2xl p-12 text-center text-gray-400 animate-pulse">Loading test suites...</div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Jira ID</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Story</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Source</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">User</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Cases</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Review Status</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Created</th>
                <th className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider"></th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => {
                const reviewed = Number(run.approved_count) || 0;
                const total = Number(run.test_case_count) || 0;
                const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;
                return (
                  <tr key={run.id} className="border-b border-gray-50 hover:bg-gray-50/50 cursor-pointer" onClick={() => openRunDetail(run)}>
                    <td className="px-3 py-1.5" onClick={e => e.stopPropagation()}>
                      {run.story_key ? (
                        <button
                          onClick={() => openRunDetail(run)}
                          className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-sm font-mono border border-blue-200 hover:bg-blue-100 hover:underline transition-colors"
                          title="Open test suite"
                        >
                          {run.story_key}
                        </button>
                      ) : (
                        <button
                          onClick={() => openRunDetail(run)}
                          className="text-[#155dfc] hover:underline text-sm"
                          title="Open test suite"
                        >
                          Manual
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-gray-700 truncate max-w-xs">{run.story_title || 'Manual Test Suite'}</td>
                    <td className="px-3 py-1.5">
                      <span className="px-2 py-0.5 rounded-md bg-blue-100 text-blue-700 text-sm border border-blue-200 lowercase">{run.source || 'manual'}</span>
                    </td>
                    <td className="px-3 py-1.5 text-gray-700">{run.username}</td>
                    <td className="px-3 py-1.5 text-gray-700">{total}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm ${pct === 100 ? 'text-emerald-600' : pct > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                          {reviewed}/{total}
                        </span>
                        <div className="w-14 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${pct === 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-gray-200'}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-gray-700 whitespace-nowrap">
                      {new Date(run.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                    </td>
                    <td className="px-3 py-1.5 text-center" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => handleExport(run.id, 'csv')} className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-500 transition-colors" title="Export CSV"><Download className="w-4 h-4" /></button>
                        <button onClick={() => { setConfirmDelete(run.id); setConfirmDeleteType('run'); }} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 transition-colors" title="Delete"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-1.5 border-t border-gray-100 bg-gray-50/50 text-xs">
            <div className="flex items-center gap-1.5 text-gray-600">
              <span>Rows:</span>
              <select
                value={pagination.limit}
                onChange={e => { fetchRuns(1, Number(e.target.value)); }}
                className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-xs outline-none focus:ring-1 focus:ring-[#155dfc]/20 focus:border-[#155dfc]"
              >
                {[5, 10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="ml-2 text-gray-500">
                {Math.min((pagination.page - 1) * pagination.limit + 1, pagination.total)}–{Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
              </span>
              <span className="ml-4 flex items-center gap-3 text-gray-600">
                <span>Total Test Cases: <span className="font-semibold text-[#155dfc]">{totalTcCount}</span></span>
                <span>Reviewed: <span className="font-semibold text-emerald-600">{totalReviewed}</span></span>
                <span>Scripted: <span className="font-semibold text-blue-600">{totalScripted}</span></span>
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                disabled={pagination.page <= 1}
                onClick={() => fetchRuns(pagination.page - 1, pagination.limit)}
                className="px-2 py-0.5 rounded font-medium text-gray-600 hover:bg-white border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Prev
              </button>
              <span className="px-2 text-gray-600">
                Page <span className="font-semibold text-[#155dfc]">{pagination.page}</span> of {pagination.totalPages}
              </span>
              <button
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => fetchRuns(pagination.page + 1, pagination.limit)}
                className="px-2 py-0.5 rounded font-medium text-gray-600 hover:bg-white border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

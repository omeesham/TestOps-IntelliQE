import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Trash2, Edit3, Eye, Download, FileText, X, Check, Code2, Copy,
  AlertTriangle, Save, Tag, Maximize2, Minimize2,
} from 'lucide-react';
import {
  listAutomationScripts, updateAutomationScript,
  deleteAutomationScript, getScriptsByRun,
} from '@/services/api';

/* ── Types ── */
interface Script {
  id: string; tenant_id: string; test_run_id: string; test_case_id: string;
  tc_number: string; test_case_title: string; file_name: string;
  language: string; framework: string; code: string; status: string;
  last_run_at: string | null; last_run_result: string | null;
  version: number; created_by: string; updated_at: string; created_at: string;
  story_key: string | null; story_title: string | null;
}

/* ── Status badges ── */
const STATUS_COLORS: Record<string, string> = {
  generated: 'bg-gray-100 text-gray-600',
  modified:  'bg-amber-100 text-amber-700',
  tested:    'bg-blue-100 text-blue-700',
  passed:    'bg-emerald-100 text-emerald-700',
  failed:    'bg-red-100 text-red-700',
};

/* ── Simple syntax highlighting ── */
function highlightCode(code: string): string {
  return code
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // strings
    .replace(/(["'`])(?:(?=(\\?))\2.)*?\1/g, '<span class="text-emerald-600">$&</span>')
    // keywords
    .replace(/\b(import|export|from|const|let|var|function|async|await|return|if|else|new|class|extends|test|describe|expect|page|beforeEach|afterEach)\b/g, '<span class="text-blue-600 font-semibold">$&</span>')
    // comments
    .replace(/(\/\/.*$)/gm, '<span class="text-gray-400 italic">$&</span>')
    // numbers
    .replace(/\b(\d+)\b/g, '<span class="text-amber-600">$&</span>');
}

export default function AutomationScriptsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const runIdFilter = searchParams.get('runId');

  /* ── State ── */
  const [scripts, setScripts] = useState<Script[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  /* ── Detail/Editor state ── */
  const [selectedScript, setSelectedScript] = useState<Script | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editCode, setEditCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /* ── Fetch ── */
  const fetchScripts = useCallback(async (page = 1, limit = 10) => {
    setLoading(true);
    try {
      if (runIdFilter) {
        const res = await getScriptsByRun(runIdFilter);
        setScripts(res.scripts || []);
        setPagination({ page: 1, limit: 100, total: (res.scripts || []).length, totalPages: 1 });
      } else {
        const res = await listAutomationScripts({ page, limit, search: search || undefined });
        setScripts(res.scripts || []);
        setPagination(res.pagination || { page, limit, total: 0, totalPages: 0 });
      }
    } catch (err) {
      console.error('Failed to load scripts:', err);
    } finally {
      setLoading(false);
    }
  }, [search, runIdFilter]);

  // Runs on mount and whenever the search/run filter changes (no separate
  // mount-only effect — that caused a duplicate initial fetch).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchScripts(1, pagination.limit); }, [search, runIdFilter]);

  /* ── Handlers ── */
  const openScript = (script: Script) => {
    setSelectedScript(script);
    setEditCode(script.code);
    setIsEditing(false);
  };

  const closeScript = () => {
    setSelectedScript(null);
    setIsEditing(false);
    setFullscreen(false);
  };

  const handleSave = async () => {
    if (!selectedScript) return;
    setSaving(true);
    try {
      await updateAutomationScript(selectedScript.id, { code: editCode, status: 'modified' });
      setSelectedScript({ ...selectedScript, code: editCode, version: (selectedScript.version || 1) + 1, status: 'modified' });
      setScripts(prev => prev.map(s => s.id === selectedScript.id ? { ...s, code: editCode, status: 'modified', version: (s.version || 1) + 1 } : s));
      setIsEditing(false);
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteAutomationScript(id);
      setConfirmDelete(null);
      if (selectedScript?.id === id) closeScript();
      setScripts(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(selectedScript?.code || editCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = (script: Script) => {
    const blob = new Blob([script.code], { type: 'text/typescript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = script.file_name; a.click();
    URL.revokeObjectURL(url);
  };

  /* ── Stats ── */
  const totalScripts = scripts.length;
  const modifiedCount = scripts.filter(s => s.status === 'modified').length;
  const groupedByRun = scripts.reduce<Record<string, Script[]>>((acc, s) => {
    const key = s.test_run_id || 'unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});

  /* ── Confirm Delete Modal ── */
  const ConfirmModal = () => {
    if (!confirmDelete) return null;
    return (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setConfirmDelete(null)}>
        <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center"><AlertTriangle className="w-5 h-5 text-red-600" /></div>
            <div>
              <h3 className="font-semibold text-gray-900">Delete Script</h3>
              <p className="text-sm text-gray-500">This will permanently delete this automation script.</p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
            <button onClick={() => handleDelete(confirmDelete)} className="px-4 py-2 text-sm text-white bg-red-600 rounded-lg hover:bg-red-700">Delete</button>
          </div>
        </div>
      </div>
    );
  };

  /* ══════════════════════════════════════════
     SCRIPT DETAIL / EDITOR VIEW
     ══════════════════════════════════════════ */
  if (selectedScript) {
    return (
      <div className={`space-y-4 ${fullscreen ? 'fixed inset-0 z-40 bg-gray-50 p-4 overflow-auto' : ''}`}>
        <ConfirmModal />

        {/* Header */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <button onClick={closeScript} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500">
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div>
                <div className="flex items-center gap-2">
                  <Code2 className="w-5 h-5 text-[#155dfc]" />
                  <h2 className="text-base font-bold text-gray-900 font-mono">{selectedScript.file_name}</h2>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_COLORS[selectedScript.status] || STATUS_COLORS.generated}`}>
                    {selectedScript.status}
                  </span>
                  <span className="text-[10px] text-gray-400">v{selectedScript.version}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
                  {selectedScript.story_key && (
                    <span className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 font-mono font-bold border border-blue-200 text-[10px]">
                      {selectedScript.story_key}
                    </span>
                  )}
                  <span className="flex items-center gap-1"><Tag className="w-3 h-3" />{selectedScript.tc_number}</span>
                  <span>{selectedScript.test_case_title}</span>
                  <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 text-[10px]">Automation Script</span>
                  <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 text-[10px]">TypeScript</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!isEditing ? (
                <>
                  <button onClick={() => { setIsEditing(true); setEditCode(selectedScript.code); }}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#155dfc] text-white rounded-lg hover:bg-[#124fd6]">
                    <Edit3 className="w-3.5 h-3.5" /> Edit Code
                  </button>
                  <button onClick={handleCopy} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50">
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied!' : 'Copy'}
                  </button>
                  <button onClick={() => handleDownload(selectedScript)} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50">
                    <Download className="w-3.5 h-3.5" /> Download
                  </button>
                </>
              ) : (
                <>
                  <button onClick={handleSave} disabled={saving}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40">
                    <Save className="w-3.5 h-3.5" /> {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                  <button onClick={() => { setIsEditing(false); setEditCode(selectedScript.code); }}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50">
                    <X className="w-3.5 h-3.5" /> Cancel
                  </button>
                </>
              )}
              <button onClick={() => setFullscreen(!fullscreen)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
                {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Code Editor / Preview */}
        <div className="bg-[#1E1E2E] rounded-xl border border-gray-700 shadow-lg overflow-hidden">
          {/* File tab bar */}
          <div className="flex items-center bg-[#181825] px-4 py-2 border-b border-gray-700">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#1E1E2E] rounded-t-lg border border-gray-700 border-b-transparent -mb-[1px]">
              <Code2 className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-xs text-gray-300 font-mono">{selectedScript.file_name}</span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-[10px] text-gray-500">{selectedScript.code.split('\n').length} lines</span>
              {isEditing && <span className="text-[10px] text-amber-400 font-medium">EDITING</span>}
            </div>
          </div>

          {/* Code content */}
          {isEditing ? (
            <div className="relative">
              <div className="flex">
                {/* Line numbers */}
                <div className="select-none text-right pr-3 pl-4 py-4 text-[11px] leading-5 text-gray-600 font-mono bg-[#181825] border-r border-gray-700 min-w-[48px]">
                  {editCode.split('\n').map((_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </div>
                {/* Editor textarea */}
                <textarea
                  value={editCode}
                  onChange={e => setEditCode(e.target.value)}
                  spellCheck={false}
                  className="flex-1 bg-transparent text-gray-200 font-mono text-[13px] leading-5 p-4 outline-none resize-none min-h-[500px]"
                  style={{ tabSize: 2 }}
                />
              </div>
            </div>
          ) : (
            <div className="flex overflow-auto max-h-[600px]">
              {/* Line numbers */}
              <div className="select-none text-right pr-3 pl-4 py-4 text-[11px] leading-5 text-gray-600 font-mono bg-[#181825] border-r border-gray-700 min-w-[48px] sticky left-0">
                {selectedScript.code.split('\n').map((_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              {/* Highlighted code */}
              <pre className="flex-1 p-4 text-[13px] leading-5 font-mono text-gray-200 overflow-x-auto">
                <code dangerouslySetInnerHTML={{ __html: highlightCode(selectedScript.code) }} />
              </pre>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ══════════════════════════════════════════
     LIST VIEW — All automation scripts
     ══════════════════════════════════════════ */
  return (
    <div className="space-y-4">
      <ConfirmModal />

      {/* Search + Navigate */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by file name, test case, story..."
            className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-300 outline-none bg-white" />
        </div>
        <div className="flex items-center gap-2">
          {runIdFilter && (
            <button onClick={() => navigate('/automation-scripts')} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50">
              <X className="w-3.5 h-3.5" /> Clear Filter
            </button>
          )}
          <button onClick={() => navigate('/generated-tests')} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50">
            <FileText className="w-3.5 h-3.5" /> View Test Cases
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center"><Code2 className="w-5 h-5 text-[#155dfc]" /></div>
          <div><div className="text-2xl font-bold text-gray-900">{totalScripts}</div><div className="text-[10px] font-medium text-gray-500 uppercase">Total Scripts</div></div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center"><FileText className="w-5 h-5 text-blue-600" /></div>
          <div><div className="text-2xl font-bold text-blue-600">{Object.keys(groupedByRun).length}</div><div className="text-[10px] font-medium text-gray-500 uppercase">Test Suites</div></div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center"><Edit3 className="w-5 h-5 text-amber-600" /></div>
          <div><div className="text-2xl font-bold text-amber-600">{modifiedCount}</div><div className="text-[10px] font-medium text-gray-500 uppercase">Modified</div></div>
        </div>
      </div>

      {/* Filter info */}
      {runIdFilter && scripts.length > 0 && scripts[0].story_key && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-center gap-2">
          <Tag className="w-4 h-4 text-blue-600" />
          <span className="text-sm text-blue-700">
            Showing scripts for <span className="font-bold font-mono">{scripts[0].story_key}</span> — {scripts[0].story_title}
          </span>
        </div>
      )}

      {/* Scripts Table */}
      {loading ? (
        <div className="bg-white rounded-xl p-12 text-center text-gray-400 animate-pulse">Loading automation scripts...</div>
      ) : scripts.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
          <Code2 className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <h3 className="text-lg font-semibold text-gray-700">No Automation Scripts</h3>
          <p className="text-sm text-gray-400 mt-1 mb-4">Generate scripts from reviewed test cases in the Generated Test Cases page.</p>
          <button onClick={() => navigate('/generated-tests')} className="px-4 py-2 text-sm bg-[#155dfc] text-white rounded-lg hover:bg-[#124fd6]">
            Go to Test Cases
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-500 uppercase w-16">TC #</th>
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-500 uppercase">File Name</th>
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-500 uppercase">Test Case</th>
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-500 uppercase w-20">Jira ID</th>
                <th className="text-center px-4 py-3 text-[10px] font-semibold text-gray-500 uppercase w-20">Status</th>
                <th className="text-center px-4 py-3 text-[10px] font-semibold text-gray-500 uppercase w-14">Ver</th>
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-500 uppercase w-24">Created</th>
                <th className="text-center px-4 py-3 text-[10px] font-semibold text-gray-500 uppercase w-28">Actions</th>
              </tr>
            </thead>
            <tbody>
              {scripts.map(script => (
                <tr key={script.id} className="border-b border-gray-50 hover:bg-gray-50/50 cursor-pointer" onClick={() => openScript(script)}>
                  <td className="px-4 py-3 text-xs font-mono text-gray-400">{script.tc_number}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Code2 className="w-4 h-4 text-blue-400 flex-shrink-0" />
                      <span className="text-sm font-mono text-gray-900">{script.file_name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 max-w-[200px] truncate">{script.test_case_title}</td>
                  <td className="px-4 py-3">
                    {script.story_key ? (
                      <span className="px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700 text-[10px] font-bold font-mono border border-blue-200">{script.story_key}</span>
                    ) : <span className="text-xs text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_COLORS[script.status] || STATUS_COLORS.generated}`}>
                      {script.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center text-xs text-gray-500">v{script.version}</td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-gray-600">{new Date(script.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                  </td>
                  <td className="px-4 py-3 text-center" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => openScript(script)} className="p-1.5 rounded-md hover:bg-blue-50 text-blue-500" title="View/Edit"><Eye className="w-3.5 h-3.5" /></button>
                      <button onClick={() => handleDownload(script)} className="p-1.5 rounded-md hover:bg-green-50 text-green-600" title="Download"><Download className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setConfirmDelete(script.id)} className="p-1.5 rounded-md hover:bg-red-50 text-red-500" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination (only for non-runId filtered view) */}
          {!runIdFilter && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-xs text-gray-500">
              <div className="flex items-center gap-2">
                <span>Rows</span>
                <select value={pagination.limit} onChange={e => fetchScripts(1, Number(e.target.value))} className="border border-gray-200 rounded px-2 py-1 text-xs">
                  {[10, 15, 20, 25].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <span>Showing {Math.min((pagination.page-1)*pagination.limit+1, pagination.total)}–{Math.min(pagination.page*pagination.limit, pagination.total)} of {pagination.total}</span>
              <div className="flex items-center gap-1">
                <button disabled={pagination.page <= 1} onClick={() => fetchScripts(1, pagination.limit)} className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronsLeft className="w-3.5 h-3.5" /></button>
                <button disabled={pagination.page <= 1} onClick={() => fetchScripts(pagination.page - 1, pagination.limit)} className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronLeft className="w-3.5 h-3.5" /></button>
                <span className="px-2 py-1 bg-[#155dfc] text-white rounded text-[10px] font-bold">{pagination.page}</span>
                <button disabled={pagination.page >= pagination.totalPages} onClick={() => fetchScripts(pagination.page + 1, pagination.limit)} className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronRight className="w-3.5 h-3.5" /></button>
                <button disabled={pagination.page >= pagination.totalPages} onClick={() => fetchScripts(pagination.totalPages, pagination.limit)} className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"><ChevronsRight className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

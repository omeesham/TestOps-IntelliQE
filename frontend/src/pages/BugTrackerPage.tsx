import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Bug, Plus, Search, X, Trash2, Edit3, Undo2, RotateCcw, AlertTriangle,
  CheckCircle2, Clock, XCircle, CircleDot, Loader2, RefreshCw, Eye,
  Activity, User, CalendarDays, Layers, Monitor, Tag, ExternalLink, Upload,
  Zap, Play,
} from 'lucide-react';
import {
  listBugs, getBug, createBug, updateBug, revokeBug, deleteBug,
  subscribeToBugEvents, getBugAdoStatus, pushBugsToAdo, getBugJiraStatus, pushBugsToJira,
  rerunBugs,
} from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';
import ActionIcon from '@/components/ui/ActionIcon';

interface BugRow {
  id: string;
  bug_number: number;
  title: string;
  description?: string | null;
  severity: string;
  priority: string;
  status: string;
  environment?: string | null;
  module?: string | null;
  steps_to_reproduce?: string | null;
  expected_result?: string | null;
  actual_result?: string | null;
  tags?: string[];
  bug_type?: string | null;
  test_run_id?: string | null;
  test_case_id?: string | null;
  reported_by?: string | null;
  assigned_to?: string | null;
  resolution_notes?: string | null;
  revoke_reason?: string | null;
  ado_work_item_id?: number | null;
  ado_url?: string | null;
  ado_pushed_at?: string | null;
  jira_issue_key?: string | null;
  jira_url?: string | null;
  jira_pushed_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface BugActivityRow {
  id: string;
  action: string;
  details?: { changes?: Record<string, { from: any; to: any }>; reason?: string } | null;
  performed_by?: string | null;
  created_at: string;
}

interface Pagination { page: number; limit: number; total: number; totalPages: number; }

interface BugForm {
  title: string; description: string; severity: string; priority: string; status: string;
  environment: string; module: string; steps_to_reproduce: string; expected_result: string;
  actual_result: string; assigned_to: string; test_case_id: string; resolution_notes: string;
  tags: string;
}

const EMPTY_FORM: BugForm = {
  title: '', description: '', severity: 'medium', priority: 'P2', status: 'open',
  environment: '', module: '', steps_to_reproduce: '', expected_result: '',
  actual_result: '', assigned_to: '', test_case_id: '', resolution_notes: '', tags: '',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 border border-red-200',
  high: 'bg-orange-100 text-orange-700 border border-orange-200',
  medium: 'bg-yellow-100 text-yellow-700 border border-yellow-200',
  low: 'bg-green-100 text-green-700 border border-green-200',
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: 'bg-red-100 text-red-700 border border-red-200',
  P1: 'bg-orange-100 text-orange-700 border border-orange-200',
  P2: 'bg-yellow-100 text-yellow-700 border border-yellow-200',
  P3: 'bg-green-100 text-green-700 border border-green-200',
};

const STATUS_CONFIG: Record<string, { bg: string; dot: string; icon: any; label: string }> = {
  open:        { bg: 'bg-blue-100 text-blue-700',       dot: 'text-blue-600',    icon: CircleDot,    label: 'Open' },
  in_progress: { bg: 'bg-amber-100 text-amber-700',     dot: 'text-amber-600',   icon: Clock,        label: 'In Progress' },
  resolved:    { bg: 'bg-emerald-100 text-emerald-700', dot: 'text-emerald-600', icon: CheckCircle2, label: 'Resolved' },
  closed:      { bg: 'bg-gray-100 text-gray-600',       dot: 'text-gray-500',    icon: XCircle,      label: 'Closed' },
  revoked:     { bg: 'bg-rose-100 text-rose-600',       dot: 'text-rose-500',    icon: Undo2,        label: 'Revoked' },
};

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

// Bug origin/classification. 'failure' = failed and stayed failing; 'flaky' =
// failed then passed after auto-heal; 'manual' = filed by a person.
const BUG_TYPE_CONFIG: Record<string, { label: string; cls: string; icon: any }> = {
  failure: { label: 'Failure', cls: 'bg-red-50 text-red-700 border border-red-200',       icon: XCircle },
  flaky:   { label: 'Flaky',   cls: 'bg-amber-50 text-amber-700 border border-amber-200', icon: Zap },
  manual:  { label: 'Manual',  cls: 'bg-gray-100 text-gray-600 border border-gray-200',   icon: User },
};

const FIELD_LABELS: Record<string, string> = {
  title: 'Title', description: 'Description', severity: 'Severity', priority: 'Priority',
  status: 'Status', environment: 'Environment', module: 'Module',
  steps_to_reproduce: 'Steps to Reproduce', expected_result: 'Expected Result',
  actual_result: 'Actual Result', tags: 'Tags', test_run_id: 'Test Run',
  test_case_id: 'Test Case', assigned_to: 'Assignee', resolution_notes: 'Resolution Notes',
};

const inputCls = 'w-full px-4 py-3 bg-[#F5F3FF] border border-[#DDD6FE] rounded-xl text-[#1E1B4B] placeholder:text-gray-400 text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/30 focus:border-[#7C3AED] transition-all';
const labelCls = 'block text-xs font-semibold text-gray-600 mb-1.5';

const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const fmtDateTime = (d?: string | null) =>
  d ? new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

/** Azure DevOps brand mark (inline SVG — external icon CDNs are blocked in some deployments). */
function AdoLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z" />
    </svg>
  );
}

/** JIRA brand mark (inline SVG). */
function JiraLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0z" />
    </svg>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.open;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-sm whitespace-nowrap ${cfg.bg}`}>
      <Icon className="w-3.5 h-3.5" /> {cfg.label}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-md text-sm capitalize ${SEVERITY_COLORS[severity] || 'bg-gray-100 text-gray-600'}`}>
      {severity}
    </span>
  );
}

function TypeBadge({ type }: { type?: string | null }) {
  const cfg = BUG_TYPE_CONFIG[type || 'manual'] || BUG_TYPE_CONFIG.manual;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap ${cfg.cls}`}>
      <Icon className="w-3 h-3" /> {cfg.label}
    </span>
  );
}

function activityLabel(entry: BugActivityRow): string {
  switch (entry.action) {
    case 'created': return 'reported this bug';
    case 'status_changed': return 'changed the status';
    case 'updated': return 'updated bug details';
    case 'revoked': return 'revoked this bug';
    case 'ado_raised': return 'raised this bug in Azure DevOps';
    case 'ado_removed': return 'deleted the Azure DevOps work item';
    case 'jira_raised': return 'raised this bug in JIRA';
    case 'jira_removed': return 'deleted the JIRA issue';
    case 'auto_created': return 'auto-registered this from a test run';
    case 'auto_updated': return 'refreshed this from a later test run';
    case 'rerun_passed': return 'passed on re-run — resolved';
    case 'rerun_failed': return 're-ran the test — still failing';
    default: return entry.action;
  }
}

function formatChangeValue(value: any): string {
  if (value === null || value === undefined || value === '') return 'empty';
  if (Array.isArray(value)) return value.join(', ') || 'empty';
  const s = String(value);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

export default function BugTrackerPage() {
  const toast = useToast();

  const [bugs, setBugs] = useState<BugRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 10, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [, setLive] = useState(false); // connection status feeds the SSE subscription; no longer shown in the UI

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  // Which re-run is in flight ('flaky' | 'failure' | ''), so only that button spins.
  const [rerunning, setRerunning] = useState('');

  const [detail, setDetail] = useState<{ bug: BugRow; activity: BugActivityRow[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; bug: BugRow; initial: BugForm } | null>(null);
  const [form, setForm] = useState<BugForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<BugRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // External trackers: connection status + row selection for bulk raise.
  // Selecting bugs enables BOTH destinations — the user picks which button
  // (Azure DevOps or JIRA) to send them to.
  const [adoStatus, setAdoStatus] = useState<{ connected: boolean; project?: string; orgUrl?: string } | null>(null);
  const [jiraStatus, setJiraStatus] = useState<{ connected: boolean; projectKey?: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pushingAdo, setPushingAdo] = useState(false);
  const [pushingJira, setPushingJira] = useState(false);
  // The "Raise Bug" destination picker popup (Azure DevOps vs JIRA).
  const [raiseOpen, setRaiseOpen] = useState(false);

  // Bugs on the current page that can still be raised in at least one tracker.
  const selectableBugs = bugs.filter((b) => !b.ado_work_item_id || !b.jira_issue_key);
  const allSelectableChecked = selectableBugs.length > 0 && selectableBugs.every((b) => selectedIds.has(b.id));
  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  const toggleSelectAll = () =>
    setSelectedIds((prev) => {
      if (allSelectableChecked) return new Set();
      const n = new Set(prev); selectableBugs.forEach((b) => n.add(b.id)); return n;
    });

  const detailIdRef = useRef<string | null>(null);
  detailIdRef.current = detail?.bug.id || null;
  // Monotonic sequence so an out-of-order response can't overwrite a newer one
  const fetchSeqRef = useRef(0);
  // The seq that owns the loading spinner — a superseding SILENT fetch must not
  // stop the superseded non-silent fetch from clearing it (stuck spinner).
  const loadingSeqRef = useRef(0);

  const fetchBugs = useCallback(async (
    page: number,
    limit: number,
    opts?: { silent?: boolean },
  ) => {
    const seq = ++fetchSeqRef.current;
    if (!opts?.silent) {
      loadingSeqRef.current = seq;
      setLoading(true);
    }
    try {
      const data = await listBugs({
        page, limit,
        search: debouncedSearch || undefined,
        status: statusFilter || undefined,
        severity: severityFilter || undefined,
        priority: priorityFilter || undefined,
        type: typeFilter || undefined,
      });
      if (seq !== fetchSeqRef.current) return; // superseded by a newer fetch
      // Requested page emptied out (e.g. after deletes) — snap back to page 1
      if (data.bugs.length === 0 && page > 1) {
        return fetchBugs(1, limit, opts);
      }
      setBugs(data.bugs);
      setPagination(data.pagination);
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      console.error('Load bugs error:', err);
      toast.fromError(err);
    } finally {
      // Clear the spinner when the fetch that turned it on completes, even if a
      // newer SILENT fetch superseded it; only a newer non-silent fetch (which
      // owns the spinner now) may keep it spinning.
      if (!opts?.silent && seq === loadingSeqRef.current) setLoading(false);
    }
  }, [debouncedSearch, statusFilter, severityFilter, priorityFilter, typeFilter, toast]);

  const fetchBugsRef = useRef(fetchBugs);
  fetchBugsRef.current = fetchBugs;
  const paginationRef = useRef(pagination);
  paginationRef.current = pagination;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    fetchBugs(1, paginationRef.current.limit);
  }, [fetchBugs]);

  // Resolve the Azure DevOps connection once so the "Raise in Azure DevOps"
  // action knows whether it's available (and which project bugs land in).
  useEffect(() => {
    getBugAdoStatus().then(setAdoStatus).catch(() => setAdoStatus({ connected: false }));
    getBugJiraStatus().then(setJiraStatus).catch(() => setJiraStatus({ connected: false }));
  }, []);

  const handleRaiseInAdo = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!adoStatus?.connected) {
      toast.error('Azure DevOps not connected', 'Connect it in System Configuration → Requirement Sources first.');
      return;
    }
    setPushingAdo(true);
    try {
      const res = await pushBugsToAdo(ids);
      const failed = res.results.filter((r) => !r.ok);
      if (res.raised > 0) {
        toast.success(
          `Raised ${res.raised} bug${res.raised > 1 ? 's' : ''} in Azure DevOps${res.project ? ` (${res.project})` : ''}`,
          'Find them under Boards → Backlogs.',
        );
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} bug${failed.length > 1 ? 's' : ''} could not be raised`, failed[0]?.error || 'Check the bug details and try again.');
      } else if (res.raised === 0) {
        toast.info('Nothing to raise', 'The selected bugs are already in Azure DevOps.');
      }
      setSelectedIds(new Set());
      fetchBugsRef.current(paginationRef.current.page, paginationRef.current.limit, { silent: true });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setPushingAdo(false);
    }
  };

  const handleRaiseInJira = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!jiraStatus?.connected) {
      toast.error('JIRA not connected', 'Connect it in System Configuration → Requirement Sources first.');
      return;
    }
    setPushingJira(true);
    try {
      const res = await pushBugsToJira(ids);
      const failed = res.results.filter((r) => !r.ok);
      if (res.raised > 0) {
        toast.success(
          `Raised ${res.raised} bug${res.raised > 1 ? 's' : ''} in JIRA${res.projectKey ? ` (${res.projectKey})` : ''}`,
          'Find them on your JIRA board / backlog.',
        );
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} bug${failed.length > 1 ? 's' : ''} could not be raised`, failed[0]?.error || 'Check the bug details and try again.');
      } else if (res.raised === 0) {
        toast.info('Nothing to raise', 'The selected bugs are already in JIRA.');
      }
      setSelectedIds(new Set());
      fetchBugsRef.current(paginationRef.current.page, paginationRef.current.limit, { silent: true });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setPushingJira(false);
    }
  };

  // Live updates: refetch the current page whenever another session mutates bugs
  useEffect(() => {
    const unsubscribe = subscribeToBugEvents((event) => {
      if (!event || event.type === 'connected') return;
      fetchBugsRef.current(paginationRef.current.page, paginationRef.current.limit, { silent: true });
      if (event.type === 'bug_deleted' && event.bugId) {
        // The bug is gone — drop any selection or confirm dialog still
        // pointing at it (they'd hold a stale snapshot otherwise).
        const deletedId = event.bugId;
        setSelectedIds((prev) => {
          if (!prev.has(deletedId)) return prev;
          const n = new Set(prev); n.delete(deletedId); return n;
        });
        setConfirmDelete((prev) => (prev && prev.id === deletedId ? null : prev));
      }
      const openId = detailIdRef.current;
      if (!openId || event.bugId !== openId) return;
      if (event.type === 'bug_deleted') {
        setDetail(null);
        setRevokeOpen(false);
      } else {
        getBug(openId)
          .then((d) => setDetail((prev) => (prev && prev.bug.id === openId ? d : prev)))
          .catch(() => {});
      }
    }, setLive);
    return unsubscribe;
  }, []);

  const openDetail = async (bugId: string) => {
    setDetailLoading(true);
    setRevokeOpen(false);
    setRevokeReason('');
    try {
      setDetail(await getBug(bugId));
    } catch (err) {
      console.error('Load bug detail error:', err);
      toast.fromError(err);
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshAll = (opts?: { silent?: boolean }) => {
    fetchBugs(pagination.page, pagination.limit, opts);
  };

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError('');
    setEditor({ mode: 'create' });
  };

  const openEdit = (bug: BugRow) => {
    const snapshot: BugForm = {
      title: bug.title || '',
      description: bug.description || '',
      severity: bug.severity || 'medium',
      priority: bug.priority || 'P2',
      status: bug.status || 'open',
      environment: bug.environment || '',
      module: bug.module || '',
      steps_to_reproduce: bug.steps_to_reproduce || '',
      expected_result: bug.expected_result || '',
      actual_result: bug.actual_result || '',
      assigned_to: bug.assigned_to || '',
      test_case_id: bug.test_case_id || '',
      resolution_notes: bug.resolution_notes || '',
      tags: (bug.tags || []).join(', '),
    };
    setForm(snapshot);
    setFormError('');
    setEditor({ mode: 'edit', bug, initial: snapshot });
  };

  const handleSave = async () => {
    if (!editor) return;
    const title = form.title.trim();
    if (!title) { setFormError('Title is required'); return; }
    setSaving(true);
    setFormError('');
    try {
      if (editor.mode === 'create') {
        await createBug({
          title,
          description: form.description,
          severity: form.severity,
          priority: form.priority,
          environment: form.environment,
          module: form.module,
          steps_to_reproduce: form.steps_to_reproduce,
          expected_result: form.expected_result,
          actual_result: form.actual_result,
          assigned_to: form.assigned_to,
          test_case_id: form.test_case_id,
          tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        });
        toast.success('Bug reported successfully');
      } else {
        // Send only fields the user actually changed so a stale editor can't
        // clobber concurrent edits; expected_updated_at makes the server
        // reject with 409 if the bug moved underneath us.
        const payload: Record<string, any> = {};
        for (const key of Object.keys(form) as (keyof BugForm)[]) {
          if (form[key] === editor.initial[key]) continue;
          if (key === 'tags') {
            payload.tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
          } else if (key === 'title') {
            payload.title = title;
          } else {
            payload[key] = form[key];
          }
        }
        if (Object.keys(payload).length === 0) {
          setEditor(null);
          return;
        }
        payload.expected_updated_at = editor.bug.updated_at;
        await updateBug(editor.bug.id, payload);
        toast.success('Saved successfully');
        if (detailIdRef.current === editor.bug.id) openDetail(editor.bug.id);
      }
      setEditor(null);
      refreshAll({ silent: true });
    } catch (err: any) {
      console.error('Save bug error:', err);
      setFormError(err?.response?.data?.error || 'Failed to save bug');
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async () => {
    if (!detail) return;
    setActionBusy(true);
    try {
      await revokeBug(detail.bug.id, revokeReason.trim());
      toast.success('Bug revoked');
      setRevokeOpen(false);
      setRevokeReason('');
      openDetail(detail.bug.id);
      refreshAll({ silent: true });
    } catch (err) {
      console.error('Revoke bug error:', err);
      toast.fromError(err);
    } finally {
      setActionBusy(false);
    }
  };

  const handleReopen = async () => {
    if (!detail) return;
    setActionBusy(true);
    try {
      await updateBug(detail.bug.id, { status: 'open' });
      toast.success('Bug reopened');
      openDetail(detail.bug.id);
      refreshAll({ silent: true });
    } catch (err) {
      console.error('Reopen bug error:', err);
      toast.fromError(err);
    } finally {
      setActionBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      const res = await deleteBug(confirmDelete.id) as {
        adoDeleted?: boolean; adoError?: string; adoId?: number;
        jiraDeleted?: boolean; jiraError?: string; jiraKey?: string;
      };
      const removed: string[] = [];
      if (confirmDelete.ado_work_item_id && res?.adoDeleted) removed.push(`Azure DevOps work item #${res.adoId ?? confirmDelete.ado_work_item_id}`);
      if (confirmDelete.jira_issue_key && res?.jiraDeleted) removed.push(`JIRA issue ${res.jiraKey ?? confirmDelete.jira_issue_key}`);
      if (confirmDelete.ado_work_item_id && res?.adoError) {
        toast.warning('Bug deleted — Azure DevOps not removed', res.adoError);
      } else if (confirmDelete.jira_issue_key && res?.jiraError) {
        toast.warning('Bug deleted — JIRA issue not removed', res.jiraError);
      } else if (removed.length > 0) {
        toast.success('Deleted', `Removed the bug and its ${removed.join(' and ')}.`);
      } else {
        toast.success('Deleted successfully');
      }
      if (detailIdRef.current === confirmDelete.id) setDetail(null);
      setConfirmDelete(null);
      // Deleted bugs must not linger in the raise-in-ADO selection
      setSelectedIds((prev) => {
        if (!prev.has(confirmDelete.id)) return prev;
        const n = new Set(prev); n.delete(confirmDelete.id); return n;
      });
      // If we removed the last row on this page, step back a page
      if (bugs.length === 1 && pagination.page > 1) {
        fetchBugs(pagination.page - 1, pagination.limit);
      } else {
        fetchBugs(pagination.page, pagination.limit, { silent: true });
      }
    } catch (err) {
      console.error('Delete bug error:', err);
      toast.fromError(err);
    } finally {
      setDeleting(false);
    }
  };

  const clearFilters = () => {
    setSearch('');
    setStatusFilter('');
    setSeverityFilter('');
    setPriorityFilter('');
    setTypeFilter('');
  };

  const hasFilters = Boolean(search || statusFilter || severityFilter || priorityFilter || typeFilter);

  // Re-run all flaky (or failure) bugs' tests server-side, then refresh the list.
  const handleRerun = async (bugType: 'flaky' | 'failure') => {
    if (rerunning) return;
    setRerunning(bugType);
    try {
      const res = await rerunBugs({ bugType });
      if (res.ran === 0) {
        toast.info('Nothing to re-run', res.message || `No re-runnable ${bugType} tests are linked to a saved run.`);
      } else {
        toast.success(
          `Re-ran ${res.ran} ${bugType} test${res.ran > 1 ? 's' : ''}`,
          `${res.passed} passed (${res.resolved} resolved), ${res.failed} still failing.`,
        );
      }
      const runErrors = res.byRun.filter((r) => r.error);
      if (runErrors.length > 0) {
        toast.error('Some runs could not execute', runErrors[0].error || 'See server logs for details.');
      }
      refreshAll();
    } catch (err) {
      toast.fromError(err);
    } finally {
      setRerunning('');
    }
  };
  const detailBug = detail?.bug;
  const canRevoke = detailBug && detailBug.status !== 'revoked';
  const canReopen = detailBug && ['resolved', 'closed', 'revoked'].includes(detailBug.status);

  return (
    <div className="-m-6 p-4 space-y-3">
      {/* Action bar — the layout header already names the page, so no title here */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Refresh — kept on the left, away from the primary actions */}
        <button
          onClick={() => refreshAll()}
          title="Refresh"
          aria-label="Refresh"
          className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-gray-200 bg-white text-gray-500 hover:text-[#7C3AED] hover:border-[#DDD6FE] hover:bg-[#F5F3FF] shadow-sm transition-colors shrink-0"
        >
          <RefreshCw className="w-4 h-4" />
        </button>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Re-run all failing / flaky tests. The trigger buttons are hidden
              for now, but handleRerun('failure' | 'flaky') stays wired up so the
              functionality can be re-exposed without rebuilding it. */}

          {/* One generic raise button — the destination (Azure DevOps / JIRA)
              is picked in a popup so new trackers can be added without
              crowding the header. */}
          <button
            onClick={() => setRaiseOpen(true)}
            disabled={selectedIds.size === 0 || pushingAdo || pushingJira}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium whitespace-nowrap shrink-0 shadow-sm transition-colors"
            title={selectedIds.size === 0 ? 'Select bugs with the checkboxes first' : 'Raise the selected bugs in Azure DevOps or JIRA'}
          >
            {(pushingAdo || pushingJira) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Raise Bug{selectedIds.size > 1 ? 's' : ''}
          </button>

          <button
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 bg-[#7C3AED] hover:bg-[#6D28D9] text-white rounded-lg text-sm font-medium whitespace-nowrap shrink-0 shadow-sm shadow-purple-500/25 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Report Bug
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-3 py-2 flex flex-wrap items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 px-3 pr-8 bg-white border border-gray-200 rounded-md text-sm text-gray-700 outline-none hover:border-gray-300 focus:border-[#7C3AED] focus:ring-1 focus:ring-[#7C3AED]/20 transition-colors"
        >
          <option value="">All Statuses</option>
          {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
            <option key={key} value={key}>{cfg.label}</option>
          ))}
        </select>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          className="h-9 px-3 pr-8 bg-white border border-gray-200 rounded-md text-sm text-gray-700 outline-none hover:border-gray-300 focus:border-[#7C3AED] focus:ring-1 focus:ring-[#7C3AED]/20 transition-colors"
        >
          <option value="">All Severities</option>
          {SEVERITIES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          className="h-9 px-3 pr-8 bg-white border border-gray-200 rounded-md text-sm text-gray-700 outline-none hover:border-gray-300 focus:border-[#7C3AED] focus:ring-1 focus:ring-[#7C3AED]/20 transition-colors"
        >
          <option value="">All Priorities</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="h-9 px-3 pr-8 bg-white border border-gray-200 rounded-md text-sm text-gray-700 outline-none hover:border-gray-300 focus:border-[#7C3AED] focus:ring-1 focus:ring-[#7C3AED]/20 transition-colors"
          title="Filter by bug origin"
        >
          <option value="">All Types</option>
          {Object.entries(BUG_TYPE_CONFIG).map(([key, cfg]) => (
            <option key={key} value={key}>{cfg.label}</option>
          ))}
        </select>
        {hasFilters && (
          <button onClick={clearFilters} className="text-sm text-gray-500 hover:text-[#7C3AED] px-2 transition-colors">
            Clear
          </button>
        )}
        <div className="relative ml-auto w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, module, assignee..."
            className="w-full h-9 pl-9 pr-3 bg-white border border-gray-200 rounded-md text-sm text-gray-700 placeholder:text-gray-400 outline-none hover:border-gray-300 focus:border-[#7C3AED] focus:ring-1 focus:ring-[#7C3AED]/20 transition-colors"
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="bg-white rounded-2xl p-12 text-center text-gray-400 animate-pulse">Loading bugs...</div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="px-3 py-1.5 w-10">
                  <input
                    type="checkbox"
                    checked={allSelectableChecked}
                    onChange={toggleSelectAll}
                    disabled={selectableBugs.length === 0}
                    className="w-4 h-4 rounded border-gray-300 text-sky-600 focus:ring-sky-500 cursor-pointer disabled:opacity-40"
                    title="Select all raisable bugs on this page"
                  />
                </th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Bug ID</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Title</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Severity</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Priority</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Status</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Type</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Module</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Updated</th>
                <th className="text-right px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bugs.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-12 text-center text-gray-400">
                    <Bug className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                    {hasFilters ? 'No bugs match the current filters.' : 'No bugs reported yet. Click "Report Bug" to log your first one.'}
                  </td>
                </tr>
              ) : bugs.map((bug) => (
                <tr
                  key={bug.id}
                  className={`border-b border-gray-50 hover:bg-gray-50/50 cursor-pointer ${selectedIds.has(bug.id) ? 'bg-sky-50/40' : ''}`}
                  onClick={() => openDetail(bug.id)}
                >
                  <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                    {bug.ado_work_item_id && bug.jira_issue_key ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" aria-label="Already in Azure DevOps and JIRA" />
                    ) : (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(bug.id)}
                        onChange={() => toggleSelect(bug.id)}
                        className="w-4 h-4 rounded border-gray-300 text-sky-600 focus:ring-sky-500 cursor-pointer"
                        title="Select, then choose Raise in Azure DevOps or Raise in JIRA"
                      />
                    )}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-sm font-mono border border-blue-200">
                      BUG-{bug.bug_number}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-gray-700 font-medium truncate max-w-xs" title={bug.title}>{bug.title}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap"><SeverityBadge severity={bug.severity} /></td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className={`px-2 py-0.5 rounded-md text-sm ${PRIORITY_COLORS[bug.priority] || 'bg-gray-100 text-gray-600'}`}>
                      {bug.priority}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap"><StatusBadge status={bug.status} /></td>
                  <td className="px-3 py-1.5 whitespace-nowrap"><TypeBadge type={bug.bug_type} /></td>
                  <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{bug.module || '—'}</td>
                  <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{fmtDate(bug.updated_at)}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <div className="inline-flex items-center gap-1.5">
                      <ActionIcon tone="view" title="View details" onClick={() => openDetail(bug.id)}><Eye className="w-4 h-4" /></ActionIcon>
                      <ActionIcon tone="edit" title="Edit" onClick={() => openEdit(bug)}><Edit3 className="w-4 h-4" /></ActionIcon>
                      <ActionIcon tone="delete" title="Delete" onClick={() => setConfirmDelete(bug)}><Trash2 className="w-4 h-4" /></ActionIcon>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-1.5 border-t border-gray-100 bg-gray-50/50 text-xs">
            <div className="flex items-center gap-1.5 text-gray-600">
              <span>Rows:</span>
              <select
                value={pagination.limit}
                onChange={(e) => fetchBugs(1, Number(e.target.value))}
                className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-xs outline-none focus:ring-1 focus:ring-[#7C3AED]/20 focus:border-[#7C3AED]"
              >
                {[5, 10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="ml-2 text-gray-500">
                {Math.min((pagination.page - 1) * pagination.limit + 1, pagination.total)}–{Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                disabled={pagination.page <= 1}
                onClick={() => fetchBugs(pagination.page - 1, pagination.limit)}
                className="px-2 py-0.5 rounded font-medium text-gray-600 hover:bg-white border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Prev
              </button>
              <span className="px-2 text-gray-600">
                Page <span className="font-semibold text-[#7C3AED]">{pagination.page}</span> of {Math.max(1, pagination.totalPages)}
              </span>
              <button
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => fetchBugs(pagination.page + 1, pagination.limit)}
                className="px-2 py-0.5 rounded font-medium text-gray-600 hover:bg-white border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail modal */}
      {(detail || detailLoading) && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => { setDetail(null); setRevokeOpen(false); }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {detailLoading || !detailBug ? (
              <div className="flex items-center justify-center py-16 text-gray-400">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading bug details...
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between p-5 border-b border-gray-100">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-sm font-mono border border-blue-200">
                        BUG-{detailBug.bug_number}
                      </span>
                      <StatusBadge status={detailBug.status} />
                      <SeverityBadge severity={detailBug.severity} />
                      <span className={`px-2 py-0.5 rounded-md text-sm ${PRIORITY_COLORS[detailBug.priority] || 'bg-gray-100 text-gray-600'}`}>
                        {detailBug.priority}
                      </span>
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 mt-2 break-words">{detailBug.title}</h3>
                  </div>
                  <button onClick={() => { setDetail(null); setRevokeOpen(false); }} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 shrink-0 ml-3">
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="p-5 overflow-y-auto space-y-4">
                  {detailBug.status === 'revoked' && (
                    <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-sm text-rose-700 flex items-start gap-2">
                      <Undo2 className="w-4 h-4 mt-0.5 shrink-0" />
                      <div>
                        <span className="font-semibold">This bug has been revoked.</span>
                        {detailBug.revoke_reason && <span> Reason: {detailBug.revoke_reason}</span>}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="md:col-span-2 min-w-0 space-y-4">
                      <div>
                        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Description</div>
                        <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{detailBug.description || <span className="text-gray-400">No description provided.</span>}</p>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Steps to Reproduce</div>
                        <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{detailBug.steps_to_reproduce || <span className="text-gray-400">Not documented.</span>}</p>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="bg-emerald-50/50 border border-emerald-100 rounded-xl p-3">
                          <div className="text-xs font-semibold text-emerald-700 uppercase tracking-wider mb-1">Expected Result</div>
                          <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{detailBug.expected_result || <span className="text-gray-400">—</span>}</p>
                        </div>
                        <div className="bg-red-50/50 border border-red-100 rounded-xl p-3">
                          <div className="text-xs font-semibold text-red-700 uppercase tracking-wider mb-1">Actual Result</div>
                          <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{detailBug.actual_result || <span className="text-gray-400">—</span>}</p>
                        </div>
                      </div>
                      {detailBug.resolution_notes && (
                        <div>
                          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Resolution Notes</div>
                          <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{detailBug.resolution_notes}</p>
                        </div>
                      )}
                    </div>

                    <div className="space-y-3 bg-gray-50/70 border border-gray-100 rounded-xl p-4 text-sm h-fit">
                      <div className="flex items-center gap-2 text-gray-600">
                        <User className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                        <span className="text-gray-400 w-20 shrink-0">Reporter</span>
                        <span className="truncate">{detailBug.reported_by || '—'}</span>
                      </div>
                      <div className="flex items-center gap-2 text-gray-600">
                        <User className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                        <span className="text-gray-400 w-20 shrink-0">Assignee</span>
                        <span className="truncate">{detailBug.assigned_to || <span className="text-gray-400">Unassigned</span>}</span>
                      </div>
                      <div className="flex items-center gap-2 text-gray-600">
                        <Layers className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                        <span className="text-gray-400 w-20 shrink-0">Module</span>
                        <span className="truncate">{detailBug.module || '—'}</span>
                      </div>
                      <div className="flex items-center gap-2 text-gray-600">
                        <Monitor className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                        <span className="text-gray-400 w-20 shrink-0">Environment</span>
                        <span className="truncate">{detailBug.environment || '—'}</span>
                      </div>
                      {detailBug.test_case_id && (
                        <div className="flex items-center gap-2 text-gray-600">
                          <CheckCircle2 className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                          <span className="text-gray-400 w-20 shrink-0">Test Case</span>
                          <span className="truncate font-mono text-xs">{detailBug.test_case_id}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2 text-gray-600">
                        <CalendarDays className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                        <span className="text-gray-400 w-20 shrink-0">Created</span>
                        <span>{fmtDateTime(detailBug.created_at)}</span>
                      </div>
                      <div className="flex items-center gap-2 text-gray-600">
                        <CalendarDays className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                        <span className="text-gray-400 w-20 shrink-0">Updated</span>
                        <span>{fmtDateTime(detailBug.updated_at)}</span>
                      </div>
                      {(detailBug.ado_work_item_id || detailBug.jira_issue_key) && (
                        <div className="flex items-start gap-2 text-gray-600" onClick={(e) => e.stopPropagation()}>
                          <ExternalLink className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-1" />
                          <span className="text-gray-400 w-20 shrink-0">Trackers</span>
                          <div className="flex flex-wrap gap-1">
                            {detailBug.ado_work_item_id && (
                              <a
                                href={detailBug.ado_url || '#'}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-50 text-sky-700 border border-sky-200 text-xs font-medium hover:bg-sky-100 transition-colors"
                                title="Open the Azure DevOps work item"
                              >
                                ADO #{detailBug.ado_work_item_id} <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                            {detailBug.jira_issue_key && (
                              <a
                                href={detailBug.jira_url || '#'}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-medium hover:bg-indigo-100 transition-colors"
                                title="Open the JIRA issue"
                              >
                                {detailBug.jira_issue_key} <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                        </div>
                      )}
                      {(detailBug.tags || []).length > 0 && (
                        <div className="flex items-start gap-2 text-gray-600">
                          <Tag className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-1" />
                          <div className="flex flex-wrap gap-1">
                            {(detailBug.tags || []).map((t) => (
                              <span key={t} className="px-2 py-0.5 rounded-md bg-purple-100 text-purple-700 text-xs border border-purple-200 lowercase">{t}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Activity timeline */}
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      <Activity className="w-3.5 h-3.5" /> Activity
                    </div>
                    <div className="space-y-2.5">
                      {detail!.activity.length === 0 ? (
                        <p className="text-sm text-gray-400">No activity recorded yet.</p>
                      ) : detail!.activity.map((entry) => (
                        <div key={entry.id} className="flex items-start gap-2.5 text-sm">
                          <span className="w-2 h-2 rounded-full bg-[#7C3AED] mt-1.5 shrink-0" />
                          <div className="min-w-0">
                            <span className="font-medium text-gray-800">{entry.performed_by || 'Someone'}</span>
                            <span className="text-gray-600"> {activityLabel(entry)}</span>
                            <span className="text-gray-400 text-xs ml-2">{fmtDateTime(entry.created_at)}</span>
                            {entry.details?.reason && (
                              <div className="text-xs text-gray-500 mt-0.5">Reason: {entry.details.reason}</div>
                            )}
                            {entry.details?.changes && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {Object.entries(entry.details.changes).map(([field, change]) => (
                                  <span key={field} className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-xs">
                                    {FIELD_LABELS[field] || field}: {formatChangeValue(change.from)} → {formatChangeValue(change.to)}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Detail footer actions */}
                <div className="border-t border-gray-100 p-5">
                  {revokeOpen ? (
                    <div className="space-y-3">
                      <label className={labelCls}>Reason for revoking (optional)</label>
                      <textarea
                        value={revokeReason}
                        onChange={(e) => setRevokeReason(e.target.value)}
                        rows={2}
                        placeholder="e.g. Duplicate of BUG-12, not reproducible, works as designed..."
                        className={inputCls}
                      />
                      <div className="flex items-center justify-end gap-3">
                        <button onClick={() => setRevokeOpen(false)} className="px-4 py-2.5 text-gray-600 bg-gray-100 rounded-xl text-sm font-medium hover:bg-gray-200 transition-colors">
                          Cancel
                        </button>
                        <button
                          onClick={handleRevoke}
                          disabled={actionBusy}
                          className="flex items-center gap-2 px-4 py-2.5 bg-rose-600 hover:bg-rose-700 disabled:bg-rose-300 text-white rounded-xl text-sm font-semibold transition-colors"
                        >
                          {actionBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                          <Undo2 className="w-3.5 h-3.5" /> Confirm Revoke
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={() => setConfirmDelete(detailBug)}
                        className="mr-auto flex items-center gap-1.5 px-4 py-2.5 text-red-600 bg-red-50 border border-red-200 rounded-xl text-sm font-medium hover:bg-red-100 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Delete
                      </button>
                      {canReopen && (
                        <button
                          onClick={handleReopen}
                          disabled={actionBusy}
                          className="flex items-center gap-1.5 px-4 py-2.5 text-blue-600 bg-blue-50 border border-blue-200 rounded-xl text-sm font-medium hover:bg-blue-100 disabled:opacity-50 transition-colors"
                        >
                          {actionBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Reopen
                        </button>
                      )}
                      {canRevoke && (
                        <button
                          onClick={() => setRevokeOpen(true)}
                          className="flex items-center gap-1.5 px-4 py-2.5 text-rose-600 bg-rose-50 border border-rose-200 rounded-xl text-sm font-medium hover:bg-rose-100 transition-colors"
                        >
                          <Undo2 className="w-3.5 h-3.5" /> Revoke
                        </button>
                      )}
                      <button
                        onClick={() => openEdit(detailBug)}
                        className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:from-[#6D28D9] hover:to-[#4F46E5] text-white rounded-xl text-sm font-semibold transition-all shadow-lg shadow-purple-500/25"
                      >
                        <Edit3 className="w-3.5 h-3.5" /> Edit
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Create / Edit modal */}
      {editor && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setEditor(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-900">
                {editor.mode === 'edit' ? `Edit Bug — BUG-${editor.bug.bug_number}` : 'Report New Bug'}
              </h3>
              <button onClick={() => setEditor(null)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 overflow-y-auto">
              {formError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{formError}</div>
              )}
              <div>
                <label className={labelCls}>Title *</label>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={400} placeholder="Short summary of the defect" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} placeholder="What happened? Include any relevant context." className={inputCls} />
              </div>
              <div className={`grid grid-cols-2 ${editor.mode === 'edit' ? 'sm:grid-cols-3' : ''} gap-4`}>
                <div>
                  <label className={labelCls}>Severity</label>
                  <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} className={inputCls}>
                    {SEVERITIES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Priority</label>
                  <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className={inputCls}>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                {editor.mode === 'edit' && (
                  <div>
                    <label className={labelCls}>Status</label>
                    <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className={inputCls}>
                      {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                        <option key={key} value={key}>{cfg.label}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Module</label>
                  <input value={form.module} onChange={(e) => setForm({ ...form, module: e.target.value })} maxLength={100} placeholder="e.g. Checkout" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Environment</label>
                  <input value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })} maxLength={100} placeholder="e.g. QA / Chrome 126" className={inputCls} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Assigned To</label>
                  <input value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })} maxLength={100} placeholder="Username or name" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Related Test Case ID</label>
                  <input value={form.test_case_id} onChange={(e) => setForm({ ...form, test_case_id: e.target.value })} maxLength={100} placeholder="e.g. TC-014" className={inputCls} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Steps to Reproduce</label>
                <textarea value={form.steps_to_reproduce} onChange={(e) => setForm({ ...form, steps_to_reproduce: e.target.value })} rows={3} placeholder={'1. Go to...\n2. Click on...\n3. Observe...'} className={inputCls} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Expected Result</label>
                  <textarea value={form.expected_result} onChange={(e) => setForm({ ...form, expected_result: e.target.value })} rows={2} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Actual Result</label>
                  <textarea value={form.actual_result} onChange={(e) => setForm({ ...form, actual_result: e.target.value })} rows={2} className={inputCls} />
                </div>
              </div>
              {editor.mode === 'edit' && (
                <div>
                  <label className={labelCls}>Resolution Notes</label>
                  <textarea value={form.resolution_notes} onChange={(e) => setForm({ ...form, resolution_notes: e.target.value })} rows={2} placeholder="How was this fixed / why was it closed?" className={inputCls} />
                </div>
              )}
              <div>
                <label className={labelCls}>Tags</label>
                <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="regression, login, ui (comma-separated)" className={inputCls} />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-100">
              <button onClick={() => setEditor(null)} className="px-4 py-2.5 text-gray-600 bg-gray-100 rounded-xl text-sm font-medium hover:bg-gray-200 transition-colors">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-3d flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:from-[#6D28D9] hover:to-[#4F46E5] disabled:from-[#C4B5FD] disabled:to-[#C7D2FE] text-white rounded-xl text-sm font-semibold transition-all shadow-lg shadow-purple-500/25"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {editor.mode === 'edit' ? 'Save Changes' : 'Report Bug'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Raise destination picker */}
      {raiseOpen && (
        <div
          className="fixed inset-0 bg-black/45 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => { if (!pushingAdo && !pushingJira) setRaiseOpen(false); }}
        >
          <div
            className="raise-dest-modal bg-gradient-to-b from-white to-slate-50 rounded-3xl shadow-[0_24px_60px_-12px_rgba(30,27,75,0.45)] ring-1 ring-black/5 w-full max-w-md overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Raise Bug{selectedIds.size > 1 ? 's' : ''}</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Where should the {selectedIds.size} selected bug{selectedIds.size > 1 ? 's' : ''} be raised?
                </p>
              </div>
              <button
                onClick={() => setRaiseOpen(false)}
                disabled={pushingAdo || pushingJira}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 disabled:opacity-40"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {/* Azure DevOps — 3D card */}
              <button
                onClick={async () => { await handleRaiseInAdo(); setRaiseOpen(false); }}
                disabled={!adoStatus?.connected || pushingAdo || pushingJira}
                className={`group relative w-full flex items-center gap-4 p-4 rounded-2xl text-left transform-gpu transition-all duration-200 ease-out
                  border border-sky-100 bg-gradient-to-br from-white via-sky-50/40 to-sky-100/60
                  shadow-[0_6px_16px_-6px_rgba(2,132,199,0.35),inset_0_1px_0_rgba(255,255,255,0.9)]
                  hover:-translate-y-1 hover:border-sky-300 hover:shadow-[0_16px_32px_-10px_rgba(2,132,199,0.5),inset_0_1px_0_rgba(255,255,255,0.9)]
                  active:translate-y-0 active:shadow-[0_4px_10px_-4px_rgba(2,132,199,0.4)]
                  disabled:cursor-not-allowed disabled:hover:translate-y-0
                  ${pushingAdo ? 'animate-pulse border-sky-400 ring-2 ring-sky-300/60' : (!adoStatus?.connected || pushingJira) ? 'opacity-50' : ''}`}
                title={adoStatus?.connected ? undefined : 'Connect Azure DevOps in System Configuration → Requirement Sources'}
              >
                <div className="relative w-14 h-14 shrink-0 rounded-2xl text-white bg-gradient-to-br from-sky-400 via-sky-600 to-blue-800 flex items-center justify-center
                    shadow-[0_8px_16px_-4px_rgba(2,132,199,0.55),inset_0_1px_1px_rgba(255,255,255,0.5),inset_0_-2px_3px_rgba(0,0,0,0.25)]
                    transition-transform duration-200 group-hover:scale-105 group-hover:rotate-[-3deg]">
                  {pushingAdo
                    ? <Upload className="w-7 h-7 text-white drop-shadow animate-bounce" />
                    : <AdoLogo className="w-7 h-7 text-white drop-shadow-[0_2px_2px_rgba(0,0,0,0.3)]" />}
                  <span className="pointer-events-none absolute inset-x-1.5 top-1 h-1/3 rounded-t-xl bg-white/30 blur-[1px]" />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-gray-900 text-[15px]">Azure DevOps</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {pushingAdo
                      ? <span className="text-sky-700 font-medium">Raising {selectedIds.size} bug{selectedIds.size > 1 ? 's' : ''} in {adoStatus?.project}…</span>
                      : adoStatus?.connected
                        ? <>Raise as Bug work items in <span className="font-semibold text-sky-700">{adoStatus.project}</span></>
                        : 'Not connected'}
                  </div>
                </div>
                {pushingAdo
                  ? <span className="ml-auto shrink-0 text-sky-600"><Loader2 className="w-5 h-5 animate-spin" /></span>
                  : <span className="ml-auto shrink-0 text-sky-400 opacity-0 -translate-x-1 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-0">→</span>}
              </button>

              {/* JIRA — 3D card */}
              <button
                onClick={async () => { await handleRaiseInJira(); setRaiseOpen(false); }}
                disabled={!jiraStatus?.connected || pushingAdo || pushingJira}
                className={`group relative w-full flex items-center gap-4 p-4 rounded-2xl text-left transform-gpu transition-all duration-200 ease-out
                  border border-blue-100 bg-gradient-to-br from-white via-blue-50/40 to-indigo-100/60
                  shadow-[0_6px_16px_-6px_rgba(37,99,235,0.35),inset_0_1px_0_rgba(255,255,255,0.9)]
                  hover:-translate-y-1 hover:border-blue-300 hover:shadow-[0_16px_32px_-10px_rgba(37,99,235,0.5),inset_0_1px_0_rgba(255,255,255,0.9)]
                  active:translate-y-0 active:shadow-[0_4px_10px_-4px_rgba(37,99,235,0.4)]
                  disabled:cursor-not-allowed disabled:hover:translate-y-0
                  ${pushingJira ? 'animate-pulse border-blue-400 ring-2 ring-blue-300/60' : (!jiraStatus?.connected || pushingAdo) ? 'opacity-50' : ''}`}
                title={jiraStatus?.connected ? undefined : 'Connect JIRA in System Configuration → Requirement Sources'}
              >
                <div className="relative w-14 h-14 shrink-0 rounded-2xl text-white bg-gradient-to-br from-blue-400 via-blue-600 to-indigo-800 flex items-center justify-center
                    shadow-[0_8px_16px_-4px_rgba(37,99,235,0.55),inset_0_1px_1px_rgba(255,255,255,0.5),inset_0_-2px_3px_rgba(0,0,0,0.25)]
                    transition-transform duration-200 group-hover:scale-105 group-hover:rotate-[3deg]">
                  {pushingJira
                    ? <Upload className="w-7 h-7 text-white drop-shadow animate-bounce" />
                    : <JiraLogo className="w-7 h-7 text-white drop-shadow-[0_2px_2px_rgba(0,0,0,0.3)]" />}
                  <span className="pointer-events-none absolute inset-x-1.5 top-1 h-1/3 rounded-t-xl bg-white/30 blur-[1px]" />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-gray-900 text-[15px]">JIRA</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {pushingJira
                      ? <span className="text-blue-700 font-medium">Raising {selectedIds.size} bug{selectedIds.size > 1 ? 's' : ''} in project {jiraStatus?.projectKey}…</span>
                      : jiraStatus?.connected
                        ? <>Raise as Bug issues in project <span className="font-semibold text-blue-700">{jiraStatus.projectKey || '—'}</span></>
                        : 'Not connected'}
                  </div>
                </div>
                {pushingJira
                  ? <span className="ml-auto shrink-0 text-blue-600"><Loader2 className="w-5 h-5 animate-spin" /></span>
                  : <span className="ml-auto shrink-0 text-blue-400 opacity-0 -translate-x-1 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-0">→</span>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setConfirmDelete(null)}>
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Confirm Delete</h3>
                <p className="text-sm text-gray-500">
                  This will permanently delete <span className="font-mono">BUG-{confirmDelete.bug_number}</span> "{confirmDelete.title}" and its activity history.
                </p>
                {confirmDelete.ado_work_item_id && (
                  <p className="mt-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                    This also deletes its linked Azure DevOps work item{' '}
                    <span className="font-mono">#{confirmDelete.ado_work_item_id}</span> (moved to the ADO Recycle Bin).
                  </p>
                )}
                {confirmDelete.jira_issue_key && (
                  <p className="mt-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                    This also deletes its linked JIRA issue{' '}
                    <span className="font-mono">{confirmDelete.jira_issue_key}</span>.
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:bg-red-300"
              >
                {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Delete
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

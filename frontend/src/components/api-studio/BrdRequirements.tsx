/**
 * BrdRequirements — Business Requirements Document module (Module 2).
 *
 * Upload a BRD (PDF/DOCX/XLSX/TXT/MD) or paste its text; the tenant LLM extracts
 * STRUCTURED business requirements (BR-### with objective, rules, workflows,
 * acceptance criteria, validations, dependencies, positive/negative scenarios),
 * which are persisted per tenant for traceability. Previously-analysed BRDs are
 * listed on the left; selecting one shows its requirements.
 *
 * Distinct from the BRD *import* card on the Import screen, which turns a BRD
 * into runnable API endpoints. This surfaces the requirements themselves.
 * Opt-in, standalone tool — nothing else depends on it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, ClipboardList, Upload, Trash2, AlertTriangle, FileText, Sparkles,
  Target, ListChecks, ShieldCheck, GitBranch, Workflow as WorkflowIcon, CircleCheck, CircleX,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  analyzeBrd, listBrdDocuments, getBrdDocument, deleteBrdDocument,
  type BrdDocument, type BusinessRequirement,
} from '@/services/api';
import { CARD, STRIP, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, relativeTime } from './format';
import { EmptyState } from './primitives';

export default function BrdRequirements({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [docs, setDocs] = useState<BrdDocument[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ document: BrdDocument; requirements: BusinessRequirement[] } | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [mode, setMode] = useState<'list' | 'new'>('list');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');

  const refreshList = async () => {
    setLoadingList(true);
    try { setDocs((await listBrdDocuments()).documents); }
    catch (err: any) { toast.error('Could not load BRDs', err?.response?.data?.error || 'Please try again.'); }
    finally { setLoadingList(false); }
  };

  useEffect(() => { void refreshList(); }, []);

  const openDoc = async (id: string) => {
    setSelectedId(id); setMode('list'); setLoadingDetail(true); setDetail(null);
    try { setDetail(await getBrdDocument(id)); }
    catch (err: any) { toast.error('Could not open BRD', err?.response?.data?.error || 'Please try again.'); }
    finally { setLoadingDetail(false); }
  };

  const analyze = async () => {
    setAnalyzing(true); setError('');
    try {
      const res = await analyzeBrd({ file: file || undefined, text: file ? undefined : text, name: name.trim() || undefined });
      toast.success('BRD analysed', `${res.requirements.length} business requirement${res.requirements.length === 1 ? '' : 's'} extracted.`);
      setText(''); setName(''); setFile(null);
      await refreshList();
      setDetail(res); setSelectedId(res.document.id); setMode('list');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not analyse the document.');
    } finally { setAnalyzing(false); }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this BRD and its extracted requirements?')) return;
    try {
      await deleteBrdDocument(id);
      if (selectedId === id) { setSelectedId(null); setDetail(null); }
      await refreshList();
      toast.success('BRD deleted', 'The document and its requirements were removed.');
    } catch (err: any) { toast.error('Could not delete', err?.response?.data?.error || 'Please try again.'); }
  };

  const canAnalyze = !analyzing && (!!file || text.trim().length >= 20);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-5xl h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ClipboardList className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Business requirements (BRD)</h3>
          <span className="text-[11px] text-gray-400">Extract structured BRs for traceability</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* ── Left: saved BRDs + "new" trigger ── */}
          <aside className="w-64 flex-shrink-0 border-r border-[#EDE9FE] flex flex-col min-h-0">
            <div className="p-3 border-b border-[#EDE9FE] flex-shrink-0">
              <button type="button" onClick={() => { setMode('new'); setSelectedId(null); setDetail(null); setError(''); }} className={`${PRIMARY_BTN} w-full justify-center`}>
                <Upload className="w-3.5 h-3.5" />Analyse a BRD
              </button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 p-2">
              {loadingList ? (
                <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-4 h-4 animate-spin" /></div>
              ) : docs.length === 0 ? (
                <p className="px-2 py-6 text-[11px] text-gray-400 text-center">No BRDs analysed yet.</p>
              ) : docs.map((d) => (
                <div key={d.id} className={`group relative rounded-lg mb-1 ${selectedId === d.id ? 'bg-[#F5F3FF] border border-[#DDD6FE]' : 'hover:bg-gray-50 border border-transparent'}`}>
                  <button type="button" onClick={() => void openDoc(d.id)} className="w-full text-left px-2.5 py-2 pr-7">
                    <div className="text-[12px] font-semibold text-gray-800 truncate" title={d.name}>{d.name}</div>
                    <div className="text-[10.5px] text-gray-500 mt-0.5">{d.requirementCount} req · {relativeTime(d.createdAt)}</div>
                  </button>
                  <button type="button" onClick={() => void remove(d.id)} title="Delete" className="absolute top-1.5 right-1.5 p-1 rounded text-gray-300 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-50"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
          </aside>

          {/* ── Right: analyse form OR requirement detail ── */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            {mode === 'new' ? (
              <div className="p-5 max-w-2xl space-y-3">
                <div>
                  <label className={LABEL}>Document name (optional)</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Payments BRD v2" className={`${FIELD} w-full`} />
                </div>
                <div>
                  <label className={LABEL}>Upload a BRD</label>
                  <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.markdown,.rtf" onChange={(e) => { setFile(e.target.files?.[0] || null); }} className="hidden" />
                  <button type="button" onClick={() => fileRef.current?.click()} className={`${SECONDARY_BTN} w-full justify-center`}>
                    <FileText className="w-3.5 h-3.5" />{file ? file.name : 'Choose a PDF / DOCX / XLSX / TXT file'}
                  </button>
                </div>
                <div className="relative">
                  <div className="flex items-center gap-2 my-1"><div className="flex-1 h-px bg-gray-200" /><span className="text-[10px] uppercase tracking-wide text-gray-400">or paste text</span><div className="flex-1 h-px bg-gray-200" /></div>
                  <textarea value={text} onChange={(e) => setText(e.target.value)} disabled={!!file} placeholder="Paste the Business Requirements Document text here…" spellCheck={false} className={`${FIELD} w-full h-48 resize-none ${file ? 'opacity-50' : ''}`} />
                </div>
                {error && <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>}
                <div className="flex items-center justify-end gap-2">
                  {file && <button type="button" onClick={() => setFile(null)} className="text-[11px] text-gray-500 hover:text-gray-700">Clear file</button>}
                  <button type="button" onClick={() => void analyze()} disabled={!canAnalyze} className={PRIMARY_BTN}>
                    {analyzing ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}{analyzing ? 'Analysing…' : 'Extract requirements'}
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 leading-relaxed">Extraction is deterministic about structure but reads the document with your tenant LLM — review the requirements before relying on them. Nothing is invented where the document is silent.</p>
              </div>
            ) : loadingDetail ? (
              <div className="flex items-center justify-center h-full text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
            ) : detail ? (
              <RequirementDetail detail={detail} />
            ) : (
              <div className="h-full flex items-center justify-center p-6">
                <EmptyState icon={ClipboardList} title="Select a BRD" hint="Pick an analysed document on the left, or analyse a new one." />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RequirementDetail({ detail }: { detail: { document: BrdDocument; requirements: BusinessRequirement[] } }) {
  const { document: doc, requirements } = detail;
  const totals = useMemo(() => ({
    rules: requirements.reduce((n, r) => n + (r.rules?.length || 0), 0),
    ac: requirements.reduce((n, r) => n + (r.acceptanceCriteria?.length || 0), 0),
    scenarios: requirements.reduce((n, r) => n + (r.positiveScenarios?.length || 0) + (r.negativeScenarios?.length || 0), 0),
  }), [requirements]);

  return (
    <div className="p-5 space-y-4">
      <div>
        <h2 className="text-[16px] font-bold text-gray-900">{doc.name}</h2>
        {doc.summary && <p className="text-[12px] text-gray-600 mt-1 leading-relaxed">{doc.summary}</p>}
        <div className="flex flex-wrap items-center gap-2 mt-2.5">
          <Stat label="Requirements" value={requirements.length} />
          <Stat label="Business rules" value={totals.rules} />
          <Stat label="Acceptance criteria" value={totals.ac} />
          <Stat label="Scenarios" value={totals.scenarios} />
        </div>
      </div>
      <div className="space-y-3">
        {requirements.map((r) => <RequirementCard key={r.brId} r={r} />)}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[#DDD6FE] bg-[#F5F3FF] text-[11.5px] font-semibold text-[#6D28D9] tabular-nums">{value}<span className="font-normal text-gray-500">{label}</span></span>;
}

function RequirementCard({ r }: { r: BusinessRequirement }) {
  return (
    <div className={`${CARD} p-4`}>
      <div className="flex items-start gap-2.5">
        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-[#7C3AED] text-white text-[10.5px] font-bold tracking-wide flex-shrink-0 mt-px">{r.brId}</span>
        <div className="min-w-0 flex-1">
          <h4 className="text-[13.5px] font-semibold text-gray-900 leading-snug">{r.title}</h4>
          {r.description && <p className="text-[12px] text-gray-600 mt-1 leading-relaxed">{r.description}</p>}
        </div>
      </div>
      {r.objective && (
        <div className="mt-3 flex items-start gap-2 text-[12px]"><Target className="w-3.5 h-3.5 text-[#7C3AED] flex-shrink-0 mt-0.5" /><p className="text-gray-700 min-w-0"><span className="font-semibold text-gray-800">Objective: </span>{r.objective}</p></div>
      )}
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ListBlock icon={ShieldCheck} title="Business rules" items={r.rules} accent="#F43F5E" />
        <ListBlock icon={WorkflowIcon} title="Workflows" items={r.workflows} accent="#0EA5E9" />
        <ListBlock icon={ListChecks} title="Acceptance criteria" items={r.acceptanceCriteria} accent="#10B981" />
        <ListBlock icon={ShieldCheck} title="Validations" items={r.validations} accent="#F59E0B" />
        <ListBlock icon={GitBranch} title="Dependencies" items={r.dependencies} accent="#8B5CF6" />
      </div>
      {(r.positiveScenarios?.length || r.negativeScenarios?.length) ? (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ScenarioBlock positive title="Positive scenarios" items={r.positiveScenarios} />
          <ScenarioBlock title="Negative scenarios" items={r.negativeScenarios} />
        </div>
      ) : null}
    </div>
  );
}

function ListBlock({ icon: Icon, title, items, accent }: { icon: React.ElementType; title: string; items?: string[]; accent: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/60 p-2.5">
      <div className="flex items-center gap-1.5 mb-1.5"><Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: accent }} /><span className="text-[10.5px] font-bold uppercase tracking-wide text-gray-600">{title}</span><span className="text-[10px] text-gray-400 tabular-nums">{items.length}</span></div>
      <ul className="space-y-1">
        {items.map((it, i) => <li key={i} className="text-[11.5px] text-gray-700 leading-snug pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-gray-400">{it}</li>)}
      </ul>
    </div>
  );
}

function ScenarioBlock({ title, items, positive }: { title: string; items?: string[]; positive?: boolean }) {
  if (!items || items.length === 0) return null;
  const Icon = positive ? CircleCheck : CircleX;
  const color = positive ? '#10B981' : '#F43F5E';
  return (
    <div className="rounded-lg border p-2.5" style={{ borderColor: `${color}33`, backgroundColor: `${color}0A` }}>
      <div className="flex items-center gap-1.5 mb-1.5"><Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color }} /><span className="text-[10.5px] font-bold uppercase tracking-wide text-gray-600">{title}</span><span className="text-[10px] text-gray-400 tabular-nums">{items.length}</span></div>
      <ul className="space-y-1">
        {items.map((it, i) => <li key={i} className="text-[11.5px] text-gray-700 leading-snug pl-3 relative before:content-['–'] before:absolute before:left-0 before:text-gray-400">{it}</li>)}
      </ul>
    </div>
  );
}

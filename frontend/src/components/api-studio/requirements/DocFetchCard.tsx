/**
 * DocFetchCard — the "Fetch BRD / FRD Documents" intake card.
 *
 * One card, four real sources: Upload File, Azure DevOps, Jira, Swagger. Each
 * produces document text that is handed to the existing BRD/FRD analyzer — no
 * mocked content, no fake "connected" states (the ADO/Jira pickers fail loudly
 * if the tenant isn't connected). Alongside it: Document Options (project /
 * branch annotation + attachment listing) and a live Processing Status panel.
 */
import { useState } from 'react';
import { Upload, Cloud, Boxes, FileJson, AlertTriangle, Sparkles, Loader2, Paperclip } from 'lucide-react';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  analyzeBrd, analyzeFrd,
  getAzureDevopsStories, getAzureDevopsStoryDetails, getAzureDevopsAttachments,
  getJiraStories, getJiraStoryDetails, getJiraAttachments,
  type AdoAttachmentMeta, type JiraAttachmentMeta,
  type IntegrationDashboard, type IntegratedMatrix,
} from '@/services/api';
import { CARD, FIELD, LABEL, PRIMARY_BTN } from '../format';
import { SectionCard, DropZone, ProcessingStatusPanel } from './shared';
import { formatBytes, buildProcessingSteps, type ProcessingStep } from './util';

type Source = 'upload' | 'ado' | 'jira' | 'swagger';
type Kind = 'BRD' | 'FRD';
interface Item { key: string; label: string }

const SOURCES: { id: Source; label: string; icon: typeof Upload }[] = [
  { id: 'upload', label: 'Upload File', icon: Upload },
  { id: 'ado', label: 'Azure DevOps', icon: Cloud },
  { id: 'jira', label: 'Jira', icon: Boxes },
  { id: 'swagger', label: 'Swagger', icon: FileJson },
];

const UPLOAD_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.markdown,.rtf';
const SWAGGER_ACCEPT = '.json,.yaml,.yml,.txt';

/** Pull readable text out of a tracker item detail of unknown exact shape. */
function storyToText(d: any): string {
  if (!d) return '';
  const parts: string[] = [];
  const push = (v: any) => { if (!v) return; parts.push(typeof v === 'string' ? v : JSON.stringify(v)); };
  push(d.title || d.summary);
  push(d.description);
  push(d.acceptanceCriteria);
  const text = parts.filter(Boolean).join('\n\n').trim();
  return text || JSON.stringify(d);
}

export default function DocFetchCard({ kind, username, dash, matrix, loadingGlobal, onAnalyzed }: {
  kind: Kind;
  username: string;
  dash: IntegrationDashboard | null;
  matrix: IntegratedMatrix | null;
  loadingGlobal: boolean;
  onAnalyzed: () => void;
}) {
  const toast = useToast();
  const noun = kind; // "BRD" | "FRD"
  const analyze = kind === 'BRD' ? analyzeBrd : analyzeFrd;

  const [source, setSource] = useState<Source>('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Document options
  const [project, setProject] = useState('');
  const [branch, setBranch] = useState('');
  const [includeAttachments, setIncludeAttachments] = useState(true);

  // Tracker pickers (ADO / Jira)
  const [items, setItems] = useState<Item[] | null>(null);
  const [loadingItems, setLoadingItems] = useState(false);
  const [selected, setSelected] = useState('');
  const [attachments, setAttachments] = useState<(AdoAttachmentMeta | JiraAttachmentMeta)[] | null>(null);

  const steps: ProcessingStep[] = buildProcessingSteps(dash, matrix);

  const docName = (base: string) => {
    const prefix = [project.trim(), branch.trim()].filter(Boolean).join(' / ');
    return prefix ? `${prefix} — ${base}` : base;
  };

  const finish = (count: number) => {
    toast.success(`${noun} analysed`, `${count} requirement${count === 1 ? '' : 's'} extracted.`);
    setSelected(''); setAttachments(null); setError('');
    onAnalyzed();
  };

  const runAnalyze = async (input: { file?: File; text?: string; name?: string }) => {
    setBusy(true); setError('');
    try {
      const res = await analyze(input);
      finish(res.requirements.length);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || `Could not analyse the ${noun}.`);
    } finally { setBusy(false); }
  };

  const loadItems = async (src: Source) => {
    setItems(null); setSelected(''); setAttachments(null); setError('');
    setLoadingItems(true);
    try {
      if (src === 'ado') {
        const rows = await getAzureDevopsStories();
        setItems(rows.map((r) => ({ key: r.key, label: `${r.key} · ${r.summary}` })));
      } else if (src === 'jira') {
        const rows = await getJiraStories(username);
        setItems((Array.isArray(rows) ? rows : []).map((r: any) => ({ key: r.key, label: `${r.key} · ${r.summary || r.title || ''}` })));
      }
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || `Could not reach ${src === 'ado' ? 'Azure DevOps' : 'Jira'}. Connect it in System Configuration first.`);
    } finally { setLoadingItems(false); }
  };

  const pickSource = (src: Source) => {
    setSource(src); setError(''); setItems(null); setSelected(''); setAttachments(null);
    if (src === 'ado' || src === 'jira') void loadItems(src);
  };

  const onSelectItem = async (key: string) => {
    setSelected(key); setAttachments(null);
    if (!key || !includeAttachments) return;
    try {
      const atts = source === 'ado' ? await getAzureDevopsAttachments(key) : await getJiraAttachments(key);
      setAttachments(atts);
    } catch { /* attachment listing is a convenience; never block analysis */ }
  };

  const analyzeTrackerItem = async () => {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      const detail = source === 'ado' ? await getAzureDevopsStoryDetails(selected) : await getJiraStoryDetails(username, selected);
      const text = storyToText(detail);
      if (text.trim().length < 20) { setError('That item has too little text to extract requirements from.'); setBusy(false); return; }
      const res = await analyze({ text, name: docName(selected) });
      finish(res.requirements.length);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not fetch that item.');
    } finally { setBusy(false); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* ── Fetch card ── */}
      <div className="lg:col-span-2">
        <SectionCard icon={Upload} title={`Fetch ${noun} Documents`} hint="Upload, or pull from a connected tracker">
          <div className="flex flex-wrap gap-1.5 mb-3">
            {SOURCES.map((s) => {
              const on = source === s.id;
              return (
                <button key={s.id} type="button" onClick={() => pickSource(s.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-semibold border transition-colors ${on ? 'bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white border-transparent shadow-sm' : 'bg-white text-gray-600 border-[#E7E3F5] hover:text-[#7C3AED] hover:border-[#DDD6FE]'}`}>
                  <s.icon className="w-3.5 h-3.5" />{s.label}
                </button>
              );
            })}
          </div>

          {(source === 'upload' || source === 'swagger') && (
            <DropZone
              accept={source === 'swagger' ? SWAGGER_ACCEPT : UPLOAD_ACCEPT}
              formatsLabel={source === 'swagger' ? 'JSON, YAML, TXT' : 'PDF, DOCX, XLSX, TXT, MD'}
              busy={busy}
              onFile={(file) => void runAnalyze({ file, name: docName(file.name) })}
            />
          )}

          {(source === 'ado' || source === 'jira') && (
            <div className="space-y-2.5">
              <div>
                <label className={LABEL}>{source === 'ado' ? 'Work item' : 'Issue'}</label>
                {loadingItems ? (
                  <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading live from {source === 'ado' ? 'Azure DevOps' : 'Jira'}…</div>
                ) : (
                  <select value={selected} onChange={(e) => void onSelectItem(e.target.value)} className={`${FIELD} w-full`} disabled={busy || !items || items.length === 0}>
                    <option value="">{items && items.length === 0 ? 'No items found' : `Select ${source === 'ado' ? 'a work item' : 'an issue'}…`}</option>
                    {(items || []).map((it) => <option key={it.key} value={it.key}>{it.label}</option>)}
                  </select>
                )}
              </div>

              {includeAttachments && selected && attachments && attachments.length > 0 && (
                <div className="rounded-lg border border-[#ECE9F8] bg-[#FCFBFF] p-2">
                  <div className="flex items-center gap-1.5 mb-1 text-[10.5px] font-bold uppercase tracking-wide text-gray-500"><Paperclip className="w-3 h-3" />Attachments ({attachments.length})</div>
                  <ul className="space-y-0.5">
                    {attachments.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 text-[11.5px] text-gray-600">
                        <span className="truncate">{a.name}</span>
                        <span className="ml-auto text-[10.5px] text-gray-400 tabular-nums">{formatBytes(a.sizeBytes)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button type="button" onClick={() => void analyzeTrackerItem()} disabled={busy || !selected} className={`${PRIMARY_BTN} w-full justify-center`}>
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}{busy ? 'Analysing…' : `Fetch & extract ${noun}`}
              </button>
            </div>
          )}

          {error && <div className="mt-3 flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>}
          <p className="mt-3 text-[11px] text-gray-400 leading-relaxed">Extraction reads the document with your tenant LLM — review the requirements before relying on them. Nothing is invented where the document is silent.</p>
        </SectionCard>
      </div>

      {/* ── Options + processing status ── */}
      <div className="space-y-4">
        <div className={`${CARD} p-4`}>
          <h3 className="text-[13px] font-semibold text-gray-900 mb-3">Document Options</h3>
          <div className="space-y-2.5">
            <div>
              <label className={LABEL}>Project</label>
              <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="e.g. E-Commerce Platform" className={`${FIELD} w-full`} />
            </div>
            <div>
              <label className={LABEL}>Branch</label>
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className={`${FIELD} w-full`} />
            </div>
            <label className="flex items-center gap-2 text-[12.5px] text-gray-700 cursor-pointer select-none">
              <input type="checkbox" checked={includeAttachments} onChange={(e) => setIncludeAttachments(e.target.checked)} className="rounded border-gray-300 text-[#7C3AED] focus:ring-[#7C3AED]" />
              Include attachments
            </label>
          </div>
          <p className="mt-2 text-[10.5px] text-gray-400 leading-relaxed">Project / branch label the saved document. Attachments are listed for the selected tracker item.</p>
        </div>

        <div className={`${CARD} p-4`}>
          <h3 className="text-[13px] font-semibold text-gray-900 mb-3">Processing Status</h3>
          <ProcessingStatusPanel steps={steps} loading={loadingGlobal && !dash} />
        </div>
      </div>
    </div>
  );
}

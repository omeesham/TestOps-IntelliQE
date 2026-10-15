/**
 * FullCodeExport — the full-code escape hatch.
 *
 * Emits the selected catalogue as a self-contained, owned test project the
 * customer runs in their own repo and IDE — Playwright API tests or a k6 load
 * script, plus Monitoring-as-Code (monitors.yaml) and a local-first authoring
 * manifest (intelliqe.config.json) that round-trips edits back in. No lock-in:
 * every file is downloadable and yours to keep editing.
 */
import { useState } from 'react';
import { X, FileCode2, Play, AlertTriangle, Download } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { generateCodeProject, type CodegenTarget, type CodegenResult } from '@/services/api';
import { downloadText } from './generators';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const TARGETS: { id: CodegenTarget; label: string; desc: string }[] = [
  { id: 'playwright', label: 'Playwright (@playwright/test)', desc: 'API specs · CI workflow · config' },
  { id: 'k6', label: 'k6 load / smoke', desc: 'One script · thresholds' },
];
const LANG_MIME: Record<string, string> = { typescript: 'text/typescript', javascript: 'text/javascript', json: 'application/json', yaml: 'text/yaml', markdown: 'text/markdown' };

export default function FullCodeExport({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [target, setTarget] = useState<CodegenTarget>('playwright');
  const [projectName, setProjectName] = useState('intelliqe-api-tests');
  const [result, setResult] = useState<CodegenResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await generateCodeProject({ endpoints, target, projectName: projectName.trim() || undefined }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Code generation failed.');
    } finally { setBusy(false); }
  };

  const downloadOne = (path: string, content: string, language: string) => downloadText(path.split('/').pop() || path, content, LANG_MIME[language] || 'text/plain');
  const downloadAll = () => { if (result) for (const f of result.files) downloadOne(f.path, f.content, f.language); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <FileCode2 className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Full-code export &amp; Monitoring-as-Code</h3>
          <span className="text-[11px] text-gray-400">owned code · local-first · no lock-in</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          <div>
            <label className={LABEL}>Target</label>
            <div className="grid grid-cols-2 gap-2">
              {TARGETS.map((t) => (
                <button key={t.id} type="button" onClick={() => { setTarget(t.id); setResult(null); }} className={`text-left rounded-lg border px-3 py-2 transition-colors ${target === t.id ? 'border-[#7C3AED] bg-[#F5F3FF]' : 'border-gray-200 hover:bg-gray-50'}`}>
                  <span className="block text-[12px] font-medium text-gray-800">{t.label}</span>
                  <span className="block text-[10.5px] text-gray-400">{t.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={LABEL}>Project name</label>
            <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="intelliqe-api-tests" className={INPUT} />
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} · Monitoring-as-Code + local-first config always included</span>
            <button type="button" onClick={() => void run()} disabled={busy} className={PRIMARY_BTN}>
              {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {busy ? 'Generating…' : 'Generate project'}
            </button>
          </div>

          {result && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-gray-800">{result.projectName}</span>
                <span className="text-[11px] text-gray-400">{result.fileCount} files</span>
                <button type="button" onClick={downloadAll} className={`${SECONDARY_BTN} ml-auto`}><Download className="w-3.5 h-3.5" />Download all</button>
              </div>
              {result.files.map((f) => (
                <div key={f.path} className="rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50/60 border-b border-gray-100">
                    <span className="font-mono text-[11.5px] text-gray-700 min-w-0 flex-1 truncate">{f.path}</span>
                    <span className="text-[10px] uppercase tracking-wide text-gray-400">{f.language}</span>
                    <button type="button" onClick={() => downloadOne(f.path, f.content, f.language)} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]" title="Download file"><Download className="w-3.5 h-3.5" /></button>
                  </div>
                  <pre className="px-3 py-2 text-[10.5px] leading-relaxed text-gray-700 font-mono overflow-x-auto max-h-48 whitespace-pre">{f.content.length > 4000 ? f.content.slice(0, 4000) + '\n… (truncated — download for the full file)' : f.content}</pre>
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-gray-400">Secrets are read from the environment — none are baked into the generated code.</p>
        </div>
      </div>
    </div>
  );
}

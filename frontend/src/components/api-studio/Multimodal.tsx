/**
 * Multimodal — screenshots, Figma exports and recording transcripts → a plan.
 *
 * Drop in images of a screen or API console, paste a Figma export or a session
 * transcript, and the backend reads them together: observations, the flows it
 * can see, the fields and their constraints, and which catalogue endpoints the
 * inputs map to. The whole reading folds into an `AttoBrief` the run can adopt
 * as its strategy. Standalone and read-only until the user clicks "Apply".
 */
import { useState } from 'react';
import { Image as ImageIcon, X, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { analyzeMultimodal, type MultimodalResult, type AttoBrief } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

/** One picked image, held as a data URL so the backend can read it inline. */
interface PickedImage { name: string; dataUrl: string; mediaType: string }

const MAX_IMAGES = 6;

export default function Multimodal({ endpoints, onApply, onClose }: { endpoints: CatalogEndpoint[]; onApply: (brief: AttoBrief) => void; onClose: () => void }) {
  const toast = useToast();
  const [images, setImages] = useState<PickedImage[]>([]);
  const [figma, setFigma] = useState('');
  const [transcript, setTranscript] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MultimodalResult | null>(null);

  const addFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl) return;
        setImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, { name: file.name, dataUrl, mediaType: file.type }]));
      };
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (idx: number) => setImages((prev) => prev.filter((_, i) => i !== idx));

  const canAnalyze = images.length > 0 || !!figma.trim() || !!transcript.trim() || !!note.trim();

  const analyze = async () => {
    if (!canAnalyze || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await analyzeMultimodal({
        images: images.map((i) => ({ data: i.dataUrl, mediaType: i.mediaType })),
        figma,
        transcript,
        note,
        endpoints: endpoints.map((e) => ({ method: e.method, url: e.url, title: e.title })),
      });
      setResult(res);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not analyze the inputs.');
    } finally {
      setLoading(false);
    }
  };

  const apply = () => {
    if (!result) return;
    onApply(result.brief);
    toast.success('Strategy updated', 'Generation will follow this plan.');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ImageIcon className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Multimodal inputs</h3>
          <span className="text-[11px] text-gray-400">Screenshots · Figma · recordings → a test plan</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
              <p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {/* Images */}
          <div>
            <label className={LABEL}>Screenshots / mockups ({images.length}/{MAX_IMAGES})</label>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              disabled={loading || images.length >= MAX_IMAGES}
              onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ''; }}
              className="block w-full text-[12px] text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-[12px] file:font-medium file:bg-[#F5F3FF] file:text-[#6D28D9] hover:file:bg-[#EDE9FE] disabled:opacity-40"
            />
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {images.map((img, i) => (
                  <div key={i} className="relative group">
                    <img src={img.dataUrl} alt={img.name} className="w-16 h-16 object-cover rounded border border-gray-200" />
                    <button
                      type="button"
                      onClick={() => removeImage(i)}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-white border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-200 shadow-sm"
                      aria-label={`Remove ${img.name}`}
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Figma */}
          <div>
            <label className={LABEL}>Figma export / design text</label>
            <textarea
              value={figma}
              onChange={(e) => setFigma(e.target.value)}
              rows={3}
              placeholder="Paste exported frame names, annotations, or design copy…"
              disabled={loading}
              className={`${INPUT} resize-y`}
            />
          </div>

          {/* Transcript */}
          <div>
            <label className={LABEL}>Recording transcript / step notes</label>
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={3}
              placeholder="Paste a session transcript or the steps you walked through…"
              disabled={loading}
              className={`${INPUT} resize-y`}
            />
          </div>

          {/* Note */}
          <div>
            <label className={LABEL}>What to look for</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. focus on the checkout validation rules"
              disabled={loading}
              className={INPUT}
            />
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={() => void analyze()} disabled={loading || !canAnalyze} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
              Analyze
            </button>
          </div>

          {/* Result */}
          {result && (
            <div className="space-y-3">
              {result.observations.length > 0 && (
                <div className={`${CARD} p-3`}>
                  <p className={LABEL}>Observations</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {result.observations.map((o, i) => (
                      <li key={i} className="text-[12px] text-gray-700 break-words">{o}</li>
                    ))}
                  </ul>
                </div>
              )}

              {result.flows.length > 0 && (
                <div className={`${CARD} p-3 space-y-2`}>
                  <p className={LABEL}>Flows</p>
                  {result.flows.map((f, i) => (
                    <div key={i}>
                      <p className="text-[12px] font-medium text-gray-800">{f.name}</p>
                      {f.steps.length > 0 && (
                        <ul className="list-disc list-inside space-y-0.5 mt-0.5">
                          {f.steps.map((s, j) => (
                            <li key={j} className="text-[11.5px] text-gray-600 break-words">{s}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {result.fields.length > 0 && (
                <div className={`${CARD} p-3`}>
                  <p className={LABEL}>Fields</p>
                  <div className="space-y-1">
                    {result.fields.map((f, i) => (
                      <div key={i} className="flex items-start gap-2 text-[12px]">
                        <span className="font-mono text-[#6D28D9] flex-shrink-0">{f.name}</span>
                        <span className="text-gray-600 min-w-0 break-words">{f.constraint}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.mappedEndpoints.length > 0 && (
                <div>
                  <p className={LABEL}>Mapped endpoints</p>
                  <div className="flex flex-wrap gap-1.5">
                    {result.mappedEndpoints.map((url, i) => (
                      <span key={i} className="inline-flex items-center max-w-[220px] truncate px-1.5 py-0.5 rounded border text-[10.5px] font-mono text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]">
                        {url}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Apply */}
        {result && (
          <div className="border-t border-gray-100 p-3 flex justify-end flex-shrink-0">
            <button type="button" onClick={apply} className={PRIMARY_BTN}>Apply as run strategy</button>
          </div>
        )}
      </div>
    </div>
  );
}

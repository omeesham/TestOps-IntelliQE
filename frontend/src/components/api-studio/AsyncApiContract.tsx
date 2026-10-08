/**
 * AsyncApiContract — event-driven channels & message validation.
 *
 * Paste an AsyncAPI document (YAML or JSON) to summarise its channels — the
 * operations each exposes, the messages it carries, and whether a payload
 * schema is attached — then validate a concrete JSON message against a chosen
 * channel's schema. Read-only and opt-in: it inspects the contract and a sample
 * payload, and changes nothing in the catalogue or the pipeline.
 */
import { useState } from 'react';
import { X, Radio, Play, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { summarizeAsyncApi, validateAsyncMessage, type AsyncApiSummary, type AsyncValidateResult } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN, BRAND_CHIP, MUTED_CHIP } from './format';

export default function AsyncApiContract({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [docText, setDocText] = useState('');
  const [summary, setSummary] = useState<AsyncApiSummary | null>(null);
  const [summarizing, setSummarizing] = useState(false);

  const [channel, setChannel] = useState('');
  const [payloadText, setPayloadText] = useState('');
  const [validating, setValidating] = useState(false);
  const [result, setResult] = useState<AsyncValidateResult | null>(null);

  const [error, setError] = useState('');

  const summarize = async () => {
    if (!docText.trim()) { setError('Paste an AsyncAPI document first.'); return; }
    setSummarizing(true); setError(''); setSummary(null); setResult(null);
    try {
      const s = await summarizeAsyncApi(docText);
      setSummary(s);
      if (s.channels.length && !channel) setChannel(s.channels[0].name);
      toast.success('AsyncAPI summarised', `${s.channels.length} channel${s.channels.length === 1 ? '' : 's'}`);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not summarise the document.');
    } finally { setSummarizing(false); }
  };

  const validate = async () => {
    if (!channel.trim()) { setError('Pick or enter a channel to validate against.'); return; }
    let payload: any;
    try { payload = JSON.parse(payloadText); }
    catch { setError('Message payload must be valid JSON.'); return; }
    setValidating(true); setError(''); setResult(null);
    try {
      setResult(await validateAsyncMessage(docText, channel.trim(), payload));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not validate the message.');
    } finally { setValidating(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Radio className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">AsyncAPI contracts</h3>
          <span className="text-[11px] text-gray-400">event-driven channels &amp; message validation</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {/* Document */}
          <div>
            <label className={LABEL}>AsyncAPI document (YAML or JSON)</label>
            <textarea
              value={docText}
              onChange={(e) => { setDocText(e.target.value); setError(''); }}
              rows={10}
              spellCheck={false}
              className={`${INPUT} font-mono text-[11px] leading-[1.5] resize-y`}
              placeholder={'asyncapi: 3.0.0\ninfo:\n  title: Orders\n  version: 1.0.0\nchannels:\n  orders/created:\n    messages:\n      OrderCreated: …'}
            />
            <div className="flex justify-end mt-2">
              <button type="button" onClick={() => void summarize()} disabled={summarizing || !docText.trim()} className={PRIMARY_BTN}>
                {summarizing ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Summarize
              </button>
            </div>
          </div>

          {/* Summary */}
          {summary && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <span className="font-semibold text-gray-800">{summary.title || 'Untitled'}</span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10.5px] font-mono ${MUTED_CHIP}`}>v{summary.version || '—'}</span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10.5px] font-mono ${BRAND_CHIP}`}>asyncapi {summary.asyncapi || '—'}</span>
              </div>

              <label className={LABEL}>Channels ({summary.channels.length})</label>
              {summary.channels.length === 0 ? (
                <p className="text-[11px] text-gray-400">No channels found in this document.</p>
              ) : (
                <div className="space-y-1.5">
                  {summary.channels.map((ch) => (
                    <button
                      key={ch.name}
                      type="button"
                      onClick={() => { setChannel(ch.name); setResult(null); }}
                      className={`w-full text-left rounded-lg border px-2.5 py-2 transition-colors ${channel === ch.name ? 'bg-[#F5F3FF] border-[#DDD6FE]' : 'bg-white border-gray-100 hover:bg-gray-50'}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11.5px] text-gray-800 truncate">{ch.name}</span>
                        <span className={`ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${ch.hasSchema ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-gray-500 bg-gray-50 border-gray-200'}`}>
                          {ch.hasSchema ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}schema
                        </span>
                      </div>
                      {(ch.operations.length > 0 || ch.messageNames.length > 0) && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {ch.operations.map((o) => (
                            <span key={`op-${o}`} className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono ${BRAND_CHIP}`}>{o}</span>
                          ))}
                          {ch.messageNames.map((m) => (
                            <span key={`msg-${m}`} className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${MUTED_CHIP}`}>{m}</span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Validate */}
          <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-2">
            <div>
              <label className={LABEL}>Channel</label>
              <input value={channel} onChange={(e) => { setChannel(e.target.value); setResult(null); }} placeholder="orders/created" className={`${INPUT} font-mono text-[11px]`} />
            </div>
            <div>
              <label className={LABEL}>Message payload (JSON)</label>
              <textarea
                value={payloadText}
                onChange={(e) => { setPayloadText(e.target.value); setError(''); }}
                rows={6}
                spellCheck={false}
                className={`${INPUT} font-mono text-[11px] leading-[1.5] resize-y`}
                placeholder='{"orderId":"abc","total":42}'
              />
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={() => void validate()} disabled={validating || !payloadText.trim()} className={SECONDARY_BTN}>
                {validating ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Validate
              </button>
            </div>

            {result && (
              <div className="space-y-2">
                <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${result.valid ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                  {result.valid ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                  <span className={`text-[12.5px] font-semibold ${result.valid ? 'text-emerald-700' : 'text-red-700'}`}>
                    {result.valid ? 'Message is valid' : 'Message is invalid'}
                  </span>
                  <span className="ml-auto text-[11px] text-gray-500 font-mono">{result.channel}</span>
                </div>
                <p className="text-[11px] text-gray-500">{result.schemaFound ? 'Validated against the channel schema.' : 'No schema found for this channel — structural checks only.'}</p>
                {result.errors.length > 0 && (
                  <ul className="space-y-1">
                    {result.errors.map((er, i) => (
                      <li key={i} className="flex items-start gap-2 text-[11.5px]">
                        <code className="font-mono text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-1.5 py-0.5 flex-shrink-0">{er.path || '/'}</code>
                        <span className="text-red-700 min-w-0">{er.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

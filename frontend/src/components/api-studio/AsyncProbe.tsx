/**
 * AsyncProbe — WebSocket & Server-Sent Events testing.
 *
 * Opt-in and standalone, for the streaming protocols the request/response
 * pipeline can't express. Point it at a ws/wss URL (optionally sending one
 * frame) or an http(s) SSE stream, choose how long to listen, and it reports
 * what arrived plus an optional "expected substring" assertion. It connects to
 * the live endpoint and stores nothing; the HTTP pipeline is untouched.
 */
import { useState } from 'react';
import { X, Loader2, Radio, Play, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { runAsyncProbe, type AsyncProbeResult } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, INSET } from './format';

function protocolOf(url: string): 'websocket' | 'sse' | null {
  if (/^wss?:\/\//i.test(url)) return 'websocket';
  if (/^https?:\/\//i.test(url)) return 'sse';
  return null;
}

export default function AsyncProbe({ initialUrl = '', onClose }: { initialUrl?: string; onClose: () => void }) {
  const [url, setUrl] = useState(initialUrl);
  const [message, setMessage] = useState('');
  const [waitMs, setWaitMs] = useState(4000);
  const [expect, setExpect] = useState('');
  const [result, setResult] = useState<AsyncProbeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const protocol = protocolOf(url.trim());

  const run = async () => {
    if (!protocol) { setError('Enter a ws:// or wss:// URL, or an http(s):// SSE stream.'); return; }
    setLoading(true); setError(''); setResult(null);
    try {
      setResult(await runAsyncProbe({
        url: url.trim(),
        message: protocol === 'websocket' && message.trim() ? message : undefined,
        waitMs,
        expectContains: expect.trim() || undefined,
      }));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'The probe failed.');
    } finally { setLoading(false); }
  };

  const ok = result && result.connected && !result.error && (result.matched === undefined || result.matched);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Radio className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Async & streaming</h3>
          <span className="text-[11px] text-gray-400">WebSocket · Server-Sent Events</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div>
            <label className={LABEL}>Endpoint URL</label>
            <div className="relative">
              <input value={url} onChange={(e) => { setUrl(e.target.value); setError(''); }} placeholder="wss://example.com/socket  or  https://example.com/events" className={`${INPUT} font-mono text-[11.5px] pr-16`} />
              {protocol && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9.5px] font-semibold uppercase px-1.5 py-0.5 rounded bg-[#F5F3FF] text-[#6D28D9]">{protocol === 'websocket' ? 'WS' : 'SSE'}</span>}
            </div>
          </div>

          {protocol === 'websocket' && (
            <div>
              <label className={LABEL}>Message to send <span className="text-gray-400 font-normal">— optional, sent once on connect</span></label>
              <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder='{"type":"subscribe","channel":"prices"}' className={`${INPUT} font-mono text-[11.5px]`} />
            </div>
          )}

          <div className="grid grid-cols-[130px_1fr] gap-2.5 items-end">
            <div>
              <label className={LABEL}>Listen for</label>
              <select value={waitMs} onChange={(e) => setWaitMs(Number(e.target.value))} className={INPUT}>
                {[1000, 2000, 4000, 8000, 12000, 15000].map((ms) => <option key={ms} value={ms}>{ms / 1000}s</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL}>Expected substring <span className="text-gray-400 font-normal">— optional assertion</span></label>
              <input value={expect} onChange={(e) => setExpect(e.target.value)} placeholder='e.g. "connected"' className={INPUT} />
            </div>
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={() => void run()} disabled={loading || !protocol} className={PRIMARY_BTN}>
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {loading ? `Listening ${waitMs / 1000}s…` : 'Connect & listen'}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {result && (
            <div className="space-y-2.5">
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />}
                <span className={`text-[12px] font-medium ${ok ? 'text-emerald-800' : 'text-red-800'}`}>
                  {result.error ? result.error
                    : result.connected
                      ? `Connected · ${result.received} ${result.protocol === 'websocket' ? 'frame' : 'event'}${result.received === 1 ? '' : 's'} in ${(result.durationMs / 1000).toFixed(1)}s`
                      : 'Did not connect'}
                </span>
                {result.expectContains !== undefined && (
                  <span className={`ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${result.matched ? 'text-emerald-700 bg-emerald-100' : 'text-red-700 bg-red-100'}`}>
                    {result.matched ? 'assertion met' : 'assertion failed'}
                  </span>
                )}
              </div>

              {result.firstByteMs !== undefined && (
                <div className="text-[11px] text-gray-400">First {result.protocol === 'websocket' ? 'frame' : 'event'} at {result.firstByteMs}ms</div>
              )}

              {result.frames.length > 0 && (
                <div>
                  <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 mb-1">{result.protocol === 'websocket' ? 'Frames' : 'Events'} received</div>
                  <div className={`font-mono text-[11px] bg-[#FCFBFF] border border-[#E4E0F5] rounded-md p-2.5 max-h-56 overflow-auto space-y-1 ${INSET}`}>
                    {result.frames.map((f, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="text-gray-300 tabular-nums flex-shrink-0">{f.at}ms</span>
                        <span className="text-gray-700 whitespace-pre-wrap break-all min-w-0">{f.preview}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

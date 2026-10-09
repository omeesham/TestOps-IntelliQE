/**
 * ChatToTest — conversational chat-to-test.
 *
 * Pick an endpoint, then refine a single test by chatting in plain English
 * ("add a 401 case", "assert response time < 300ms"). Each turn re-sends the
 * running draft and the recent history, and the model returns a reply, the
 * evolving structured draft, and a rendered Playwright snippet. Opt-in and
 * standalone — it touches no pipeline.
 */
import { useState } from 'react';
import { MessageSquare, X, Send, Copy, Check, Sparkles, CheckCircle2, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { chatRefineApiTest, type ChatTestDraft, type ChatTestResult, type ChatMessage, type FlowCheck } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const EXAMPLES = [
  'add a 401 case',
  'assert the body has an id',
  'check response time under 300ms',
  'add a header Authorization',
];

/** Render a check as a short, human-readable line. */
function describeCheck(c: FlowCheck): string {
  switch (c.kind) {
    case 'status': return `status ∈ ${(c.oneOf || []).join('/') || '—'}`;
    case 'jsonPathExists': return `${c.path || 'body'} exists`;
    case 'jsonPathEquals': return `${c.path || 'body'} = ${String(c.value ?? '')}`;
    case 'bodyContains': return `body contains "${c.text || ''}"`;
    case 'responseTimeUnderMs': return `response < ${c.ms ?? 0}ms`;
    case 'header': return `header ${c.name || ''} ${c.op || 'exists'}${c.op && c.op !== 'exists' ? ` "${String(c.value ?? '')}"` : ''}`;
    case 'bodyMatches': return `body matches (${c.compareMode || 'lenient'})`;
    case 'xpath': return `xpath ${c.path || ''} ${c.op || 'exists'}${c.op && c.op !== 'exists' ? ` "${String(c.value ?? '')}"` : ''}`;
    default: return 'check';
  }
}

export default function ChatToTest({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<ChatTestDraft | null>(null);
  const [snippet, setSnippet] = useState('');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const ep = endpoints[Math.min(idx, endpoints.length - 1)];

  const reset = () => { setMessages([]); setDraft(null); setSnippet(''); setError(''); };

  const send = async () => {
    const instruction = input.trim();
    if (!instruction || !ep || loading) return;
    const prior = messages;
    setMessages([...prior, { role: 'user', content: instruction }]);
    setInput(''); setLoading(true); setError('');
    try {
      const res: ChatTestResult = await chatRefineApiTest({
        endpoint: { method: ep.method, url: ep.url, headers: ep.headers, body: ep.body },
        current: draft ?? undefined,
        history: prior.slice(-8),
        instruction,
      });
      setMessages((cur) => [...cur, { role: 'assistant', content: res.reply }]);
      setDraft(res.draft);
      setSnippet(res.snippet);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Chat refinement failed.');
    } finally { setLoading(false); }
  };

  const copy = () => {
    navigator.clipboard?.writeText(snippet).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => { /* clipboard blocked — the snippet is on screen and selectable */ },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <MessageSquare className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Chat-to-test</h3>
          <span className="text-[11px] text-gray-400">refine a test in plain English</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div>
            <label className={LABEL}>Endpoint</label>
            <select value={idx} onChange={(e) => { setIdx(Number(e.target.value)); reset(); }} className={INPUT}>
              {endpoints.map((e, i) => <option key={e.id} value={i}>{e.method} {e.url}</option>)}
            </select>
          </div>
          {ep && <div className="flex items-center gap-2 text-[11.5px] text-gray-500"><MethodBadge method={ep.method} /><span className="font-mono truncate">{ep.url}</span></div>}

          {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700">{error}</p></div>}

          <div className="grid md:grid-cols-2 gap-3">
            {/* Chat column */}
            <div className="flex flex-col">
              <div className="flex-1 min-h-[220px] max-h-[340px] overflow-y-auto space-y-2 p-2 bg-gray-50/60 border border-gray-100 rounded-lg">
                {messages.length === 0 ? (
                  <div className="text-[11.5px] text-gray-400 space-y-1 p-1">
                    <p className="text-gray-500 font-medium">Try an instruction:</p>
                    <ul className="space-y-0.5">
                      {EXAMPLES.map((x) => (
                        <li key={x}>
                          <button type="button" onClick={() => setInput(x)} className="flex items-center gap-1 text-left hover:text-[#7C3AED]"><Sparkles className="w-3 h-3 text-[#A78BFA] flex-shrink-0" />{x}</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  messages.map((m, i) => (
                    <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] px-2.5 py-1.5 rounded-lg text-[12px] whitespace-pre-wrap ${m.role === 'user' ? 'bg-[#7C3AED] text-white' : 'bg-white border border-gray-200 text-gray-700'}`}>{m.content}</div>
                    </div>
                  ))
                )}
                {loading && <div className="flex justify-start"><div className="px-2.5 py-1.5 rounded-lg bg-white border border-gray-200 text-[#7C3AED]"><Spinner className="w-3.5 h-3.5 animate-spin" /></div></div>}
              </div>
              <div className="flex gap-2 mt-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                  placeholder="Describe a change… e.g. add a 401 case"
                  disabled={loading || !ep}
                  className={INPUT}
                />
                <button type="button" onClick={() => void send()} disabled={loading || !input.trim() || !ep} className={PRIMARY_BTN}>{loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}</button>
              </div>
            </div>

            {/* Draft column */}
            <div className="space-y-2">
              {!draft ? (
                <div className="text-[11.5px] text-gray-400 border border-dashed border-gray-200 rounded-lg p-4 text-center">The refined test will appear here.</div>
              ) : (
                <>
                  <div className={`${CARD} p-3 space-y-2`}>
                    <div className="text-[12px] font-semibold text-gray-800">{draft.title}</div>
                    <div className="flex items-center gap-2"><MethodBadge method={draft.method} /><span className="text-[11.5px] font-mono text-gray-500 truncate">{draft.url}</span></div>
                    {draft.headers.length > 0 && (
                      <div>
                        <div className={LABEL}>Headers</div>
                        <div className="space-y-0.5">{draft.headers.map((h, i) => <div key={i} className="text-[11px] font-mono text-gray-600 truncate"><span className="text-gray-400">{h.key}:</span> {h.value}</div>)}</div>
                      </div>
                    )}
                    {draft.body && (
                      <div>
                        <div className={LABEL}>Body</div>
                        <pre className="text-[10.5px] font-mono text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto max-h-32">{draft.body}</pre>
                      </div>
                    )}
                    {draft.checks.length > 0 && (
                      <div>
                        <div className={LABEL}>Assertions</div>
                        <ul className="space-y-0.5">{draft.checks.map((c, i) => <li key={i} className="flex items-center gap-1.5 text-[11.5px] text-gray-700"><CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />{describeCheck(c)}</li>)}</ul>
                      </div>
                    )}
                  </div>

                  {snippet && (
                    <div className={`${CARD} overflow-hidden`}>
                      <div className={`flex items-center gap-2 px-3 h-9 border-b border-gray-100 ${STRIP}`}>
                        <span className="text-[11px] font-semibold text-gray-600">Playwright</span>
                        <button type="button" onClick={copy} className="ml-auto inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-[#7C3AED]">{copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? 'Copied' : 'Copy'}</button>
                      </div>
                      <pre className="text-[10.5px] font-mono text-gray-700 p-3 overflow-x-auto max-h-56">{snippet}</pre>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

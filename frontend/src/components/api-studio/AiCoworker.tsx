/**
 * AiCoworker — a conversational + autonomous orchestrator over the API workspace.
 *
 * Two opt-in surfaces behind one modal. "Coworker" is a chat: ask in plain
 * English ("where are my coverage gaps?", "what changed and which tests should
 * I run?") and the orchestrator classifies the intent, runs the matching
 * read-only analysis, and answers with a compact summary plus a suggested next
 * action. "Autonomy" wires the same orchestrator to events — point a GitHub PR
 * or Jira sprint webhook at the minted URL and matching events are recorded and
 * surfaced as suggested actions. Standalone; nothing here mutates the pipeline.
 */
import { useState, useEffect, useRef } from 'react';
import { Bot, Send, Sparkles, X, RefreshCw, Webhook, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  orchestrate,
  getOrchestratorConfig,
  saveOrchestratorConfig,
  rotateOrchestratorToken,
  listOrchestratorEvents,
  type OrchestrateResult,
  type OrchestratorConfigView,
  type OrchestratorEvent,
} from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, relativeTime } from './format';
import { CopyButton, EmptyState } from './primitives';
import type { CatalogEndpoint } from './types';

type Tab = 'coworker' | 'autonomy';

/** One line of the chat — carries the orchestrator's intent, data and plan so each reply can summarise itself. */
type ChatMsg = {
  role: 'user' | 'assistant';
  content: string;
  intent?: string;
  data?: any;
  plan?: { action: string; params?: Record<string, unknown> };
};

const EXAMPLES = [
  'Where are my coverage gaps?',
  'What changed and which tests should I run?',
  'Draft a maintenance changeset',
];

const TAB_ACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-[#6D28D9] border-b-2 border-[#7C3AED]';
const TAB_INACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-gray-500 hover:text-gray-700';

/** Classify an event's status into one of the app's chip tones. */
function eventStatusClass(status: string): string {
  const s = (status || '').toLowerCase();
  if (/(ok|success|done|processed|applied|complete)/.test(s)) return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (/(fail|error|reject)/.test(s)) return 'text-red-700 bg-red-50 border-red-200';
  if (/(pending|queued|new|received|running)/.test(s)) return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]';
}

/**
 * Turn an assistant reply's `data` into one compact line — never raw JSON.
 * Defensive throughout: an unknown shape falls back to a brief `data.summary`.
 */
function summarize(intent: string | undefined, data: any): string | null {
  if (data === undefined || data === null) return null;
  try {
    if (intent === 'coverage') {
      const parts: string[] = [];
      if (data.coveragePct !== undefined && data.coveragePct !== null) parts.push(`${data.coveragePct}% covered`);
      const gaps = Array.isArray(data.gaps) ? data.gaps.length
        : typeof data.gaps === 'number' ? data.gaps
        : data.summary?.gaps;
      if (gaps !== undefined && gaps !== null) parts.push(`${gaps} gap${gaps === 1 ? '' : 's'}`);
      if (parts.length) return parts.join(' · ');
    } else if (intent === 'maintenance') {
      const p = data.summary?.proposals;
      if (p !== undefined && p !== null) return `${p} proposal${p === 1 ? '' : 's'}`;
    } else if (intent === 'impact') {
      const parts: string[] = [];
      const selectedPct = data.summary?.selectedPct;
      if (selectedPct !== undefined && selectedPct !== null) parts.push(`${selectedPct}% selected`);
      const impacted = data.impacted?.length;
      if (impacted !== undefined && impacted !== null) parts.push(`${impacted} impacted`);
      if (parts.length) return parts.join(' · ');
    }
    const s = data.summary;
    if (s !== undefined && s !== null) {
      const str = typeof s === 'string' ? s : JSON.stringify(s);
      return str.length > 160 ? `${str.slice(0, 160)}…` : str;
    }
  } catch {
    /* unknown shape — nothing to summarise */
  }
  return null;
}

export default function AiCoworker({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('coworker');
  const [error, setError] = useState('');

  // ── Coworker (chat) ──
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  // ── Autonomy (event-triggered config) ──
  const [config, setConfig] = useState<OrchestratorConfigView | null>(null);
  const [events, setEvents] = useState<OrchestratorEvent[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [triggers, setTriggers] = useState<string[]>([]);
  const [action, setAction] = useState('maintenance');
  const [cfgLoading, setCfgLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  const loadConfig = async () => {
    const cfg = await getOrchestratorConfig();
    setConfig(cfg);
    setEnabled(cfg.enabled);
    setTriggers(cfg.triggers || []);
    setAction(cfg.action || 'maintenance');
  };

  const loadEvents = async () => {
    const { events: list } = await listOrchestratorEvents();
    setEvents(list || []);
  };

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([loadConfig(), loadEvents()]);
      } catch (e: any) {
        setError(e?.response?.data?.error || e?.message || 'Could not load the autonomy config.');
      } finally {
        setCfgLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTab = (t: Tab) => { setTab(t); setError(''); };

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const prior = messages;
    setMessages([...prior, { role: 'user', content: text }]);
    setInput(''); setLoading(true); setError('');
    try {
      const res: OrchestrateResult = await orchestrate({
        message: text,
        endpoints: endpoints.map((e) => ({ id: e.id, title: e.title, method: e.method, url: e.url })),
        history: prior.map((m) => ({ role: m.role, content: m.content })),
      });
      setMessages((cur) => [...cur, { role: 'assistant', content: res.reply, intent: res.intent, data: res.data, plan: res.plan }]);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'The coworker could not respond.');
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      const cfg = await saveOrchestratorConfig({ enabled, triggers, action });
      setConfig(cfg);
      setEnabled(cfg.enabled);
      setTriggers(cfg.triggers || []);
      setAction(cfg.action || action);
      toast.success('Autonomy saved');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save the autonomy config.');
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
    setSaving(true); setError('');
    try {
      const { token } = await rotateOrchestratorToken();
      await loadConfig();
      // Surface the freshly minted token even if the config read omits the raw value.
      setConfig((c: OrchestratorConfigView | null) => (c ? { ...c, token, hasToken: true } : c));
      toast.success('Token minted');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not mint a token.');
    } finally {
      setSaving(false);
    }
  };

  const toggleTrigger = (name: string) =>
    setTriggers((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]));

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const webhookUrl = config?.token ? `${origin}${config.eventPath}/${config.token}` : '';
  const empty = messages.length === 0 && !loading;

  const errorBlock = error ? (
    <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
      <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
      <p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
    </div>
  ) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Bot className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">AI coworker</h3>
          <span className="text-[11px] text-gray-400">your API testing pair — chat &amp; autonomous actions</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-3 border-b border-[#EDE9FE] flex-shrink-0 bg-white">
          <button type="button" onClick={() => switchTab('coworker')} className={tab === 'coworker' ? TAB_ACTIVE : TAB_INACTIVE}>Coworker</button>
          <button type="button" onClick={() => switchTab('autonomy')} className={tab === 'autonomy' ? TAB_ACTIVE : TAB_INACTIVE}>Autonomy</button>
        </div>

        {tab === 'coworker' ? (
          /* ── Coworker chat ── */
          <div className="flex-1 min-h-0 flex flex-col">
            <div className={`flex-1 min-h-0 overflow-y-auto ${empty ? 'flex flex-col' : ''}`}>
              {empty ? (
                <div className="m-auto max-w-md w-full">
                  <EmptyState icon={Bot} title="Your API coworker" hint="Ask about coverage, what changed, or draft a maintenance changeset — the orchestrator runs the right analysis and answers." />
                  <div className="flex flex-wrap justify-center gap-2 px-6 pb-8">
                    {EXAMPLES.map((x) => (
                      <button
                        key={x}
                        type="button"
                        onClick={() => setInput(x)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[#DDD6FE] bg-[#F5F3FF] text-[11.5px] text-[#6D28D9] hover:bg-[#EDE9FE] transition-colors"
                      >
                        <Sparkles className="w-3 h-3 flex-shrink-0" />{x}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="p-4 space-y-2">
                  {messages.map((m, i) => {
                    if (m.role === 'user') {
                      return (
                        <div key={i} className="flex justify-end">
                          <div className="max-w-[85%] px-2.5 py-1.5 rounded-lg text-[12px] whitespace-pre-wrap bg-[#7C3AED] text-white">{m.content}</div>
                        </div>
                      );
                    }
                    const summary = summarize(m.intent, m.data);
                    return (
                      <div key={i} className="flex justify-start">
                        <div className="max-w-[85%] space-y-1">
                          {m.intent && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]">
                              <Sparkles className="w-3 h-3" />{m.intent}
                            </span>
                          )}
                          <div className="px-2.5 py-1.5 rounded-lg text-[12px] whitespace-pre-wrap bg-white border border-gray-200 text-gray-700">{m.content}</div>
                          {summary && (
                            <div className="px-2 py-1 rounded-md bg-[#FAF9FE] border border-[#E4E0F5] text-[11px] text-gray-600 font-mono break-words">{summary}</div>
                          )}
                          {m.plan && <div className="text-[11px] text-gray-400 italic">Suggested: open {m.plan.action}</div>}
                        </div>
                      </div>
                    );
                  })}
                  {loading && (
                    <div className="flex justify-start">
                      <div className="px-2.5 py-1.5 rounded-lg bg-white border border-gray-200 text-[#7C3AED]"><Spinner className="w-3.5 h-3.5 animate-spin" /></div>
                    </div>
                  )}
                  <div ref={endRef} />
                </div>
              )}
            </div>

            <div className="border-t border-gray-100 p-3 space-y-2 flex-shrink-0">
              {errorBlock}
              <div className="flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                  placeholder="Ask your coworker… e.g. where are my coverage gaps?"
                  disabled={loading}
                  className={INPUT}
                />
                <button type="button" onClick={() => void send()} disabled={loading || !input.trim()} className={PRIMARY_BTN}>
                  {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ── Autonomy ── */
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {errorBlock}
            {cfgLoading ? (
              <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
            ) : config ? (
              <>
                {/* Config */}
                <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-3">
                  <label className="flex items-center gap-2 text-[12px] text-gray-700">
                    <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-3.5 h-3.5" />
                    <span className="font-medium">Enable autonomous actions</span>
                  </label>

                  <div>
                    <label className={LABEL}>Triggers</label>
                    <div className="flex flex-wrap gap-4">
                      <label className="flex items-center gap-2 text-[12px] text-gray-600">
                        <input type="checkbox" checked={triggers.includes('pull_request')} onChange={() => toggleTrigger('pull_request')} className="w-3.5 h-3.5" />
                        Pull request
                      </label>
                      <label className="flex items-center gap-2 text-[12px] text-gray-600">
                        <input type="checkbox" checked={triggers.includes('sprint_started')} onChange={() => toggleTrigger('sprint_started')} className="w-3.5 h-3.5" />
                        Sprint started
                      </label>
                    </div>
                  </div>

                  <div>
                    <label className={LABEL}>Action</label>
                    <select value={action} onChange={(e) => setAction(e.target.value)} className={FIELD}>
                      <option value="maintenance">Maintenance</option>
                      <option value="coverage">Coverage</option>
                    </select>
                  </div>

                  <div className="flex justify-end">
                    <button type="button" onClick={() => void save()} disabled={saving} className={PRIMARY_BTN}>
                      {saving && <Spinner className="w-3.5 h-3.5 animate-spin" />}Save
                    </button>
                  </div>
                </div>

                {/* Webhook */}
                <div>
                  <label className={LABEL}>Webhook URL</label>
                  {config.token ? (
                    <div className="flex items-center gap-1.5">
                      <Webhook className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                      <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-2 py-1.5">{webhookUrl}</code>
                      <CopyButton text={webhookUrl} />
                    </div>
                  ) : (
                    <p className="text-[11.5px] text-gray-400">No token yet — mint one below to get a webhook URL.</p>
                  )}
                  <div className="mt-2">
                    <button type="button" onClick={() => void rotate()} disabled={saving} className={SECONDARY_BTN}>
                      {saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Mint / rotate token
                    </button>
                  </div>
                  <p className="text-[10.5px] text-gray-400 mt-2">Point your GitHub PR or Jira sprint webhook here; matching events are recorded and surfaced as suggested actions.</p>
                </div>

                {/* Recent events */}
                <div>
                  <label className={LABEL}>Recent events</label>
                  {events.length === 0 ? (
                    <p className="text-[11.5px] text-gray-400">No events yet.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {events.map((ev) => (
                        <div key={ev.id} className={`${CARD} px-3 py-2 flex items-center gap-2`}>
                          <span className="text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-1.5 py-0.5 flex-shrink-0">{ev.source}</span>
                          <span className="text-[11px] text-gray-500 flex-shrink-0">{ev.type}</span>
                          <span className="text-[12px] text-gray-700 truncate min-w-0 flex-1">{ev.summary}</span>
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 ${eventStatusClass(ev.status)}`}>{ev.status}</span>
                          <span className="text-[10.5px] text-gray-400 flex-shrink-0 tabular-nums">{relativeTime(ev.createdAt)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p className="text-[12px] text-gray-400 text-center py-8">Could not load the autonomy config.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

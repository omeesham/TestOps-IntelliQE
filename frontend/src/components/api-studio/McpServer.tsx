/**
 * McpServer — mint per-tenant MCP tokens.
 *
 * Exposes IntelliQE's API-testing tools (probe, import, load-test, capture,
 * coverage) to MCP clients such as Claude Code and Cursor. Each token is a
 * tenant-scoped bearer baked into the MCP endpoint URL; pasting the ready-made
 * client config into a client's `.mcp.json` wires the tools up. The URL is a
 * credential — anyone holding it calls the tools as this tenant — so deleting a
 * token revokes it. Standalone and opt-in; nothing here touches the pipeline.
 */
import { useEffect, useState } from 'react';
import { X, Server, Plus, Trash2, Copy, Check, AlertTriangle, Link2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { listMcpTokens, createMcpToken, deleteMcpToken, type McpToken } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, SECONDARY_BTN } from './format';

const TOOLS: { name: string; desc: string }[] = [
  { name: 'probe_endpoint', desc: 'Send a request to any endpoint and inspect the live response.' },
  { name: 'import_openapi', desc: 'Import an OpenAPI / Swagger spec into the endpoint catalogue.' },
  { name: 'load_test', desc: 'Fire a bounded burst at an endpoint and report latency percentiles.' },
  { name: 'list_capture_sessions', desc: 'List recorded traffic-capture sessions for this tenant.' },
  { name: 'coverage_gaps', desc: 'Surface endpoints and cases that have no test coverage yet.' },
];

export default function McpServer({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'url' | 'config' | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const selected = tokens.find((t) => t.id === selectedId) || tokens[0] || null;
  const mcpUrl = selected ? `${origin}/mcp/${selected.token}` : '';
  const clientConfig = JSON.stringify({ mcpServers: { intelliqe: { url: mcpUrl } } }, null, 2);

  const load = async (selectId?: string) => {
    const { tokens: list } = await listMcpTokens();
    setTokens(list);
    if (selectId) setSelectedId(selectId);
    else if (!list.some((t) => t.id === selectedId)) setSelectedId(list[0]?.id || '');
  };

  useEffect(() => {
    (async () => {
      try { await load(); }
      catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Could not load MCP tokens.'); }
      finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    setBusy(true); setError('');
    try {
      const { token } = await createMcpToken(name.trim() || undefined);
      setName('');
      await load(token.id);
      toast.success('Token created', token.name);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not create a token.');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      await deleteMcpToken(selected.id);
      await load();
      toast.success('Token revoked');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not delete the token.');
    } finally { setBusy(false); }
  };

  const copy = async (text: string, key: 'url' | 'config') => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1500); }
    catch { /* clipboard blocked */ }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Server className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">MCP server</h3>
          <span className="text-[11px] text-gray-400">expose IntelliQE tools to AI coding agents</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {/* New token */}
          <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3">
            <label className={LABEL}>New token</label>
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <input value={name} onChange={(e) => { setName(e.target.value); setError(''); }} placeholder="Token name (e.g. Claude Code)" className={INPUT} />
              </div>
              <button type="button" onClick={() => void create()} disabled={busy} className={SECONDARY_BTN}>
                {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Create
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : tokens.length === 0 ? (
            <div className="text-center py-6 text-[12px] text-gray-400">No tokens yet — create one above to connect an MCP client.</div>
          ) : (
            <>
              <div>
                <label className={LABEL}>Token</label>
                <div className="flex items-center gap-2">
                  <select value={selected?.id || ''} onChange={(e) => setSelectedId(e.target.value)} className={INPUT}>
                    {tokens.map((t) => (
                      <option key={t.id} value={t.id}>{t.name} · {new Date(t.createdAt).toLocaleDateString()}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => void remove()} disabled={busy || !selected} className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-40" title="Delete (revokes the token)"><Trash2 className="w-4 h-4" /></button>
                </div>
                {selected?.lastUsedAt && <p className="text-[10.5px] text-gray-400 mt-1">Last used {new Date(selected.lastUsedAt).toLocaleString()}</p>}
              </div>

              {/* MCP endpoint URL */}
              <div>
                <label className={LABEL}>MCP endpoint</label>
                <div className="flex items-center gap-1.5">
                  <Link2 className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                  <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-2 py-1.5">{mcpUrl}</code>
                  <button type="button" onClick={() => void copy(mcpUrl, 'url')} className={SECONDARY_BTN}>
                    {copied === 'url' ? <><Check className="w-3.5 h-3.5" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}
                  </button>
                </div>
              </div>

              {/* Client config */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className={`${LABEL} mb-0`}>Client config</label>
                  <span className="text-[10.5px] text-gray-400">paste into Claude Code / Cursor <code className="font-mono">.mcp.json</code></span>
                  <button type="button" onClick={() => void copy(clientConfig, 'config')} className={`${SECONDARY_BTN} ml-auto`}>
                    {copied === 'config' ? <><Check className="w-3.5 h-3.5" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}
                  </button>
                </div>
                <pre className="text-[11px] font-mono text-gray-700 bg-[#FCFBFF] border border-[#E4E0F5] rounded-lg p-3 overflow-x-auto whitespace-pre">{clientConfig}</pre>
              </div>
            </>
          )}

          {/* Exposed tools */}
          <div>
            <label className={LABEL}>Exposed tools</label>
            <ul className="space-y-1.5">
              {TOOLS.map((t) => (
                <li key={t.name} className="flex items-start gap-2 text-[11.5px]">
                  <code className="font-mono text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-1.5 py-0.5 flex-shrink-0">{t.name}</code>
                  <span className="text-gray-500 min-w-0">{t.desc}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Security note */}
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-px" />
            <p className="text-[11.5px] text-amber-700 min-w-0">Anyone with this URL can call these tools as your tenant. Delete the token to revoke.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

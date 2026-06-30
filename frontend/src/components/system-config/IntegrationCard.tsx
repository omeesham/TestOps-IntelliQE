import { XCircle, RefreshCw, Loader2, CheckCircle, AlertCircle, Plug, Trash2 } from 'lucide-react';
import { LOGOS } from './integrationCatalog';

interface Props {
  id: string;
  name: string;
  category: string;
  description: string;
  comingSoon: boolean;
  status: 'connected' | 'available' | 'disconnected' | 'coming_soon';
  connectedBy?: string | null;
  lastSyncAt?: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  /** Reactivate a disconnected integration (reuses its saved config). */
  onReconnect?: () => void;
  /** Permanently delete the saved configuration. */
  onDelete?: () => void;
  /** Optional connectivity test for connected integrations (e.g. git repos). */
  onTest?: () => void;
  testing?: boolean;
  testResult?: { ok: boolean; message: string } | null;
}

const badge: Record<string, { label: string; color: string; bg: string; dot: string | null }> = {
  connected: { label: 'Connected', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500' },
  available: { label: 'Available', color: 'text-gray-500', bg: 'bg-gray-50 border-gray-200', dot: null },
  disconnected: { label: 'Disconnected', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200', dot: 'bg-amber-400' },
  coming_soon: { label: 'Coming Soon', color: 'text-gray-400', bg: 'bg-gray-50 border-gray-200', dot: null },
};

function timeSince(dateStr: string | null): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function IntegrationCard({ id, name, category, description, comingSoon, status, connectedBy, lastSyncAt, onConnect, onDisconnect, onReconnect, onDelete, onTest, testing, testResult }: Props) {
  const b = badge[status] || badge.available;
  const logo = LOGOS[id];

  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#DDD6FE]/60 p-5 hover:shadow-lg hover:shadow-purple-500/5 transition-all">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center border border-gray-100">
            {logo ? (
              <img src={logo} alt={name} className="w-6 h-6"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; const fb = (e.target as HTMLImageElement).nextElementSibling; if (fb) (fb as HTMLElement).style.display = ''; }}
              />
            ) : null}
            <span className="text-lg font-bold text-[#7C3AED]" style={{ display: logo ? 'none' : '' }}>{name.charAt(0)}</span>
          </div>
          <div>
            <h4 className="font-semibold text-[#1E1B4B]">{name}</h4>
            <p className="text-xs text-[#A5B4FC]">{category}</p>
          </div>
        </div>
        <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${b.bg}`}>
          {b.dot && <span className={`w-2 h-2 rounded-full ${b.dot} shadow-[0_0_0_3px_rgba(16,185,129,0.18)]`} />}
          <span className={b.color}>{b.label}</span>
        </span>
      </div>
      <p className="text-sm text-[#6B7280] mb-3">{description}</p>
      <div className="flex items-center justify-between">
        {lastSyncAt && (
          <p className="text-xs text-[#A5B4FC] flex items-center gap-1"><RefreshCw className="w-3 h-3" /> Synced {timeSince(lastSyncAt)}</p>
        )}
        {connectedBy && <p className="text-xs text-[#A5B4FC]">by {connectedBy}</p>}
        {status === 'connected' ? (
          <div className="flex items-center gap-3 ml-auto">
            {onTest && (
              <button
                onClick={onTest}
                disabled={testing}
                className="text-xs text-[#7C3AED] hover:underline flex items-center gap-1 disabled:opacity-50"
              >
                {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plug className="w-3 h-3" />}
                {testing ? 'Testing…' : 'Test connection'}
              </button>
            )}
            <button onClick={onDisconnect} className="text-xs text-amber-600 hover:underline flex items-center gap-1">
              Disconnect <XCircle className="w-3 h-3" />
            </button>
            {onDelete && (
              <button onClick={onDelete} className="text-xs text-red-500 hover:underline flex items-center gap-1" title="Delete saved configuration">
                Delete <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        ) : status === 'disconnected' ? (
          <div className="flex items-center gap-3 ml-auto">
            <button onClick={onReconnect || onConnect} className="px-3 py-1.5 bg-[#F5F3FF] text-[#7C3AED] rounded-lg text-xs font-medium hover:bg-[#EDE9FE] transition-colors flex items-center gap-1">
              <Plug className="w-3 h-3" />Reconnect
            </button>
            {onDelete && (
              <button onClick={onDelete} className="text-xs text-red-500 hover:underline flex items-center gap-1" title="Delete saved configuration">
                Delete <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        ) : status === 'available' ? (
          <button onClick={onConnect} className="px-3 py-1.5 bg-[#F5F3FF] text-[#7C3AED] rounded-lg text-xs font-medium hover:bg-[#EDE9FE] transition-colors ml-auto">
            Connect
          </button>
        ) : null}
      </div>
      {testResult && (
        <div className={`mt-3 flex items-start gap-2 p-2.5 rounded-lg text-xs border ${testResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-600'}`}>
          {testResult.ok ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
          <span>{testResult.message}</span>
        </div>
      )}
    </div>
  );
}

import { CheckCircle, Plug, XCircle, RefreshCw } from 'lucide-react';
import { LOGOS } from './integrationCatalog';

interface Props {
  id: string;
  name: string;
  category: string;
  description: string;
  comingSoon: boolean;
  status: 'connected' | 'available' | 'coming_soon';
  connectedBy?: string | null;
  lastSyncAt?: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

const badge: Record<string, { label: string; color: string; bg: string }> = {
  connected: { label: 'Connected', color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200' },
  available: { label: 'Available', color: 'text-[#155dfc]', bg: 'bg-[#EFF5FF] border-[#C9DCFF]' },
  coming_soon: { label: 'Coming Soon', color: 'text-gray-500', bg: 'bg-gray-50 border-gray-200' },
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

export default function IntegrationCard({ id, name, category, description, status, connectedBy, lastSyncAt, onConnect, onDisconnect }: Props) {
  const b = badge[status] || badge.available;
  const logo = LOGOS[id];

  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#C9DCFF]/60 p-5 hover:shadow-lg hover:shadow-blue-500/5 transition-all">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center border border-gray-100">
            {logo ? (
              <img src={logo} alt={name} className="w-6 h-6"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; const fb = (e.target as HTMLImageElement).nextElementSibling; if (fb) (fb as HTMLElement).style.display = ''; }}
              />
            ) : null}
            <span className="text-lg font-bold text-[#155dfc]" style={{ display: logo ? 'none' : '' }}>{name.charAt(0)}</span>
          </div>
          <div>
            <h4 className="font-semibold text-[#1E1B4B]">{name}</h4>
            <p className="text-xs text-[#93B4FB]">{category}</p>
          </div>
        </div>
        <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${b.bg}`}>
          {status === 'connected' ? <CheckCircle className="w-3 h-3 text-emerald-500" /> : status === 'available' ? <Plug className="w-3 h-3 text-[#155dfc]" /> : <XCircle className="w-3 h-3 text-gray-400" />}
          <span className={b.color}>{b.label}</span>
        </span>
      </div>
      <p className="text-sm text-[#6B7280] mb-3">{description}</p>
      <div className="flex items-center justify-between">
        {lastSyncAt && (
          <p className="text-xs text-[#93B4FB] flex items-center gap-1"><RefreshCw className="w-3 h-3" /> Synced {timeSince(lastSyncAt)}</p>
        )}
        {connectedBy && <p className="text-xs text-[#93B4FB]">by {connectedBy}</p>}
        {status === 'connected' ? (
          <button onClick={onDisconnect} className="text-xs text-red-500 hover:underline flex items-center gap-1 ml-auto">
            Disconnect <XCircle className="w-3 h-3" />
          </button>
        ) : status === 'available' ? (
          <button onClick={onConnect} className="px-3 py-1.5 bg-[#EFF5FF] text-[#155dfc] rounded-lg text-xs font-medium hover:bg-[#DEEAFF] transition-colors ml-auto">
            Connect
          </button>
        ) : null}
      </div>
    </div>
  );
}

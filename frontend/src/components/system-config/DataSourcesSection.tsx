import { useState, useMemo } from 'react';
import { getDataSources } from './integrationCatalog';
import type { CatalogItem } from './integrationCatalog';
import IntegrationCard from './IntegrationCard';
import ConnectModal from './ConnectModal';
import { connectIntegration, disconnectIntegration } from '@/services/api';
import { normalizeError } from '@/utils/apiError';

interface DbConfig {
  integrationId: string;
  status: string;
  configData: Record<string, unknown>;
  connectedBy: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
}

interface Props {
  configs: DbConfig[];
  onRefresh: () => void;
}

export default function DataSourcesSection({ configs, onRefresh }: Props) {
  const [connectModal, setConnectModal] = useState<CatalogItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const catalog = useMemo(() => getDataSources(), []);

  // Merge catalog with live DB state
  const mergedItems = useMemo(() => {
    return catalog.map((cat) => {
      const dbRow = configs.find((c) => c.integrationId === cat.id);
      if (cat.comingSoon) {
        return { ...cat, status: 'coming_soon' as const, dbRow: null };
      }
      if (dbRow && dbRow.status === 'connected') {
        return { ...cat, status: 'connected' as const, dbRow };
      }
      return { ...cat, status: 'available' as const, dbRow: null };
    });
  }, [catalog, configs]);

  const connectedCount = mergedItems.filter((i) => i.status === 'connected').length;
  const availableCount = mergedItems.filter((i) => i.status === 'available').length;

  const handleConnect = (cat: CatalogItem) => {
    setConnectModal(cat);
    setError('');
  };

  const handleDisconnect = async (integrationId: string) => {
    try {
      await disconnectIntegration(integrationId);
      onRefresh();
    } catch (err) {
      console.error('Disconnect error:', err);
    }
  };

  const handleSaveConnect = async (formData: Record<string, string>) => {
    if (!connectModal) return;
    setSaving(true);
    setError('');
    try {
      await connectIntegration(connectModal.id, formData);
      setConnectModal(null);
      onRefresh();
    } catch (err) {
      setError(normalizeError(err).message || 'Failed to connect');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[#1E1B4B] mb-1">Storage Providers</h3>
          <p className="text-xs text-[#6B7280]">
            Connect cloud storage for test artifacts (screenshots, traces, reports)
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border bg-emerald-50 border-emerald-200 text-emerald-600">
            {connectedCount} connected
          </span>
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border bg-[#EFF5FF] border-[#C9DCFF] text-[#155dfc]">
            {availableCount} available
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {mergedItems.map((item) => (
          <IntegrationCard
            key={item.id}
            id={item.id}
            name={item.name}
            category={item.category}
            description={item.description}
            comingSoon={item.comingSoon}
            status={item.status}
            connectedBy={item.dbRow?.connectedBy}
            lastSyncAt={item.dbRow?.lastSyncAt}
            onConnect={() => handleConnect(item)}
            onDisconnect={() => handleDisconnect(item.id)}
          />
        ))}
      </div>

      {/* Connect Modal */}
      {connectModal && (
        <ConnectModal
          integration={connectModal}
          saving={saving}
          error={error}
          onSave={handleSaveConnect}
          onClose={() => {
            setConnectModal(null);
            setError('');
          }}
        />
      )}
    </div>
  );
}

import { useState } from 'react';
import { getGitRepos } from './integrationCatalog';
import IntegrationCard from './IntegrationCard';
import ConnectModal from './ConnectModal';
import { connectIntegration, disconnectIntegration } from '@/services/api';
import type { CatalogItem } from './integrationCatalog';

interface DbConfig {
  integrationId: string;
  status: string;
  configData: Record<string, any>;
  connectedBy: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
}

interface Props {
  configs: DbConfig[];
  onRefresh: () => void;
}

export default function GitRepositoriesSection({ configs, onRefresh }: Props) {
  const catalog = getGitRepos();

  const [modalIntegration, setModalIntegration] = useState<CatalogItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /** Merge catalog entries with live config state */
  const merged = catalog.map((item) => {
    const cfg = configs.find((c) => c.integrationId === item.id);
    const status: 'connected' | 'available' | 'coming_soon' = item.comingSoon
      ? 'coming_soon'
      : cfg?.status === 'connected'
        ? 'connected'
        : 'available';
    return { ...item, status, connectedBy: cfg?.connectedBy ?? null, lastSyncAt: cfg?.lastSyncAt ?? null };
  });

  const handleConnect = async (formData: Record<string, string>) => {
    if (!modalIntegration) return;
    setSaving(true);
    setError('');
    try {
      await connectIntegration(modalIntegration.id, formData);
      setModalIntegration(null);
      onRefresh();
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || 'Connection failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async (integrationId: string) => {
    try {
      await disconnectIntegration(integrationId);
      onRefresh();
    } catch (err: any) {
      console.error('Failed to disconnect:', err);
    }
  };

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-[#1E1B4B]">Git Repositories</h3>
        <p className="text-xs text-[#6B7280] mt-0.5">
          Connect version control platforms to trigger test generation on PRs and push test scripts.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {merged.map((item) => (
          <IntegrationCard
            key={item.id}
            id={item.id}
            name={item.name}
            category={item.category}
            description={item.description}
            comingSoon={item.comingSoon}
            status={item.status}
            connectedBy={item.connectedBy}
            lastSyncAt={item.lastSyncAt}
            onConnect={() => {
              setError('');
              setModalIntegration(catalog.find((c) => c.id === item.id) ?? null);
            }}
            onDisconnect={() => handleDisconnect(item.id)}
          />
        ))}
      </div>

      {modalIntegration && (
        <ConnectModal
          integration={modalIntegration}
          saving={saving}
          error={error}
          onSave={handleConnect}
          onClose={() => {
            setModalIntegration(null);
            setError('');
          }}
        />
      )}
    </div>
  );
}

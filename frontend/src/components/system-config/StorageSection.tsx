import { useState } from 'react';
import { getStorageIntegrations, prefillFromConfig } from './integrationCatalog';
import type { CatalogItem } from './integrationCatalog';
import IntegrationCard from './IntegrationCard';
import ConnectModal from './ConnectModal';
import { connectAzureStorage, testAzureStorage, disconnectIntegration, reconnectIntegration, deleteIntegration } from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';

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

/**
 * Storage — durable archive for execution reports. Every generated report is
 * copied here (latest 10 kept) so the Reports page can reload them even after
 * the app's local disk is recycled.
 */
export default function StorageSection({ configs, onRefresh }: Props) {
  const toast = useToast();
  const catalog = getStorageIntegrations();

  const [modalIntegration, setModalIntegration] = useState<CatalogItem | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string> | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const merged = catalog.map((item) => {
    const cfg = configs.find((c) => c.integrationId === item.id);
    const status: 'connected' | 'available' | 'disconnected' | 'coming_soon' = item.comingSoon
      ? 'coming_soon'
      : cfg?.status === 'connected'
        ? 'connected'
        : cfg
          ? 'disconnected'
          : 'available';
    return { ...item, status };
  });

  const handleConnect = async (formData: Record<string, string>) => {
    if (!modalIntegration) return;
    setSaving(true);
    setError('');
    try {
      await connectAzureStorage({
        accountUrl: formData.accountUrl || '',
        connectionString: formData.connectionString || '',
        containerName: formData.containerName || '',
        prefix: formData.prefix || '',
      });
      setModalIntegration(null);
      setEditValues(undefined);
      onRefresh();
      toast.success('Azure Storage connected');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Connection failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async (integrationId: string) => {
    try { await disconnectIntegration(integrationId); onRefresh(); toast.success('Disconnected successfully'); }
    catch (err: any) { console.error('Disconnect error:', err); toast.fromError(err); }
  };
  const handleReconnect = async (integrationId: string) => {
    try { await reconnectIntegration(integrationId); onRefresh(); toast.success('Reconnected successfully'); }
    catch (err: any) { console.error('Reconnect error:', err); toast.fromError(err); }
  };
  const handleDelete = async (integrationId: string) => {
    try { await deleteIntegration(integrationId); onRefresh(); toast.success('Deleted successfully'); }
    catch (err: any) { console.error('Delete error:', err); toast.fromError(err); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[#1E1B4B] mb-1">Storage</h3>
        <p className="text-xs text-[#6B7280]">
          Durable storage for execution reports. The latest 10 reports are kept.
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
            onConnect={() => {
              setError('');
              setEditValues(undefined);
              setModalIntegration(catalog.find((c) => c.id === item.id) ?? null);
            }}
            onDisconnect={() => handleDisconnect(item.id)}
            onReconnect={() => handleReconnect(item.id)}
            onDelete={() => handleDelete(item.id)}
            onEdit={
              item.status === 'connected' || item.status === 'disconnected'
                ? () => {
                    setError('');
                    setEditValues(prefillFromConfig(item, configs.find((c) => c.integrationId === item.id)?.configData));
                    setModalIntegration(catalog.find((c) => c.id === item.id) ?? null);
                  }
                : undefined
            }
          />
        ))}
      </div>

      {modalIntegration && (
        <ConnectModal
          integration={modalIntegration}
          saving={saving}
          error={error}
          initialValues={editValues}
          onSave={handleConnect}
          testLabel="Test Connection"
          onTest={(formData) => testAzureStorage({
            accountUrl: formData.accountUrl || '',
            connectionString: formData.connectionString || '',
            containerName: formData.containerName || '',
          })}
          onClose={() => {
            setModalIntegration(null);
            setEditValues(undefined);
            setError('');
          }}
        />
      )}
    </div>
  );
}

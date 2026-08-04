import { useState, useMemo } from 'react';
import { getRequirementSources, prefillFromConfig } from './integrationCatalog';
import type { CatalogItem } from './integrationCatalog';
import IntegrationCard from './IntegrationCard';
import ConnectModal from './ConnectModal';
import { connectIntegration, disconnectIntegration, reconnectIntegration, deleteIntegration, connectJira, connectAzureDevops } from '@/services/api';
import { encryptField } from '@/utils/crypto';
import { useAuth } from '@/contexts/AuthContext';
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

export default function RequirementSourcesSection({ configs, onRefresh }: Props) {
  const { user } = useAuth();
  const toast = useToast();
  const [connectModal, setConnectModal] = useState<CatalogItem | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string> | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const catalog = useMemo(() => getRequirementSources(), []);

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
      if (dbRow) {
        return { ...cat, status: 'disconnected' as const, dbRow };
      }
      return { ...cat, status: 'available' as const, dbRow: null };
    });
  }, [catalog, configs]);

  const handleConnect = (cat: CatalogItem) => {
    setEditValues(undefined);
    setConnectModal(cat);
    setError('');
  };

  /** Reopen the connect form prefilled with the saved (non-secret) config. */
  const handleEdit = (cat: CatalogItem, configData: Record<string, any> | null | undefined) => {
    setEditValues(prefillFromConfig(cat, configData));
    setConnectModal(cat);
    setError('');
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

  const handleSaveConnect = async (formData: Record<string, string>) => {
    if (!connectModal) return;
    setSaving(true);
    setError('');
    try {
      if (connectModal.id === 'jira') {
        // JIRA uses a dedicated endpoint
        const username = user?.username;
        if (!username) {
          throw new Error('You must be logged in to connect JIRA');
        }
        await connectJira(
          username,
          formData.jira_url || '',
          formData.email || '',
          formData.api_token || '',
        );
      } else if (connectModal.id === 'azure-devops') {
        // Azure DevOps uses a dedicated endpoint that validates the PAT and
        // returns the resolved project before saving.
        await connectAzureDevops(
          formData.org_url || '',
          formData.project || '',
          formData.pat || '',
          formData.areaPath || undefined,
        );
      } else {
        // Generic connect for Confluence, SharePoint, etc.
        await connectIntegration(connectModal.id, formData);
      }
      setConnectModal(null);
      onRefresh();
      toast.success('Connected successfully');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to connect');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[#1E1B4B] mb-1">Requirement Sources</h3>
        <p className="text-xs text-[#6B7280]">
          Import requirements from your project tools.
        </p>
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
            onReconnect={() => handleReconnect(item.id)}
            onDelete={() => handleDelete(item.id)}
            onEdit={item.dbRow ? () => handleEdit(item, item.dbRow?.configData) : undefined}
          />
        ))}
      </div>

      {/* Connect Modal */}
      {connectModal && (
        <ConnectModal
          integration={connectModal}
          saving={saving}
          error={error}
          initialValues={editValues}
          onSave={handleSaveConnect}
          onClose={() => {
            setConnectModal(null);
            setEditValues(undefined);
            setError('');
          }}
        />
      )}
    </div>
  );
}

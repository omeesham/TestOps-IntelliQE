import { useState } from 'react';
import { getGitRepos } from './integrationCatalog';
import IntegrationCard from './IntegrationCard';
import ConnectModal from './ConnectModal';
import { connectIntegration, disconnectIntegration, reconnectIntegration, deleteIntegration, testGitConnection } from '@/services/api';
import type { CatalogItem } from './integrationCatalog';
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

export default function GitRepositoriesSection({ configs, onRefresh }: Props) {
  const toast = useToast();
  const catalog = getGitRepos();

  const [modalIntegration, setModalIntegration] = useState<CatalogItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  /** Verify a saved git connection can reach the repo + default branch. */
  const handleTest = async (integrationId: string) => {
    setTestingId(integrationId);
    setTestResults((prev) => { const next = { ...prev }; delete next[integrationId]; return next; });
    try {
      const r = await testGitConnection({ integrationId });
      setTestResults((prev) => ({
        ...prev,
        [integrationId]: { ok: !!r.ok, message: r.ok ? (r.message || 'Connection OK.') : (r.error || r.message || 'Connection test failed.') },
      }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [integrationId]: { ok: false, message: err?.response?.data?.error || err?.message || 'Connection test failed.' },
      }));
    } finally {
      setTestingId(null);
    }
  };

  /** Merge catalog entries with live config state. A saved-but-inactive config
   *  shows as 'disconnected' (data retained) rather than 'available'. */
  const merged = catalog.map((item) => {
    const cfg = configs.find((c) => c.integrationId === item.id);
    const status: 'connected' | 'available' | 'disconnected' | 'coming_soon' = item.comingSoon
      ? 'coming_soon'
      : cfg?.status === 'connected'
        ? 'connected'
        : cfg
          ? 'disconnected'
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
      toast.success('Connected successfully');
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || 'Connection failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async (integrationId: string) => {
    try { await disconnectIntegration(integrationId); onRefresh(); toast.success('Disconnected successfully'); }
    catch (err: any) { console.error('Failed to disconnect:', err); toast.fromError(err); }
  };

  const handleReconnect = async (integrationId: string) => {
    try { await reconnectIntegration(integrationId); onRefresh(); toast.success('Reconnected successfully'); }
    catch (err: any) { console.error('Failed to reconnect:', err); toast.fromError(err); }
  };

  const handleDelete = async (integrationId: string) => {
    try { await deleteIntegration(integrationId); onRefresh(); toast.success('Deleted successfully'); }
    catch (err: any) { console.error('Failed to delete:', err); toast.fromError(err); }
  };

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-[#1E1B4B]">Code Repositories</h3>
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
            onReconnect={() => handleReconnect(item.id)}
            onDelete={() => handleDelete(item.id)}
            onTest={item.status === 'connected' ? () => handleTest(item.id) : undefined}
            testing={testingId === item.id}
            testResult={testResults[item.id] ?? null}
          />
        ))}
      </div>

      {modalIntegration && (
        <ConnectModal
          integration={modalIntegration}
          saving={saving}
          error={error}
          onSave={handleConnect}
          testLabel="Test Connection"
          onTest={(formData) => testGitConnection({
            repo_url: formData.repo_url,
            branch: formData.branch,
            access_token: formData.access_token,
            username: formData.username,
          })}
          onClose={() => {
            setModalIntegration(null);
            setError('');
          }}
        />
      )}
    </div>
  );
}

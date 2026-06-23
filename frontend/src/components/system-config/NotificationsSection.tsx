import { useState } from 'react';
import { Send, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { getNotifications } from './integrationCatalog';
import IntegrationCard from './IntegrationCard';
import ConnectModal from './ConnectModal';
import { connectIntegration, disconnectIntegration, testNotificationIntegration } from '@/services/api';
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

const TRIGGER_EVENTS = [
  { key: 'testExecutionComplete', label: 'Test Execution Complete' },
  { key: 'testFailureDetected', label: 'Test Failure Detected' },
  { key: 'selfHealingApplied', label: 'Self-Healing Applied' },
  { key: 'dailySummaryReport', label: 'Daily Summary Report' },
] as const;

export default function NotificationsSection({ configs, onRefresh }: Props) {
  const catalog = getNotifications();

  const [modalIntegration, setModalIntegration] = useState<CatalogItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /** Track trigger event selections per integration (informational, stored in configData) */
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'sending' | 'sent' | 'failed'>>({});

  const handleSendTest = async (integrationId: string) => {
    setTestStatus(prev => ({ ...prev, [integrationId]: 'sending' }));
    try {
      const result = await testNotificationIntegration(integrationId);
      setTestStatus(prev => ({ ...prev, [integrationId]: result.ok || result.sent ? 'sent' : 'failed' }));
    } catch {
      setTestStatus(prev => ({ ...prev, [integrationId]: 'failed' }));
    }
    setTimeout(() => setTestStatus(prev => ({ ...prev, [integrationId]: 'idle' })), 5000);
  };

  const [triggerEvents, setTriggerEvents] = useState<Record<string, Record<string, boolean>>>(() => {
    const initial: Record<string, Record<string, boolean>> = {};
    configs.forEach((cfg) => {
      if (cfg.status === 'connected' && cfg.configData?.triggerEvents) {
        initial[cfg.integrationId] = cfg.configData.triggerEvents;
      }
    });
    return initial;
  });

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
      // Clear trigger events for this integration
      setTriggerEvents((prev) => {
        const next = { ...prev };
        delete next[integrationId];
        return next;
      });
      onRefresh();
    } catch (err: any) {
      console.error('Failed to disconnect:', err);
    }
  };

  const handleTriggerToggle = (integrationId: string, eventKey: string, checked: boolean) => {
    setTriggerEvents((prev) => ({
      ...prev,
      [integrationId]: {
        ...(prev[integrationId] || {}),
        [eventKey]: checked,
      },
    }));
  };

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-[#1E1B4B]">Notifications</h3>
        <p className="text-xs text-[#6B7280] mt-0.5">
          Configure notification channels to receive test execution results, alerts, and reports.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {merged.map((item) => (
          <div key={item.id}>
            <IntegrationCard
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

            {/* Trigger Events + Test — only shown when this notification channel is connected */}
            {item.status === 'connected' && (
              <div className="mt-2 ml-2 p-4 bg-[#F5F3FF] border border-[#DDD6FE]/60 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-[#1E1B4B]">Trigger Events</h4>
                  <button
                    onClick={() => handleSendTest(item.id)}
                    disabled={testStatus[item.id] === 'sending'}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all duration-200 active:scale-95 ${
                      testStatus[item.id] === 'sent'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : testStatus[item.id] === 'failed'
                        ? 'bg-red-50 text-red-600 border border-red-200'
                        : 'bg-white text-[#7C3AED] border border-[#DDD6FE] hover:bg-[#F5F3FF] hover:shadow-sm'
                    } disabled:opacity-50`}
                  >
                    {testStatus[item.id] === 'sending' ? (
                      <><Loader2 className="w-3 h-3 animate-spin" /> Sending...</>
                    ) : testStatus[item.id] === 'sent' ? (
                      <><CheckCircle className="w-3 h-3" /> Test Sent!</>
                    ) : testStatus[item.id] === 'failed' ? (
                      <><AlertCircle className="w-3 h-3" /> Failed</>
                    ) : (
                      <><Send className="w-3 h-3" /> Send Test {item.id === 'notif-email' ? 'Email' : item.id === 'notif-teams' ? 'Teams Message' : 'Notification'}</>
                    )}
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {TRIGGER_EVENTS.map((evt) => (
                    <label
                      key={evt.key}
                      className="flex items-center gap-2.5 cursor-pointer group"
                    >
                      <input
                        type="checkbox"
                        checked={triggerEvents[item.id]?.[evt.key] ?? false}
                        onChange={(e) => handleTriggerToggle(item.id, evt.key, e.target.checked)}
                        className="w-4 h-4 text-[#7C3AED] rounded border-[#DDD6FE] focus:ring-[#7C3AED]/20"
                      />
                      <span className="text-xs text-[#1E1B4B] group-hover:text-[#7C3AED] transition-colors">
                        {evt.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
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

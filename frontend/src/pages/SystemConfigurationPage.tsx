import { useState, useEffect, useCallback } from 'react';
import { Settings } from 'lucide-react';
import ConfigTabNav, { type TabKey } from '@/components/system-config/ConfigTabNav';
import GeneralSettingsSection from '@/components/system-config/GeneralSettingsSection';
import ApplicationSetupSection from '@/components/system-config/ApplicationSetupSection';
import RequirementSourcesSection from '@/components/system-config/RequirementSourcesSection';
import DataSourcesSection from '@/components/system-config/DataSourcesSection';
import GitRepositoriesSection from '@/components/system-config/GitRepositoriesSection';
import NotificationsSection from '@/components/system-config/NotificationsSection';
import AISelfHealingSection from '@/components/system-config/AISelfHealingSection';
import VoiceAssistantSection from '@/components/system-config/VoiceAssistantSection';
import { getConfigurations } from '@/services/api';
import ErrorAlert from '@/components/feedback/ErrorAlert';
import { normalizeError, type NormalizedError } from '@/utils/apiError';

interface DbConfig {
  integrationId: string;
  status: string;
  configData: Record<string, any>;
  connectedBy: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
}

export default function SystemConfigurationPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('general');
  const [configs, setConfigs] = useState<DbConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<NormalizedError | null>(null);

  const fetchConfigs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getConfigurations();
      setConfigs(res.configs || []);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  const renderSection = () => {
    // Show errors prominently — but never block rendering on initial load.
    // Sections handle empty `configs` gracefully (they show form defaults),
    // so we render them immediately and let the API fill data in (~400ms).
    if (error) {
      return (
        <div className="max-w-xl mx-auto py-8">
          <ErrorAlert error={error} onRetry={fetchConfigs} onDismiss={() => setError(null)} />
        </div>
      );
    }

    switch (activeTab) {
      case 'general':
        return <GeneralSettingsSection configs={configs} />;
      case 'application':
        return <ApplicationSetupSection configs={configs} onRefresh={fetchConfigs} />;
      case 'requirements':
        return <RequirementSourcesSection configs={configs} onRefresh={fetchConfigs} />;
      case 'data-sources':
        return <DataSourcesSection configs={configs} onRefresh={fetchConfigs} />;
      case 'git-repos':
        return <GitRepositoriesSection configs={configs} onRefresh={fetchConfigs} />;
      case 'notifications':
        return <NotificationsSection configs={configs} onRefresh={fetchConfigs} />;
      case 'ai-healing':
        return <AISelfHealingSection configs={configs} />;
      case 'voice':
        return <VoiceAssistantSection />;
      default:
        return null;
    }
  };

  return (
    <div className="-m-6 p-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#3366FF] to-[#2645D6] flex items-center justify-center shadow-md shadow-violet-500/25">
          <Settings className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-[#1E3A8A]">System Configuration</h1>
          <p className="text-sm text-[#6B7280]">Integrations and platform settings</p>
        </div>
      </div>

      <div className="flex bg-white/80 backdrop-blur-sm rounded-2xl border border-[#DCE7FF] shadow-sm overflow-hidden">
        {/* Left: Vertical Tabs */}
        <div className="p-3 border-r border-[#DCE7FF] bg-[#EEF4FF]/40 w-56 flex-shrink-0">
          <ConfigTabNav activeTab={activeTab} onTabChange={setActiveTab} />
        </div>

        {/* Right: Active Section */}
        <div className="flex-1 p-5 min-w-0 relative">
          {/* Subtle top-strip loader so users see progress without blocking the UI */}
          {loading && (
            <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden">
              <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-[#3366FF] to-transparent animate-[shimmer_1.2s_ease-in-out_infinite]"
                   style={{ animation: 'shimmer 1.2s ease-in-out infinite' }} />
            </div>
          )}
          {renderSection()}
        </div>
      </div>
      <style>{`
        @keyframes shimmer {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}

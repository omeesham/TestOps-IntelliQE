import {
  Settings, AppWindow, FileText, Database,
  GitBranch, Bell, Brain, Volume2, Sparkles,
} from 'lucide-react';

export type TabKey =
  | 'general'
  | 'application'
  | 'requirements'
  | 'data-sources'
  | 'git-repos'
  | 'notifications'
  | 'llm-config'
  | 'ai-healing'
  | 'voice';

interface Tab {
  key: TabKey;
  label: string;
  icon: React.ElementType;
}

const TABS: Tab[] = [
  { key: 'general',       label: 'General Settings',       icon: Settings  },
  { key: 'application',   label: 'Application Setup',      icon: AppWindow },
  { key: 'requirements',  label: 'Requirement Sources',    icon: FileText  },
  { key: 'data-sources',  label: 'Data Sources',           icon: Database  },
  { key: 'git-repos',     label: 'Git Repositories',       icon: GitBranch },
  { key: 'notifications', label: 'Notifications',          icon: Bell      },
  { key: 'llm-config',    label: 'LLM Configuration',      icon: Sparkles  },
  { key: 'ai-healing',    label: 'AI & Healer Agent',      icon: Brain     },
  { key: 'voice',         label: 'Voice Assistant',        icon: Volume2   },
];

interface Props {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
}

export default function ConfigTabNav({ activeTab, onTabChange }: Props) {
  return (
    <nav className="w-60 flex-shrink-0 space-y-0.5">
      {TABS.map((tab) => {
        const isActive = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 text-left ${
              isActive
                ? 'bg-gradient-to-r from-[#3366FF] to-[#2645D6] text-white shadow-lg shadow-purple-500/20'
                : 'text-[#6B7280] hover:bg-[#EEF4FF] hover:text-[#1E3A8A]'
            }`}
          >
            <tab.icon className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

import {
  Settings, AppWindow, FileText, Database,
  GitBranch, Bell, BrainCircuit, Volume2,
} from 'lucide-react';

export type TabKey =
  | 'general'
  | 'application'
  | 'requirements'
  | 'storage'
  | 'git-repos'
  | 'notifications'
  | 'llm-config'
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
  { key: 'storage',       label: 'Storage',                icon: Database  },
  { key: 'git-repos',     label: 'Code Repositories',      icon: GitBranch },
  { key: 'notifications', label: 'Notifications',          icon: Bell      },
  { key: 'llm-config',    label: 'LLM Configuration',      icon: BrainCircuit },
  { key: 'voice',         label: 'Voice Assistant',        icon: Volume2   },
];

interface Props {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
}

export default function ConfigTabNav({ activeTab, onTabChange }: Props) {
  return (
    <nav className="w-full flex-shrink-0 space-y-0.5">
      {TABS.map((tab) => {
        const isActive = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 text-left ${
              isActive
                ? 'bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white shadow-lg shadow-purple-500/20'
                : 'text-[#6B7280] hover:bg-[#F5F3FF] hover:text-[#1E1B4B]'
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

import { MessageSquare, Terminal, LayoutGrid } from 'lucide-react';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';
import type { Dispatch, SetStateAction } from 'react';
import { useMacOS } from '../../../../hooks/useMacOS';

interface MainContentHeaderProps {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab?: Dispatch<SetStateAction<AppTab>>;
}

const TABS = [
  { id: 'chat' as AppTab, label: '聊天', icon: MessageSquare },
  { id: 'shell' as AppTab, label: '终端', icon: Terminal },
  { id: 'hybrid' as AppTab, label: '混合终端', icon: LayoutGrid },
];

export default function MainContentHeader({
  selectedProject,
  activeTab,
  setActiveTab,
}: MainContentHeaderProps) {
  const { isMacOS } = useMacOS();

  return (
    <div className={`bg-background border-b border-border/60 px-4 py-2 flex-shrink-0 ${isMacOS ? 'macos-content-header' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-sm font-medium text-foreground truncate">
            {selectedProject ? (selectedProject.displayName || selectedProject.name) : '工作区'}
          </span>
        </div>

        {setActiveTab && (
          <div className="flex-shrink-0 inline-flex items-center bg-muted/60 rounded-lg p-[3px] gap-[2px]">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-[5px] text-sm font-medium rounded-md transition-all duration-150 ${
                    isActive
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
                  <span className="hidden lg:inline">{tab.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

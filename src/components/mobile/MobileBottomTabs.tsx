import { FolderKanban, MessageSquare, MessagesSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';

export type MobilePrimaryTab = 'projects' | 'sessions' | 'chat';

type MobileBottomTabsProps = {
  activeTab: MobilePrimaryTab;
  onSelectTab: (tab: MobilePrimaryTab) => void;
};

const TABS: Array<{
  id: MobilePrimaryTab;
  icon: typeof FolderKanban;
  labelKey: string;
  fallback: string;
}> = [
  { id: 'projects', icon: FolderKanban, labelKey: 'workbench.projects', fallback: 'Projects' },
  { id: 'sessions', icon: MessagesSquare, labelKey: 'sessions.title', fallback: 'Sessions' },
  { id: 'chat', icon: MessageSquare, labelKey: 'navigation.chat', fallback: 'Chat' },
];

export default function MobileBottomTabs({ activeTab, onSelectTab }: MobileBottomTabsProps) {
  const { t } = useTranslation('sidebar');

  return (
    <nav className="mx-auto grid w-full max-w-2xl grid-cols-3 gap-2">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelectTab(tab.id)}
            className={cn(
              'flex h-12 items-center justify-center gap-2 rounded-xl border text-sm font-medium transition-colors',
              isActive
                ? 'border-foreground/15 bg-foreground text-background shadow-sm'
                : 'border-border/60 bg-background text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={isActive}
            aria-label={t(tab.labelKey, { defaultValue: tab.fallback })}
          >
            <Icon className="h-4 w-4" />
            <span>{t(tab.labelKey, { defaultValue: tab.fallback })}</span>
          </button>
        );
      })}
    </nav>
  );
}


import { GitBranch, Palette, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';

type SettingsTab = 'agents' | 'appearance' | 'git';

type SettingsSidebarPanelProps = {
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
};

const ITEMS = [
  { id: 'agents' as SettingsTab, icon: SlidersHorizontal, labelKey: 'mainTabs.agents' },
  { id: 'appearance' as SettingsTab, icon: Palette, labelKey: 'mainTabs.appearance' },
  { id: 'git' as SettingsTab, icon: GitBranch, labelKey: 'mainTabs.git' },
];

export default function SettingsSidebarPanel({ activeTab, onSelectTab }: SettingsSidebarPanelProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b border-border/60 px-4 py-3.5">
        <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">OpenWork</p>
        <h2 className="mt-1 text-sm font-semibold text-foreground">{t('title')}</h2>
      </div>
      <div className="flex-1 space-y-1.5 overflow-y-auto px-3 py-3">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = item.id === activeTab;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors',
                isActive
                  ? 'border-foreground/12 bg-background text-foreground shadow-sm ring-1 ring-foreground/6'
                  : 'border-transparent text-muted-foreground hover:border-border/70 hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <div className={cn('flex h-8 w-8 items-center justify-center rounded-xl', isActive ? 'bg-muted text-foreground' : 'bg-muted/70 text-muted-foreground')}>
                <Icon className="h-4 w-4" />
              </div>
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

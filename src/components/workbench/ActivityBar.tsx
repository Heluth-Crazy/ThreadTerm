import { Boxes, FolderKanban, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import type { WorkbenchNav } from '../../types/workbench';

type ActivityBarProps = {
  activeNav: WorkbenchNav;
  onSelectNav: (nav: WorkbenchNav) => void;
};

const ITEMS = [
  { id: 'projects' as WorkbenchNav, icon: FolderKanban, labelKey: 'workbench.projects' },
  { id: 'extensions' as WorkbenchNav, icon: Boxes, labelKey: 'workbench.extensions' },
  { id: 'settings' as WorkbenchNav, icon: Settings2, labelKey: 'workbench.settings' },
];

export default function ActivityBar({ activeNav, onSelectNav }: ActivityBarProps) {
  const { t } = useTranslation('sidebar');

  return (
    <aside className="flex h-full w-16 flex-col items-center border-r border-border/60 bg-card/70 px-2 py-3">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-2xl bg-foreground text-lg font-semibold text-background">
        O
      </div>
      <nav className="flex w-full flex-1 flex-col items-center gap-2">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = item.id === activeNav;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectNav(item.id)}
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-xl border transition-colors',
                isActive
                  ? 'border-foreground/10 bg-foreground text-background shadow-sm'
                  : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground',
              )}
              title={t(item.labelKey)}
              aria-label={t(item.labelKey)}
              aria-pressed={isActive}
            >
              <Icon className="h-5 w-5" strokeWidth={isActive ? 2.25 : 2} />
            </button>
          );
        })}
      </nav>
    </aside>
  );
}


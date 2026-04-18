import { Boxes, FolderKanban, LayoutGrid, ListTodo, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import { useTaskQueueStore } from '../../stores/taskQueueStore';
import type { WorkbenchNav } from '../../types/workbench';

type ActivityBarProps = {
  activeNav: WorkbenchNav;
  onSelectNav: (nav: WorkbenchNav) => void;
};

const ITEMS = [
  { id: 'projects' as WorkbenchNav, icon: FolderKanban, labelKey: 'workbench.projects' },
  { id: 'livegrid' as WorkbenchNav, icon: LayoutGrid, labelKey: 'workbench.liveGrid' },
  { id: 'queue' as WorkbenchNav, icon: ListTodo, labelKey: 'workbench.queue' },
  { id: 'extensions' as WorkbenchNav, icon: Boxes, labelKey: 'workbench.extensions' },
  { id: 'settings' as WorkbenchNav, icon: Settings2, labelKey: 'workbench.settings' },
];

export default function ActivityBar({ activeNav, onSelectNav }: ActivityBarProps) {
  const { t } = useTranslation('sidebar');
  const queuedCount = useTaskQueueStore((s) =>
    s.queue.filter((t) => t.status === 'queued' || t.status === 'running').length,
  );

  return (
    <aside className="flex h-full w-14 flex-col items-center border-r border-border/60 bg-card/70 px-2 pt-2 pb-3">
      <nav className="flex w-full flex-1 flex-col items-center gap-1.5">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = item.id === activeNav;
          const label = t(item.labelKey);

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectNav(item.id)}
              className={cn(
                'relative flex h-10 w-10 items-center justify-center rounded-xl border transition-colors',
                isActive
                  ? 'border-foreground/10 bg-foreground text-background shadow-sm'
                  : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground',
              )}
              title={label}
              aria-label={label}
              aria-pressed={isActive}
            >
              <Icon className="h-5 w-5" strokeWidth={isActive ? 2.25 : 2} />
              {item.id === 'queue' && queuedCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-[9px] font-bold text-white">
                  {queuedCount > 9 ? '9+' : queuedCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}


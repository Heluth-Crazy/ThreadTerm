import { FolderKanban, Home } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import Sidebar from '../../sidebar/view/Sidebar';
import type { SidebarProps } from '../../sidebar/types/types';

type ProjectsSidebarPanelProps = {
  sidebarProps: SidebarProps;
  isOverviewActive: boolean;
  onSelectOverview: () => void;
};

export default function ProjectsSidebarPanel({
  sidebarProps,
  isOverviewActive,
  onSelectOverview,
}: ProjectsSidebarPanelProps) {
  const { t } = useTranslation('sidebar');

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="relative z-10 flex-shrink-0 border-b border-border/60 px-3 py-3">
        <div className="relative z-10 rounded-[22px] border border-border/60 bg-card/72 p-3 shadow-sm">
          <div className="flex items-start gap-2.5">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
              <FolderKanban className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">OpenWork</p>
              <h2 className="mt-1 text-sm font-semibold text-foreground">{t('workbench.projects')}</h2>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {t('workbench.projectsPanel.description')}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onSelectOverview}
            className={cn(
              'relative z-10 mt-3 flex w-full cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
              isOverviewActive
                ? 'border-border/70 bg-background text-foreground'
                : 'border-border/60 bg-background/80 text-muted-foreground hover:bg-muted/45 hover:text-foreground',
            )}
          >
            <div
              className={cn(
                'mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg',
                isOverviewActive ? 'bg-muted text-foreground' : 'bg-muted/70 text-muted-foreground',
              )}
            >
              <Home className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium leading-5 text-foreground">{t('workbench.overview.nav')}</div>
              <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                {t('workbench.projectsPanel.overviewHint')}
              </p>
            </div>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2 pt-2">
        <div className="h-full overflow-hidden rounded-[22px] border border-border/60 bg-card/40 shadow-sm">
          <Sidebar {...sidebarProps} />
        </div>
      </div>
    </div>
  );
}

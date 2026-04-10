import { FolderPlus, Plus, RefreshCw, Search, X, PanelLeftClose, Settings } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { IS_PLATFORM } from '../../../../constants/config';
import { useMacOS } from '../../../../hooks/useMacOS';

type SidebarHeaderProps = {
  isLoading: boolean;
  projectsCount: number;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

export default function SidebarHeader({

  isLoading,
  projectsCount,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  onShowSettings,
  t,
}: SidebarHeaderProps) {
  const { isMacOS } = useMacOS();
  const [appIconSrc, setAppIconSrc] = useState('/icons/icon-32x32.png');

  useEffect(() => {
    let mounted = true;

    if (!window.electronAPI?.getAppIconDataUrl) {
      return () => {
        mounted = false;
      };
    }

    window.electronAPI
      .getAppIconDataUrl()
      .then((dataUrl) => {
        if (mounted && dataUrl) {
          setAppIconSrc(dataUrl);
        }
      })
      .catch(() => {
        // Keep the static icon fallback.
      });

    return () => {
      mounted = false;
    };
  }, []);

  const LogoBlock = () => (
    <div className="flex items-center gap-2.5 min-w-0">
      <img
        src={appIconSrc}
        alt="OpenWork"
        className="w-8 h-8 rounded-lg shadow-sm flex-shrink-0"
      />
      <h1 className="text-sm font-semibold text-foreground tracking-tight truncate">{t('app.title')}</h1>
    </div>
  );

  return (
    <div className="flex-shrink-0">
      <div className={`px-3 pt-3 pb-2 ${isMacOS ? 'macos-sidebar-header' : ''}`}>
        <div className="flex items-center justify-between gap-2">
          {IS_PLATFORM ? (
            <a
              href="https://openwork.ai/dashboard"
              className="flex items-center gap-2.5 min-w-0 hover:opacity-80 transition-opacity"
              title={t('tooltips.viewEnvironments')}
            >
              <LogoBlock />
            </a>
          ) : (
            <LogoBlock />
          )}

          <div className="flex items-center gap-1 flex-shrink-0">
            <Button variant="ghost" size="sm" className="h-8 w-8 rounded-lg p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={onRefresh} disabled={isRefreshing} title={t('tooltips.refresh')}>
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 rounded-lg p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={onCreateProject} title={t('tooltips.createProject')}>
              <Plus className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 rounded-lg p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={onShowSettings} title={t('actions.settings')}>
              <Settings className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 rounded-lg p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={onCollapseSidebar} title={t('tooltips.hideSidebar')}>
              <PanelLeftClose className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {projectsCount > 0 && !isLoading && (
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50 pointer-events-none" />
            <Input
              type="text"
              placeholder={t('projects.searchPlaceholder')}
              value={searchFilter}
              onChange={(event) => onSearchFilterChange(event.target.value)}
              className="nav-search-input h-8 rounded-lg border-0 pl-9 pr-8 text-sm placeholder:text-muted-foreground/40 transition-all duration-200 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            {searchFilter && (
              <button onClick={onClearSearchFilter} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 transition-colors hover:bg-muted">
                <X className="w-3 h-3 text-muted-foreground" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="nav-divider" />
    </div>
  );
}

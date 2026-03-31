import { Blocks, LayoutGrid, PlugZap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import type { ExtensionsView } from '../../../types/workbench';

type ExtensionsSidebarPanelProps = {
  activeView: ExtensionsView;
  onSelectView: (view: ExtensionsView) => void;
};

const ITEMS = [
  { id: 'overview' as ExtensionsView, icon: LayoutGrid, labelKey: 'workbench.overview.nav' },
  { id: 'skills' as ExtensionsView, icon: Blocks, labelKey: 'workbench.skills' },
  { id: 'mcp' as ExtensionsView, icon: PlugZap, labelKey: 'workbench.mcp' },
];

export default function ExtensionsSidebarPanel({ activeView, onSelectView }: ExtensionsSidebarPanelProps) {
  const { t } = useTranslation('sidebar');

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b border-border/60 px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{t('workbench.extensions')}</h2>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = item.id === activeView;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectView(item.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors',
                isActive
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

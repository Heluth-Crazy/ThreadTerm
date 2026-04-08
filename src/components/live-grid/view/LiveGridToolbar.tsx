import { useTranslation } from 'react-i18next';
import { Grid2x2, Grid3x3, Columns2, LayoutGrid } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { GridLayout } from '../../../stores/liveGridStore';

type LiveGridToolbarProps = {
  layout: GridLayout;
  onLayoutChange: (l: GridLayout) => void;
  filter: string;
  onFilterChange: (f: string) => void;
  onNewSession: () => void;
};

const LAYOUTS: { id: GridLayout; icon: React.ElementType; labelKey: string }[] = [
  { id: '1x2', icon: Columns2, labelKey: 'liveGrid.layout.1x2' },
  { id: '2x2', icon: Grid2x2, labelKey: 'liveGrid.layout.2x2' },
  { id: '2x3', icon: LayoutGrid, labelKey: 'liveGrid.layout.2x3' },
  { id: '3x3', icon: Grid3x3, labelKey: 'liveGrid.layout.3x3' },
];

const FILTERS = [
  { id: 'all', labelKey: 'liveGrid.filter.all' },
  { id: 'claude', labelKey: 'liveGrid.filter.claude' },
  { id: 'codex', labelKey: 'liveGrid.filter.codex' },
];

export default function LiveGridToolbar({
  layout,
  onLayoutChange,
  filter,
  onFilterChange,
  onNewSession,
}: LiveGridToolbarProps) {
  const { t } = useTranslation('common');

  return (
    <div className="flex items-center gap-3 border-b border-border/60 bg-card/70 px-4 py-2">
      <h2 className="text-sm font-semibold text-foreground">{t('liveGrid.title')}</h2>

      <div className="flex-1" />

      {/* Layout buttons */}
      <div className="flex items-center gap-0.5 rounded-lg border border-border/50 p-0.5">
        {LAYOUTS.map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            type="button"
            onClick={() => onLayoutChange(id)}
            className={cn(
              'flex items-center justify-center rounded-md px-2 py-1 text-xs transition-colors',
              layout === id
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
            title={t(labelKey)}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>

      {/* Filter */}
      <select
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
        className="h-7 rounded-md border border-border/50 bg-background px-2 text-xs text-foreground focus:outline-none"
      >
        {FILTERS.map(({ id, labelKey }) => (
          <option key={id} value={id}>
            {t(labelKey)}
          </option>
        ))}
      </select>

      {/* New session */}
      <button
        type="button"
        onClick={onNewSession}
        className="flex h-7 items-center gap-1 rounded-md border border-border/50 bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
      >
        <span className="text-sm">+</span>
        {t('liveGrid.newSession')}
      </button>
    </div>
  );
}

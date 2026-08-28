import {
  CircleAlert,
  SquareTerminal,
  Star,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface WorkbenchStatStripProps {
  attentionCount: number;
  terminalCount: number;
  followedCount: number;
  onOpenAttention: () => void;
  onOpenTerminals: () => void;
  onOpenFollowed: () => void;
}

interface StatCell {
  key: 'attention' | 'terminals' | 'followed';
  value: number;
  label: string;
  icon: LucideIcon;
  tone: string;
  onClick: () => void;
}

export function WorkbenchStatStrip({
  attentionCount,
  terminalCount,
  followedCount,
  onOpenAttention,
  onOpenTerminals,
  onOpenFollowed,
}: WorkbenchStatStripProps) {
  const { t } = useTranslation('terminal');
  const cells: StatCell[] = [
    {
      key: 'attention',
      value: attentionCount,
      label: t('workbench.attention.title', { defaultValue: 'Needs attention' }),
      icon: CircleAlert,
      tone: 'bg-warning/10 text-warning',
      onClick: onOpenAttention,
    },
    {
      key: 'terminals',
      value: terminalCount,
      label: t('workbench.stats.terminals', { defaultValue: 'Terminals' }),
      icon: SquareTerminal,
      tone: 'bg-primary/10 text-primary',
      onClick: onOpenTerminals,
    },
    {
      key: 'followed',
      value: followedCount,
      label: t('workbench.stats.followed', { defaultValue: 'Followed' }),
      icon: Star,
      tone: 'bg-info/10 text-info',
      onClick: onOpenFollowed,
    },
  ];

  return (
    <div
      role="group"
      aria-label={t('workbench.stats.label', { defaultValue: 'Workbench stats' })}
      className="mt-3 grid grid-cols-3 divide-x divide-border/60 rounded-xl border border-border/70 bg-card/50"
    >
      {cells.map((cell) => {
        const Icon = cell.icon;
        return (
          <button
            key={cell.key}
            type="button"
            data-testid={`workbench-stat-${cell.key}`}
            aria-label={`${cell.label}: ${cell.value}`}
            onClick={cell.onClick}
            className="flex min-w-0 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
          >
            <span
              className={[
                'grid h-9 w-9 shrink-0 place-items-center rounded-md',
                cell.tone,
              ].join(' ')}
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-lg font-semibold leading-tight tabular-nums">
                {cell.value}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {cell.label}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

import {
  Activity,
  CircleCheckBig,
  CircleX,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  WorkbenchSummary as WorkbenchSummaryData,
  WorkbenchViewFilter,
} from '../../lib/workbench/types';

interface WorkbenchSummaryProps {
  summary: WorkbenchSummaryData;
  activeFilter: WorkbenchViewFilter;
  onSelectFilter: (filter: WorkbenchViewFilter) => void;
}

interface SummaryCard {
  key: 'attention' | 'normalRunning' | 'review' | 'failed';
  value: number;
  icon: LucideIcon;
  tone: string;
  filter: WorkbenchViewFilter;
}

export function WorkbenchSummary({
  summary,
  activeFilter,
  onSelectFilter,
}: WorkbenchSummaryProps) {
  const { t } = useTranslation('terminal');
  const cards: SummaryCard[] = [
    {
      key: 'attention',
      value: summary.attention,
      icon: TriangleAlert,
      tone: 'text-warning bg-warning/10',
      filter: 'all',
    },
    {
      key: 'normalRunning',
      value: summary.normalRunning,
      icon: Activity,
      tone: 'text-success bg-success/10',
      filter: 'running',
    },
    {
      key: 'review',
      value: summary.review,
      icon: CircleCheckBig,
      tone: 'text-info bg-info/10',
      filter: 'review',
    },
    {
      key: 'failed',
      value: summary.failed,
      icon: CircleX,
      tone: 'text-destructive bg-destructive/10',
      filter: 'failed',
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-3">
      {cards
        .filter((card) => card.key === 'attention' || card.value > 0)
        .map((card) => {
          const Icon = card.icon;
          const selected = activeFilter === card.filter;
          const label = t(`workbench.summary.${card.key}`, {
            defaultValue: summaryLabel(card.key),
          });
          return (
            <button
              key={card.key}
              type="button"
              aria-label={`${label}: ${card.value}`}
              aria-pressed={selected}
              onClick={() => onSelectFilter(card.filter)}
              className={[
                'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors',
                selected
                  ? 'border-primary/35 bg-primary/[0.07] text-foreground'
                  : 'border-border bg-card/80 text-muted-foreground hover:bg-card hover:text-foreground',
              ].join(' ')}
            >
              <Icon className={['h-3 w-3', card.tone.split(' ')[0]].join(' ')} />
              <span className="font-semibold tabular-nums text-foreground">
                {card.value}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
    </div>
  );
}

function summaryLabel(key: SummaryCard['key']): string {
  switch (key) {
    case 'attention':
      return 'Needs attention';
    case 'normalRunning':
      return 'Running normally';
    case 'review':
      return 'Ready to review';
    case 'failed':
      return 'Unrecovered failures';
  }
}

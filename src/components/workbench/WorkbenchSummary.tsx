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
    <div className="grid grid-cols-2 gap-2 pt-4 xl:grid-cols-4">
      {cards.map((card) => {
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
              'group flex min-h-[72px] items-center gap-3 rounded-lg border bg-card/80 px-3 text-left transition-colors',
              selected
                ? 'border-primary/35 bg-primary/[0.07]'
                : 'border-border hover:border-border hover:bg-card',
            ].join(' ')}
          >
            <span
              className={[
                'grid h-9 w-9 shrink-0 place-items-center rounded-md',
                card.tone,
              ].join(' ')}
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[22px] font-semibold leading-none tabular-nums">
                {card.value}
              </span>
              <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                {label}
              </span>
            </span>
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

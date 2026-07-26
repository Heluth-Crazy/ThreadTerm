import { ChevronRight, GitBranch, TerminalSquare } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ExecutionContextGroup,
  ExecutionContextStatus,
} from '../../lib/workbench/types';
import {
  executionStatusLabel,
  relativeTime,
} from './workbenchFormatting';

interface ExecutionGroupCardProps {
  group: ExecutionContextGroup;
  now: number;
  onOpenDetail: (group: ExecutionContextGroup) => void;
}

const STATUS_STYLE: Record<ExecutionContextStatus, string> = {
  failed: 'bg-destructive/10 text-destructive',
  attention: 'bg-warning/10 text-warning',
  stalled: 'bg-warning/10 text-warning',
  running: 'bg-success/10 text-success',
  review: 'bg-info/10 text-info',
  idle: 'bg-muted text-muted-foreground',
};

export const ExecutionGroupCard = memo(function ExecutionGroupCard({
  group,
  now,
  onOpenDetail,
}: ExecutionGroupCardProps) {
  const { t, i18n } = useTranslation('terminal');
  const showBranch =
    group.worktreePath !== group.projectPath && Boolean(group.branchLabel);

  return (
    <button
      type="button"
      onClick={() => onOpenDetail(group)}
      className="group flex min-h-[118px] min-w-0 flex-col rounded-lg border border-border bg-card/80 p-3 text-left transition-colors hover:border-border hover:bg-card"
    >
      <span className="mb-1.5 flex w-full min-w-0 items-center gap-1.5">
        <span className="truncate text-xs font-semibold">{group.projectName}</span>
        <span
          className={[
            'ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold',
            STATUS_STYLE[group.status],
          ].join(' ')}
        >
          {executionStatusLabel(group.status, t)}
        </span>
      </span>
      {showBranch && (
        <span className="mb-1.5 flex max-w-full items-center gap-1 truncate text-[11px] text-muted-foreground">
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate">{group.branchLabel}</span>
        </span>
      )}
      <span className="text-[11px] text-muted-foreground/75">
        {t('workbench.group.terminals', {
          count: group.terminalCount,
          defaultValue: '{{count}} terminals',
        })}
        {group.attentionCount > 0
          ? ` · ${t('workbench.group.attention', {
              count: group.attentionCount,
              defaultValue: '{{count}} need attention',
            })}`
          : ''}
      </span>
      {group.preview && (
        <span className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
          {group.preview}
        </span>
      )}
      <span className="mt-auto flex w-full items-center gap-2 border-t border-border pt-2">
        <span className="flex min-w-0 items-center">
          {group.terminalTypes.slice(0, 4).map((terminalType) => (
            <span
              key={terminalType}
              title={terminalType}
              className="-ml-1 grid h-[22px] w-[22px] place-items-center rounded-full border-2 border-card bg-muted font-mono text-[8px] font-bold uppercase text-muted-foreground first:ml-0"
            >
              {terminalType.slice(0, 2)}
            </span>
          ))}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground/70">
          <TerminalSquare className="h-3 w-3" />
          {relativeTime(group.lastActivity, now, i18n.language)}
        </span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </span>
    </button>
  );
});

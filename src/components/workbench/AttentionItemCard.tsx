import {
  Bookmark,
  BookmarkCheck,
  CircleCheckBig,
  CircleX,
  Clock3,
  MessageSquareWarning,
  ShieldAlert,
  TimerOff,
  type LucideIcon,
} from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AttentionItem, AttentionKind } from '../../lib/workbench/types';
import {
  attentionKindLabel,
  relativeTime,
} from './workbenchFormatting';

interface AttentionItemCardProps {
  item: AttentionItem;
  now: number;
  followed: boolean;
  layout?: AttentionItemCardLayout;
  onOpenItem: (item: AttentionItem) => void;
  onOpenDetail: (item: AttentionItem) => void;
  onIgnoreItem: (item: AttentionItem) => void;
  onToggleFollow: (item: AttentionItem) => void;
}

export type AttentionItemCardLayout = 'compact' | 'wide';

const KIND_STYLE: Record<
  AttentionKind,
  { icon: LucideIcon; border: string; badge: string }
> = {
  approval: {
    icon: ShieldAlert,
    border: 'border-l-warning',
    badge: 'bg-warning/10 text-warning',
  },
  waiting_input: {
    icon: MessageSquareWarning,
    border: 'border-l-warning',
    badge: 'bg-warning/10 text-warning',
  },
  failed: {
    icon: CircleX,
    border: 'border-l-destructive',
    badge: 'bg-destructive/10 text-destructive',
  },
  review: {
    icon: CircleCheckBig,
    border: 'border-l-info',
    badge: 'bg-info/10 text-info',
  },
  stalled: {
    icon: TimerOff,
    border: 'border-l-warning',
    badge: 'bg-warning/10 text-warning',
  },
};

export const AttentionItemCard = memo(function AttentionItemCard({
  item,
  now,
  followed,
  layout = 'wide',
  onOpenItem,
  onOpenDetail,
  onIgnoreItem,
  onToggleFollow,
}: AttentionItemCardProps) {
  const { t, i18n } = useTranslation('terminal');
  const style = KIND_STYLE[item.kind];
  const Icon = style.icon;
  const scope = [item.projectName, item.branchLabel].filter(Boolean).join(' · ');
  const primaryAction = item.capability.openRequest
    ? t('workbench.action.openRequest', { defaultValue: 'View request' })
    : item.kind === 'review'
      ? t('workbench.action.openResult', { defaultValue: 'View result' })
      : t('workbench.action.openTerminal', { defaultValue: 'Open terminal' });
  const compact = layout === 'compact';

  return (
    <article
      data-kind={item.kind}
      data-layout={layout}
      className={[
        'grid min-h-[72px] items-center gap-3 rounded-lg border border-l-2 border-border bg-card/80 px-3 py-2 transition-colors hover:border-border hover:bg-card',
        compact
          ? 'grid-cols-[28px_minmax(0,1fr)]'
          : 'grid-cols-[28px_minmax(0,1fr)_auto]',
        style.border,
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={['grid h-7 w-7 place-items-center rounded-md', style.badge].join(' ')}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0">
        <div className="mb-0.5 flex min-w-0 items-center gap-1.5 text-[11px]">
          <span className={['shrink-0 rounded px-1.5 py-px font-semibold', style.badge].join(' ')}>
            {attentionKindLabel(item.kind, t)}
          </span>
          <span className="truncate text-muted-foreground">{scope}</span>
          <span className="shrink-0 rounded bg-foreground/[0.05] px-1 py-px font-mono text-[11px] text-muted-foreground">
            {item.terminalType}
          </span>
        </div>
        <div className="truncate text-xs font-semibold text-foreground">{item.title}</div>
        {item.detail && (
          <div className="truncate text-[11px] text-muted-foreground">{item.detail}</div>
        )}
        {compact && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/75">
              <Clock3 className="h-3 w-3" />
              {relativeTime(item.occurredAt, now, i18n.language)}
            </span>
            <ItemActions
              compact
              followed={followed}
              primaryAction={primaryAction}
              onOpen={() => onOpenItem(item)}
              onDetail={() => onOpenDetail(item)}
              onIgnore={() => onIgnoreItem(item)}
              onToggleFollow={() => onToggleFollow(item)}
            />
          </div>
        )}
      </div>

      {!compact && (
        <div className="flex items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/75">
            <Clock3 className="h-3 w-3" />
            {relativeTime(item.occurredAt, now, i18n.language)}
          </span>
          <ItemActions
            compact={false}
            followed={followed}
            primaryAction={primaryAction}
            onOpen={() => onOpenItem(item)}
            onDetail={() => onOpenDetail(item)}
            onIgnore={() => onIgnoreItem(item)}
            onToggleFollow={() => onToggleFollow(item)}
          />
        </div>
      )}
    </article>
  );
});

function ItemActions({
  compact,
  followed,
  primaryAction,
  onOpen,
  onDetail,
  onIgnore,
  onToggleFollow,
}: {
  compact: boolean;
  followed: boolean;
  primaryAction: string;
  onOpen: () => void;
  onDetail: () => void;
  onIgnore: () => void;
  onToggleFollow: () => void;
}) {
  const { t } = useTranslation('terminal');
  const followLabel = followed
    ? t('workbench.action.removeFromWorkbench', {
        defaultValue: 'Remove from Workbench',
      })
    : t('workbench.action.addToWorkbench', {
        defaultValue: 'Add to Workbench',
      });
  const ignoreLabel = t('workbench.action.ignoreHint', {
    defaultValue: 'Ignore without opening',
  });
  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        className="h-[27px] rounded-md border border-primary/30 bg-primary/10 px-2.5 text-[11px] font-semibold text-primary hover:bg-primary/15"
      >
        {primaryAction}
      </button>
      <button
        type="button"
        onClick={onDetail}
        className="h-[27px] rounded-md border border-border bg-foreground/[0.03] px-2.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {t('workbench.action.details', { defaultValue: 'Details' })}
      </button>
      <button
        type="button"
        onClick={onIgnore}
        title={ignoreLabel}
        className="h-[27px] rounded-md border border-border bg-foreground/[0.03] px-2.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {t('workbench.action.ignore', { defaultValue: 'Ignore' })}
      </button>
      <button
        type="button"
        onClick={onToggleFollow}
        title={followLabel}
        aria-label={followLabel}
        className={[
          'inline-flex h-[27px] items-center gap-1 rounded-md border px-2 text-[11px] font-medium',
          followed
            ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/15'
            : 'border-border bg-foreground/[0.03] text-muted-foreground hover:bg-accent hover:text-foreground',
        ].join(' ')}
      >
        {followed ? (
          <BookmarkCheck className="h-3 w-3" />
        ) : (
          <Bookmark className="h-3 w-3" />
        )}
        {!compact && (
          <span className="hidden lg:inline">
            {followed
              ? t('workbench.action.followed', { defaultValue: 'Followed' })
              : t('workbench.action.follow', { defaultValue: 'Follow' })}
          </span>
        )}
      </button>
    </>
  );
}

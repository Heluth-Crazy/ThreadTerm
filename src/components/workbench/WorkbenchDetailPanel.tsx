import {
  Activity,
  ArrowUpRight,
  Bell,
  CircleDot,
  Clock3,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AttentionItem,
  ExecutionContextGroup,
  WorkbenchPanelState,
} from '../../lib/workbench/types';
import type { NotificationEntry, TerminalCard } from '../../types/terminal';
import { resolveTerminalEventSummary } from '../../lib/terminalEventSummary';
import {
  attentionKindLabel,
  attentionReasonLabel,
  executionStatusLabel,
  relativeTime,
} from './workbenchFormatting';
import { WorkbenchRulesPanel } from './WorkbenchRulesPanel';

interface WorkbenchDetailPanelProps {
  panel: WorkbenchPanelState;
  attentionItems: readonly AttentionItem[];
  groups: readonly ExecutionContextGroup[];
  cards: readonly TerminalCard[];
  notifications: readonly NotificationEntry[];
  now: number;
  onOpenTerminal: (cardId: string) => Promise<boolean>;
  onClose: () => void;
}

export function WorkbenchDetailPanel({
  panel,
  attentionItems,
  groups,
  cards,
  notifications,
  now,
  onOpenTerminal,
  onClose,
}: WorkbenchDetailPanelProps) {
  const { t } = useTranslation('terminal');
  const item =
    panel.kind === 'attention'
      ? attentionItems.find((candidate) => candidate.id === panel.attentionId)
      : undefined;
  const group =
    panel.kind === 'group'
      ? groups.find((candidate) => candidate.id === panel.groupId)
      : undefined;
  const card = item ? cards.find((candidate) => candidate.id === item.cardId) : undefined;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const title =
    panel.kind === 'rules'
      ? t('workbench.rules.title', { defaultValue: 'Attention rules' })
      : item
        ? attentionKindLabel(item.kind, t)
        : group?.projectName ??
          t('workbench.detail.unavailable', { defaultValue: 'Item unavailable' });
  const safelyOpenTerminal = (cardId: string) => {
    void onOpenTerminal(cardId).catch(() => undefined);
  };

  return (
    <div
      className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-x-hidden"
      role="complementary"
      aria-label={title}
      data-testid="workbench-detail-panel"
    >
      <div className="flex min-h-12 shrink-0 items-center gap-2 etched-border-b px-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            {panel.kind === 'rules'
              ? t('workbench.detail.settings', { defaultValue: 'Local settings' })
              : t('workbench.detail.title', { defaultValue: 'Workbench detail' })}
          </div>
          <div className="truncate text-[13px] font-semibold">{title}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', { defaultValue: 'Close' })}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto p-3">
        {panel.kind === 'rules' ? (
          <WorkbenchRulesPanel cards={cards} />
        ) : item && card ? (
          <AttentionDetail
            item={item}
            card={card}
            notifications={notifications.filter(
              (notification) => notification.cardId === card.id,
            )}
            now={now}
          />
        ) : group ? (
          <GroupDetail
            group={group}
            cards={cards.filter((candidate) => group.cardIds.includes(candidate.id))}
            now={now}
            onOpenTerminal={safelyOpenTerminal}
          />
        ) : (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-[11px] text-muted-foreground">
            {t('workbench.detail.sourceGone', {
              defaultValue: 'The source state changed and this item is no longer active.',
            })}
          </div>
        )}
      </div>

      {panel.kind !== 'rules' && (item || group) && (
        <div className="flex shrink-0 items-center gap-2 etched-border-t px-3 py-2.5">
          <span className="mr-auto text-[11px] leading-tight text-muted-foreground">
            {t('workbench.detail.readonly', {
              defaultValue: 'Read-only here; act in the terminal.',
            })}
          </span>
          <button
            type="button"
            onClick={() =>
              safelyOpenTerminal(item ? item.cardId : (group?.cardIds[0] ?? ''))
            }
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground"
          >
            <ArrowUpRight className="h-3 w-3" />
            {item?.capability.openRequest
              ? t('workbench.action.openRequest', { defaultValue: 'View request' })
              : t('workbench.action.openTerminal', { defaultValue: 'Open terminal' })}
          </button>
        </div>
      )}
    </div>
  );
}

function AttentionDetail({
  item,
  card,
  notifications,
  now,
}: {
  item: AttentionItem;
  card: TerminalCard;
  notifications: readonly NotificationEntry[];
  now: number;
}) {
  const { t, i18n } = useTranslation('terminal');
  const events = useMemo(
    () => [...card.events].sort((left, right) => right.at - left.at).slice(0, 8),
    [card.events],
  );
  const recentNotifications = useMemo(
    () => [...notifications].sort((left, right) => right.at - left.at).slice(0, 5),
    [notifications],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-foreground/[0.025] p-3">
        <div className="text-xs font-semibold">{item.title}</div>
        {item.detail && (
          <p
            className="mt-1 max-w-full overflow-hidden whitespace-pre-wrap break-all text-[11px] leading-relaxed text-muted-foreground"
            data-testid="workbench-attention-detail"
          >
            {item.detail}
          </p>
        )}
      </div>

      <dl className="divide-y divide-border rounded-md border border-border px-2.5">
        <Fact
          label={t('workbench.detail.source', { defaultValue: 'Source' })}
          value={t(`workbench.source.${item.sourceKind}`, {
            defaultValue: item.sourceKind.replace('_', ' '),
          })}
        />
        <Fact
          label={t('workbench.detail.reason', { defaultValue: 'Why it appears' })}
          value={attentionReasonLabel(item.reasonCode, t)}
        />
        <Fact
          label={t('workbench.detail.context', { defaultValue: 'Context' })}
          value={[item.projectName, item.branchLabel].filter(Boolean).join(' · ')}
        />
        <Fact
          label={t('workbench.detail.observed', { defaultValue: 'Observed' })}
          value={relativeTime(item.occurredAt, now, i18n.language)}
        />
      </dl>

      {events.length > 0 && (
        <TimelineSection
          title={t('workbench.detail.activity', { defaultValue: 'Terminal activity' })}
          icon={<Activity className="h-3.5 w-3.5" />}
          rows={events.map((event) => ({
            id: `${event.at}:${event.kind}:${event.summary}`,
            title: resolveTerminalEventSummary(event, t),
            meta: relativeTime(event.at, now, i18n.language),
          }))}
        />
      )}

      {recentNotifications.length > 0 && (
        <TimelineSection
          title={t('workbench.detail.notifications', { defaultValue: 'Notifications' })}
          icon={<Bell className="h-3.5 w-3.5" />}
          rows={recentNotifications.map((notification) => ({
            id: notification.id,
            title: notification.title,
            body: notification.body,
            meta: relativeTime(notification.at, now, i18n.language),
          }))}
        />
      )}
    </div>
  );
}

function GroupDetail({
  group,
  cards,
  now,
  onOpenTerminal,
}: {
  group: ExecutionContextGroup;
  cards: readonly TerminalCard[];
  now: number;
  onOpenTerminal: (cardId: string) => void;
}) {
  const { t, i18n } = useTranslation('terminal');
  return (
    <div className="space-y-4">
      <dl className="divide-y divide-border rounded-md border border-border px-2.5">
        <Fact
          label={t('workbench.detail.status', { defaultValue: 'Status' })}
          value={executionStatusLabel(group.status, t)}
        />
        <Fact
          label={t('workbench.detail.path', { defaultValue: 'Path' })}
          value={group.worktreePath}
        />
        <Fact
          label={t('workbench.detail.lastActivity', { defaultValue: 'Last activity' })}
          value={relativeTime(group.lastActivity, now, i18n.language)}
        />
      </dl>

      {group.preview && (
        <div>
          <SectionTitle
            icon={<CircleDot className="h-3.5 w-3.5" />}
            title={t('workbench.detail.latestSignal', {
              defaultValue: 'Latest real signal',
            })}
          />
          <p
            className="max-w-full overflow-hidden whitespace-pre-wrap break-all rounded-md border border-border bg-foreground/[0.025] p-2.5 text-[11px] leading-relaxed text-muted-foreground"
            data-testid="workbench-latest-signal"
          >
            {group.preview}
          </p>
        </div>
      )}

      <div>
        <SectionTitle
          icon={<TerminalSquare className="h-3.5 w-3.5" />}
          title={t('workbench.detail.terminals', { defaultValue: 'Terminals' })}
        />
        <div className="space-y-1">
          {cards
            .slice()
            .sort((left, right) => right.lastActivity - left.lastActivity)
            .map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => onOpenTerminal(card.id)}
                className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-2 text-left hover:bg-accent"
              >
                <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-medium">
                    {card.projectName}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {card.terminalType} · {card.status}
                  </span>
                </span>
                <Clock3 className="h-3 w-3 text-muted-foreground" />
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {relativeTime(card.lastActivity, now, i18n.language)}
                </span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-2 text-[11px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words text-right text-foreground/85">{value}</dd>
    </div>
  );
}

function TimelineSection({
  title,
  icon,
  rows,
}: {
  title: string;
  icon: React.ReactNode;
  rows: Array<{ id: string; title: string; body?: string; meta: string }>;
}) {
  return (
    <div>
      <SectionTitle icon={icon} title={title} />
      <div className="space-y-1">
        {rows.map((row) => (
          <div
            key={row.id}
            className="rounded-md border border-border px-2.5 py-2"
          >
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 text-[11px] font-medium">{row.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{row.meta}</span>
            </div>
            {row.body && (
              <div className="mt-0.5 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                {row.body}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold">
      <span className="text-muted-foreground">{icon}</span>
      {title}
    </div>
  );
}

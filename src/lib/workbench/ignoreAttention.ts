import type { NotificationEntry, NotificationKind } from '../../types/terminal';
import type {
  AttentionItem,
  AttentionKind,
  AttentionSourceKind,
} from './types';

/** Newest ignored episodes are kept; older entries fall off after this cap. */
export const MAX_IGNORED_ATTENTION_EPISODES = 200;

const NOTIFICATION_KINDS_BY_ATTENTION: Record<
  AttentionKind,
  readonly NotificationKind[]
> = {
  review: ['completed'],
  failed: ['failed'],
  waiting_input: ['waiting', 'attention'],
  approval: ['waiting', 'attention'],
  stalled: [],
};

export interface IgnoredAttentionEpisode {
  cardId: string;
  kind: AttentionKind;
  sourceKind: AttentionSourceKind;
  sourceId: string;
  occurredAt: number;
}

export function ignoredAttentionEpisodeFromItem(
  item: Pick<
    AttentionItem,
    'cardId' | 'kind' | 'sourceKind' | 'sourceId' | 'occurredAt'
  >,
  ignoredAt = Date.now(),
): IgnoredAttentionEpisode {
  return {
    cardId: item.cardId,
    kind: item.kind,
    sourceKind: item.sourceKind,
    sourceId: item.sourceId,
    occurredAt:
      item.sourceKind === 'structured_request'
        ? item.occurredAt
        : Math.max(item.occurredAt, ignoredAt),
  };
}

export function isAttentionItemIgnored(
  item: AttentionItem,
  ignored: readonly IgnoredAttentionEpisode[],
): boolean {
  return ignored.some((entry) => matchesIgnoredAttention(item, entry));
}

export function matchesIgnoredAttention(
  item: Pick<
    AttentionItem,
    'cardId' | 'kind' | 'sourceKind' | 'sourceId' | 'occurredAt'
  >,
  entry: IgnoredAttentionEpisode,
): boolean {
  if (entry.cardId !== item.cardId || entry.kind !== item.kind) return false;
  const structured =
    item.sourceKind === 'structured_request' ||
    entry.sourceKind === 'structured_request';
  if (structured) {
    return (
      entry.sourceKind === item.sourceKind && entry.sourceId === item.sourceId
    );
  }
  return item.occurredAt <= entry.occurredAt;
}

export function normalizeIgnoredAttention(
  value: unknown,
): IgnoredAttentionEpisode[] {
  if (!Array.isArray(value)) return [];
  return retainIgnoredAttention(
    value
      .map(normalizeIgnoredAttentionEpisode)
      .filter((entry): entry is IgnoredAttentionEpisode => entry !== null),
  );
}

export function retainIgnoredAttention(
  entries: readonly IgnoredAttentionEpisode[],
  validCardIds?: ReadonlySet<string> | readonly string[],
): IgnoredAttentionEpisode[] {
  const valid =
    validCardIds == null
      ? null
      : validCardIds instanceof Set
        ? validCardIds
        : new Set(validCardIds);
  const next: IgnoredAttentionEpisode[] = [];
  const structuredKeys = new Set<string>();
  const watermarkKeys = new Set<string>();

  for (const entry of entries) {
    if (valid && !valid.has(entry.cardId)) continue;
    if (entry.sourceKind === 'structured_request') {
      const key = `${entry.cardId}\u001f${entry.kind}\u001f${entry.sourceId}`;
      if (structuredKeys.has(key)) continue;
      structuredKeys.add(key);
      next.push(entry);
    } else {
      const key = `${entry.cardId}\u001f${entry.kind}`;
      if (watermarkKeys.has(key)) continue;
      watermarkKeys.add(key);
      next.push(entry);
    }
    if (next.length >= MAX_IGNORED_ATTENTION_EPISODES) break;
  }
  return next;
}

/**
 * Notifications acknowledged by ignoring a workbench item. This does not
 * navigate, and it only targets the ignored card's related unread entries
 * so a later episode can still reappear.
 */
export function notificationIdsAcknowledgedByIgnore(
  item: AttentionItem,
  notifications: readonly NotificationEntry[],
): string[] {
  const kinds = new Set(NOTIFICATION_KINDS_BY_ATTENTION[item.kind]);
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  if (item.sourceKind === 'notification') push(item.sourceId);

  if (kinds.size === 0) return ids;

  for (const notification of notifications) {
    if (notification.read || notification.cardId !== item.cardId) continue;
    if (kinds.has(notification.kind)) push(notification.id);
  }
  return ids;
}

function normalizeIgnoredAttentionEpisode(
  value: unknown,
): IgnoredAttentionEpisode | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<IgnoredAttentionEpisode>;
  const occurredAt = Number(candidate.occurredAt);
  if (
    typeof candidate.cardId !== 'string' ||
    candidate.cardId.trim().length === 0 ||
    !isAttentionKind(candidate.kind) ||
    !isAttentionSourceKind(candidate.sourceKind) ||
    typeof candidate.sourceId !== 'string' ||
    candidate.sourceId.trim().length === 0 ||
    !Number.isFinite(occurredAt)
  ) {
    return null;
  }
  return {
    cardId: candidate.cardId,
    kind: candidate.kind,
    sourceKind: candidate.sourceKind,
    sourceId: candidate.sourceId,
    occurredAt,
  };
}

function isAttentionKind(value: unknown): value is AttentionKind {
  return (
    value === 'approval' ||
    value === 'waiting_input' ||
    value === 'failed' ||
    value === 'review' ||
    value === 'stalled'
  );
}

function isAttentionSourceKind(value: unknown): value is AttentionSourceKind {
  return (
    value === 'structured_request' ||
    value === 'supervisor_alert' ||
    value === 'notification' ||
    value === 'terminal_state'
  );
}

import type { SupervisorAlert } from '../supervisor/supervisorStore';
import type { PendingCodexRequest } from '../codexApp/pendingRequest';
import {
  classifyCodexRequest,
  summarizeCodexRequest,
} from '../codexApp/pendingRequest';
import { cardMatchesWorktree } from '../worktreePaths';
import type { NotificationEntry, TerminalCard } from '../../types/terminal';
import type {
  AttentionItem,
  AttentionKind,
  AttentionSourceKind,
  WorkbenchRules,
  WorkbenchSummary,
} from './types';

interface DeriveAttentionItemsInput {
  cards: readonly TerminalCard[];
  notifications: readonly NotificationEntry[];
  supervisorAlerts: readonly SupervisorAlert[];
  codexRequests: readonly PendingCodexRequest[];
  rules: WorkbenchRules;
  now: number;
  selectedProjectPath?: string | null;
  selectedWorktreePath?: string | null;
}

const SUPERVISOR_APPROVAL_RULES = new Set([
  'yes-no-bracket',
  'yes-no-paren',
  'ai-proceed',
  'ai-apply-diff',
  'arrow-select',
]);

export function filterWorkbenchCards(
  cards: readonly TerminalCard[],
  selectedProjectPath?: string | null,
  selectedWorktreePath?: string | null,
): TerminalCard[] {
  if (!selectedProjectPath) return [...cards];
  return cards.filter(
    (card) =>
      card.projectPath === selectedProjectPath &&
      cardMatchesWorktree(card, selectedWorktreePath),
  );
}

export function deriveAttentionItems(input: DeriveAttentionItemsInput): AttentionItem[] {
  const cards = filterWorkbenchCards(
    input.cards,
    input.selectedProjectPath,
    input.selectedWorktreePath,
  );
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const unreadNotifications = input.notifications.filter(
    (notification) => !notification.read && cardById.has(notification.cardId),
  );
  const items: AttentionItem[] = [];
  const waitingSourceByCard = new Set<string>();
  const semanticKeys = new Set<string>();

  if (input.rules.includeWaiting) {
    for (const request of input.codexRequests) {
      const card = cardById.get(request.cardId);
      if (!card) continue;
      const kind = classifyCodexRequest(request.method);
      items.push(
        makeItem({
          card,
          kind,
          severity: kind === 'approval' ? 'critical' : 'warning',
          sourceKind: 'structured_request',
          sourceId: request.key,
          occurredAt: request.createdAt,
          title: card.projectName,
          detail: summarizeCodexRequest(request.params) || undefined,
          reasonCode: kind === 'approval' ? 'structured_approval' : 'structured_input',
          notificationId: request.notificationId,
          openRequest: true,
        }),
      );
      waitingSourceByCard.add(card.id);
    }

    for (const alert of input.supervisorAlerts) {
      if (alert.acted || waitingSourceByCard.has(alert.cardId)) continue;
      const card = cardById.get(alert.cardId);
      if (!card) continue;
      const kind: AttentionKind = SUPERVISOR_APPROVAL_RULES.has(alert.ruleId)
        ? 'approval'
        : 'waiting_input';
      items.push(
        makeItem({
          card,
          kind,
          severity: kind === 'approval' ? 'critical' : 'warning',
          sourceKind: 'supervisor_alert',
          sourceId: alert.id,
          occurredAt: alert.ts,
          title: card.projectName,
          detail: cleanDetail(alert.sampleText),
          reasonCode: 'supervisor_prompt',
          notificationId: alert.notificationId,
          openRequest: false,
        }),
      );
      waitingSourceByCard.add(card.id);
    }
  }

  for (const card of cards) {
    const latestByKind = latestUnreadNotificationsForCard(unreadNotifications, card.id);

    if (input.rules.includeWaiting && card.status === 'waiting' && !waitingSourceByCard.has(card.id)) {
      const source = latestByKind.waiting ?? latestByKind.attention;
      addSemanticItem(items, semanticKeys, `${card.id}:waiting`, () =>
        makeItem({
          card,
          kind: 'waiting_input',
          severity: 'warning',
          sourceKind: source ? 'notification' : 'terminal_state',
          sourceId: source?.id ?? card.id,
          occurredAt: source?.at ?? card.lastActivity,
          title: source?.title ?? card.projectName,
          detail: cleanDetail(source?.body ?? card.lastReplyPreview),
          reasonCode: 'waiting_state',
          notificationId: source?.id ?? null,
          openRequest: false,
        }),
      );
    }

    if (
      input.rules.includeFailed &&
      card.status === 'failed' &&
      !hasPendingAutoRestart(card)
    ) {
      const source = latestByKind.failed;
      addSemanticItem(items, semanticKeys, `${card.id}:failed`, () =>
        makeItem({
          card,
          kind: 'failed',
          severity: 'critical',
          sourceKind: source ? 'notification' : 'terminal_state',
          sourceId: source?.id ?? card.id,
          occurredAt: source?.at ?? card.lastActivity,
          title: source?.title ?? card.projectName,
          detail: cleanDetail(source?.body ?? card.lastReplyPreview),
          reasonCode: 'failed_state',
          notificationId: source?.id ?? null,
          openRequest: false,
        }),
      );
    }

    const completedSource = latestByKind.completed;
    if (
      input.rules.includeCompletedReview &&
      (card.status === 'completed' || Boolean(completedSource))
    ) {
      const source = completedSource;
      addSemanticItem(items, semanticKeys, `${card.id}:review`, () =>
        makeItem({
          card,
          kind: 'review',
          severity: 'info',
          sourceKind: source ? 'notification' : 'terminal_state',
          sourceId: source?.id ?? card.id,
          occurredAt: source?.at ?? card.lastActivity,
          title: source?.title ?? card.projectName,
          detail: cleanDetail(source?.body ?? card.lastReplyPreview),
          reasonCode: 'completed_unread',
          notificationId: source?.id ?? null,
          openRequest: false,
        }),
      );
    }
  }

  if (input.rules.stalledEnabled) {
    const thresholdMs = input.rules.stalledThresholdMinutes * 60_000;
    const excluded = new Set(input.rules.stalledExcludedCardIds);
    const cardsWithAttention = new Set(items.map((item) => item.cardId));
    for (const card of cards) {
      if (
        card.status !== 'running' ||
        excluded.has(card.id) ||
        cardsWithAttention.has(card.id) ||
        input.now - card.lastActivity < thresholdMs
      ) {
        continue;
      }
      items.push(
        makeItem({
          card,
          kind: 'stalled',
          severity: 'warning',
          sourceKind: 'terminal_state',
          sourceId: card.id,
          occurredAt: card.lastActivity,
          title: card.projectName,
          detail: cleanDetail(card.lastReplyPreview),
          reasonCode: 'stalled_running',
          notificationId: null,
          openRequest: false,
        }),
      );
    }
  }

  return items.sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      right.occurredAt - left.occurredAt,
  );
}

export function deriveWorkbenchSummary(
  cards: readonly TerminalCard[],
  attentionItems: readonly AttentionItem[],
): WorkbenchSummary {
  const cardsWithAttention = new Set(attentionItems.map((item) => item.cardId));
  return {
    // "Needs attention" counts only actionable kinds (approval / waiting /
    // failed / review). Stalled is a watch signal, not an action item, and
    // lives in its own section — but a stalled card still isn't "running
    // normally", so normalRunning keeps using the full item set.
    attention: attentionItems.filter((item) => item.kind !== 'stalled').length,
    normalRunning: cards.filter(
      (card) => card.status === 'running' && !cardsWithAttention.has(card.id),
    ).length,
    review: attentionItems.filter((item) => item.kind === 'review').length,
    failed: attentionItems.filter((item) => item.kind === 'failed').length,
  };
}

export function attentionFilterMatches(
  item: AttentionItem,
  filter: 'all' | 'approval' | 'waiting' | 'failed' | 'review' | 'stalled',
): boolean {
  if (filter === 'all') return true;
  if (filter === 'waiting') return item.kind === 'waiting_input';
  return item.kind === filter;
}

function hasPendingAutoRestart(card: TerminalCard): boolean {
  return Boolean(card.autoRestart?.history.some((attempt) => attempt.status === 'pending'));
}

function latestUnreadNotificationsForCard(
  notifications: readonly NotificationEntry[],
  cardId: string,
): Partial<Record<NotificationEntry['kind'], NotificationEntry>> {
  const latest: Partial<Record<NotificationEntry['kind'], NotificationEntry>> = {};
  for (const notification of notifications) {
    if (notification.cardId !== cardId) continue;
    const current = latest[notification.kind];
    if (!current || notification.at > current.at) latest[notification.kind] = notification;
  }
  return latest;
}

function addSemanticItem(
  items: AttentionItem[],
  semanticKeys: Set<string>,
  semanticKey: string,
  build: () => AttentionItem,
) {
  if (semanticKeys.has(semanticKey)) return;
  semanticKeys.add(semanticKey);
  items.push(build());
}

function makeItem(input: {
  card: TerminalCard;
  kind: AttentionKind;
  severity: AttentionItem['severity'];
  sourceKind: AttentionSourceKind;
  sourceId: string;
  occurredAt: number;
  title: string;
  detail?: string;
  reasonCode: AttentionItem['reasonCode'];
  notificationId: string | null;
  openRequest: boolean;
}): AttentionItem {
  return {
    id: `${input.sourceKind}:${input.sourceId}`,
    cardId: input.card.id,
    kind: input.kind,
    severity: input.severity,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    occurredAt: input.occurredAt,
    projectPath: input.card.projectPath,
    projectName: input.card.projectName,
    worktreePath: input.card.worktreePath,
    branchLabel: input.card.branchLabel,
    terminalType: input.card.terminalType,
    title: input.title,
    detail: input.detail,
    reasonCode: input.reasonCode,
    capability: {
      openRequest: input.openRequest,
      openTerminal: true,
      openNotification: Boolean(input.notificationId),
      openEvidence: false,
    },
  };
}

function cleanDetail(value: string | undefined, maxLength = 240): string | undefined {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function severityRank(severity: AttentionItem['severity']): number {
  switch (severity) {
    case 'critical':
      return 3;
    case 'warning':
      return 2;
    case 'info':
      return 1;
  }
}

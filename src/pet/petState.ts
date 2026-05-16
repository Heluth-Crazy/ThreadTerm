import type {
  DesktopPetConfig,
  NotificationEntry,
  NotificationKind,
  TerminalCard,
  TerminalStatus,
} from '../types/terminal';

export interface PetCardSummary {
  id: string;
  projectName: string;
  projectPath: string;
  status: TerminalStatus;
  unread: boolean;
  unreadCount: number;
  lastActivity: number;
  preview: string;
  latestKind: NotificationKind | null;
}

export interface PetStatePayload {
  cards: PetCardSummary[];
  notifications: NotificationEntry[];
  unreadCount: number;
  config: DesktopPetConfig;
  updatedAt: number;
}

export interface BuildPetStateInput {
  cards: TerminalCard[];
  notifications: NotificationEntry[];
  config: DesktopPetConfig;
  now?: number;
}

const ATTENTION_STATUSES = new Set<TerminalStatus>(['waiting', 'failed']);

function latestNotificationForCard(
  notifications: NotificationEntry[],
  cardId: string,
): NotificationEntry | undefined {
  return notifications.find((notification) => notification.cardId === cardId);
}

function previewForCard(card: TerminalCard, notification?: NotificationEntry): string {
  const raw =
    notification?.body ||
    notification?.title ||
    card.lastReplyPreview ||
    card.lastOutput ||
    card.events[card.events.length - 1]?.summary ||
    card.projectPath;
  return raw.trim().replace(/\s+/g, ' ').slice(0, 140);
}

export function buildPetState({
  cards,
  notifications,
  config,
  now = Date.now(),
}: BuildPetStateInput): PetStatePayload {
  const unreadByCard = new Map<string, number>();
  for (const notification of notifications) {
    if (!notification.read) {
      unreadByCard.set(notification.cardId, (unreadByCard.get(notification.cardId) ?? 0) + 1);
    }
  }

  const summaries = cards
    .filter((card) => card.unread || ATTENTION_STATUSES.has(card.status))
    .map((card) => {
      const latestNotification = latestNotificationForCard(notifications, card.id);
      return {
        id: card.id,
        projectName: card.projectName,
        projectPath: card.worktreePath || card.projectPath,
        status: card.status,
        unread: card.unread,
        unreadCount: unreadByCard.get(card.id) ?? 0,
        lastActivity: card.lastActivity,
        preview: previewForCard(card, latestNotification),
        latestKind: latestNotification?.kind ?? null,
      } satisfies PetCardSummary;
    })
    .sort((a, b) => b.lastActivity - a.lastActivity);

  return {
    cards: summaries,
    notifications: notifications.slice(0, 12),
    unreadCount: notifications.filter((notification) => !notification.read).length,
    config,
    updatedAt: now,
  };
}

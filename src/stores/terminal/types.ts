/**
 * 终端 store —— 共享类型。
 *
 * store 按域拆成若干 zustand slice（见同目录兄弟文件）。所有 slice 共享同一组
 * 覆盖完整 `TerminalStore` 的 `set`/`get`，因此任一 slice 可经 `get()`/`set()`
 * 直接读写其他 slice 的字段。
 */
import type { StateCreator } from 'zustand';
import type {
  NotificationEntry,
  TerminalCard,
  TerminalCreateOptions,
  TerminalEvent,
  TerminalAiIntent,
  CodexAppThreadBinding,
  ProviderSessionImportInfo,
  TerminalStatus,
} from '../../types/terminal';
import type { AutoRestartDecision } from '../../lib/autoRestart';

/** Maximum number of user-pinned cards eligible for the global selector overlay. */
export const MAX_PINNED_CARDS = 6;

/** Maximum number of recently focused cards shown in the session dock. */
export const MAX_RECENTLY_VIEWED_CARDS = 20;

/** Maximum length of a user-assigned card display name (`projectName`). */
export const MAX_CARD_NAME_LENGTH = 80;

export interface ArchivedTerminalCard extends TerminalCard {
  archivedAt: number;
}

// ── cards slice ────────────────────────────────────────────────────────────
export interface CardsSlice {
  cards: TerminalCard[];
  archivedCards: ArchivedTerminalCard[];

  /**
   * User-defined card order scoped by exact `projectPath`.
   *
   * Keys are raw project paths. Do not normalize separators or case-fold here:
   * macOS/Linux and Windows paths must remain byte-stable across reloads.
   */
  projectCardOrder: Record<string, string[]>;

  createCard: (options: TerminalCreateOptions) => string;
  importProviderSessionCards: (sessions: ProviderSessionImportInfo[]) => number;
  removeCard: (id: string) => void;
  archiveCard: (id: string) => void;
  restoreArchivedCard: (id: string) => void;
  updateCardOutput: (id: string, chunk: string) => void;
  updateCardOutputAndPreview: (
    id: string,
    chunk: string | null,
    preview: string | null,
  ) => void;
  updateCardStatus: (id: string, status: TerminalStatus) => void;
  updateCardReplyPreview: (id: string, preview: string) => void;
  appendEvent: (id: string, event: Omit<TerminalEvent, 'at'> & { at?: number }) => void;
  incrementMessageCount: (id: string) => void;
  recordUserSubmit: (id: string, summary: string) => void;
  markUnread: (id: string, unread: boolean) => void;
  markCardRead: (id: string) => void;
  markProviderSessionBound: (id: string, providerSessionId: string) => void;
  bindCodexAppThread: (id: string, binding: CodexAppThreadBinding) => void;
  updateCardAiIntent: (id: string, intent: TerminalAiIntent | null) => void;
  /**
   * Rename a card's display name. Trims, caps at MAX_CARD_NAME_LENGTH, and
   * falls back to the project directory basename when the new name is blank.
   * Only the targeted card changes — cards sharing a projectPath are unaffected.
   */
  renameCard: (id: string, name: string) => void;
  moveProjectCard: (projectPath: string, id: string, toIndex: number) => void;
  getCardsForProjectView: (path: string | null, worktreePath?: string | null) => TerminalCard[];
  getArchivedCardsForProject: (
    path: string,
    worktreePath?: string | null,
  ) => ArchivedTerminalCard[];
  getCardById: (id: string) => TerminalCard | undefined;
}

// ── auto-restart slice ─────────────────────────────────────────────────────
export interface AutoRestartSlice {
  setCardAutoRestartEnabled: (id: string, enabled: boolean) => void;
  setCardAutoRestartMaxRetries: (id: string, maxRetries: number) => void;
  scheduleCardAutoRestart: (
    id: string,
    input: { exitCode?: number | null; now?: number },
  ) => AutoRestartDecision | null;
  startCardAutoRestart: (
    id: string,
    input: { attempt: number; now?: number },
  ) => string | null;
  cancelCardAutoRestart: (id: string, now?: number) => void;
}

// ── notifications slice ────────────────────────────────────────────────────
export interface NotificationsSlice {
  notifications: NotificationEntry[];
  notificationCentreOpen: boolean;
  /** Pending cardId to focus once the app regains focus (system-notification click). */
  pendingFocusCardId: string | null;
  /**
   * One-shot "locate this card" request from a notification jump. Unlike
   * `pendingFocusCardId` (always opens the full-screen focus view), the
   * consumer resolves this with smart-hybrid semantics: stay in the grid and
   * scroll + pulse when the grid is already showing, otherwise fall back to
   * the focus view. Transient — never persisted.
   */
  pendingLocateCardId: string | null;
  /**
   * Card currently flashing its "you were looking for me" pulse after a
   * notification jump. Transient UI state — never persisted; cleared
   * automatically ~2.4s after `highlightCard`.
   */
  highlightCardId: string | null;

  // OS notifications
  osNotificationsEnabled: boolean;
  setOsNotificationsEnabled: (enabled: boolean) => void;

  /** Master switch for the AI Supervisor. Default OFF — when false, the
   *  backend doesn't subscribe to any events (zero CPU overhead). */
  supervisorEnabled: boolean;
  setSupervisorEnabled: (enabled: boolean) => void;

  pushNotification: (
    n: Omit<NotificationEntry, 'id' | 'at' | 'read'> & { at?: number },
  ) => NotificationEntry;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  clearNotifications: () => void;
  removeNotification: (id: string) => void;
  /** Remove read notifications older than `olderThanMs` (default 2h). */
  purgeReadNotifications: (olderThanMs?: number) => number;
  toggleNotificationCentre: (open?: boolean) => void;
  setPendingFocusCardId: (id: string | null) => void;
  setPendingLocateCardId: (id: string | null) => void;
  /** Flash the notification-locate pulse on a card; auto-expires (default 2.4s). */
  highlightCard: (id: string, ttlMs?: number) => void;
  getUnreadCount: () => number;
}

// ── navigation slice (focus / pin / recently viewed) ───────────────────────
export interface NavigationSlice {
  focusedCardId: string | null;
  lastActiveCardId: string | null;
  /** Global MRU queue for the focus-mode session dock. */
  recentlyViewedCardIds: string[];
  /** Whether the focus-mode session dock is pinned open. */
  dockPinned: boolean;
  /**
   * Ordered list of card ids that the user has pinned to the global overlay
   * selector. Capped at `MAX_PINNED_CARDS` (6). Order is the preferred
   * presentation order before the lastActivity re-sort in the selector.
   */
  pinnedCardIds: string[];

  focusCard: (id: string | null) => void;
  toggleDockPin: () => void;
  switchToLast: () => void;
  nextCard: () => void;
  prevCard: () => void;
  jumpToIndex: (i: number) => void;

  pinCard: (id: string) => boolean;
  unpinCard: (id: string) => void;
  movePinned: (id: string, toIndex: number) => void;
  isPinned: (id: string) => boolean;
  getPinnedCards: () => TerminalCard[];
}

// ── project slice (project / worktree selection) ───────────────────────────
export interface ProjectSlice {
  /** Selected project path for the left sidebar filter. `null` = "All". */
  selectedProjectPath: string | null;
  /** Selected worktree path for the branch/worktree filter. `null` = project level. */
  selectedWorktreePath: string | null;
  /** Human-readable selected branch/worktree label for breadcrumbs and empty states. */
  selectedWorktreeLabel: string | null;

  selectProject: (path: string | null) => void;
  selectWorktree: (projectPath: string, worktreePath: string, label?: string | null) => void;
}

export type TerminalStore = CardsSlice &
  AutoRestartSlice &
  NotificationsSlice &
  NavigationSlice &
  ProjectSlice;

/** StateCreator specialised for a slice of the persisted terminal store. */
export type TerminalSliceCreator<T> = StateCreator<
  TerminalStore,
  [['zustand/persist', unknown]],
  [],
  T
>;

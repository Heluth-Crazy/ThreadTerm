/**
 * Terminal Manager Lite — single Zustand store.
 *
 * State split:
 *   • cards / lastActiveCardId / focusedCardId     → persisted metadata
 *   • notifications / centreOpen                   → persisted
 *   • switcherVisible / switcherSelectedIndex      → volatile (not persisted)
 *
 * Output buffers (`lastOutput`, `lastReplyPreview`) are persisted as-is because
 * they're tiny (≤2KB per card) and give the user a useful restart preview
 * until the PTY reconnects and overwrites them. Their high-frequency writes
 * are debounced at the storage layer — see `./throttledStorage` (FIX-3) — so
 * per-chunk store mutations don't each trigger a synchronous full
 * `JSON.stringify(cards)` + `localStorage` write.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createThrottledLocalStorage } from './throttledStorage';
import type {
  NotificationEntry,
  NotificationKind,
  DesktopPetConfig,
  Block,
  Bookmark,
  TerminalCard,
  TerminalCreateOptions,
  TerminalEvent,
  TerminalAiIntent,
  CodexAppThreadBinding,
  ProviderSessionImportInfo,
  TerminalStatus,
} from '../types/terminal';
import type { AiExplainProvider } from '../lib/ai/aiExplain';
import {
  MAX_BLOCK_OUTPUT_LENGTH,
  MAX_BLOCKS_PER_CARD,
  MAX_LAST_OUTPUT_LENGTH,
  MAX_NOTIFICATIONS,
  MAX_TIMELINE_EVENTS,
} from '../types/terminal';
import {
  cancelPendingAutoRestart,
  clampAutoRestartMaxRetries,
  createAutoRestartDecision,
  markAutoRestartStarted,
  normalizeAutoRestartConfig,
  type AutoRestartDecision,
} from '../lib/autoRestart';
import { DEFAULT_PET_CONFIG, normalizePetConfig } from '../lib/petConfig';
import i18n from '../i18n/config.js';
import { isTauriEnv, pty } from '../lib/tauri-bridge';
import { emitSettingsChanged, type TerminalPreferenceSnapshot } from '../lib/settingsSync';
import { orderCardsByIdList } from '../lib/cardSort';
import {
  cardMatchesWorktree,
  effectiveWorktreePath,
  isPendingWorktreePath,
  pathBasename,
  samePath,
} from '../lib/worktreePaths';

// ── helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  // Not security-sensitive; time + random is plenty.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function uuid(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();

  // RFC 4122 v4 fallback for older webviews/test environments.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function appendEvent(card: TerminalCard, event: TerminalEvent): TerminalCard {
  const events = [...card.events, event];
  if (events.length > MAX_TIMELINE_EVENTS) {
    events.splice(0, events.length - MAX_TIMELINE_EVENTS);
  }
  return { ...card, events, lastActivity: event.at };
}

function tailJoin(buffer: string, chunk: string, limit: number): string {
  if (!chunk) return buffer;
  const next = buffer + chunk;
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}

// Strip ANSI escape sequences and non-printable control characters so the
// preview on cards stays readable. Handles:
//   • CSI  ESC [ ... final-byte         (cursor moves, SGR, erase, DECSET/DECRST...)
//   • OSC  ESC ] ... (BEL | ESC \)      (titles, hyperlinks)
//   • DCS / SOS / PM / APC              (similar structure to OSC)
//   • 2-byte ESC sequences  ESC <single>
//   • single-char C0 controls           (keeping \t \n)
//   • DEL (0x7f) and all C1 controls (0x80-0x9f)
/* eslint-disable no-control-regex */
const ANSI_RE = new RegExp(
  [
    // CSI sequences (ESC [ ... with optional private markers + intermediates + final)
    '\\x1b\\[[0-?]*[ -/]*[@-~]',
    // OSC / DCS / SOS / PM / APC — terminated by BEL or ST (ESC \)
    '\\x1b[\\]PX^_][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
    // Escape sequences per VT100 spec: ESC (intermediate 0x20-0x2F)* (final 0x30-0x7E)
    '\\x1b[\\x20-\\x2f]*[\\x30-\\x7e]',
  ].join('|'),
  'g',
);
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '').replace(CONTROL_RE, '').replace(/\r/g, '');
}

function isProviderSessionType(type: TerminalCard['terminalType']): boolean {
  return type === 'claude' || type === 'codex';
}

function providerSessionKey(provider: ProviderSessionImportInfo['provider'], id: string): string {
  return `${provider}\0${id}`;
}

function normalizeImportedProviderSession(
  session: ProviderSessionImportInfo,
): ProviderSessionImportInfo | null {
  const id = session.id.trim();
  const projectPath = session.projectPath.trim();
  if (!id || !projectPath) return null;
  if (session.provider !== 'claude' && session.provider !== 'codex') return null;

  return {
    id,
    provider: session.provider,
    projectPath,
    updatedAt:
      typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
        ? session.updatedAt
        : null,
  };
}

function isTransientStatus(status: TerminalStatus): boolean {
  return status === 'running' || status === 'waiting';
}

function prepareAutoRestartForPersistence(card: TerminalCard): TerminalCard['autoRestart'] {
  if (!card.autoRestart) return undefined;
  const normalized = normalizeAutoRestartConfig(card.autoRestart);
  return {
    ...cancelPendingAutoRestart(normalized, Date.now()),
    enabled: normalized.enabled,
  };
}

// ── store shape ──────────────────────────────────────────────────────────────

/** Maximum number of user-pinned cards eligible for the global selector overlay. */
export const MAX_PINNED_CARDS = 6;

/** Maximum number of recently focused cards shown in the session dock. */
export const MAX_RECENTLY_VIEWED_CARDS = 20;

/** Maximum length of a user-assigned card display name (`projectName`). */
export const MAX_CARD_NAME_LENGTH = 80;
export { DEFAULT_PET_CONFIG } from '../lib/petConfig';

export interface ArchivedTerminalCard extends TerminalCard {
  archivedAt: number;
}

interface TerminalStore {
  // Cards
  cards: TerminalCard[];
  archivedCards: ArchivedTerminalCard[];
  blocks: Record<string, Block[]>;
  focusedCardId: string | null;
  lastActiveCardId: string | null;
  /** Global MRU queue for the focus-mode session dock. */
  recentlyViewedCardIds: string[];
  /** Whether the focus-mode session dock is pinned open. */
  dockPinned: boolean;

  /** Selected project path for the left sidebar filter. `null` = "All". */
  selectedProjectPath: string | null;
  /** Selected worktree path for the branch/worktree filter. `null` = project level. */
  selectedWorktreePath: string | null;
  /** Human-readable selected branch/worktree label for breadcrumbs and empty states. */
  selectedWorktreeLabel: string | null;

  /**
   * User-defined card order scoped by exact `projectPath`.
   *
   * Keys are raw project paths. Do not normalize separators or case-fold here:
   * macOS/Linux and Windows paths must remain byte-stable across reloads.
   */
  projectCardOrder: Record<string, string[]>;

  /**
   * Ordered list of card ids that the user has pinned to the global overlay
   * selector. Capped at `MAX_PINNED_CARDS` (6). Order is the preferred
   * presentation order before the lastActivity re-sort in the selector.
   */
  pinnedCardIds: string[];

  // Notification centre
  notifications: NotificationEntry[];
  notificationCentreOpen: boolean;
  /** Pending cardId to focus once the app regains focus (system-notification click). */
  pendingFocusCardId: string | null;

  // Desktop pet
  petConfig: DesktopPetConfig;
  updatePetConfig: (patch: Partial<DesktopPetConfig>) => void;

  // ─── Stage 6: AI Explain + bottom chip strip settings ────────────────────
  /** Default provider to use when the focused card is not an AI CLI. */
  aiExplainDefaultProvider: AiExplainProvider;
  /** Global toggle for the focus-mode bottom chip strip. Defaults to false
   *  (i.e. the chip strip is visible). Per-card overrides deferred. */
  bottomBarHidden: boolean;
  setAiExplainDefaultProvider: (provider: AiExplainProvider) => void;
  setBottomBarHidden: (hidden: boolean) => void;

  // ─── AI Supervisor v0.1 (PRD D3) ─────────────────────────────────────────
  /** Master switch for the AI Supervisor. Default OFF — when false, the
   *  backend doesn't subscribe to any events (zero CPU overhead). */
  supervisorEnabled: boolean;
  setSupervisorEnabled: (enabled: boolean) => void;

  // ─── card actions ────────────────────────────────────────────────────────
  createCard: (options: TerminalCreateOptions) => string;
  importProviderSessionCards: (sessions: ProviderSessionImportInfo[]) => number;
  removeCard: (id: string) => void;
  archiveCard: (id: string) => void;
  restoreArchivedCard: (id: string) => void;
  updateCardOutput: (id: string, chunk: string) => void;
  updateCardStatus: (id: string, status: TerminalStatus) => void;
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
  recordBlockStarted: (input: {
    cardId: string;
    blockId: string;
    command: string;
    cwd: string;
    startedAt: number;
    /**
     * Absolute scrollback row index (`baseY + cursorY`) at the moment the
     * block started — used by Stage 4 to anchor folding / "jump to failed
     * block" / per-block copy actions to real xterm rows. The bridge
     * resolves this from `xtermRegistry.getAbsoluteCursorRow` so callers
     * never have to compute it themselves.
     */
    bufferStart: number;
  }) => void;
  recordBlockFinished: (input: {
    cardId: string;
    blockId: string;
    exitCode?: number | null;
    finishedAt: number;
    durationMs?: number | null;
    /** Absolute scrollback row index at the moment the block finished. */
    bufferEnd?: number;
    /** Stage 5.1 — ANSI-stripped output snapshot. Truncated to
     *  MAX_BLOCK_OUTPUT_LENGTH by the store; callers may pass larger strings. */
    output?: string;
  }) => void;
  ensureBlocksState: () => void;

  // ─── block UI state (Stage 4, volatile — not persisted) ──────────────────
  /** Set of block ids the user has collapsed. Reset to [] on app restart. */
  collapsedBlockIds: string[];
  /** Per-card selected block id for the Block Inspector. `null` = nothing selected. */
  selectedBlockId: Record<string, string | null>;
  toggleBlockCollapsed: (blockId: string) => void;
  selectBlock: (cardId: string, blockId: string | null) => void;

  // ─── bookmarks (Stage 5, persisted) ───────────────────────────────────
  bookmarks: Bookmark[];
  addBookmark: (input: {
    blockId: string;
    cardId: string;
    command: string;
    cwd: string;
    label?: string;
  }) => Bookmark | null;
  removeBookmark: (id: string) => void;
  isBookmarked: (blockId: string) => boolean;

  // ─── focus / switching ───────────────────────────────────────────────────
  focusCard: (id: string | null) => void;
  toggleDockPin: () => void;
  switchToLast: () => void;
  nextCard: () => void;
  prevCard: () => void;
  jumpToIndex: (i: number) => void;

  // ─── project sidebar ────────────────────────────────────────────────────
  selectProject: (path: string | null) => void;
  selectWorktree: (projectPath: string, worktreePath: string, label?: string | null) => void;
  getCardsForProjectView: (path: string | null, worktreePath?: string | null) => TerminalCard[];
  getArchivedCardsForProject: (
    path: string,
    worktreePath?: string | null,
  ) => ArchivedTerminalCard[];

  // ─── pinned cards (global overlay) ───────────────────────────────────────
  pinCard: (id: string) => boolean;
  unpinCard: (id: string) => void;
  movePinned: (id: string, toIndex: number) => void;
  isPinned: (id: string) => boolean;
  getPinnedCards: () => TerminalCard[];

  // ─── notifications ───────────────────────────────────────────────────────
  pushNotification: (n: Omit<NotificationEntry, 'id' | 'at' | 'read'> & { at?: number }) => NotificationEntry;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  clearNotifications: () => void;
  removeNotification: (id: string) => void;
  /** Remove read notifications older than `olderThanMs` (default 2h). */
  purgeReadNotifications: (olderThanMs?: number) => number;
  toggleNotificationCentre: (open?: boolean) => void;
  setPendingFocusCardId: (id: string | null) => void;

  // ─── selectors ───────────────────────────────────────────────────────────
  getCardById: (id: string) => TerminalCard | undefined;
  getUnreadCount: () => number;
}

// ── store impl ───────────────────────────────────────────────────────────────

function terminalPreferenceSnapshotFromState(
  state: Pick<
    TerminalStore,
    'bottomBarHidden' | 'aiExplainDefaultProvider' | 'petConfig' | 'supervisorEnabled'
  >,
): TerminalPreferenceSnapshot {
  return {
    bottomBarHidden: state.bottomBarHidden,
    aiExplainDefaultProvider: state.aiExplainDefaultProvider,
    petConfig: normalizePetConfig(state.petConfig),
    supervisorEnabled: state.supervisorEnabled,
  };
}

function notifyTerminalPreferencesChanged(snapshot: TerminalPreferenceSnapshot) {
  void emitSettingsChanged({
    domain: 'terminal-preferences',
    sourceWindow: 'settings',
    terminalPreferences: snapshot,
  });
}

function cardsForProjectView(
  cards: readonly TerminalCard[],
  projectCardOrder: Record<string, string[]> | undefined,
  path: string | null,
  worktreePath?: string | null,
): TerminalCard[] {
  if (!path) return [...cards];
  const projectCards = cards.filter(
    (card) => card.projectPath === path && cardMatchesWorktree(card, worktreePath),
  );
  return orderCardsByIdList(projectCards, projectCardOrder?.[path]);
}

function prependProjectCardOrder(
  order: Record<string, string[]> | undefined,
  projectPath: string,
  cardId: string,
): Record<string, string[]> {
  const current = order?.[projectPath] ?? [];
  return {
    ...(order ?? {}),
    [projectPath]: [cardId, ...current.filter((id) => id !== cardId)],
  };
}

function compactProjectCardOrder(
  order: Record<string, string[]> | undefined,
  cards: readonly TerminalCard[],
): Record<string, string[]> {
  if (!order) return {};
  const idsByProject = new Map<string, Set<string>>();
  for (const card of cards) {
    const ids = idsByProject.get(card.projectPath);
    if (ids) ids.add(card.id);
    else idsByProject.set(card.projectPath, new Set([card.id]));
  }

  const next: Record<string, string[]> = {};
  for (const [projectPath, orderedIds] of Object.entries(order)) {
    const validIds = idsByProject.get(projectPath);
    if (!validIds) continue;
    const seen = new Set<string>();
    const cleaned = orderedIds.filter((id) => {
      if (!validIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (cleaned.length > 0) next[projectPath] = cleaned;
  }
  return next;
}

function sameStringArray(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function compactRecentCardIds(
  ids: readonly string[] | undefined,
  cards: readonly TerminalCard[],
): string[] {
  if (!ids || ids.length === 0) return [];
  const liveIds = new Set(cards.map((card) => card.id));
  const seen = new Set<string>();
  const next: string[] = [];

  for (const id of ids) {
    if (!liveIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
    if (next.length >= MAX_RECENTLY_VIEWED_CARDS) break;
  }

  return sameStringArray(ids, next) ? (ids as string[]) : next;
}

function recentCardIdsAfterFocus(
  ids: readonly string[] | undefined,
  id: string | null,
  cards: readonly TerminalCard[],
): string[] {
  const compacted = compactRecentCardIds(ids, cards);
  if (!id || !cards.some((card) => card.id === id)) return compacted;

  const next = [id, ...compacted.filter((candidate) => candidate !== id)].slice(
    0,
    MAX_RECENTLY_VIEWED_CARDS,
  );
  return sameStringArray(ids, next) ? (ids as string[]) : next;
}

function archiveCardSnapshot(card: TerminalCard, archivedAt: number): ArchivedTerminalCard {
  return {
    ...card,
    archivedAt,
    status: 'idle',
    unread: false,
    autoRestart: prepareAutoRestartForPersistence(card),
  };
}

function restoreArchivedCardSnapshot(card: ArchivedTerminalCard, now: number): TerminalCard {
  const { archivedAt: _archivedAt, ...restored } = card;
  void _archivedAt;
  return {
    ...restored,
    status: 'idle',
    unread: false,
    lastActivity: now,
    autoRestart: prepareAutoRestartForPersistence(restored),
  };
}

function archivedCardsForProject(
  archivedCards: readonly ArchivedTerminalCard[] | undefined,
  path: string,
  worktreePath?: string | null,
): ArchivedTerminalCard[] {
  return (archivedCards ?? [])
    .filter((card) => card.projectPath === path && cardMatchesWorktree(card, worktreePath))
    .sort((a, b) => b.archivedAt - a.archivedAt);
}

export const useTerminalStore = create<TerminalStore>()(
  persist(
    (set, get) => ({
      cards: [],
      archivedCards: [],
      blocks: {},
      collapsedBlockIds: [],
      selectedBlockId: {},
      bookmarks: [],
      focusedCardId: null,
      lastActiveCardId: null,
      recentlyViewedCardIds: [],
      dockPinned: false,
      selectedProjectPath: null,
      selectedWorktreePath: null,
      selectedWorktreeLabel: null,
      projectCardOrder: {},

      pinnedCardIds: [],

      notifications: [],
      notificationCentreOpen: false,
      pendingFocusCardId: null,
      petConfig: DEFAULT_PET_CONFIG,

      aiExplainDefaultProvider: 'claude',
      bottomBarHidden: false,
      setAiExplainDefaultProvider: (provider) => {
        const snapshot = terminalPreferenceSnapshotFromState({
          ...get(),
          aiExplainDefaultProvider: provider,
        });
        set({ aiExplainDefaultProvider: provider });
        notifyTerminalPreferencesChanged(snapshot);
      },
      setBottomBarHidden: (hidden) => {
        const snapshot = terminalPreferenceSnapshotFromState({
          ...get(),
          bottomBarHidden: hidden,
        });
        set({ bottomBarHidden: hidden });
        notifyTerminalPreferencesChanged(snapshot);
      },

      supervisorEnabled: false,
      setSupervisorEnabled: (enabled) => {
        const snapshot = terminalPreferenceSnapshotFromState({
          ...get(),
          supervisorEnabled: enabled,
        });
        set({ supervisorEnabled: enabled });
        notifyTerminalPreferencesChanged(snapshot);
      },

      updatePetConfig: (patch) => {
        const petConfig = normalizePetConfig({ ...get().petConfig, ...patch });
        const snapshot = terminalPreferenceSnapshotFromState({
          ...get(),
          petConfig,
        });
        set({ petConfig });
        notifyTerminalPreferencesChanged(snapshot);
      },

      createCard: (options) => {
        const id = uid();
        const now = Date.now();
        const card: TerminalCard = {
          id,
          ptyId: id, // 1:1 by default; Rust side uses the same id
          projectPath: options.projectPath,
          projectName: options.projectName,
          worktreePath: options.worktreePath,
          branchLabel: options.branchLabel,
          terminalType: options.terminalType,
          command: options.command,
          providerSessionId: options.terminalType === 'claude' ? uuid() : undefined,
          providerSessionState: isProviderSessionType(options.terminalType) ? 'unbound' : undefined,
          status: 'idle',
          createdAt: now,
          lastActivity: now,
          lastOutput: '',
          lastReplyPreview: '',
          messageCount: 0,
          events: [
            {
              at: now,
              kind: 'created',
              summary: i18n.t('terminal:events.created', {
                type: i18n.t(`terminal:types.${options.terminalType}`, options.terminalType),
                project: options.projectName,
              }),
            },
          ],
          unread: false,
        };
        set((state) => ({
          cards: [...state.cards, card],
          projectCardOrder: prependProjectCardOrder(
            state.projectCardOrder,
            options.projectPath,
            id,
          ),
        }));
        return id;
      },

      renameCard: (id, name) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const existing = state.cards[idx];
          const trimmed = name.trim().slice(0, MAX_CARD_NAME_LENGTH);
          const nextName = trimmed || pathBasename(existing.projectPath);
          if (nextName === existing.projectName) return state;
          const cards = [...state.cards];
          cards[idx] = { ...existing, projectName: nextName };
          return { cards };
        }),

      importProviderSessionCards: (sessions) => {
        if (sessions.length === 0) return 0;

        let imported = 0;
        set((state) => {
          const knownCards = [...state.cards, ...(state.archivedCards ?? [])];
          const existingKeys = new Set(
            knownCards
              .filter(
                (card) =>
                  isProviderSessionType(card.terminalType) && Boolean(card.providerSessionId),
              )
              .map((card) =>
                providerSessionKey(
                  card.terminalType as ProviderSessionImportInfo['provider'],
                  card.providerSessionId ?? '',
                ),
              ),
          );
          const projectNames = new Map(
            knownCards.map((card) => [card.projectPath, card.projectName]),
          );
          const cards = [...state.cards];
          let projectCardOrder = state.projectCardOrder ?? {};

          for (const rawSession of sessions) {
            const session = normalizeImportedProviderSession(rawSession);
            if (!session) continue;

            const key = providerSessionKey(session.provider, session.id);
            if (existingKeys.has(key)) continue;

            const now = Date.now();
            const projectName =
              projectNames.get(session.projectPath) ?? pathBasename(session.projectPath);
            const id = uid();
            cards.push({
              id,
              ptyId: session.id,
              projectPath: session.projectPath,
              projectName,
              terminalType: session.provider,
              providerSessionId: session.id,
              providerSessionState: 'bound',
              providerSessionBoundAt: now,
              status: 'idle',
              createdAt: now,
              lastActivity: session.updatedAt ?? now,
              lastOutput: '',
              lastReplyPreview: '',
              messageCount: 0,
              events: [
                {
                  at: now,
                  kind: 'created',
                  summary: i18n.t('terminal:events.created', {
                    type: i18n.t(`terminal:types.${session.provider}`, session.provider),
                    project: projectName,
                  }),
                },
              ],
              unread: false,
            });
            projectCardOrder = prependProjectCardOrder(projectCardOrder, session.projectPath, id);
            existingKeys.add(key);
            projectNames.set(session.projectPath, projectName);
            imported += 1;
          }

          return imported > 0 ? { cards, projectCardOrder } : state;
        });

        return imported;
      },

      removeCard: (id) => {
        const target = get().cards.find((c) => c.id === id);
        if (target && isTauriEnv()) {
          void pty.kill(target.ptyId || target.id);
        }

        set((state) => {
          const cards = state.cards.filter((c) => c.id !== id);
          const focusedCardId = state.focusedCardId === id ? null : state.focusedCardId;
          const lastActiveCardId =
            state.lastActiveCardId === id ? null : state.lastActiveCardId;
          // also drop notifications targeting this card
          const notifications = state.notifications.filter((n) => n.cardId !== id);
          // if the removed card was the last one for its project and the project
          // was selected, fall back to "All"
          let selectedProjectPath = state.selectedProjectPath;
          let selectedWorktreePath = state.selectedWorktreePath;
          let selectedWorktreeLabel = state.selectedWorktreeLabel;
          if (
            target &&
            selectedProjectPath === target.projectPath &&
            !cards.some((c) => c.projectPath === target.projectPath)
          ) {
            selectedProjectPath = null;
            selectedWorktreePath = null;
            selectedWorktreeLabel = null;
          } else if (
            target &&
            selectedWorktreePath &&
            !isPendingWorktreePath(selectedWorktreePath) &&
            samePath(effectiveWorktreePath(target), selectedWorktreePath) &&
            !cards.some(
              (c) =>
                c.projectPath === target.projectPath &&
                samePath(effectiveWorktreePath(c), selectedWorktreePath),
            )
          ) {
            selectedWorktreePath = null;
            selectedWorktreeLabel = null;
          }
          // Also drop from the pinned list so it doesn't linger as a dead entry.
          const pinnedCardIds = state.pinnedCardIds.filter((p) => p !== id);
          const recentlyViewedCardIds = state.recentlyViewedCardIds.filter(
            (recentId) => recentId !== id,
          );
          const projectCardOrder = compactProjectCardOrder(state.projectCardOrder, cards);
          const previousBlocks = (state.blocks ?? {})[id] ?? [];
          const blocks = { ...(state.blocks ?? {}) };
          delete blocks[id];
          // Drop block-level UI state belonging to the removed card so it
          // can't accumulate over a long session.
          const removedBlockIds = new Set(previousBlocks.map((b) => b.id));
          const collapsedBlockIds = state.collapsedBlockIds.filter(
            (bid) => !removedBlockIds.has(bid),
          );
          // Drop the removed card's selection entry. `_removed` is the
          // discarded value from the destructuring; `void` keeps TS quiet
          // without enabling `noUnusedLocals`.
          const { [id]: _removed, ...selectedBlockId } = state.selectedBlockId;
          void _removed;
          // Stage 5 — drop bookmarks belonging to the deleted card.
          const bookmarks = state.bookmarks.filter((b) => b.cardId !== id);
          return {
            cards,
            focusedCardId,
            lastActiveCardId,
            notifications,
            selectedProjectPath,
            selectedWorktreePath,
            selectedWorktreeLabel,
            projectCardOrder,
            pinnedCardIds,
            recentlyViewedCardIds,
            blocks,
            collapsedBlockIds,
            selectedBlockId,
            bookmarks,
          };
        });
      },

      archiveCard: (id) => {
        const target = get().cards.find((c) => c.id === id);
        if (target && isTauriEnv()) {
          void pty.kill(target.ptyId || target.id);
        }

        set((state) => {
          const targetIndex = state.cards.findIndex((c) => c.id === id);
          if (targetIndex === -1) return state;

          const now = Date.now();
          const targetCard = state.cards[targetIndex];
          const cards = state.cards.filter((c) => c.id !== id);
          const archivedCards = [
            archiveCardSnapshot(targetCard, now),
            ...(state.archivedCards ?? []).filter((card) => card.id !== id),
          ];
          const focusedCardId = state.focusedCardId === id ? null : state.focusedCardId;
          const lastActiveCardId =
            state.lastActiveCardId === id ? null : state.lastActiveCardId;
          const pendingFocusCardId =
            state.pendingFocusCardId === id ? null : state.pendingFocusCardId;
          const notifications = state.notifications.filter((n) => n.cardId !== id);
          const pinnedCardIds = state.pinnedCardIds.filter((pinnedId) => pinnedId !== id);
          const recentlyViewedCardIds = state.recentlyViewedCardIds.filter(
            (recentId) => recentId !== id,
          );
          const projectCardOrder = compactProjectCardOrder(state.projectCardOrder, cards);

          return {
            cards,
            archivedCards,
            focusedCardId,
            lastActiveCardId,
            pendingFocusCardId,
            notifications,
            pinnedCardIds,
            recentlyViewedCardIds,
            projectCardOrder,
          };
        });
      },

      restoreArchivedCard: (id) =>
        set((state) => {
          const archivedIndex = (state.archivedCards ?? []).findIndex((card) => card.id === id);
          if (archivedIndex === -1) return state;

          const now = Date.now();
          const archivedCard = state.archivedCards[archivedIndex];
          const restoredCard = restoreArchivedCardSnapshot(archivedCard, now);
          const archivedCards = state.archivedCards.filter((card) => card.id !== id);
          const cards = [...state.cards, restoredCard];

          return {
            cards,
            archivedCards,
            selectedProjectPath: restoredCard.projectPath,
            selectedWorktreePath: state.selectedWorktreePath
              ? effectiveWorktreePath(restoredCard)
              : null,
            selectedWorktreeLabel: state.selectedWorktreePath
              ? (restoredCard.branchLabel ?? state.selectedWorktreeLabel)
              : null,
            projectCardOrder: prependProjectCardOrder(
              state.projectCardOrder,
              restoredCard.projectPath,
              restoredCard.id,
            ),
          };
        }),

      updateCardOutput: (id, chunk) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cleaned = stripAnsi(chunk);
          const cards = [...state.cards];
          const existing = cards[idx];
          cards[idx] = {
            ...existing,
            lastOutput: tailJoin(existing.lastOutput, cleaned, MAX_LAST_OUTPUT_LENGTH),
            lastActivity: Date.now(),
          };
          return { cards };
        }),

      updateCardStatus: (id, status) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          const existing = cards[idx];
          if (existing.status === status) return state;
          const now = Date.now();
          cards[idx] = appendEvent(
            { ...existing, status, lastActivity: now },
            {
              at: now,
              kind: 'status',
              summary: i18n.t('terminal:events.status', {
                status: i18n.t(`terminal:status.${status}`, status),
              }),
            },
          );
          return { cards };
        }),

      setCardAutoRestartEnabled: (id, enabled) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          const existing = cards[idx];
          const current = normalizeAutoRestartConfig(existing.autoRestart);
          const next = enabled
            ? { ...current, enabled: true }
            : { ...cancelPendingAutoRestart(current, Date.now()), enabled: false };
          cards[idx] = { ...existing, autoRestart: next };
          return { cards };
        }),

      setCardAutoRestartMaxRetries: (id, maxRetries) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          const existing = cards[idx];
          cards[idx] = {
            ...existing,
            autoRestart: {
              ...normalizeAutoRestartConfig(existing.autoRestart),
              maxRetries: clampAutoRestartMaxRetries(maxRetries),
            },
          };
          return { cards };
        }),

      scheduleCardAutoRestart: (id, input) => {
        const card = get().cards.find((candidate) => candidate.id === id);
        if (!card) return null;
        const decision = createAutoRestartDecision(card.autoRestart, {
          exitCode: input.exitCode,
          now: input.now ?? Date.now(),
        });
        if (decision.kind === 'ignored' && !card.autoRestart && !decision.config.enabled) {
          return decision;
        }
        set((state) => {
          const idx = state.cards.findIndex((candidate) => candidate.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          cards[idx] = {
            ...cards[idx],
            autoRestart: decision.config,
          };
          return { cards };
        });
        return decision;
      },

      startCardAutoRestart: (id, input) => {
        const now = input.now ?? Date.now();
        const nextPtyId = `${id}-retry-${input.attempt}-${now.toString(36)}`;
        let started = false;
        set((state) => {
          const idx = state.cards.findIndex((candidate) => candidate.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          const existing = cards[idx];
          cards[idx] = appendEvent(
            {
              ...existing,
              ptyId: nextPtyId,
              status: 'idle',
              lastActivity: now,
              autoRestart: markAutoRestartStarted(existing.autoRestart, {
                attempt: input.attempt,
                now,
              }),
            },
            {
              at: now,
              kind: 'status',
              summary: i18n.t('terminal:events.autoRestartStarted', {
                attempt: input.attempt,
              }),
            },
          );
          started = true;
          return { cards };
        });
        return started ? nextPtyId : null;
      },

      cancelCardAutoRestart: (id, now = Date.now()) =>
        set((state) => {
          const idx = state.cards.findIndex((candidate) => candidate.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          const existing = cards[idx];
          cards[idx] = {
            ...existing,
            autoRestart: cancelPendingAutoRestart(existing.autoRestart, now),
          };
          return { cards };
        }),

      updateCardReplyPreview: (id, preview) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          cards[idx] = { ...cards[idx], lastReplyPreview: preview };
          return { cards };
        }),

      appendEvent: (id, event) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          cards[idx] = appendEvent(cards[idx], { at: event.at ?? Date.now(), kind: event.kind, summary: event.summary });
          return { cards };
        }),

      incrementMessageCount: (id) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          cards[idx] = { ...cards[idx], messageCount: cards[idx].messageCount + 1 };
          return { cards };
        }),

      recordUserSubmit: (id, summary) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const now = Date.now();
          const cards = [...state.cards];
          const existing = cards[idx];
          cards[idx] = appendEvent(
            {
              ...existing,
              messageCount: existing.messageCount + 1,
              lastActivity: now,
            },
            {
              at: now,
              kind: 'user-input',
              summary,
            },
          );
          return { cards };
        }),

      markUnread: (id, unread) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1 || state.cards[idx].unread === unread) return state;
          const cards = [...state.cards];
          cards[idx] = { ...cards[idx], unread };
          return { cards };
        }),

      markCardRead: (id) =>
        set((state) => {
          let changed = false;
          const cards = state.cards.map((card) => {
            if (card.id !== id || !card.unread) return card;
            changed = true;
            return { ...card, unread: false };
          });
          const notifications = state.notifications.map((notification) => {
            if (notification.cardId !== id || notification.read) return notification;
            changed = true;
            return { ...notification, read: true };
          });
          return changed ? { cards, notifications } : state;
        }),

      markProviderSessionBound: (id, providerSessionId) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const now = Date.now();
          const cards = [...state.cards];
          const existing = cards[idx];
          cards[idx] = {
            ...existing,
            providerSessionId,
            providerSessionState: 'bound',
            providerSessionBoundAt: existing.providerSessionBoundAt ?? now,
            providerSessionLastResumeAt: now,
          };
          return { cards };
        }),

      bindCodexAppThread: (id, binding) =>
        set((state) => {
          const threadId = binding.threadId.trim();
          if (!threadId) return state;
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const cards = [...state.cards];
          const existing = cards[idx];
          cards[idx] = {
            ...existing,
            codexAppThreadId: threadId,
            codexAppSessionId: binding.sessionId?.trim() || undefined,
            codexAppThreadPath: binding.threadPath?.trim() || undefined,
            codexAppBoundAt: binding.boundAt ?? Date.now(),
          };
          return { cards };
        }),

      updateCardAiIntent: (id, intent) =>
        set((state) => {
          const idx = state.cards.findIndex((c) => c.id === id);
          if (idx === -1) return state;
          const nextIntent = intent ?? undefined;
          if (state.cards[idx].aiIntent === nextIntent) return state;
          const cards = [...state.cards];
          cards[idx] = { ...cards[idx], aiIntent: nextIntent };
          return { cards };
        }),

      moveProjectCard: (projectPath, id, toIndex) =>
        set((state) => {
          const projectCards = cardsForProjectView(
            state.cards,
            state.projectCardOrder,
            projectPath,
          );
          const from = projectCards.findIndex((card) => card.id === id);
          if (from === -1) return state;

          const nextCards = projectCards.slice();
          const [moved] = nextCards.splice(from, 1);
          if (!moved) return state;
          const target = Math.max(0, Math.min(nextCards.length, toIndex));
          nextCards.splice(target, 0, moved);

          const nextIds = nextCards.map((card) => card.id);
          const previousIds = state.projectCardOrder[projectPath] ?? [];
          if (
            previousIds.length === nextIds.length &&
            previousIds.every((candidate, index) => candidate === nextIds[index])
          ) {
            return state;
          }

          return {
            projectCardOrder: {
              ...state.projectCardOrder,
              [projectPath]: nextIds,
            },
          };
        }),

      recordBlockStarted: (input) =>
        set((state) => {
          const blocksByCard = state.blocks ?? {};
          const existing = blocksByCard[input.cardId] ?? [];
          const block: Block = {
            id: input.blockId,
            cardId: input.cardId,
            cwd: input.cwd,
            command: input.command,
            startedAt: input.startedAt,
            bufferStart: input.bufferStart,
            state: 'running',
          };

          const next = [
            ...existing.filter((candidate) => candidate.id !== input.blockId),
            block,
          ];

          if (next.length <= MAX_BLOCKS_PER_CARD) {
            return {
              blocks: {
                ...blocksByCard,
                [input.cardId]: next,
              },
            };
          }

          // Audit P2-4 — FIFO eviction so a long-lived shell can't grow the
          // persisted blocks map until the localStorage quota is hit. UI
          // state and bookmarks pointing at evicted blocks are dropped with
          // them so they can't accumulate as dead references.
          const evicted = next.slice(0, next.length - MAX_BLOCKS_PER_CARD);
          const kept = next.slice(next.length - MAX_BLOCKS_PER_CARD);
          const evictedIds = new Set(evicted.map((candidate) => candidate.id));

          const collapsedBlockIds = state.collapsedBlockIds.filter(
            (id) => !evictedIds.has(id),
          );
          const bookmarks = state.bookmarks.filter(
            (bookmark) => !evictedIds.has(bookmark.blockId),
          );
          const selectedForCard = state.selectedBlockId[input.cardId];
          const selectedBlockId =
            selectedForCard && evictedIds.has(selectedForCard)
              ? { ...state.selectedBlockId, [input.cardId]: null }
              : state.selectedBlockId;

          return {
            blocks: {
              ...blocksByCard,
              [input.cardId]: kept,
            },
            collapsedBlockIds,
            bookmarks,
            selectedBlockId,
          };
        }),

      recordBlockFinished: (input) =>
        set((state) => {
          const blocksByCard = state.blocks ?? {};
          const existing = blocksByCard[input.cardId];
          if (!existing) return state;

          let changed = false;
          const blocks = existing.map((block) => {
            if (block.id !== input.blockId) return block;
            changed = true;
            const exitCode = input.exitCode ?? undefined;
            // Task 3 — preserve any previously-captured output when the
            // caller doesn't pass one; cap to MAX_BLOCK_OUTPUT_LENGTH so a
            // runaway subprocess can't bloat localStorage.
            const rawOutput = input.output ?? block.output;
            const output =
              rawOutput !== undefined
                ? rawOutput.slice(0, MAX_BLOCK_OUTPUT_LENGTH)
                : undefined;
            return {
              ...block,
              finishedAt: input.finishedAt,
              exitCode,
              durationMs: input.durationMs ?? undefined,
              bufferEnd: input.bufferEnd,
              output,
              state:
                exitCode === undefined
                  ? 'aborted'
                  : exitCode === 0
                    ? 'success'
                    : 'failed',
            } satisfies Block;
          });

          if (!changed) return state;
          return {
            blocks: {
              ...blocksByCard,
              [input.cardId]: blocks,
            },
          };
        }),

      ensureBlocksState: () =>
        set((state) => (state.blocks === undefined ? { blocks: {} } : state)),

      toggleBlockCollapsed: (blockId) =>
        set((state) => {
          const ids = state.collapsedBlockIds;
          return {
            collapsedBlockIds: ids.includes(blockId)
              ? ids.filter((id) => id !== blockId)
              : [...ids, blockId],
          };
        }),

      selectBlock: (cardId, blockId) =>
        set((state) => ({
          selectedBlockId: { ...state.selectedBlockId, [cardId]: blockId },
        })),

      // ─── bookmarks (Stage 5) ──────────────────────────────────────────────
      addBookmark: (input) => {
        const existing = get().bookmarks.find((b) => b.blockId === input.blockId);
        if (existing) return null;
        const bookmark: Bookmark = {
          id: uid(),
          blockId: input.blockId,
          cardId: input.cardId,
          command: input.command,
          cwd: input.cwd,
          createdAt: Date.now(),
          label: input.label,
        };
        set((state) => ({ bookmarks: [...state.bookmarks, bookmark] }));
        return bookmark;
      },

      removeBookmark: (id) =>
        set((state) => ({ bookmarks: state.bookmarks.filter((b) => b.id !== id) })),

      isBookmarked: (blockId) => get().bookmarks.some((b) => b.blockId === blockId),

      // ─── focus / switching ────────────────────────────────────────────────
      focusCard: (id) =>
        set((state) => {
          if (state.focusedCardId === id) {
            if (!id) return state;
            const recentlyViewedCardIds = recentCardIdsAfterFocus(
              state.recentlyViewedCardIds,
              id,
              state.cards,
            );
            const recentChanged = recentlyViewedCardIds !== state.recentlyViewedCardIds;
            let changed = false;
            const cards = state.cards.map((card) => {
              if (card.id !== id || !card.unread) return card;
              changed = true;
              return { ...card, unread: false };
            });
            const notifications = state.notifications.map((notification) => {
              if (notification.cardId !== id || notification.read) return notification;
              changed = true;
              return { ...notification, read: true };
            });
            return changed || recentChanged
              ? { cards, notifications, recentlyViewedCardIds }
              : state;
          }
          // when leaving a card, remember it as last-active for double-ctrl switching
          const lastActiveCardId =
            state.focusedCardId && state.focusedCardId !== id
              ? state.focusedCardId
              : state.lastActiveCardId;
          // mark the newly focused card as read
          let cards = state.cards;
          let notifications = state.notifications;
          if (id) {
            const idx = state.cards.findIndex((c) => c.id === id);
            if (idx !== -1 && state.cards[idx].unread) {
              cards = [...state.cards];
              cards[idx] = { ...cards[idx], unread: false };
            }
            if (state.notifications.some((n) => n.cardId === id && !n.read)) {
              notifications = state.notifications.map((n) =>
                n.cardId === id && !n.read ? { ...n, read: true } : n,
              );
            }
          }
          return {
            focusedCardId: id,
            lastActiveCardId,
            cards,
            notifications,
            recentlyViewedCardIds: recentCardIdsAfterFocus(
              state.recentlyViewedCardIds,
              id,
              state.cards,
            ),
          };
        }),

      toggleDockPin: () => set((state) => ({ dockPinned: !state.dockPinned })),

      switchToLast: () => {
        const { lastActiveCardId, focusedCardId, cards } = get();
        if (!lastActiveCardId || lastActiveCardId === focusedCardId) return;
        if (!cards.some((c) => c.id === lastActiveCardId)) return;
        get().focusCard(lastActiveCardId);
      },

      nextCard: () => {
        const state = get();
        const { focusedCardId } = state;
        const cards = cardsForProjectView(
          state.cards,
          state.projectCardOrder,
          state.selectedProjectPath,
          state.selectedWorktreePath,
        );
        if (cards.length === 0) return;
        const i = focusedCardId ? cards.findIndex((c) => c.id === focusedCardId) : -1;
        const next = cards[(i + 1 + cards.length) % cards.length];
        get().focusCard(next.id);
      },

      prevCard: () => {
        const state = get();
        const { focusedCardId } = state;
        const cards = cardsForProjectView(
          state.cards,
          state.projectCardOrder,
          state.selectedProjectPath,
          state.selectedWorktreePath,
        );
        if (cards.length === 0) return;
        const i = focusedCardId ? cards.findIndex((c) => c.id === focusedCardId) : 0;
        const prev = cards[(i - 1 + cards.length) % cards.length];
        get().focusCard(prev.id);
      },

      jumpToIndex: (i) => {
        const state = get();
        const cards = cardsForProjectView(
          state.cards,
          state.projectCardOrder,
          state.selectedProjectPath,
          state.selectedWorktreePath,
        );
        if (i < 0 || i >= cards.length) return;
        get().focusCard(cards[i].id);
      },

      // ─── project sidebar ─────────────────────────────────────────────────
      selectProject: (path) =>
        set((state) => {
          if (
            state.selectedProjectPath === path &&
            state.selectedWorktreePath === null &&
            state.selectedWorktreeLabel === null
          ) {
            return state;
          }
          // When switching projects, exit focus mode so the user sees the
          // filtered grid of the newly-selected project.
          return {
            selectedProjectPath: path,
            selectedWorktreePath: null,
            selectedWorktreeLabel: null,
            focusedCardId: null,
          };
        }),

      selectWorktree: (projectPath, worktreePath, label) =>
        set((state) => {
          const selectedWorktreeLabel = label?.trim() || pathBasename(worktreePath);
          if (
            state.selectedProjectPath === projectPath &&
            state.selectedWorktreePath === worktreePath &&
            state.selectedWorktreeLabel === selectedWorktreeLabel
          ) {
            return state;
          }
          return {
            selectedProjectPath: projectPath,
            selectedWorktreePath: worktreePath,
            selectedWorktreeLabel,
            focusedCardId: null,
          };
        }),

      getCardsForProjectView: (path, worktreePath) => {
        const state = get();
        return cardsForProjectView(state.cards, state.projectCardOrder, path, worktreePath);
      },

      getArchivedCardsForProject: (path, worktreePath) =>
        archivedCardsForProject(get().archivedCards, path, worktreePath),

      // ─── pinned cards (global overlay) ───────────────────────────────────
      pinCard: (id) => {
        const state = get();
        if (state.pinnedCardIds.includes(id)) return true;
        if (state.pinnedCardIds.length >= MAX_PINNED_CARDS) return false;
        set({ pinnedCardIds: [...state.pinnedCardIds, id] });
        return true;
      },

      unpinCard: (id) =>
        set((state) => ({
          pinnedCardIds: state.pinnedCardIds.filter((p) => p !== id),
        })),

      movePinned: (id, toIndex) =>
        set((state) => {
          const from = state.pinnedCardIds.indexOf(id);
          if (from === -1) return state;
          const next = state.pinnedCardIds.slice();
          next.splice(from, 1);
          const target = Math.max(0, Math.min(next.length, toIndex));
          next.splice(target, 0, id);
          return { pinnedCardIds: next };
        }),

      isPinned: (id) => get().pinnedCardIds.includes(id),

      getPinnedCards: () => {
        const { cards, pinnedCardIds } = get();
        return pinnedCardIds
          .map((id) => cards.find((c) => c.id === id))
          .filter((c): c is TerminalCard => !!c);
      },

      // ─── notifications ────────────────────────────────────────────────────
      pushNotification: (input) => {
        const entry: NotificationEntry = {
          id: uid(),
          at: input.at ?? Date.now(),
          read: false,
          cardId: input.cardId,
          kind: input.kind,
          title: input.title,
          body: input.body,
        };
        set((state) => {
          const notifications = [entry, ...state.notifications];
          if (notifications.length > MAX_NOTIFICATIONS) {
            notifications.length = MAX_NOTIFICATIONS;
          }
          // mark originating card as unread
          const idx = state.cards.findIndex((c) => c.id === entry.cardId);
          let cards = state.cards;
          if (idx !== -1 && !state.cards[idx].unread) {
            cards = [...state.cards];
            cards[idx] = { ...cards[idx], unread: true };
          }
          return { notifications, cards };
        });
        return entry;
      },

      markNotificationRead: (id) =>
        set((state) => {
          const target = state.notifications.find((n) => n.id === id);
          if (!target) return state;

          const notifications = state.notifications.map((n) =>
            n.id === id ? { ...n, read: true } : n,
          );
          const cardStillHasUnread = notifications.some(
            (n) => n.cardId === target.cardId && !n.read,
          );
          if (cardStillHasUnread) return { notifications };

          const cards = state.cards.map((card) =>
            card.id === target.cardId && card.unread ? { ...card, unread: false } : card,
          );
          return { notifications, cards };
        }),

      markAllNotificationsRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => (n.read ? n : { ...n, read: true })),
          cards: state.cards.map((card) => (card.unread ? { ...card, unread: false } : card)),
        })),

      clearNotifications: () =>
        set((state) => ({
          notifications: [],
          cards: state.cards.map((card) => (card.unread ? { ...card, unread: false } : card)),
        })),

      removeNotification: (id) =>
        set((state) => {
          const target = state.notifications.find((n) => n.id === id);
          const notifications = state.notifications.filter((n) => n.id !== id);
          if (!target) return { notifications };
          const cardStillHasUnread = notifications.some(
            (n) => n.cardId === target.cardId && !n.read,
          );
          if (cardStillHasUnread) return { notifications };
          return {
            notifications,
            cards: state.cards.map((card) =>
              card.id === target.cardId && card.unread ? { ...card, unread: false } : card,
            ),
          };
        }),

      purgeReadNotifications: (olderThanMs = 2 * 60 * 60_000) => {
        const cutoff = Date.now() - olderThanMs;
        let removed = 0;
        set((state) => {
          const notifications = state.notifications.filter((n) => {
            if (n.read && n.at < cutoff) {
              removed += 1;
              return false;
            }
            return true;
          });
          if (removed === 0) return state;
          return { notifications };
        });
        return removed;
      },

      toggleNotificationCentre: (open) =>
        set((state) => ({
          notificationCentreOpen: open ?? !state.notificationCentreOpen,
        })),

      setPendingFocusCardId: (id) => set({ pendingFocusCardId: id }),

      // ─── selectors ────────────────────────────────────────────────────────
      getCardById: (id) => get().cards.find((c) => c.id === id),
      getUnreadCount: () => get().notifications.filter((n) => !n.read).length,
    }),
    {
      name: 'threadterm-terminal-store',
      // FIX-3: debounce the per-chunk persist writes (see ./throttledStorage).
      storage: createJSONStorage(() => createThrottledLocalStorage(500)),
      partialize: (state) => ({
        cards: state.cards.map((card) => ({
          ...card,
          status: isTransientStatus(card.status) ? 'idle' : card.status,
          autoRestart: prepareAutoRestartForPersistence(card),
        })),
        archivedCards: state.archivedCards.map((card) => ({
          ...card,
          status: isTransientStatus(card.status) ? 'idle' : card.status,
          unread: false,
          autoRestart: prepareAutoRestartForPersistence(card),
        })),
        blocks: state.blocks ?? {},
        bookmarks: state.bookmarks ?? [],
        focusedCardId: null,
        lastActiveCardId: state.lastActiveCardId,
        recentlyViewedCardIds: compactRecentCardIds(state.recentlyViewedCardIds, state.cards),
        dockPinned: state.dockPinned,
        selectedProjectPath: state.selectedProjectPath,
        selectedWorktreePath: state.selectedWorktreePath,
        selectedWorktreeLabel: state.selectedWorktreeLabel,
        projectCardOrder: compactProjectCardOrder(state.projectCardOrder, state.cards),
        pinnedCardIds: state.pinnedCardIds,
        notifications: state.notifications,
        notificationCentreOpen: state.notificationCentreOpen,
        petConfig: normalizePetConfig(state.petConfig),
        // Stage 6 — persist the global AI provider default + chip strip toggle.
        aiExplainDefaultProvider: state.aiExplainDefaultProvider,
        bottomBarHidden: state.bottomBarHidden,
        // AI Supervisor v0.1 (PRD D3) — master switch persisted; default OFF.
        supervisorEnabled: state.supervisorEnabled,
      }),
      version: 16,
      migrate: (persisted) => {
        const state = persisted as Partial<TerminalStore>;
        const cards = state.cards?.map((card) => ({
          ...card,
          status: isTransientStatus(card.status) ? 'idle' : card.status,
          providerSessionState:
            card.providerSessionState ??
            (isProviderSessionType(card.terminalType) ? 'unbound' : undefined),
          autoRestart: prepareAutoRestartForPersistence(card),
        }));
        const archivedCards = (state.archivedCards ?? []).map((card) => ({
          ...card,
          status: isTransientStatus(card.status) ? 'idle' : card.status,
          unread: false,
          providerSessionState:
            card.providerSessionState ??
            (isProviderSessionType(card.terminalType) ? 'unbound' : undefined),
          autoRestart: prepareAutoRestartForPersistence(card),
        }));
        return {
          ...state,
          focusedCardId: null,
          blocks: state.blocks ?? {},
          // v6 — default bookmarks to [] for stores persisted at v≤5.
          bookmarks: state.bookmarks ?? [],
          // v7 — Stage 6 settings defaults for older snapshots.
          aiExplainDefaultProvider: state.aiExplainDefaultProvider ?? 'claude',
          bottomBarHidden: state.bottomBarHidden ?? false,
          // v9 — AI Supervisor master switch defaults to OFF on upgrade.
          supervisorEnabled: state.supervisorEnabled ?? false,
          // v16 — focus-mode session dock metadata.
          recentlyViewedCardIds: compactRecentCardIds(
            state.recentlyViewedCardIds,
            cards ?? [],
          ),
          dockPinned: state.dockPinned ?? false,
          // v12 — project-scoped manual card order. Empty means existing
          // cards are projected in their current store order until the user
          // creates or drags a card in a project view.
          projectCardOrder: compactProjectCardOrder(state.projectCardOrder, cards ?? []),
          // v15 — branch/worktree card filtering state.
          selectedWorktreePath: state.selectedWorktreePath ?? null,
          selectedWorktreeLabel: state.selectedWorktreeLabel ?? null,
          // v13 — archived cards live outside the active card list so existing
          // views and bridge snapshots keep showing only active cards.
          archivedCards,
          // v10 — desktop pet is opt-in for upgraded users.
          // v11 — notification model changed to two toggles; reset
          //       notificationMode to 'both' once on upgrade. The desktop
          //       pet is a brand-new opt-in feature, so a persisted
          //       'system' is the old default, never a deliberate user
          //       choice — preserving it would silently suppress the pet
          //       bubble forever. Other fields (skin/size/position) are
          //       kept by spreading the existing petConfig first.
          petConfig: normalizePetConfig({
            ...(state.petConfig ?? {}),
            notificationMode: 'both',
          }),
          cards,
        };
      },
    },
  ),
);

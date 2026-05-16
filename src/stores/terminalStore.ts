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
 * until the PTY reconnects and overwrites them.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
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
  TerminalStatus,
} from '../types/terminal';
import type { AiExplainProvider } from '../lib/ai/aiExplain';
import {
  MAX_BLOCK_OUTPUT_LENGTH,
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
export { DEFAULT_PET_CONFIG } from '../lib/petConfig';

interface TerminalStore {
  // Cards
  cards: TerminalCard[];
  blocks: Record<string, Block[]>;
  focusedCardId: string | null;
  lastActiveCardId: string | null;

  /** Selected project path for the left sidebar filter. `null` = "All". */
  selectedProjectPath: string | null;

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
  removeCard: (id: string) => void;
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
  updateCardAiIntent: (id: string, intent: TerminalAiIntent | null) => void;
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
  switchToLast: () => void;
  nextCard: () => void;
  prevCard: () => void;
  jumpToIndex: (i: number) => void;

  // ─── project sidebar ────────────────────────────────────────────────────
  selectProject: (path: string | null) => void;

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

export const useTerminalStore = create<TerminalStore>()(
  persist(
    (set, get) => ({
      cards: [],
      blocks: {},
      collapsedBlockIds: [],
      selectedBlockId: {},
      bookmarks: [],
      focusedCardId: null,
      lastActiveCardId: null,
      selectedProjectPath: null,

      pinnedCardIds: [],

      notifications: [],
      notificationCentreOpen: false,
      pendingFocusCardId: null,
      petConfig: DEFAULT_PET_CONFIG,

      aiExplainDefaultProvider: 'claude',
      bottomBarHidden: false,
      setAiExplainDefaultProvider: (provider) => set({ aiExplainDefaultProvider: provider }),
      setBottomBarHidden: (hidden) => set({ bottomBarHidden: hidden }),

      supervisorEnabled: false,
      setSupervisorEnabled: (enabled) => set({ supervisorEnabled: enabled }),

      updatePetConfig: (patch) =>
        set((state) => ({
          petConfig: normalizePetConfig({ ...state.petConfig, ...patch }),
        })),

      createCard: (options) => {
        const id = uid();
        const now = Date.now();
        const card: TerminalCard = {
          id,
          ptyId: id, // 1:1 by default; Rust side uses the same id
          projectPath: options.projectPath,
          projectName: options.projectName,
          worktreePath: options.worktreePath,
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
        set((state) => ({ cards: [...state.cards, card] }));
        return id;
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
          if (
            target &&
            selectedProjectPath === target.projectPath &&
            !cards.some((c) => c.projectPath === target.projectPath)
          ) {
            selectedProjectPath = null;
          }
          // Also drop from the pinned list so it doesn't linger as a dead entry.
          const pinnedCardIds = state.pinnedCardIds.filter((p) => p !== id);
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
            pinnedCardIds,
            blocks,
            collapsedBlockIds,
            selectedBlockId,
            bookmarks,
          };
        });
      },

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

          return {
            blocks: {
              ...blocksByCard,
              [input.cardId]: [
                ...existing.filter((candidate) => candidate.id !== input.blockId),
                block,
              ],
            },
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
          return { focusedCardId: id, lastActiveCardId, cards, notifications };
        }),

      switchToLast: () => {
        const { lastActiveCardId, focusedCardId, cards } = get();
        if (!lastActiveCardId || lastActiveCardId === focusedCardId) return;
        if (!cards.some((c) => c.id === lastActiveCardId)) return;
        get().focusCard(lastActiveCardId);
      },

      nextCard: () => {
        const { cards, focusedCardId } = get();
        if (cards.length === 0) return;
        const i = focusedCardId ? cards.findIndex((c) => c.id === focusedCardId) : -1;
        const next = cards[(i + 1 + cards.length) % cards.length];
        get().focusCard(next.id);
      },

      prevCard: () => {
        const { cards, focusedCardId } = get();
        if (cards.length === 0) return;
        const i = focusedCardId ? cards.findIndex((c) => c.id === focusedCardId) : 0;
        const prev = cards[(i - 1 + cards.length) % cards.length];
        get().focusCard(prev.id);
      },

      jumpToIndex: (i) => {
        const { cards } = get();
        if (i < 0 || i >= cards.length) return;
        get().focusCard(cards[i].id);
      },

      // ─── project sidebar ─────────────────────────────────────────────────
      selectProject: (path) =>
        set((state) => {
          if (state.selectedProjectPath === path) return state;
          // When switching projects, exit focus mode so the user sees the
          // filtered grid of the newly-selected project.
          return {
            selectedProjectPath: path,
            focusedCardId: null,
          };
        }),

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
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        cards: state.cards.map((card) => ({
          ...card,
          status: isTransientStatus(card.status) ? 'idle' : card.status,
          autoRestart: prepareAutoRestartForPersistence(card),
        })),
        blocks: state.blocks ?? {},
        bookmarks: state.bookmarks ?? [],
        focusedCardId: null,
        lastActiveCardId: state.lastActiveCardId,
        selectedProjectPath: state.selectedProjectPath,
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
      version: 11,
      migrate: (persisted) => {
        const state = persisted as Partial<TerminalStore>;
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
          cards: state.cards?.map((card) => ({
            ...card,
            status: isTransientStatus(card.status) ? 'idle' : card.status,
            providerSessionState:
              card.providerSessionState ??
              (isProviderSessionType(card.terminalType) ? 'unbound' : undefined),
            autoRestart: prepareAutoRestartForPersistence(card),
          })),
        };
      },
    },
  ),
);

/**
 * Terminal Manager Lite — core types.
 *
 * These types describe the domain objects that flow between
 *   • the Rust PTY layer   (source of truth for live session state)
 *   • the Zustand store    (projection used by UI)
 *   • the React UI         (cards, switcher, notification centre)
 *
 * Persistence: only `cards` metadata and `notifications` are persisted;
 * transient output buffers are rebuilt from the PTY on reconnection.
 */

// ── Session status ───────────────────────────────────────────────────────────

/** Frontend-facing status; mirrors (simplified) SessionState from pty.rs. */
export type TerminalStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'failed';

/** Native CLI session binding state for providers that support resume. */
export type ProviderSessionState = 'unbound' | 'bound';

/** Lightweight intent labels for AI CLI cards. */
export type TerminalAiIntent = 'review' | 'fix' | 'research' | 'test' | 'docs';

/** Terminal type identifier; drives icon / colour / default launch command. */
export type TerminalType =
  | 'shell'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'npm'
  | 'yarn'
  | 'pnpm'
  | 'docker'
  | 'python'
  | 'node'
  | 'custom';

// ── Events (small timeline on each card) ─────────────────────────────────────

export type TerminalEventKind =
  | 'created'
  | 'output'
  | 'status'
  | 'notification'
  | 'user-input'
  | 'closed';

export interface TerminalEvent {
  /** Epoch ms when the event occurred. */
  at: number;
  kind: TerminalEventKind;
  /** 1-line human-readable summary (≤120 chars preferred). */
  summary: string;
}

// Command block model (Stage 3): metadata emitted by shell integration OSC.
export type BlockState = 'running' | 'success' | 'failed' | 'aborted';

export interface Block {
  id: string;
  cardId: string;
  cwd: string;
  command: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  durationMs?: number;
  bufferStart: number;
  bufferEnd?: number;
  state: BlockState;
  /** ANSI-stripped output captured at block-finish time. Used by
   *  BlockInspector and cross-session search. Capped at MAX_BLOCK_OUTPUT_LENGTH. */
  output?: string;
}

/** Cap on per-block output snapshot. 4KB is enough for ~50 lines of
 *  command output; anything bigger gets truncated head-style. */
export const MAX_BLOCK_OUTPUT_LENGTH = 4000;

// Stage 5 — block-level bookmarks (persisted)
export interface Bookmark {
  id: string;
  blockId: string;
  cardId: string;
  /** Snapshot of the block's command at bookmark time so the entry survives
   *  block eviction from xterm scrollback. */
  command: string;
  /** Snapshot of the block's working directory. */
  cwd: string;
  createdAt: number;
  /** Optional user-supplied label. */
  label?: string;
}

// ── Card auto restart (Stage 8.2) ────────────────────────────────────────────

export type TerminalAutoRestartAttemptStatus = 'pending' | 'started' | 'cancelled';

export interface TerminalAutoRestartAttempt {
  /** 1-based retry attempt number within the current failure streak. */
  attempt: number;
  /** Exit code that triggered this retry, when the backend provided one. */
  exitCode?: number;
  /** Epoch ms when the failed exit was observed. */
  failedAt: number;
  /** Epoch ms when this retry was scheduled. */
  scheduledAt: number;
  /** Deterministic backoff delay. */
  delayMs: number;
  /** Epoch ms when the retry should launch. */
  runAt: number;
  status: TerminalAutoRestartAttemptStatus;
  /** Epoch ms when ThreadTerm launched the retry. */
  startedAt?: number;
  /** Epoch ms when the user cancelled a pending retry. */
  cancelledAt?: number;
}

export interface TerminalAutoRestartConfig {
  enabled: boolean;
  /** Max retry attempts for one failure streak. */
  maxRetries: number;
  /** Attempts already scheduled or started for the current failure streak. */
  retryCount: number;
  history: TerminalAutoRestartAttempt[];
  /** Epoch ms when the latest failure exceeded `maxRetries`. */
  limitReachedAt?: number;
  lastExitCode?: number;
}

// ── Card ─────────────────────────────────────────────────────────────────────

export interface TerminalCard {
  /** Stable UUID generated at creation time. */
  id: string;
  /** PTY session id that the Rust backend knows about; kept in sync with `id`. */
  ptyId: string;
  projectPath: string;
  projectName: string;
  worktreePath?: string;
  terminalType: TerminalType;
  /** Optional initial command executed after PTY spawn. */
  command?: string;
  /** Native provider session id, e.g. Claude/Codex UUID. */
  providerSessionId?: string;
  /** Whether `providerSessionId` is known to exist in the provider's own history. */
  providerSessionState?: ProviderSessionState;
  /** Last time ThreadTerm bound this card to a provider-native session id. */
  providerSessionBoundAt?: number;
  /** Last time ThreadTerm launched this card with a provider-native session id. */
  providerSessionLastResumeAt?: number;
  /** User-selected intent label for quickly scanning AI CLI cards. */
  aiIntent?: TerminalAiIntent;
  status: TerminalStatus;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Last time any activity happened (output / status / input) — epoch ms. */
  lastActivity: number;
  /** Last ~2 KB of raw output (ANSI stripped). Transient, not persisted verbatim. */
  lastOutput: string;
  /** AI-reply preview (trailing 3-5 lines of assistant content), optional. */
  lastReplyPreview: string;
  /** Number of user inputs sent to this terminal. */
  messageCount: number;
  /** Recent timeline events (cap 20). */
  events: TerminalEvent[];
  /** True if there's activity the user hasn't seen since last focus. */
  unread: boolean;
  /** Stage 8.2: opt-in recovery config. Missing means default off. */
  autoRestart?: TerminalAutoRestartConfig;
}

// ── Notifications ────────────────────────────────────────────────────────────

export type NotificationKind = 'waiting' | 'completed' | 'failed' | 'attention';

export interface NotificationEntry {
  id: string;
  cardId: string;
  /** Epoch ms */
  at: number;
  kind: NotificationKind;
  title: string;
  body: string;
  read: boolean;
}

// ── Creation ─────────────────────────────────────────────────────────────────

export interface TerminalCreateOptions {
  projectPath: string;
  projectName: string;
  terminalType: TerminalType;
  /** Optional initial command. If omitted, terminalType's default command is used. */
  command?: string;
  worktreePath?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Max events retained per card timeline. */
export const MAX_TIMELINE_EVENTS = 20;

/** Max characters kept in `lastOutput`. */
export const MAX_LAST_OUTPUT_LENGTH = 2000;

/** Max notifications retained in the centre. */
export const MAX_NOTIFICATIONS = 100;

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

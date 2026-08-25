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

/** How a terminal process is expected to reach a task boundary. */
export type TerminalExecutionMode = 'interactive' | 'oneShot';

export type OneShotRunState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';

/** Persisted lifecycle marker for an explicit execute-and-exit run. */
export interface OneShotRun {
  generation: number;
  state: OneShotRunState;
  requestedAt: number;
  finishedAt?: number;
  exitCode?: number;
}

/** Native CLI session binding state for providers that support resume. */
export type ProviderSessionState = 'unbound' | 'bound';

/** Lightweight intent labels for AI CLI cards. */
export type TerminalAiIntent = 'review' | 'fix' | 'research' | 'test' | 'docs';

/** Terminal type identifier; drives icon / colour / default launch command. */
export type TerminalType =
  | 'shell'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'gemini'
  | 'kimi'
  | 'grok'
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
  /** Restricted localization key for backend-owned startup projections. */
  summaryKey?: 'terminal:view.sentInput';
  /** Opaque backend startup-effect identity for timeline reconciliation. */
  startupEffectToken?: string;
}

export type TerminalStartupEffectRecord =
  | {
      token: string;
      kind: 'recordUserSubmit';
      at: number;
      timeline: 'present' | 'retired';
    }
  | {
      token: string;
      kind: 'bindProviderSession' | 'discoverProviderSession';
      at: number;
      binding: 'active' | 'retired';
    };

export interface TerminalStartupSideEffects {
  schema: 1;
  projectionEpoch: string;
  parentProjectionEpoch?: string;
  applied: TerminalStartupEffectRecord[];
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

export interface CodexAppThreadBinding {
  threadId: string;
  sessionId?: string | null;
  threadPath?: string | null;
  boundAt?: number;
}

// ── Card ─────────────────────────────────────────────────────────────────────

export interface TerminalCard {
  /** Stable UUID generated at creation time. */
  id: string;
  /** PTY session id that the Rust backend knows about; kept in sync with `id`. */
  ptyId: string;
  projectPath: string;
  projectName: string;
  /** Stable directory-level label. Historical session cards may use projectName as their card title. */
  projectLabel?: string;
  worktreePath?: string;
  /** Human-readable branch/worktree label when the card belongs to a branch view. */
  branchLabel?: string;
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
  /** Codex app-server thread id used by Chat Mode. Kept separate from CLI resume ids. */
  codexAppThreadId?: string;
  /** Codex app-server session id for display/debugging; may differ from the thread id. */
  codexAppSessionId?: string;
  /** Codex app-server rollout/history path when the server reports one. */
  codexAppThreadPath?: string;
  /** Last time ThreadTerm bound this card to an app-server thread. */
  codexAppBoundAt?: number;
  /** User-selected intent label for quickly scanning AI CLI cards. */
  aiIntent?: TerminalAiIntent;
  /** Optional persisted projection for backend-owned Provider startup effects. */
  startupSideEffects?: TerminalStartupSideEffects;
  /** Missing values are legacy interactive cards. */
  executionMode?: TerminalExecutionMode;
  /** Optional one-shot generation; never auto-relaunched after reload. */
  oneShotRun?: OneShotRun;
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

export type NotificationOrigin =
  | 'pty'
  | 'reply'
  | 'codex_request'
  | 'supervisor'
  | 'auto_restart';

export type NotificationFamily = 'interaction' | 'completion' | 'failure' | 'system';

/**
 * Optional semantic metadata used by the OS-notification boundary.
 *
 * This stays optional because notification entries are persisted and older
 * snapshots must remain readable. In-app notification consumers can ignore it.
 */
export interface NotificationRouting {
  origin: NotificationOrigin;
  family: NotificationFamily;
  /** Stable interaction/completion generation shared by related producers. */
  episodeKey?: string;
  /** Stable normalized signal identity inside one episode. */
  fingerprint?: string;
  /** Additive source metadata used by the completion coordinator. */
  signalSource?: CompletionSignalSource;
  confidence?: CompletionConfidence;
}

export type CompletionSignalSource =
  | 'codex_chat'
  | 'claude_chat'
  | 'one_shot_exit'
  | 'agent_cli_prompt'
  | 'agent_cli_idle';

export type CompletionConfidence = 'authoritative' | 'compatible';

export interface CompletionSignal {
  cardId: string;
  episodeKey: string;
  fingerprint: string;
  source: CompletionSignalSource;
  confidence: CompletionConfidence;
  outcome: 'completed' | 'failed';
  at: number;
  summary?: string;
  /** Optional non-completion family for legacy PTY failure evidence. */
  family?: NotificationFamily;
  /** Optional origin override; reply remains the default for completions. */
  origin?: NotificationOrigin;
}

export interface NotificationEntry {
  id: string;
  cardId: string;
  /** Epoch ms */
  at: number;
  kind: NotificationKind;
  title: string;
  body: string;
  read: boolean;
  routing?: NotificationRouting;
}

// ── Creation ─────────────────────────────────────────────────────────────────

export interface TerminalCreateOptions {
  projectPath: string;
  projectName: string;
  terminalType: TerminalType;
  /** Optional initial command. If omitted, terminalType's default command is used. */
  command?: string;
  worktreePath?: string;
  branchLabel?: string;
  executionMode?: TerminalExecutionMode;
}

export interface ProviderSessionImportInfo {
  id: string;
  provider: 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi' | 'grok';
  projectPath: string;
  updatedAt?: number | null;
  /** Optional display name derived from catalog title; never stores full transcripts. */
  projectNameHint?: string | null;
}

export type ProviderSessionImportOutcome =
  | 'imported'
  | 'alreadyActive'
  | 'archived'
  | 'invalid'
  | 'unsupported';

export interface ProviderSessionImportResult {
  id: string;
  provider: ProviderSessionImportInfo['provider'];
  outcome: ProviderSessionImportOutcome;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Max events retained per card timeline. */
export const MAX_TIMELINE_EVENTS = 20;

/** Max characters kept in `lastOutput`. */
export const MAX_LAST_OUTPUT_LENGTH = 2000;

/** Max notifications retained in the centre. */
export const MAX_NOTIFICATIONS = 100;

/** Read-history retention window. Unread entries are never evicted by age. */
export const NOTIFICATION_READ_RETENTION_MS = 2 * 60 * 60_000;

/**
 * Max archived cards retained (FIFO, newest first). Archived cards persist to
 * ThreadTerm managed state; without a cap the archive grows for the lifetime of the
 * install and every persist write slows down with it. Restoring is the common path, long-tail archaeology is not,
 * so the oldest snapshots are dropped once the list is full.
 */
export const MAX_ARCHIVED_CARDS = 100;

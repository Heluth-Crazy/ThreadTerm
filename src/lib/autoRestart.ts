import type {
  TerminalAutoRestartAttempt,
  TerminalAutoRestartConfig,
} from '../types/terminal';

export const AUTO_RESTART_DEFAULT_MAX_RETRIES = 3;
export const AUTO_RESTART_MIN_MAX_RETRIES = 1;
export const AUTO_RESTART_MAX_MAX_RETRIES = 10;
export const AUTO_RESTART_BASE_BACKOFF_MS = 1000;
export const AUTO_RESTART_MAX_BACKOFF_MS = 30_000;
export const AUTO_RESTART_HISTORY_LIMIT = 8;

export type AutoRestartDecision =
  | { kind: 'ignored'; config: TerminalAutoRestartConfig }
  | {
      kind: 'schedule';
      config: TerminalAutoRestartConfig;
      attempt: TerminalAutoRestartAttempt;
    }
  | {
      kind: 'limit-reached';
      config: TerminalAutoRestartConfig;
      maxRetries: number;
    };

export function clampAutoRestartMaxRetries(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return AUTO_RESTART_DEFAULT_MAX_RETRIES;
  const integer = Math.trunc(numeric);
  return Math.min(
    AUTO_RESTART_MAX_MAX_RETRIES,
    Math.max(AUTO_RESTART_MIN_MAX_RETRIES, integer),
  );
}

export function calculateAutoRestartBackoffMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt) || 1);
  return Math.min(
    AUTO_RESTART_BASE_BACKOFF_MS * 2 ** (safeAttempt - 1),
    AUTO_RESTART_MAX_BACKOFF_MS,
  );
}

export function normalizeAutoRestartConfig(
  config?: Partial<TerminalAutoRestartConfig> | null,
): TerminalAutoRestartConfig {
  const maxRetries = clampAutoRestartMaxRetries(config?.maxRetries);
  const history = Array.isArray(config?.history)
    ? config.history
        .filter((entry): entry is TerminalAutoRestartAttempt => {
          return (
            typeof entry?.attempt === 'number' &&
            typeof entry.failedAt === 'number' &&
            typeof entry.scheduledAt === 'number' &&
            typeof entry.delayMs === 'number' &&
            typeof entry.runAt === 'number' &&
            (entry.status === 'pending' ||
              entry.status === 'started' ||
              entry.status === 'cancelled')
          );
        })
        .slice(-AUTO_RESTART_HISTORY_LIMIT)
    : [];

  return {
    enabled: config?.enabled === true,
    maxRetries,
    retryCount: Math.max(0, Math.trunc(config?.retryCount ?? 0) || 0),
    history,
    limitReachedAt:
      typeof config?.limitReachedAt === 'number' ? config.limitReachedAt : undefined,
    lastExitCode:
      typeof config?.lastExitCode === 'number' ? config.lastExitCode : undefined,
  };
}

export function getPendingAutoRestart(
  config?: Partial<TerminalAutoRestartConfig> | null,
): TerminalAutoRestartAttempt | null {
  const normalized = normalizeAutoRestartConfig(config);
  return (
    [...normalized.history].reverse().find((entry) => entry.status === 'pending') ??
    null
  );
}

export function createAutoRestartDecision(
  config: Partial<TerminalAutoRestartConfig> | undefined | null,
  input: { exitCode?: number | null; now: number },
): AutoRestartDecision {
  const normalized = normalizeAutoRestartConfig(config);
  const exitCode = input.exitCode;

  if (!normalized.enabled || typeof exitCode !== 'number' || exitCode === 0) {
    return {
      kind: 'ignored',
      config:
        typeof exitCode === 'number' && exitCode === 0
          ? {
              ...normalized,
              retryCount: 0,
              limitReachedAt: undefined,
              lastExitCode: undefined,
              history: normalized.history.filter((entry) => entry.status !== 'pending'),
            }
          : normalized,
    };
  }

  if (normalized.retryCount >= normalized.maxRetries) {
    const config = {
      ...normalized,
      lastExitCode: exitCode,
      history: normalized.history.filter((entry) => entry.status !== 'pending'),
    };
    if (normalized.limitReachedAt) {
      return { kind: 'ignored', config };
    }

    return {
      kind: 'limit-reached',
      maxRetries: normalized.maxRetries,
      config: {
        ...config,
        limitReachedAt: input.now,
      },
    };
  }

  const attemptNumber = normalized.retryCount + 1;
  const delayMs = calculateAutoRestartBackoffMs(attemptNumber);
  const attempt: TerminalAutoRestartAttempt = {
    attempt: attemptNumber,
    exitCode,
    failedAt: input.now,
    scheduledAt: input.now,
    delayMs,
    runAt: input.now + delayMs,
    status: 'pending',
  };

  return {
    kind: 'schedule',
    attempt,
    config: {
      ...normalized,
      retryCount: attemptNumber,
      limitReachedAt: undefined,
      lastExitCode: exitCode,
      history: [
        ...normalized.history.filter((entry) => entry.status !== 'pending'),
        attempt,
      ].slice(-AUTO_RESTART_HISTORY_LIMIT),
    },
  };
}

export function markAutoRestartStarted(
  config: Partial<TerminalAutoRestartConfig> | undefined | null,
  input: { attempt: number; now: number },
): TerminalAutoRestartConfig {
  const normalized = normalizeAutoRestartConfig(config);
  return {
    ...normalized,
    history: normalized.history.map((entry) =>
      entry.status === 'pending' && entry.attempt === input.attempt
        ? { ...entry, status: 'started', startedAt: input.now }
        : entry,
    ),
  };
}

export function cancelPendingAutoRestart(
  config: Partial<TerminalAutoRestartConfig> | undefined | null,
  now: number,
): TerminalAutoRestartConfig {
  const normalized = normalizeAutoRestartConfig(config);
  return {
    ...normalized,
    history: normalized.history.map((entry) =>
      entry.status === 'pending'
        ? { ...entry, status: 'cancelled', cancelledAt: now }
        : entry,
    ),
  };
}

import { describe, expect, it } from 'vitest';
import {
  AUTO_RESTART_MAX_BACKOFF_MS,
  calculateAutoRestartBackoffMs,
  cancelPendingAutoRestart,
  createAutoRestartDecision,
  normalizeAutoRestartConfig,
} from './autoRestart';

describe('autoRestart', () => {
  it('calculates deterministic exponential backoff capped at 30s', () => {
    expect(calculateAutoRestartBackoffMs(1)).toBe(1000);
    expect(calculateAutoRestartBackoffMs(2)).toBe(2000);
    expect(calculateAutoRestartBackoffMs(3)).toBe(4000);
    expect(calculateAutoRestartBackoffMs(10)).toBe(AUTO_RESTART_MAX_BACKOFF_MS);
  });

  it('schedules retries until the configured limit is reached', () => {
    const first = createAutoRestartDecision(
      { enabled: true, maxRetries: 2, retryCount: 0, history: [] },
      { exitCode: 1, now: 10_000 },
    );
    expect(first.kind).toBe('schedule');
    if (first.kind !== 'schedule') throw new Error('expected schedule');
    expect(first.attempt).toMatchObject({
      attempt: 1,
      delayMs: 1000,
      runAt: 11_000,
      status: 'pending',
    });

    const second = createAutoRestartDecision(first.config, {
      exitCode: 1,
      now: 12_000,
    });
    expect(second.kind).toBe('schedule');
    if (second.kind !== 'schedule') throw new Error('expected schedule');
    expect(second.attempt.attempt).toBe(2);

    const exhausted = createAutoRestartDecision(second.config, {
      exitCode: 1,
      now: 16_000,
    });
    expect(exhausted.kind).toBe('limit-reached');
    if (exhausted.kind !== 'limit-reached') throw new Error('expected limit');
    expect(exhausted.maxRetries).toBe(2);
    expect(exhausted.config.limitReachedAt).toBe(16_000);
  });

  it('does not emit repeated limit decisions after the limit is recorded', () => {
    const exhausted = createAutoRestartDecision(
      {
        enabled: true,
        maxRetries: 1,
        retryCount: 1,
        limitReachedAt: 30_000,
        history: [],
      },
      { exitCode: 1, now: 31_000 },
    );

    expect(exhausted.kind).toBe('ignored');
    expect(exhausted.config.limitReachedAt).toBe(30_000);
  });

  it('cancels a pending retry without carrying timeout state in config', () => {
    const decision = createAutoRestartDecision(
      { enabled: true, maxRetries: 3, retryCount: 0, history: [] },
      { exitCode: 2, now: 20_000 },
    );
    if (decision.kind !== 'schedule') throw new Error('expected schedule');

    const cancelled = cancelPendingAutoRestart(decision.config, 20_500);
    expect(cancelled.history).toHaveLength(1);
    expect(cancelled.history[0]).toMatchObject({
      attempt: 1,
      status: 'cancelled',
      cancelledAt: 20_500,
    });
    expect(JSON.stringify(cancelled)).not.toContain('Timeout');
  });

  it('normalizes default-off config and clamps max retries', () => {
    expect(normalizeAutoRestartConfig(undefined)).toMatchObject({
      enabled: false,
      maxRetries: 3,
      retryCount: 0,
      history: [],
    });
    expect(normalizeAutoRestartConfig({ enabled: true, maxRetries: 999 }).maxRetries).toBe(10);
    expect(normalizeAutoRestartConfig({ enabled: true, maxRetries: 0 }).maxRetries).toBe(1);
  });
});

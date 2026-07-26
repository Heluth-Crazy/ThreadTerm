import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SUPERVISOR_ALERTS_MAX,
  useSupervisorStore,
} from './supervisorStore';

function resetStore(): void {
  useSupervisorStore.setState({
    alerts: [],
    telemetry: { triggered: 0, clicked: 0, acted: 0 },
  });
}

beforeEach(() => {
  resetStore();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 4, 4, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ingestAlert', () => {
  it('queues an alert and increments triggered', () => {
    const ingest = useSupervisorStore.getState().ingestAlert;
    const result = ingest({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: '[sudo] password for user:',
      ts: Date.now(),
    });

    expect(result).not.toBeNull();
    expect(result!.cardId).toBe('c1');
    expect(result!.clicked).toBe(false);
    expect(result!.notificationId).toBeNull();
    expect(useSupervisorStore.getState().alerts).toHaveLength(1);
    expect(useSupervisorStore.getState().telemetry.triggered).toBe(1);
  });

  it('drops the exact same card/rule/generation/sample episode', () => {
    const ingest = useSupervisorStore.getState().ingestAlert;
    const baseTs = Date.now();
    expect(ingest({ cardId: 'c1', ruleId: 'yes-no-bracket', sampleText: 'a [y/N]', ts: baseTs })).not.toBeNull();
    const dup = ingest({
      cardId: 'c1',
      ruleId: 'yes-no-bracket',
      sampleText: 'a [y/N]',
      ts: baseTs + 120_000,
    });
    expect(dup).toBeNull();
    expect(useSupervisorStore.getState().alerts).toHaveLength(1);
    expect(useSupervisorStore.getState().telemetry.triggered).toBe(1);
  });

  it('rearms when the user-submit generation changes', () => {
    const ingest = useSupervisorStore.getState().ingestAlert;
    const baseTs = Date.now();
    ingest({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: baseTs,
      generation: 1,
    });
    const second = ingest({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: baseTs + 1_000,
      generation: 2,
    });
    expect(second).not.toBeNull();
    expect(useSupervisorStore.getState().alerts).toHaveLength(2);
    expect(useSupervisorStore.getState().telemetry.triggered).toBe(2);
  });

  it('rearms when the normalized prompt sample changes', () => {
    const ingest = useSupervisorStore.getState().ingestAlert;
    const baseTs = Date.now();
    ingest({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'Password for alice:',
      ts: baseTs,
      generation: 1,
    });
    const second = ingest({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'Password for bob:',
      ts: baseTs + 1_000,
      generation: 1,
    });
    expect(second).not.toBeNull();
    expect(useSupervisorStore.getState().alerts).toHaveLength(2);
  });

  it('does not de-dup across different cards or rules', () => {
    const ingest = useSupervisorStore.getState().ingestAlert;
    const baseTs = Date.now();
    ingest({ cardId: 'c1', ruleId: 'sudo-password', sampleText: 'x', ts: baseTs });
    ingest({ cardId: 'c2', ruleId: 'sudo-password', sampleText: 'x', ts: baseTs });
    ingest({ cardId: 'c1', ruleId: 'yes-no-bracket', sampleText: 'x', ts: baseTs });
    expect(useSupervisorStore.getState().alerts).toHaveLength(3);
    expect(useSupervisorStore.getState().telemetry.triggered).toBe(3);
  });

  it('caps the alerts queue at SUPERVISOR_ALERTS_MAX (FIFO drop)', () => {
    const ingest = useSupervisorStore.getState().ingestAlert;
    for (let i = 0; i < SUPERVISOR_ALERTS_MAX + 5; i++) {
      ingest({
        cardId: `c${i}`,
        ruleId: 'press-any-key',
        sampleText: `n${i}`,
        ts: Date.now() + i,
      });
    }
    const { alerts } = useSupervisorStore.getState();
    expect(alerts).toHaveLength(SUPERVISOR_ALERTS_MAX);
    // Oldest five must have been dropped from the front; newest entry remains.
    expect(alerts[0].cardId).toBe('c5');
    expect(alerts[alerts.length - 1].cardId).toBe(`c${SUPERVISOR_ALERTS_MAX + 4}`);
  });
});

describe('attachNotification', () => {
  it('links a notification id to an existing alert', () => {
    const alert = useSupervisorStore.getState().ingestAlert({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: Date.now(),
    })!;
    useSupervisorStore.getState().attachNotification(alert.id, 'notif-1');
    expect(useSupervisorStore.getState().alerts[0].notificationId).toBe('notif-1');
  });

  it('is a no-op for an unknown alert id', () => {
    useSupervisorStore.getState().attachNotification('nope', 'notif-1');
    expect(useSupervisorStore.getState().alerts).toHaveLength(0);
  });
});

describe('recordClick', () => {
  it('flips clicked + bumps clicked telemetry', () => {
    const alert = useSupervisorStore.getState().ingestAlert({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: Date.now(),
    })!;
    useSupervisorStore.getState().recordClick(alert.id);
    const after = useSupervisorStore.getState();
    expect(after.alerts[0].clicked).toBe(true);
    expect(after.alerts[0].clickedAt).toBe(Date.now());
    expect(after.telemetry.clicked).toBe(1);
  });

  it('is idempotent — second click does not double-count', () => {
    const alert = useSupervisorStore.getState().ingestAlert({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: Date.now(),
    })!;
    useSupervisorStore.getState().recordClick(alert.id);
    useSupervisorStore.getState().recordClick(alert.id);
    expect(useSupervisorStore.getState().telemetry.clicked).toBe(1);
  });

  it('is a no-op for an unknown alert id', () => {
    useSupervisorStore.getState().recordClick('nope');
    expect(useSupervisorStore.getState().telemetry.clicked).toBe(0);
  });
});

describe('recordClickByCardId', () => {
  it('credits the most recent unclicked alert for the card', () => {
    const store = useSupervisorStore.getState();
    const baseTs = Date.now();
    store.ingestAlert({ cardId: 'c1', ruleId: 'sudo-password', sampleText: 'x', ts: baseTs });
    store.ingestAlert({
      cardId: 'c1',
      ruleId: 'yes-no-bracket',
      sampleText: 'y',
      ts: baseTs + 1_000,
    });

    const credited = useSupervisorStore.getState().recordClickByCardId('c1');
    expect(credited).toBe(true);

    const after = useSupervisorStore.getState();
    expect(after.telemetry.clicked).toBe(1);
    // Newest alert is at the tail — that is the one credited.
    expect(after.alerts[after.alerts.length - 1].clicked).toBe(true);
    // Older alert remains unclicked.
    expect(after.alerts[0].clicked).toBe(false);
  });

  it('returns false when no alert exists for the card', () => {
    const credited = useSupervisorStore.getState().recordClickByCardId('ghost');
    expect(credited).toBe(false);
    expect(useSupervisorStore.getState().telemetry.clicked).toBe(0);
  });

  it('returns false when every alert for the card is already clicked', () => {
    const alert = useSupervisorStore.getState().ingestAlert({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: Date.now(),
    })!;
    useSupervisorStore.getState().recordClick(alert.id);

    const credited = useSupervisorStore.getState().recordClickByCardId('c1');
    expect(credited).toBe(false);
    // Still 1 — not double-counted.
    expect(useSupervisorStore.getState().telemetry.clicked).toBe(1);
  });
});

describe('recordAction', () => {
  it('counts a pty.write within 60s of a click', () => {
    const alert = useSupervisorStore.getState().ingestAlert({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: Date.now(),
    })!;
    useSupervisorStore.getState().recordClick(alert.id);
    vi.advanceTimersByTime(30_000);
    useSupervisorStore.getState().recordAction('c1');
    expect(useSupervisorStore.getState().telemetry.acted).toBe(1);
    expect(useSupervisorStore.getState().alerts[0]).toMatchObject({
      acted: true,
    });
    expect(useSupervisorStore.getState().alerts[0].actedAt).toBeTypeOf('number');
  });

  it('counts at most one pty.write per clicked alert', () => {
    const alert = useSupervisorStore.getState().ingestAlert({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: Date.now(),
    })!;
    useSupervisorStore.getState().recordClick(alert.id);
    useSupervisorStore.getState().recordAction('c1');
    useSupervisorStore.getState().recordAction('c1');
    expect(useSupervisorStore.getState().telemetry.acted).toBe(1);
  });

  it('does NOT count a pty.write when no alert was clicked', () => {
    useSupervisorStore.getState().ingestAlert({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: Date.now(),
    });
    useSupervisorStore.getState().recordAction('c1');
    expect(useSupervisorStore.getState().telemetry.acted).toBe(0);
  });

  it('does NOT count a pty.write more than 60s after the click', () => {
    const alert = useSupervisorStore.getState().ingestAlert({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: Date.now(),
    })!;
    useSupervisorStore.getState().recordClick(alert.id);
    vi.advanceTimersByTime(61_000);
    useSupervisorStore.getState().recordAction('c1');
    expect(useSupervisorStore.getState().telemetry.acted).toBe(0);
  });

  it('does NOT count a pty.write on a different card than the clicked alert', () => {
    const alert = useSupervisorStore.getState().ingestAlert({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: Date.now(),
    })!;
    useSupervisorStore.getState().recordClick(alert.id);
    useSupervisorStore.getState().recordAction('c2');
    expect(useSupervisorStore.getState().telemetry.acted).toBe(0);
  });
});

describe('resetTelemetry / clearAlerts', () => {
  it('resetTelemetry zeros all three counters but keeps alerts', () => {
    const alert = useSupervisorStore.getState().ingestAlert({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: Date.now(),
    })!;
    useSupervisorStore.getState().recordClick(alert.id);
    useSupervisorStore.getState().recordAction('c1');

    useSupervisorStore.getState().resetTelemetry();

    expect(useSupervisorStore.getState().telemetry).toEqual({
      triggered: 0,
      clicked: 0,
      acted: 0,
    });
    expect(useSupervisorStore.getState().alerts).toHaveLength(1);
  });

  it('clearAlerts drops alerts but keeps telemetry', () => {
    useSupervisorStore.getState().ingestAlert({
      cardId: 'c1',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: Date.now(),
    });
    useSupervisorStore.getState().clearAlerts();
    expect(useSupervisorStore.getState().alerts).toHaveLength(0);
    expect(useSupervisorStore.getState().telemetry.triggered).toBe(1);
  });
});

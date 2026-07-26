import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import type { SupervisorAlertPayload } from '../tauri-bridge';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Capture every call into invokeSupervisorEnable and let each test snapshot
// the latest event handler installed by `subscribeSupervisorAlert`.
const invokeSupervisorEnableMock = vi.fn<
  (enabled: boolean, watchedCardIds: string[]) => Promise<void>
>(async () => {});
let alertHandler: ((payload: SupervisorAlertPayload) => void) | null = null;
const unsubscribeMock = vi.fn();
const subscribeSupervisorAlertMock = vi.fn<
  (cb: (payload: SupervisorAlertPayload) => void) => Promise<() => void>
>(async (cb) => {
  alertHandler = cb;
  return unsubscribeMock;
});

vi.mock('../tauri-bridge', () => ({
  invokeSupervisorEnable: (enabled: boolean, watchedCardIds: string[]) =>
    invokeSupervisorEnableMock(enabled, watchedCardIds),
  subscribeSupervisorAlert: (cb: (payload: SupervisorAlertPayload) => void) =>
    subscribeSupervisorAlertMock(cb),
}));

// terminalStore mock — minimal slice the hook reads.
const pushNotificationMock = vi.fn((input: { cardId: string }) => ({
  id: `notif-${input.cardId}-${pushNotificationMock.mock.calls.length}`,
  cardId: input.cardId,
}));
let storeState: {
  supervisorEnabled: boolean;
  pinnedCardIds: string[];
  cards: Array<{ id: string; messageCount: number }>;
  pushNotification: typeof pushNotificationMock;
} = {
  supervisorEnabled: false,
  pinnedCardIds: [],
  cards: [{ id: 'a', messageCount: 3 }],
  pushNotification: pushNotificationMock,
};

vi.mock('../../stores/terminalStore', () => {
  const useTerminalStore = <T,>(selector: (s: typeof storeState) => T): T =>
    selector(storeState);
  useTerminalStore.getState = () => storeState;
  return { useTerminalStore };
});

// react-i18next: identity translator, returns the key untouched so we can
// assert what was passed without loading a locale bundle.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      (opts?.defaultValue as string | undefined) ?? key,
  }),
}));

// ── Imports under test (after mocks!) ────────────────────────────────────────
import { useSupervisor } from './useSupervisor';
import { useSupervisorStore } from './supervisorStore';

beforeEach(() => {
  invokeSupervisorEnableMock.mockClear();
  subscribeSupervisorAlertMock.mockClear();
  unsubscribeMock.mockClear();
  pushNotificationMock.mockClear();
  alertHandler = null;
  storeState = {
    supervisorEnabled: false,
    pinnedCardIds: [],
    cards: [{ id: 'a', messageCount: 3 }],
    pushNotification: pushNotificationMock,
  };
  useSupervisorStore.setState({
    alerts: [],
    telemetry: { triggered: 0, clicked: 0, acted: 0 },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSupervisor — backend sync', () => {
  it('invokes supervisor_enable with enabled=false on mount when supervisor is OFF', async () => {
    storeState = { ...storeState, supervisorEnabled: false, pinnedCardIds: ['a', 'b'] };
    renderHook(() => useSupervisor());
    await waitFor(() => {
      expect(invokeSupervisorEnableMock).toHaveBeenCalled();
    });
    // The first call (mount) should be (false, []), since enabled=false zeroes
    // the watched list — backend treats this as "tear down".
    const [enabled, watched] = invokeSupervisorEnableMock.mock.calls[0];
    expect(enabled).toBe(false);
    expect(watched).toEqual([]);
    // No call should have enabled=true.
    expect(
      invokeSupervisorEnableMock.mock.calls.some(([e]) => e === true),
    ).toBe(false);
  });

  it('passes the current pinnedCardIds when supervisor is ON', async () => {
    storeState = { ...storeState, supervisorEnabled: true, pinnedCardIds: ['a', 'b'] };
    renderHook(() => useSupervisor());
    await waitFor(() => {
      expect(invokeSupervisorEnableMock).toHaveBeenCalledWith(true, ['a', 'b']);
    });
  });

  it('re-invokes when pinnedCardIds change', async () => {
    storeState = { ...storeState, supervisorEnabled: true, pinnedCardIds: ['a', 'b'] };
    const { rerender } = renderHook(() => useSupervisor());
    await waitFor(() => {
      expect(invokeSupervisorEnableMock).toHaveBeenCalledWith(true, ['a', 'b']);
    });

    storeState = { ...storeState, pinnedCardIds: ['a', 'b', 'c'] };
    rerender();

    await waitFor(() => {
      expect(invokeSupervisorEnableMock).toHaveBeenCalledWith(true, ['a', 'b', 'c']);
    });
  });

  it('tears down on unmount with enabled=false, watched=[]', async () => {
    storeState = { ...storeState, supervisorEnabled: true, pinnedCardIds: ['a'] };
    const { unmount } = renderHook(() => useSupervisor());

    await waitFor(() => {
      expect(invokeSupervisorEnableMock).toHaveBeenCalledWith(true, ['a']);
    });
    invokeSupervisorEnableMock.mockClear();

    unmount();

    await waitFor(() => {
      expect(invokeSupervisorEnableMock).toHaveBeenCalledWith(false, []);
    });
  });
});

describe('useSupervisor — alert handling', () => {
  it('pushes a notification + ingests an alert when the backend fires', async () => {
    storeState = { ...storeState, supervisorEnabled: true, pinnedCardIds: ['a'] };
    renderHook(() => useSupervisor());

    await waitFor(() => {
      expect(subscribeSupervisorAlertMock).toHaveBeenCalled();
      expect(alertHandler).not.toBeNull();
    });

    alertHandler!({
      cardId: 'a',
      ruleId: 'sudo-password',
      sampleText: '[sudo] password for user:',
      ts: Date.now(),
    });

    expect(useSupervisorStore.getState().telemetry.triggered).toBe(1);
    expect(pushNotificationMock).toHaveBeenCalledTimes(1);
    const [arg] = pushNotificationMock.mock.calls[0];
    expect(arg).toMatchObject({
      cardId: 'a',
      kind: 'attention',
      title: 'alertTitle.sudo-password',
      routing: {
        origin: 'supervisor',
        family: 'interaction',
        episodeKey: 'interaction:a:3',
        fingerprint: 'sudo-password:[sudo] password for user:',
      },
    });
  });

  it('ignores alerts with an unknown ruleId', async () => {
    storeState = { ...storeState, supervisorEnabled: true, pinnedCardIds: ['a'] };
    renderHook(() => useSupervisor());

    await waitFor(() => {
      expect(alertHandler).not.toBeNull();
    });

    alertHandler!({
      cardId: 'a',
      ruleId: 'totally-bogus' as any,
      sampleText: 'x',
      ts: Date.now(),
    });

    expect(pushNotificationMock).not.toHaveBeenCalled();
    expect(useSupervisorStore.getState().telemetry.triggered).toBe(0);
  });

  it('drops a duplicate alert for the same semantic episode', async () => {
    storeState = { ...storeState, supervisorEnabled: true, pinnedCardIds: ['a'] };
    renderHook(() => useSupervisor());

    await waitFor(() => {
      expect(alertHandler).not.toBeNull();
    });

    const ts = Date.now();
    alertHandler!({ cardId: 'a', ruleId: 'sudo-password', sampleText: 'x', ts });
    alertHandler!({ cardId: 'a', ruleId: 'sudo-password', sampleText: 'x', ts: ts + 61_000 });

    expect(pushNotificationMock).toHaveBeenCalledTimes(1);
    expect(useSupervisorStore.getState().telemetry.triggered).toBe(1);
  });

  it('accepts the same supervisor prompt after a new user submit', async () => {
    storeState = { ...storeState, supervisorEnabled: true, pinnedCardIds: ['a'] };
    renderHook(() => useSupervisor());

    await waitFor(() => {
      expect(alertHandler).not.toBeNull();
    });

    const ts = Date.now();
    alertHandler!({ cardId: 'a', ruleId: 'sudo-password', sampleText: 'x', ts });
    storeState = {
      ...storeState,
      cards: [{ id: 'a', messageCount: 4 }],
    };
    alertHandler!({
      cardId: 'a',
      ruleId: 'sudo-password',
      sampleText: 'x',
      ts: ts + 1_000,
    });

    expect(pushNotificationMock).toHaveBeenCalledTimes(2);
    expect(useSupervisorStore.getState().telemetry.triggered).toBe(2);
  });

  it('unsubscribes from the alert event on unmount', async () => {
    storeState = { ...storeState, supervisorEnabled: true, pinnedCardIds: ['a'] };
    const { unmount } = renderHook(() => useSupervisor());

    await waitFor(() => {
      expect(subscribeSupervisorAlertMock).toHaveBeenCalled();
    });

    unmount();
    await waitFor(() => {
      expect(unsubscribeMock).toHaveBeenCalled();
    });
  });
});

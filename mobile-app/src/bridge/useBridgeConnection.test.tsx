import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_PROTOCOL_VERSION, type ServerMessage } from '@shared/mobile/bridge/protocol';
import {
  BRIDGE_HEARTBEAT_INTERVAL_MS,
  BRIDGE_HEARTBEAT_TIMEOUT_MS,
  useBridgeConnection,
} from './useBridgeConnection';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  emitOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitMessage(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function renderConnection(token = 'device-token') {
  const onMessage = vi.fn();
  const onLagged = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(
    ({ activeToken }: { activeToken: string | null }) =>
      useBridgeConnection({
        token: activeToken,
        onMessage,
        onLagged,
        onError,
      }),
    { initialProps: { activeToken: token as string | null } },
  );

  return { ...hook, onError, onLagged, onMessage };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-26T12:00:00Z'));
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useBridgeConnection', () => {
  it('checks a healthy connection on foreground events without replacing it', () => {
    const { result } = renderConnection();
    const socket = FakeWebSocket.instances[0];

    act(() => socket.emitOpen());
    expect(result.current.state).toBe('open');

    act(() => {
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('online'));
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(
      socket.sent.map((message) => JSON.parse(message) as { kind: string }).filter(
        (message) => message.kind === 'ping',
      ),
    ).toHaveLength(2);
  });

  it('reconnects when the desktop stays silent for the heartbeat timeout', () => {
    const { result } = renderConnection();
    const firstSocket = FakeWebSocket.instances[0];
    act(() => firstSocket.emitOpen());

    act(() => {
      vi.advanceTimersByTime(BRIDGE_HEARTBEAT_TIMEOUT_MS);
    });

    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(result.current.state).toBe('reconnecting');
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(350);
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.state).toBe('reconnecting');
  });

  it('keeps the connection healthy while pong responses continue', () => {
    const { result } = renderConnection();
    const socket = FakeWebSocket.instances[0];
    act(() => socket.emitOpen());

    for (
      let elapsed = BRIDGE_HEARTBEAT_INTERVAL_MS;
      elapsed <= BRIDGE_HEARTBEAT_TIMEOUT_MS * 2;
      elapsed += BRIDGE_HEARTBEAT_INTERVAL_MS
    ) {
      act(() => {
        vi.advanceTimersByTime(BRIDGE_HEARTBEAT_INTERVAL_MS);
        socket.emitMessage({
          protocol_version: BRIDGE_PROTOCOL_VERSION,
          kind: 'pong',
          t: Date.now(),
        });
      });
    }

    expect(result.current.state).toBe('open');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('stops reconnecting after the desktop revokes the device', () => {
    const { onMessage, result } = renderConnection();
    const socket = FakeWebSocket.instances[0];
    act(() => socket.emitOpen());

    const revoked: ServerMessage = {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'error',
      code: 'auth_revoked',
      message: 'Device authorization was revoked',
    };
    act(() => socket.emitMessage(revoked));

    expect(result.current.state).toBe('revoked');
    expect(onMessage).toHaveBeenCalledWith(revoked);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('allows a new pairing token to leave the revoked state', () => {
    const { rerender, result } = renderConnection();
    const firstSocket = FakeWebSocket.instances[0];
    act(() => firstSocket.emitOpen());
    act(() =>
      firstSocket.emitMessage({
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        kind: 'error',
        code: 'auth_expired',
        message: 'Device authorization expired',
      }),
    );
    expect(result.current.state).toBe('revoked');

    rerender({ activeToken: 'replacement-token' });

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.state).toBe('connecting');
  });

  it('backs off repeated failures and caps the wait at five seconds', () => {
    renderConnection();
    const expectedDelays = [350, 700, 1400, 2800, 5000, 5000];

    for (const delay of expectedDelays) {
      const socket = FakeWebSocket.instances.at(-1);
      if (!socket) throw new Error('expected a bridge socket');
      const countBeforeClose = FakeWebSocket.instances.length;

      act(() => socket.close());
      act(() => {
        vi.advanceTimersByTime(delay - 1);
      });
      expect(FakeWebSocket.instances).toHaveLength(countBeforeClose);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(FakeWebSocket.instances).toHaveLength(countBeforeClose + 1);
    }
  });

  it('coalesces duplicate close notifications into one reconnect', () => {
    renderConnection();
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.close();
      socket.onclose?.();
      socket.onclose?.();
      vi.advanceTimersByTime(350);
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('cancels a pending reconnect when the page unmounts', () => {
    const { unmount } = renderConnection();
    const socket = FakeWebSocket.instances[0];

    act(() => socket.close());
    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not revive an old connection after the pairing token changes', () => {
    const { rerender } = renderConnection('old-token');
    const oldSocket = FakeWebSocket.instances[0];

    act(() => oldSocket.close());
    rerender({ activeToken: 'replacement-token' });
    expect(FakeWebSocket.instances).toHaveLength(2);

    const replacementSocket = FakeWebSocket.instances[1];
    act(() => {
      oldSocket.onclose?.();
      vi.advanceTimersByTime(5_000);
      replacementSocket.emitOpen();
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(
      replacementSocket.sent.map((message) => JSON.parse(message)),
    ).toContainEqual({
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'auth',
      token: 'replacement-token',
    });
  });
});

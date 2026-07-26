import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_PROTOCOL_VERSION } from './protocol';
import { BridgeWsClient, buildBridgeWsUrl } from './wsClient';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
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
    this.readyState = 3;
    this.onclose?.();
  }

  emitOpen() {
    this.onopen?.();
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe('mobile bridge ws client', () => {
  it('uses secure websockets for phone access without putting tokens in the query string', () => {
    expect(buildBridgeWsUrl('https://threadterm.example.ts.net')).toBe(
      'wss://threadterm.example.ts.net/ws',
    );
    expect(buildBridgeWsUrl('http://127.0.0.1:5174')).toBe(
      'ws://127.0.0.1:5174/ws',
    );
  });

  it('rejects remote plaintext and incomplete bridge addresses', () => {
    expect(() => buildBridgeWsUrl('http://192.168.1.42:5174')).toThrow(
      /requires HTTPS/i,
    );
    expect(() => buildBridgeWsUrl('threadterm.local:5174')).toThrow(
      /absolute HTTP or HTTPS URL/i,
    );
  });

  it('subscribes on open and dispatches parsed messages', () => {
    FakeWebSocket.instances = [];
    const onMessage = vi.fn();
    const onStateChange = vi.fn();
    const client = new BridgeWsClient({
      baseUrl: 'http://127.0.0.1:5174',
      token: 'device-token',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    client.connect({ onMessage, onStateChange });

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe('ws://127.0.0.1:5174/ws');

    socket.emitOpen();
    expect(onStateChange).toHaveBeenCalledWith('open');
    expect(JSON.parse(socket.sent[0])).toEqual({
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'auth',
      token: 'device-token',
    });
    expect(JSON.parse(socket.sent[1])).toEqual({
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'subscribe',
    });

    socket.emitMessage({
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'pong',
      t: 123,
    });
    expect(onMessage).toHaveBeenCalledWith({
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'pong',
      t: 123,
    });
  });

  it('dispatches terminal snapshot and output messages', () => {
    FakeWebSocket.instances = [];
    const onMessage = vi.fn();
    const client = new BridgeWsClient({
      baseUrl: 'http://127.0.0.1:5174',
      token: 'device-token',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    client.connect({ onMessage });
    const socket = FakeWebSocket.instances[0];

    socket.emitMessage({
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'terminal_snapshot',
      snapshot: {
        cardId: 'card-1',
        data: '\u001b[1;1Hready',
        seq: 10,
        rows: 24,
        cols: 80,
        cursorRow: 1,
        cursorCol: 6,
        history: 'previous line\r\n',
      },
    });
    socket.emitMessage({
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: ' streamed',
      seq: 11,
    });

    expect(onMessage).toHaveBeenNthCalledWith(1, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'terminal_snapshot',
      snapshot: {
        cardId: 'card-1',
        data: '\u001b[1;1Hready',
        seq: 10,
        rows: 24,
        cols: 80,
        cursorRow: 1,
        cursorCol: 6,
        history: 'previous line\r\n',
      },
    });
    expect(onMessage).toHaveBeenNthCalledWith(2, {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: ' streamed',
      seq: 11,
    });
  });

  it('dispatches theme messages with app and terminal tokens', () => {
    FakeWebSocket.instances = [];
    const onMessage = vi.fn();
    const client = new BridgeWsClient({
      baseUrl: 'http://127.0.0.1:5174',
      token: 'device-token',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    client.connect({ onMessage });
    const socket = FakeWebSocket.instances[0];

    const themeMessage = {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'theme',
      mode: 'dark',
      app: {
        background: '#10151d',
        foreground: '#e8edf5',
        card: '#151b24',
        cardForeground: '#e8edf5',
        popover: '#151b24',
        popoverForeground: '#e8edf5',
        primary: '#4f8bd6',
        primaryForeground: '#f8fafc',
        secondary: '#263242',
        secondaryForeground: '#e8edf5',
        muted: '#202a38',
        mutedForeground: '#9aa7b7',
        accent: '#314154',
        accentForeground: '#e8edf5',
        destructive: '#ef4444',
        destructiveForeground: '#f8fafc',
        border: '#2d3948',
        input: '#263242',
        ring: '#4f8bd6',
      },
      terminal: {
        background: '#000000',
        foreground: '#f8fafc',
        cursor: '#f8fafc',
        cursorAccent: '#000000',
        selection: '#334155',
        selectionForeground: '#f8fafc',
        black: '#0f172a',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#d946ef',
        cyan: '#06b6d4',
        white: '#e2e8f0',
        brightBlack: '#475569',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#e879f9',
        brightCyan: '#22d3ee',
        brightWhite: '#f8fafc',
      },
    };
    socket.emitMessage(themeMessage);

    expect(onMessage).toHaveBeenCalledWith(themeMessage);
  });

  it('rejects sends before connection opens', () => {
    const client = new BridgeWsClient({
      baseUrl: 'http://127.0.0.1:5174',
      token: 'device-token',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(() => client.send({ kind: 'ping' })).toThrow(/not open/i);
  });

  it('adds the protocol version to every outbound message', () => {
    FakeWebSocket.instances = [];
    const client = new BridgeWsClient({
      baseUrl: 'http://127.0.0.1:5174',
      token: 'device-token',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    client.send({ kind: 'ping' });

    expect(JSON.parse(socket.sent[2])).toEqual({
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      kind: 'ping',
    });
  });

  it('rejects inbound messages with a missing or mismatched protocol version', () => {
    FakeWebSocket.instances = [];
    const onError = vi.fn();
    const client = new BridgeWsClient({
      baseUrl: 'http://127.0.0.1:5174',
      token: 'device-token',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    client.connect({ onError });
    const socket = FakeWebSocket.instances[0];

    socket.emitMessage({ kind: 'pong', t: 123 });
    socket.emitMessage({ protocol_version: 2, kind: 'pong', t: 123 });

    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining('protocol version'),
    });
  });
});

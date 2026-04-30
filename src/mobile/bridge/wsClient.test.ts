import { describe, expect, it, vi } from 'vitest';
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
  it('builds websocket URLs from LAN HTTP URLs', () => {
    expect(buildBridgeWsUrl('http://192.168.1.42:5174', 'token-1')).toBe(
      'ws://192.168.1.42:5174/ws?token=token-1',
    );
    expect(buildBridgeWsUrl('threadterm.local:5174', 'token 1')).toBe(
      'ws://threadterm.local:5174/ws?token=token+1',
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
    expect(socket.url).toBe('ws://127.0.0.1:5174/ws?token=device-token');

    socket.emitOpen();
    expect(onStateChange).toHaveBeenCalledWith('open');
    expect(JSON.parse(socket.sent[0])).toEqual({ kind: 'subscribe' });

    socket.emitMessage({ kind: 'pong', t: 123 });
    expect(onMessage).toHaveBeenCalledWith({ kind: 'pong', t: 123 });
  });

  it('rejects sends before connection opens', () => {
    const client = new BridgeWsClient({
      baseUrl: 'http://127.0.0.1:5174',
      token: 'device-token',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(() => client.send({ kind: 'ping' })).toThrow(/not open/i);
  });
});

import {
  BRIDGE_PROTOCOL_VERSION,
  type ClientCommand,
  type ClientMessage,
  type ServerMessage,
} from './protocol';

export type BridgeTransportState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';
export type BridgeConnectionState = BridgeTransportState | 'reconnecting' | 'revoked';

export interface BridgeWsClientOptions {
  baseUrl: string;
  token: string;
  WebSocketImpl?: typeof WebSocket;
}

export interface BridgeWsClientEvents {
  onMessage?: (message: ServerMessage) => void;
  onStateChange?: (state: BridgeTransportState) => void;
  onError?: (error: Error) => void;
}

export class BridgeWsClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly WebSocketImpl: typeof WebSocket;
  private socket: WebSocket | null = null;
  private state: BridgeTransportState = 'idle';
  private events: BridgeWsClientEvents = {};

  constructor(options: BridgeWsClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  connect(events: BridgeWsClientEvents = {}) {
    this.events = events;
    this.setState('connecting');

    const socket = new this.WebSocketImpl(buildBridgeWsUrl(this.baseUrl));
    this.socket = socket;

    socket.onopen = () => {
      this.setState('open');
      this.send({ kind: 'auth', token: this.token });
      this.send({ kind: 'subscribe' });
    };
    socket.onclose = () => {
      this.setState('closed');
      if (this.socket === socket) {
        this.socket = null;
      }
    };
    socket.onerror = () => {
      const error = new Error('Bridge websocket error');
      this.setState('error');
      this.events.onError?.(error);
    };
    socket.onmessage = (event) => {
      try {
        const message = parseServerMessage(event.data);
        this.events.onMessage?.(message);
      } catch (error) {
        this.events.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    };
  }

  disconnect() {
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }

  send(message: ClientCommand) {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error('Bridge websocket is not open');
    }
    this.socket.send(JSON.stringify(withProtocolVersion(message)));
  }

  getState(): BridgeTransportState {
    return this.state;
  }

  private setState(state: BridgeTransportState) {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange?.(state);
  }
}

export function buildBridgeWsUrl(baseUrl: string): string {
  const url = new URL('/ws', normalizeBaseUrl(baseUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error('Bridge baseUrl is required');
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Bridge baseUrl must be an absolute HTTP or HTTPS URL');
  }

  const url = new URL(trimmed);
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(
      'Remote mobile access requires HTTPS; plain HTTP is allowed only on this device',
    );
  }
  return url.toString();
}

function parseServerMessage(data: unknown): ServerMessage {
  if (typeof data !== 'string') {
    throw new Error('Bridge websocket message is not text');
  }
  const parsed = JSON.parse(data) as Partial<ServerMessage>;
  if (!parsed || typeof parsed.kind !== 'string') {
    throw new Error('Bridge websocket message has no kind');
  }
  if (parsed.protocol_version !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error(
      `Bridge websocket protocol version mismatch: expected ${BRIDGE_PROTOCOL_VERSION}, received ${
        parsed.protocol_version ?? 'missing'
      }`,
    );
  }
  return parsed as ServerMessage;
}

function withProtocolVersion(message: ClientCommand): ClientMessage {
  return {
    protocol_version: BRIDGE_PROTOCOL_VERSION,
    ...message,
  };
}

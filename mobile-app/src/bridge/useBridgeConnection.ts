import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientCommand, ServerMessage } from '@shared/mobile/bridge/protocol';
import { BridgeWsClient, type BridgeConnectionState } from '@shared/mobile/bridge/wsClient';

export const BRIDGE_HEARTBEAT_INTERVAL_MS = 5_000;
export const BRIDGE_HEARTBEAT_TIMEOUT_MS = 15_000;

interface UseBridgeConnectionOptions {
  token: string | null;
  onMessage: (message: ServerMessage) => void;
  onLagged: () => void;
  onError: (message: string) => void;
}

export function useBridgeConnection({
  token,
  onMessage,
  onLagged,
  onError,
}: UseBridgeConnectionOptions) {
  const [state, setState] = useState<BridgeConnectionState>('idle');
  const clientRef = useRef<BridgeWsClient | null>(null);
  const retryRef = useRef<number | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const lastServerActivityRef = useRef(0);
  const reconnectBlockedRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});
  const onMessageRef = useRef(onMessage);
  const onLaggedRef = useRef(onLagged);
  const onErrorRef = useRef(onError);

  onMessageRef.current = onMessage;
  onLaggedRef.current = onLagged;
  onErrorRef.current = onError;

  const baseUrl = useMemo(() => window.location.origin, []);

  const clearReconnect = useCallback(() => {
    if (retryRef.current !== null) {
      window.clearTimeout(retryRef.current);
      retryRef.current = null;
    }
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatRef.current !== null) {
      window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const disconnectCurrent = useCallback(() => {
    const current = clientRef.current;
    clientRef.current = null;
    current?.disconnect();
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!token || reconnectBlockedRef.current || retryRef.current !== null) return;
    setState('reconnecting');
    const delay = Math.min(5000, 350 * 2 ** retryAttemptRef.current);
    retryAttemptRef.current += 1;
    retryRef.current = window.setTimeout(() => {
      retryRef.current = null;
      connectRef.current();
    }, delay);
  }, [token]);

  const markConnectionUnhealthy = useCallback(() => {
    clearHeartbeat();
    disconnectCurrent();
    scheduleReconnect();
  }, [clearHeartbeat, disconnectCurrent, scheduleReconnect]);

  const startHeartbeat = useCallback(
    (client: BridgeWsClient) => {
      clearHeartbeat();
      heartbeatRef.current = window.setInterval(() => {
        if (clientRef.current !== client || client.getState() !== 'open') {
          clearHeartbeat();
          return;
        }
        if (Date.now() - lastServerActivityRef.current >= BRIDGE_HEARTBEAT_TIMEOUT_MS) {
          markConnectionUnhealthy();
          return;
        }
        try {
          client.send({ kind: 'ping' });
        } catch {
          markConnectionUnhealthy();
        }
      }, BRIDGE_HEARTBEAT_INTERVAL_MS);
    },
    [clearHeartbeat, markConnectionUnhealthy],
  );

  const connect = useCallback(() => {
    if (!token || reconnectBlockedRef.current) return;
    clearReconnect();
    clearHeartbeat();
    disconnectCurrent();

    const client = new BridgeWsClient({ baseUrl, token });
    clientRef.current = client;
    client.connect({
      onStateChange: (next) => {
        if (clientRef.current !== client) return;
        if (next === 'open') {
          retryAttemptRef.current = 0;
          lastServerActivityRef.current = Date.now();
          setState('open');
          startHeartbeat(client);
          return;
        }
        if (next === 'closed' || next === 'error') {
          clearHeartbeat();
          clientRef.current = null;
          setState(next);
          scheduleReconnect();
          return;
        }
        setState(retryAttemptRef.current > 0 ? 'reconnecting' : next);
      },
      onMessage: (message) => {
        if (clientRef.current !== client) return;
        lastServerActivityRef.current = Date.now();
        if (
          message.kind === 'error' &&
          (message.code === 'auth_revoked' || message.code === 'auth_expired')
        ) {
          reconnectBlockedRef.current = true;
          clearReconnect();
          clearHeartbeat();
          onMessageRef.current(message);
          setState('revoked');
          disconnectCurrent();
          return;
        }
        if (message.kind === 'error' && message.code === 'backpressure') {
          onLaggedRef.current();
        }
        onMessageRef.current(message);
      },
      onError: (error) => {
        if (clientRef.current !== client) return;
        onErrorRef.current(error.message);
      },
    });
  }, [
    baseUrl,
    clearHeartbeat,
    clearReconnect,
    disconnectCurrent,
    scheduleReconnect,
    startHeartbeat,
    token,
  ]);

  connectRef.current = connect;

  useEffect(() => {
    reconnectBlockedRef.current = false;
    retryAttemptRef.current = 0;
    if (!token) {
      clearReconnect();
      clearHeartbeat();
      disconnectCurrent();
      setState('idle');
      return;
    }
    connect();
    return () => {
      clearReconnect();
      clearHeartbeat();
      disconnectCurrent();
    };
  }, [clearHeartbeat, clearReconnect, connect, disconnectCurrent, token]);

  useEffect(() => {
    const probeConnection = () => {
      if (!token || reconnectBlockedRef.current) return;
      const current = clientRef.current;
      const currentState = current?.getState();
      if (
        current &&
        currentState === 'open' &&
        Date.now() - lastServerActivityRef.current < BRIDGE_HEARTBEAT_TIMEOUT_MS
      ) {
        try {
          current.send({ kind: 'ping' });
          return;
        } catch {
          // Replace the unusable socket below.
        }
      }
      if (currentState === 'connecting') return;
      clearReconnect();
      clearHeartbeat();
      disconnectCurrent();
      connectRef.current();
    };
    const resume = () => {
      if (document.visibilityState === 'visible') probeConnection();
    };
    const online = () => {
      probeConnection();
    };
    const pageShow = () => {
      probeConnection();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', online);
    window.addEventListener('pageshow', pageShow);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', online);
      window.removeEventListener('pageshow', pageShow);
    };
  }, [clearHeartbeat, clearReconnect, disconnectCurrent, token]);

  const send = useCallback((message: ClientCommand) => {
    clientRef.current?.send(message);
  }, []);

  return { state, send, reconnect: connect };
}

export async function fetchSnapshot(token: string, fetcher: typeof fetch = fetch): Promise<ServerMessage> {
  const url = new URL('/snapshot', window.location.origin);
  const response = await fetcher(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Snapshot failed with HTTP ${response.status}`);
  }
  return (await response.json()) as ServerMessage;
}

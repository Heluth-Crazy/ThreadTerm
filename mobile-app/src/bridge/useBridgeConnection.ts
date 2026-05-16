import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientCommand, ServerMessage } from '@shared/mobile/bridge/protocol';
import { BridgeWsClient, type BridgeConnectionState } from '@shared/mobile/bridge/wsClient';

interface UseBridgeConnectionOptions {
  token: string | null;
  onMessage: (message: ServerMessage) => void;
  onLagged: () => void;
  onError: (message: string) => void;
  onResume?: () => void;
}

export function useBridgeConnection({
  token,
  onMessage,
  onLagged,
  onError,
  onResume,
}: UseBridgeConnectionOptions) {
  const [state, setState] = useState<BridgeConnectionState>('idle');
  const clientRef = useRef<BridgeWsClient | null>(null);
  const retryRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const connectRef = useRef<() => void>(() => {});
  const onMessageRef = useRef(onMessage);
  const onLaggedRef = useRef(onLagged);
  const onErrorRef = useRef(onError);
  const onResumeRef = useRef(onResume);

  onMessageRef.current = onMessage;
  onLaggedRef.current = onLagged;
  onErrorRef.current = onError;
  onResumeRef.current = onResume;

  const baseUrl = useMemo(() => window.location.origin, []);

  const clearReconnect = useCallback(() => {
    if (retryRef.current !== null) {
      window.clearTimeout(retryRef.current);
      retryRef.current = null;
    }
  }, []);

  const disconnectCurrent = useCallback(() => {
    const current = clientRef.current;
    clientRef.current = null;
    current?.disconnect();
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!token || retryRef.current !== null) return;
    const delay = Math.min(5000, 350 * 2 ** retryAttemptRef.current);
    retryAttemptRef.current += 1;
    retryRef.current = window.setTimeout(() => {
      retryRef.current = null;
      connectRef.current();
    }, delay);
  }, [token]);

  const connect = useCallback(() => {
    if (!token) return;
    clearReconnect();
    disconnectCurrent();

    const client = new BridgeWsClient({ baseUrl, token });
    clientRef.current = client;
    client.connect({
      onStateChange: (next) => {
        if (clientRef.current !== client) return;
        setState(next);
        if (next === 'open') {
          retryAttemptRef.current = 0;
        }
        if (next === 'closed' || next === 'error') {
          scheduleReconnect();
        }
      },
      onMessage: (message) => {
        if (clientRef.current !== client) return;
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
  }, [baseUrl, clearReconnect, disconnectCurrent, scheduleReconnect, token]);

  connectRef.current = connect;

  useEffect(() => {
    connect();
    return () => {
      clearReconnect();
      disconnectCurrent();
    };
  }, [clearReconnect, connect, disconnectCurrent]);

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'visible') {
        connect();
        onResumeRef.current?.();
      }
    };
    const online = () => {
      connect();
      onResumeRef.current?.();
    };
    const pageShow = () => {
      connect();
      onResumeRef.current?.();
    };
    const pageHide = () => {
      clearReconnect();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', online);
    window.addEventListener('pageshow', pageShow);
    window.addEventListener('pagehide', pageHide);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', online);
      window.removeEventListener('pageshow', pageShow);
      window.removeEventListener('pagehide', pageHide);
    };
  }, [clearReconnect, connect]);

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

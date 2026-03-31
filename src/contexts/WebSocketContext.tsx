import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { IS_PLATFORM } from '../constants/config';

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => boolean;
  latestMessage: any | null;
  messageSequence: number;
  getBufferedMessagesSince: (sequence: number) => Array<{ sequence: number; message: any }>;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  // OSS mode: token may be empty when auth is disabled. Server accepts /ws without token.
  if (!token) return `${protocol}//${window.location.host}/ws`;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [messageSequence, setMessageSequence] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const messageFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const priorityMessageQueueRef = useRef<any[]>([]);
  const normalMessageQueueRef = useRef<any[]>([]);
  const bufferedMessagesRef = useRef<Array<{ sequence: number; message: any }>>([]);
  const messageSequenceRef = useRef(0);
  const { token } = useAuth();
  const MAX_PRIORITY_QUEUE_SIZE = 2000;
  const MAX_NORMAL_QUEUE_SIZE = 500;
  const MAX_BUFFERED_MESSAGE_SIZE = 5000;
  const CHAT_MESSAGE_TYPES = new Set([
    'session-created',
    'claude-response',
    'codex-response',
    'claude-complete',
    'codex-complete',
    'claude-error',
    'codex-error',
    'claude-permission-request',
    'claude-permission-cancelled',
    'error',
    'token-budget',
    'session-aborted',
  ]);

  const flushNextQueuedMessage = useCallback(() => {
    if (unmountedRef.current) {
      priorityMessageQueueRef.current = [];
      normalMessageQueueRef.current = [];
      messageFlushTimeoutRef.current = null;
      return;
    }

    const nextMessage = priorityMessageQueueRef.current.shift() ?? normalMessageQueueRef.current.shift();
    if (!nextMessage) {
      messageFlushTimeoutRef.current = null;
      return;
    }

    setLatestMessage(nextMessage);
    const nextSequence = messageSequenceRef.current + 1;
    messageSequenceRef.current = nextSequence;
    if (bufferedMessagesRef.current.length >= MAX_BUFFERED_MESSAGE_SIZE) {
      bufferedMessagesRef.current.shift();
    }
    bufferedMessagesRef.current.push({ sequence: nextSequence, message: nextMessage });
    setMessageSequence(nextSequence);
    messageFlushTimeoutRef.current = setTimeout(flushNextQueuedMessage, 0);
  }, []);

  const getBufferedMessagesSince = useCallback((sequence: number) => {
    const normalizedSequence = Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 0;
    return bufferedMessagesRef.current.filter((entry) => entry.sequence > normalizedSequence);
  }, []);

  const enqueueIncomingMessage = useCallback((message: any) => {
    const messageType = typeof message?.type === 'string' ? message.type : '';
    const isChatMessage = CHAT_MESSAGE_TYPES.has(messageType);

    if (isChatMessage) {
      if (priorityMessageQueueRef.current.length >= MAX_PRIORITY_QUEUE_SIZE) {
        priorityMessageQueueRef.current.shift();
      }
      priorityMessageQueueRef.current.push(message);
    } else {
      if (messageType === 'projects_updated' || messageType === 'loading_progress') {
        // Collapse noisy state updates; keep only the latest pending one per type.
        const queue = normalMessageQueueRef.current;
        for (let i = queue.length - 1; i >= 0; i -= 1) {
          if (queue[i]?.type === messageType) {
            queue.splice(i, 1);
            break;
          }
        }
      }

      if (normalMessageQueueRef.current.length >= MAX_NORMAL_QUEUE_SIZE) {
        normalMessageQueueRef.current.shift();
      }
      normalMessageQueueRef.current.push(message);
    }

    if (messageFlushTimeoutRef.current === null) {
      messageFlushTimeoutRef.current = setTimeout(flushNextQueuedMessage, 0);
    }
  }, [flushNextQueuedMessage]);

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    // Listen for app quit event from Electron main process
    const handleBeforeQuit = () => {
      console.log('[WebSocket] App is quitting - closing WebSocket connection gracefully');
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (messageFlushTimeoutRef.current) {
        clearTimeout(messageFlushTimeoutRef.current);
        messageFlushTimeoutRef.current = null;
      }
      priorityMessageQueueRef.current = [];
      normalMessageQueueRef.current = [];
      bufferedMessagesRef.current = [];
      messageSequenceRef.current = 0;
      if (wsRef.current) {
        // Use code 1000 (normal closure) for graceful exit
        wsRef.current.close(1000, 'Application quitting');
        wsRef.current = null;
      }
    };

    // Register Electron quit handler if running in Electron
    if (window.electronAPI?.onBeforeQuit) {
      window.electronAPI.onBeforeQuit(handleBeforeQuit);
    }

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (messageFlushTimeoutRef.current) {
        clearTimeout(messageFlushTimeoutRef.current);
        messageFlushTimeoutRef.current = null;
      }
      priorityMessageQueueRef.current = [];
      normalMessageQueueRef.current = [];
      bufferedMessagesRef.current = [];
      messageSequenceRef.current = 0;
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [token]); // everytime token changes, we reconnect

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        setIsConnected(true);
        wsRef.current = websocket;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          enqueueIncomingMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        
        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [enqueueIncomingMessage, token]); // everytime token changes, we reconnect

  const sendMessage = useCallback((message: any) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    } else {
      console.warn('WebSocket not connected');
      return false;
    }
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    messageSequence,
    getBufferedMessagesSince,
    isConnected
  }), [sendMessage, latestMessage, messageSequence, getBufferedMessagesSince, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;

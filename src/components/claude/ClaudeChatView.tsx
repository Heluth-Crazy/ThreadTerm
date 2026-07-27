import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Bot,
  Loader2,
  Send,
  Square,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { logger } from '../../lib/logger';
import {
  claudeChat,
  type ClaudeChatEventPayload,
  type ClaudeChatRequestPayload,
} from '../../lib/claudeChat/api';
import {
  assistantPreviewFromMessage,
} from '../../lib/claudeChat/normalize';
import {
  EMPTY_CLAUDE_CHAT_STATE,
  useClaudeChatStore,
  type PendingClaudeRequest,
} from '../../stores/claudeChatStore';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import { ClaudeApprovalCard, ClaudeItemRow } from './ClaudeChatRows';

interface ClaudeChatViewProps {
  card: TerminalCard;
  active?: boolean;
}

export function ClaudeChatView({
  card,
  active = true,
}: ClaudeChatViewProps) {
  const { t } = useTranslation('terminal');
  const session = useClaudeChatStore(
    (state) => state.sessions[card.id] ?? EMPTY_CLAUDE_CHAT_STATE,
  );
  const recordUserSubmit = useTerminalStore((state) => state.recordUserSubmit);
  const markProviderSessionBound = useTerminalStore(
    (state) => state.markProviderSessionBound,
  );
  const updateCardReplyPreview = useTerminalStore(
    (state) => state.updateCardReplyPreview,
  );
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [resolvingRequestId, setResolvingRequestId] = useState<string | null>(
    null,
  );
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cardId = card.id;
  const cwd = card.worktreePath ?? card.projectPath;
  const resumeSessionId =
    card.providerSessionState === 'bound'
      ? card.providerSessionId ?? null
      : null;
  const startSnapshotRef = useRef({
    cardId,
    cwd,
    resumeSessionId,
  });
  if (
    startSnapshotRef.current.cardId !== cardId ||
    startSnapshotRef.current.cwd !== cwd
  ) {
    startSnapshotRef.current = {
      cardId,
      cwd,
      resumeSessionId,
    };
  }

  useEffect(() => {
    if (!active) return;
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [active, session.items.length, session.pendingRequests.length]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const snapshot = startSnapshotRef.current;

    const handleEvent = (payload: ClaudeChatEventPayload) => {
      if (disposed || payload.cardId !== snapshot.cardId) return;
      const store = useClaudeChatStore.getState();
      if (payload.ev === 'session.event') {
        store.applyMessage(payload.cardId, payload.message);
        const preview = assistantPreviewFromMessage(payload.message);
        if (preview) updateCardReplyPreview(payload.cardId, preview);
        return;
      }

      store.applyStatus(payload);
      if (payload.phase === 'ready' && payload.sessionId) {
        markProviderSessionBound(payload.cardId, payload.sessionId);
      }
    };

    const handleRequest = (payload: ClaudeChatRequestPayload) => {
      if (disposed || payload.cardId !== snapshot.cardId) return;
      const store = useClaudeChatStore.getState();
      if (payload.ev === 'session.request') {
        store.upsertRequest(payload);
      } else {
        store.removeRequest(payload.cardId, payload.requestId);
      }
    };

    const setup = async () => {
      const listeners = await Promise.all([
        claudeChat.onEvent(handleEvent).catch((error) => {
          logger.warn('[ClaudeChatView] failed to listen for events', error);
          return () => {};
        }),
        claudeChat.onRequest(handleRequest).catch((error) => {
          logger.warn('[ClaudeChatView] failed to listen for requests', error);
          return () => {};
        }),
        claudeChat.onDisconnected(({ message }) => {
          if (!disposed) {
            useClaudeChatStore.getState().markDisconnected(message);
          }
        }).catch((error) => {
          logger.warn(
            '[ClaudeChatView] failed to listen for disconnects',
            error,
          );
          return () => {};
        }),
      ]);
      if (disposed) {
        listeners.forEach((unlisten) => unlisten());
        return;
      }
      unlisteners.push(...listeners);

      const store = useClaudeChatStore.getState();
      store.prepareCard(snapshot.cardId, snapshot.resumeSessionId);
      if (store.sessions[snapshot.cardId]?.started) return;

      try {
        const probe = await claudeChat.probe();
        if (disposed) return;
        if (!probe.ok) {
          store.setError(
            snapshot.cardId,
            probe.detail ?? 'Claude Chat is unavailable.',
          );
          return;
        }

        const result = await claudeChat.start({
          cardId: snapshot.cardId,
          cwd: snapshot.cwd,
          sessionId: snapshot.resumeSessionId,
        });
        if (disposed) return;
        store.markStarted(snapshot.cardId, result.sessionId);
        if (result.sessionId) {
          markProviderSessionBound(snapshot.cardId, result.sessionId);
        }
      } catch (error) {
        if (disposed) return;
        const message = errorMessage(error);
        // A view can be temporarily unmounted by the terminal LRU while its
        // sidecar session remains healthy. Reattaching to that card should not
        // turn an already-running conversation into an error screen.
        if (/session already exists for card/i.test(message)) {
          store.markStarted(snapshot.cardId, snapshot.resumeSessionId);
          return;
        }
        store.setError(snapshot.cardId, message);
      }
    };

    void setup();
    return () => {
      disposed = true;
      for (const unlisten of unlisteners.splice(0)) {
        try {
          unlisten();
        } catch (error) {
          logger.warn('[ClaudeChatView] failed to unlisten', error);
        }
      }
    };
  }, [
    cardId,
    cwd,
    markProviderSessionBound,
    updateCardReplyPreview,
  ]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !session.started || sending) return;
    setSending(true);
    try {
      await claudeChat.send(cardId, text);
      useClaudeChatStore.getState().appendUserMessage(cardId, text);
      recordUserSubmit(cardId, text);
      setInput('');
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    } catch (error) {
      useClaudeChatStore.getState().reportError(cardId, errorMessage(error));
    } finally {
      setSending(false);
    }
  }, [cardId, input, recordUserSubmit, sending, session.started]);

  const handleInterrupt = useCallback(async () => {
    try {
      await claudeChat.interrupt(cardId);
    } catch (error) {
      useClaudeChatStore.getState().reportError(cardId, errorMessage(error));
    }
  }, [cardId]);

  const handleDecision = useCallback(
    async (
      request: PendingClaudeRequest,
      behavior: 'allow' | 'deny',
    ) => {
      setResolvingRequestId(request.requestId);
      try {
        await claudeChat.decide({
          cardId,
          requestId: request.requestId,
          behavior,
          updatedInput: behavior === 'allow' ? request.input : undefined,
          message:
            behavior === 'deny'
              ? t('claudeChat.deniedMessage', {
                  defaultValue: 'Denied in ThreadTerm.',
                })
              : undefined,
        });
        useClaudeChatStore
          .getState()
          .removeRequest(cardId, request.requestId);
      } catch (error) {
        useClaudeChatStore.getState().reportError(cardId, errorMessage(error));
      } finally {
        setResolvingRequestId(null);
      }
    },
    [cardId, t],
  );

  const connected =
    session.started &&
    session.phase !== 'error' &&
    session.phase !== 'closed' &&
    session.phase !== 'disconnected';
  const running = session.phase === 'running';
  const statusLabel = useMemo(
    () =>
      t(`claudeChat.status.${session.phase}`, {
        defaultValue: phaseFallback(session.phase),
      }),
    [session.phase, t],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-testid="claude-chat-view"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-orange-500/10 text-orange-400">
            <Bot className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
              <span className="shrink-0">
                {t('claudeChat.title', { defaultValue: 'Claude Chat' })}
              </span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {cwd}
              </span>
            </div>
            {session.sessionId && (
              <div className="truncate font-mono text-[11px] text-muted-foreground/80">
                {session.sessionId.slice(0, 16)}
              </div>
            )}
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
          {session.phase === 'checking' || session.phase === 'starting' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <span
              className={[
                'h-1.5 w-1.5 rounded-full',
                connected ? 'bg-emerald-400' : 'bg-destructive',
              ].join(' ')}
            />
          )}
          {statusLabel}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        {session.items.length === 0 ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted/30">
              {session.phase === 'checking' || session.phase === 'starting' ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Bot className="h-5 w-5 text-orange-400" />
              )}
            </div>
            <span>
              {connected
                ? t('claudeChat.empty', {
                    defaultValue: 'Start a Claude conversation in this project.',
                  })
                : t('claudeChat.connecting', {
                    defaultValue: 'Connecting to Claude…',
                  })}
            </span>
            {session.lastError && (
              <span className="max-w-xl text-xs text-destructive">
                {session.lastError}
              </span>
            )}
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {session.items.map((item) => (
              <ClaudeItemRow key={item.id} item={item} />
            ))}
            {session.lastError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {session.lastError}
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {session.pendingRequests.length > 0 && (
        <div className="max-h-64 shrink-0 overflow-y-auto border-t border-border bg-amber-500/5 px-4 py-3">
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {session.pendingRequests.map((request) => (
              <ClaudeApprovalCard
                key={request.requestId}
                request={request}
                resolving={resolvingRequestId === request.requestId}
                onAllow={() => void handleDecision(request, 'allow')}
                onDeny={() => void handleDecision(request, 'deny')}
              />
            ))}
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-border bg-background/95 px-4 py-3">
        <div className="mx-auto max-w-3xl overflow-hidden rounded-md border border-border bg-muted/20 shadow-lg shadow-black/20 focus-within:border-orange-400/70">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            disabled={!connected}
            rows={3}
            className="min-h-[72px] w-full resize-none bg-transparent px-3 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
            placeholder={t('claudeChat.placeholder', {
              defaultValue: 'Message Claude…',
            })}
          />
          <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-2">
            <span className="truncate px-1 text-[11px] text-muted-foreground">
              {t('claudeChat.enterHint', {
                defaultValue: 'Enter to send · Shift+Enter for a new line',
              })}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              {running && (
                <button
                  type="button"
                  onClick={() => void handleInterrupt()}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  title={t('claudeChat.stop', { defaultValue: 'Stop' })}
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!connected || sending || !input.trim()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-orange-500 text-white transition hover:bg-orange-500/90 disabled:opacity-50"
                title={t('claudeChat.send', { defaultValue: 'Send' })}
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function phaseFallback(phase: string): string {
  switch (phase) {
    case 'checking':
      return 'Checking';
    case 'starting':
      return 'Starting';
    case 'ready':
      return 'Ready';
    case 'running':
      return 'Running';
    case 'idle':
      return 'Ready';
    case 'closed':
      return 'Closed';
    case 'disconnected':
      return 'Disconnected';
    default:
      return 'Error';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

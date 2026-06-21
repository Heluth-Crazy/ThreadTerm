import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Brain,
  Check,
  FileText,
  ListChecks,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Square,
  TerminalSquare,
  Wrench,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TerminalCard } from '../../types/terminal';
import { useTerminalStore } from '../../stores/terminalStore';
import {
  codexApp,
  isTauriEnv,
  type CodexAppNotificationPayload,
  type CodexAppRequestPayload,
} from '../../lib/tauri-bridge';
import {
  appendDelta,
  asString,
  extractThreadItems,
  getString,
  isRecord,
  threadBindingFromThread,
  upsertItem,
  type CodexDisplayItem,
  type CodexDisplayItemKind,
} from '../../lib/codexApp/normalize';

interface CodexChatViewProps {
  card: TerminalCard;
  active?: boolean;
}

type ConnectionState = 'opening' | 'ready' | 'error';

interface PendingRequest {
  key: string;
  requestId: unknown;
  method: string;
  params: unknown;
  raw: unknown;
  createdAt: number;
}

interface SkillOption {
  name: string;
  path: string;
  description: string;
  enabled: boolean;
}

export function CodexChatView({ card, active = true }: CodexChatViewProps) {
  const { t } = useTranslation('terminal');
  const bindCodexAppThread = useTerminalStore((s) => s.bindCodexAppThread);
  const recordUserSubmit = useTerminalStore((s) => s.recordUserSubmit);
  const updateCardReplyPreview = useTerminalStore((s) => s.updateCardReplyPreview);
  const [connectionState, setConnectionState] = useState<ConnectionState>('opening');
  const [threadId, setThreadId] = useState<string | null>(card.codexAppThreadId ?? null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [items, setItems] = useState<CodexDisplayItem[]>([]);
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [goalText, setGoalText] = useState('');
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillOption | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const threadIdRef = useRef<string | null>(threadId);
  const activeRef = useRef(active);
  const cardIdRef = useRef(card.id);

  const cwd = card.worktreePath ?? card.projectPath;

  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    cardIdRef.current = card.id;
  }, [card.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [items.length, requests.length]);

  useEffect(() => {
    let cancelled = false;
    setConnectionState('opening');
    setError(null);
    setRequests([]);
    setThreadId(card.codexAppThreadId ?? null);
    setItems([]);

    if (!isTauriEnv()) {
      setConnectionState('error');
      setError(t('codexChat.desktopOnly', { defaultValue: 'Codex Chat requires the desktop app.' }));
      return;
    }

    void codexApp
      .openCard({
        cardId: card.id,
        cwd,
        codexAppThreadId: card.codexAppThreadId,
        providerSessionId: card.providerSessionId,
      })
      .then((result) => {
        if (cancelled) return;
        setThreadId(result.threadId);
        bindCodexAppThread(card.id, {
          threadId: result.threadId,
          sessionId: result.sessionId,
          threadPath: result.threadPath,
        });
        setItems(extractThreadItems(result.thread));
        setConnectionState('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConnectionState('error');
        setError(errorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [bindCodexAppThread, card.id, card.codexAppThreadId, card.providerSessionId, cwd, t]);

  useEffect(() => {
    if (!isTauriEnv()) return;
    let cancelled = false;
    let unlistenNotification: (() => void) | undefined;
    let unlistenRequest: (() => void) | undefined;
    let unlistenDisconnected: (() => void) | undefined;

    void codexApp.onNotification((payload) => {
      if (!cancelled && belongsToCard(payload, cardIdRef.current, threadIdRef.current)) {
        handleNotification(payload);
      }
    }).then((unlisten) => {
      unlistenNotification = unlisten;
    });
    void codexApp.onRequest((payload) => {
      if (!cancelled && belongsToCard(payload, cardIdRef.current, threadIdRef.current)) {
        handleRequest(payload);
      }
    }).then((unlisten) => {
      unlistenRequest = unlisten;
    });
    void codexApp.onDisconnected((payload) => {
      if (cancelled) return;
      setConnectionState('error');
      setError(payload.message);
      setActiveTurnId(null);
      setSending(false);
    }).then((unlisten) => {
      unlistenDisconnected = unlisten;
    });

    return () => {
      cancelled = true;
      unlistenNotification?.();
      unlistenRequest?.();
      unlistenDisconnected?.();
    };
  }, []);

  const handleNotification = useCallback(
    (payload: CodexAppNotificationPayload) => {
      const params = payload.params;
      switch (payload.method) {
        case 'thread/started': {
          const thread = isRecord(params) ? params.thread : null;
          const binding = threadBindingFromThread(thread);
          if (binding) {
            setThreadId(binding.threadId);
            bindCodexAppThread(cardIdRef.current, binding);
          }
          break;
        }
        case 'turn/started': {
          const turn = isRecord(params) ? params.turn : null;
          const turnId = getString(turn, 'id');
          if (turnId) setActiveTurnId(turnId);
          const turnItems = itemsFromTurn(turn);
          if (turnItems.length > 0) {
            setItems((previous) =>
              turnItems.reduce<CodexDisplayItem[]>((acc, item) => upsertItem(acc, item), previous),
            );
          }
          break;
        }
        case 'turn/completed': {
          const turn = isRecord(params) ? params.turn : null;
          const turnItems = itemsFromTurn(turn);
          if (turnItems.length > 0) {
            setItems((previous) =>
              turnItems.reduce<CodexDisplayItem[]>((acc, item) => upsertItem(acc, item), previous),
            );
          }
          setActiveTurnId(null);
          setSending(false);
          break;
        }
        case 'item/started':
        case 'item/completed': {
          const item = isRecord(params) ? params.item : null;
          if (item) {
            setItems((previous) => upsertItem(previous, item));
            if (payload.method === 'item/completed' && getString(item, 'type') === 'agentMessage') {
              updateCardReplyPreview(cardIdRef.current, getString(item, 'text') ?? '');
            }
          }
          break;
        }
        case 'item/agentMessage/delta': {
          const itemId = getString(params, 'itemId');
          const delta = getString(params, 'delta') ?? '';
          if (itemId && delta) {
            setItems((previous) => appendDelta(previous, itemId, delta, 'assistant', 'Codex'));
          }
          break;
        }
        case 'item/commandExecution/outputDelta':
        case 'item/fileChange/outputDelta': {
          const itemId = getString(params, 'itemId');
          const delta = getString(params, 'delta') ?? '';
          if (itemId && delta) {
            const kind: CodexDisplayItemKind =
              payload.method === 'item/commandExecution/outputDelta' ? 'command' : 'file';
            setItems((previous) => appendDelta(previous, itemId, delta, kind, kind === 'command' ? 'Command' : 'File changes'));
          }
          break;
        }
        case 'turn/plan/updated': {
          setItems((previous) => [
            ...previous,
            systemItem('plan', t('codexChat.planUpdated', { defaultValue: 'Plan updated' }), stringifyCompact(params)),
          ]);
          break;
        }
        case 'thread/goal/updated':
        case 'thread/goal/cleared':
        case 'context/compacted': {
          setItems((previous) => [
            ...previous,
            systemItem(payload.method, eventTitle(payload.method), stringifyCompact(params)),
          ]);
          break;
        }
        case 'error':
        case 'thread/realtime/error': {
          setError(stringifyCompact(params));
          break;
        }
        default:
          break;
      }
    },
    [bindCodexAppThread, t, updateCardReplyPreview],
  );

  const handleRequest = useCallback((payload: CodexAppRequestPayload) => {
    setRequests((previous) => {
      const key = requestKey(payload.requestId);
      if (previous.some((request) => request.key === key)) return previous;
      return [
        ...previous,
        {
          key,
          requestId: payload.requestId,
          method: payload.method,
          params: payload.params,
          raw: payload.raw,
          createdAt: Date.now(),
        },
      ];
    });
  }, []);

  const removeRequest = useCallback((key: string) => {
    setRequests((previous) => previous.filter((request) => request.key !== key));
  }, []);

  const respondToRequest = useCallback(
    async (request: PendingRequest, response: unknown) => {
      await codexApp.respondRequest(request.requestId, response);
      removeRequest(request.key);
    },
    [removeRequest],
  );

  const loadSkills = useCallback(async () => {
    if (!threadId) return;
    setSkillsOpen(true);
    setSkillsLoading(true);
    try {
      const response = await codexApp.listSkills(cwd);
      setSkills(parseSkills(response));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSkillsLoading(false);
    }
  }, [cwd, threadId]);

  const handleCompact = useCallback(async () => {
    if (!threadId) return;
    try {
      await codexApp.compact(threadId);
      setItems((previous) => [
        ...previous,
        systemItem('compact-started', t('codexChat.compactStarted', { defaultValue: 'Compaction started' }), ''),
      ]);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [threadId, t]);

  const handleSetGoal = useCallback(async () => {
    if (!threadId) return;
    const objective = goalText.trim();
    if (!objective) return;
    try {
      await codexApp.setGoal(threadId, objective);
      setGoalOpen(false);
      setGoalText('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [goalText, threadId]);

  const handleInterrupt = useCallback(async () => {
    if (!threadId || !activeTurnId) return;
    try {
      await codexApp.interrupt(threadId, activeTurnId);
      setActiveTurnId(null);
      setSending(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeTurnId, threadId]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!threadId || sending) return;

    if (text === '/compact') {
      setInput('');
      await handleCompact();
      return;
    }
    if (text === '/skills') {
      setInput('');
      await loadSkills();
      return;
    }
    if (text.startsWith('/goal ')) {
      setGoalText(text.slice('/goal '.length).trim());
      setInput('');
      setGoalOpen(true);
      return;
    }
    if (!text && !selectedSkill) return;

    setSending(true);
    setError(null);
    const structuredInput = selectedSkill
      ? [
          { type: 'skill', name: selectedSkill.name, path: selectedSkill.path },
          ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
        ]
      : null;

    try {
      await codexApp.sendMessage({
        cardId: card.id,
        threadId,
        text,
        input: structuredInput,
        cwd,
      });
      recordUserSubmit(card.id, text || `/${selectedSkill?.name ?? 'skill'}`);
      setInput('');
      setSelectedSkill(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }, [
    card.id,
    cwd,
    handleCompact,
    input,
    loadSkills,
    recordUserSubmit,
    selectedSkill,
    sending,
    threadId,
  ]);

  const ready = connectionState === 'ready' && Boolean(threadId);
  const emptyText = useMemo(
    () =>
      connectionState === 'opening'
        ? t('codexChat.connecting', { defaultValue: 'Connecting to Codex app-server…' })
        : t('codexChat.empty', { defaultValue: 'Start a Codex chat in this project.' }),
    [connectionState, t],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <MessageSquare className="h-3.5 w-3.5 text-primary" />
              <span>{t('codexChat.title', { defaultValue: 'Codex Chat' })}</span>
              {threadId && (
                <span className="truncate font-mono text-[10px] text-muted-foreground">
                  {threadId.slice(0, 12)}
                </span>
              )}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">{cwd}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto">
            <button
              type="button"
              onClick={loadSkills}
              disabled={!ready || skillsLoading}
              className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-md)] border border-white/10 px-2 text-[11px] hover:bg-accent disabled:opacity-50"
            >
              {skillsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ListChecks className="h-3 w-3" />}
              {t('codexChat.skills', { defaultValue: 'Skills' })}
            </button>
            <button
              type="button"
              onClick={() => setGoalOpen((value) => !value)}
              disabled={!ready}
              className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-md)] border border-white/10 px-2 text-[11px] hover:bg-accent disabled:opacity-50"
            >
              <ShieldCheck className="h-3 w-3" />
              {t('codexChat.goal', { defaultValue: 'Goal' })}
            </button>
            <button
              type="button"
              onClick={handleCompact}
              disabled={!ready}
              className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-md)] border border-white/10 px-2 text-[11px] hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" />
              {t('codexChat.compact', { defaultValue: 'Compact' })}
            </button>
            <button
              type="button"
              onClick={handleInterrupt}
              disabled={!ready || !activeTurnId}
              className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-md)] border border-white/10 px-2 text-[11px] hover:bg-accent disabled:opacity-50"
            >
              <Square className="h-3 w-3" />
              {t('codexChat.stop', { defaultValue: 'Stop' })}
            </button>
          </div>
        </div>

        {goalOpen && (
          <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
            <input
              value={goalText}
              onChange={(event) => setGoalText(event.target.value)}
              className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-white/10 bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
              placeholder={t('codexChat.goalPlaceholder', { defaultValue: 'Goal objective' })}
            />
            <button
              type="button"
              onClick={handleSetGoal}
              disabled={!goalText.trim()}
              className="inline-flex h-8 shrink-0 items-center rounded-[var(--radius-md)] bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {t('codexChat.apply', { defaultValue: 'Apply' })}
            </button>
          </div>
        )}

        {skillsOpen && (
          <div className="max-h-40 shrink-0 overflow-y-auto border-b border-white/10 px-3 py-2">
            <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>{t('codexChat.availableSkills', { defaultValue: 'Available skills' })}</span>
              <button
                type="button"
                onClick={() => setSkillsOpen(false)}
                className="rounded p-0.5 hover:bg-accent"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {skills.length === 0 && !skillsLoading ? (
              <div className="py-3 text-center text-xs text-muted-foreground">
                {t('codexChat.noSkills', { defaultValue: 'No skills found for this project.' })}
              </div>
            ) : (
              <div className="grid gap-1 sm:grid-cols-2">
                {skills.map((skill) => (
                  <button
                    type="button"
                    key={`${skill.path}:${skill.name}`}
                    onClick={() => {
                      setSelectedSkill(skill);
                      setSkillsOpen(false);
                    }}
                    disabled={!skill.enabled}
                    className="min-w-0 rounded-[var(--radius-md)] border border-white/10 px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                  >
                    <div className="truncate text-xs font-medium">/{skill.name}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {skill.description}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              {connectionState === 'opening' && <Loader2 className="h-5 w-5 animate-spin" />}
              <span>{emptyText}</span>
              {error && <span className="max-w-xl text-xs text-destructive">{error}</span>}
            </div>
          ) : (
            <div className="mx-auto flex max-w-4xl flex-col gap-3">
              {items.map((item) => (
                <CodexItemRow key={item.id} item={item} />
              ))}
              {error && (
                <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>
      </div>

      {requests.length > 0 && (
        <div className="max-h-56 shrink-0 overflow-y-auto border-t border-white/10 bg-muted/20 px-3 py-2">
          <div className="mx-auto flex max-w-4xl flex-col gap-2">
            {requests.map((request) => (
              <CodexRequestCard
                key={request.key}
                request={request}
                onRespond={respondToRequest}
                onCancel={() => removeRequest(request.key)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-white/10 px-3 py-2">
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          {selectedSkill && (
            <div className="flex w-fit max-w-full items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] text-primary">
              <span className="truncate">/{selectedSkill.name}</span>
              <button type="button" onClick={() => setSelectedSkill(null)} className="rounded-full hover:bg-primary/20">
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              disabled={!ready}
              rows={2}
              className="min-h-[44px] min-w-0 flex-1 resize-none rounded-[var(--radius-md)] border border-white/10 bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
              placeholder={t('codexChat.placeholder', {
                defaultValue: 'Message Codex, or type /skills, /compact, /goal …',
              })}
            />
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!ready || sending || (!input.trim() && !selectedSkill)}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-primary text-primary-foreground disabled:opacity-50"
              title={t('codexChat.send', { defaultValue: 'Send' })}
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CodexItemRow({ item }: { item: CodexDisplayItem }) {
  const Icon = iconForItem(item.kind);
  const accent = accentForItem(item.kind);
  const compactBody = item.body.trim();
  return (
    <div className="flex gap-2">
      <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] ${accent}`}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-white/10 bg-muted/20 px-3 py-2">
        <div className="mb-1 flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold">{item.title}</span>
          {item.status && (
            <span className="shrink-0 rounded-full bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {item.status}
            </span>
          )}
        </div>
        {compactBody ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">
            {compactBody}
          </pre>
        ) : (
          <div className="text-xs text-muted-foreground">…</div>
        )}
      </div>
    </div>
  );
}

function CodexRequestCard({
  request,
  onRespond,
  onCancel,
}: {
  request: PendingRequest;
  onRespond: (request: PendingRequest, response: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation('terminal');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const title = requestTitle(request.method, t);
  const params = isRecord(request.params) ? request.params : {};
  const command = asString(params.command);
  const reason = asString(params.reason);
  const cwd = asString(params.cwd);
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const isToolInput = request.method === 'item/tool/requestUserInput';
  const isApproval =
    request.method === 'item/commandExecution/requestApproval' ||
    request.method === 'item/fileChange/requestApproval';

  const respond = async (response: unknown) => {
    setSubmitting(true);
    try {
      await onRespond(request, response);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-[var(--radius-md)] border border-primary/25 bg-primary/10 px-3 py-2">
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">{title}</div>
          <div className="truncate text-[10px] text-muted-foreground">{request.method}</div>
        </div>
        <button type="button" onClick={onCancel} className="rounded p-0.5 hover:bg-accent">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {command && (
        <pre className="mb-2 max-h-20 overflow-auto rounded bg-background px-2 py-1.5 text-xs">
          {command}
        </pre>
      )}
      {cwd && <div className="mb-1 truncate text-[10px] text-muted-foreground">{cwd}</div>}
      {reason && <div className="mb-2 text-xs text-muted-foreground">{reason}</div>}

      {isToolInput && (
        <div className="mb-2 space-y-2">
          {questions.map((question) => {
            if (!isRecord(question)) return null;
            const id = asString(question.id) ?? '';
            const options = Array.isArray(question.options) ? question.options : [];
            return (
              <div key={id} className="space-y-1">
                <div className="text-xs font-medium">{asString(question.question) ?? id}</div>
                {options.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {options.map((option) => {
                      if (!isRecord(option)) return null;
                      const label = asString(option.label) ?? '';
                      return (
                        <button
                          key={label}
                          type="button"
                          onClick={() => setAnswers((previous) => ({ ...previous, [id]: label }))}
                          className={[
                            'rounded-full border px-2 py-0.5 text-[11px]',
                            answers[id] === label
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-white/10 hover:bg-accent',
                          ].join(' ')}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
                <input
                  type={question.isSecret ? 'password' : 'text'}
                  value={answers[id] ?? ''}
                  onChange={(event) => setAnswers((previous) => ({ ...previous, [id]: event.target.value }))}
                  className="w-full rounded-[var(--radius-md)] border border-white/10 bg-background px-2 py-1 text-xs outline-none focus:border-primary"
                />
              </div>
            );
          })}
        </div>
      )}

      {!isApproval && !isToolInput && (
        <pre className="mb-2 max-h-24 overflow-auto rounded bg-background px-2 py-1.5 text-[10px] text-muted-foreground">
          {stringifyCompact(request.params)}
        </pre>
      )}

      <div className="flex flex-wrap justify-end gap-1">
        {isApproval ? (
          <>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void respond({ decision: 'accept' })}
              className="inline-flex items-center gap-1 rounded-[var(--radius-md)] bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              {t('codexChat.accept', { defaultValue: 'Accept' })}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void respond({ decision: 'acceptForSession' })}
              className="rounded-[var(--radius-md)] border border-white/10 px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {t('codexChat.acceptSession', { defaultValue: 'Accept session' })}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void respond({ decision: 'decline' })}
              className="rounded-[var(--radius-md)] border border-white/10 px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {t('codexChat.decline', { defaultValue: 'Decline' })}
            </button>
          </>
        ) : isToolInput ? (
          <button
            type="button"
            disabled={submitting}
            onClick={() =>
              void respond({
                answers: Object.fromEntries(
                  questions
                    .filter(isRecord)
                    .map((question) => {
                      const id = asString(question.id) ?? '';
                      return [id, { answers: [answers[id] ?? ''] }];
                    }),
                ),
              })
            }
            className="rounded-[var(--radius-md)] bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {t('codexChat.submit', { defaultValue: 'Submit' })}
          </button>
        ) : (
          <button
            type="button"
            disabled={submitting}
            onClick={() => void respond(unsupportedResponseFor(request.method, params))}
            className="rounded-[var(--radius-md)] border border-white/10 px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
          >
            {t('codexChat.respondUnsupported', { defaultValue: 'Respond unsupported' })}
          </button>
        )}
        <button
          type="button"
          disabled={submitting}
          onClick={() => void respond(cancelResponseFor(request.method))}
          className="rounded-[var(--radius-md)] border border-white/10 px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
        >
          {t('codexChat.cancel', { defaultValue: 'Cancel' })}
        </button>
      </div>
    </div>
  );
}

function belongsToCard(
  payload: CodexAppNotificationPayload | CodexAppRequestPayload,
  cardId: string,
  threadId: string | null,
): boolean {
  if (payload.cardId) return payload.cardId === cardId;
  const payloadThreadId =
    getString(payload.params, 'threadId') ??
    (isRecord(payload.params) ? getString(payload.params.thread, 'id') : null);
  return Boolean(threadId && payloadThreadId === threadId);
}

function itemsFromTurn(turn: unknown): unknown[] {
  if (!isRecord(turn) || !Array.isArray(turn.items)) return [];
  return turn.items;
}

function iconForItem(kind: CodexDisplayItemKind) {
  switch (kind) {
    case 'user':
      return MessageSquare;
    case 'assistant':
      return Bot;
    case 'reasoning':
      return Brain;
    case 'plan':
      return ListChecks;
    case 'command':
      return TerminalSquare;
    case 'file':
      return FileText;
    case 'tool':
      return Wrench;
    case 'search':
      return Search;
    default:
      return MessageSquare;
  }
}

function accentForItem(kind: CodexDisplayItemKind): string {
  switch (kind) {
    case 'assistant':
      return 'bg-primary/15 text-primary';
    case 'user':
      return 'bg-accent text-accent-foreground';
    case 'command':
      return 'bg-emerald-500/15 text-emerald-400';
    case 'file':
      return 'bg-amber-500/15 text-amber-400';
    case 'tool':
      return 'bg-sky-500/15 text-sky-400';
    case 'reasoning':
    case 'plan':
      return 'bg-violet-500/15 text-violet-300';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function systemItem(id: string, title: string, body: string): CodexDisplayItem {
  return {
    id: `system-${id}-${Date.now()}`,
    kind: 'system',
    title,
    body,
    raw: null,
  };
}

function requestKey(requestId: unknown): string {
  if (typeof requestId === 'string' || typeof requestId === 'number') return String(requestId);
  return stringifyCompact(requestId);
}

function requestTitle(method: string, t: ReturnType<typeof useTranslation<'terminal'>>['t']): string {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return t('codexChat.commandApproval', { defaultValue: 'Command approval' });
    case 'item/fileChange/requestApproval':
      return t('codexChat.fileApproval', { defaultValue: 'File change approval' });
    case 'item/tool/requestUserInput':
      return t('codexChat.toolInput', { defaultValue: 'Tool input' });
    case 'mcpServer/elicitation/request':
      return t('codexChat.elicitation', { defaultValue: 'MCP elicitation' });
    case 'item/tool/call':
      return t('codexChat.toolCall', { defaultValue: 'Tool call' });
    case 'item/permissions/requestApproval':
      return t('codexChat.permissionApproval', { defaultValue: 'Permission approval' });
    default:
      return t('codexChat.request', { defaultValue: 'Codex request' });
  }
}

function eventTitle(method: string): string {
  switch (method) {
    case 'thread/goal/updated':
      return 'Goal updated';
    case 'thread/goal/cleared':
      return 'Goal cleared';
    case 'context/compacted':
      return 'Context compacted';
    default:
      return method;
  }
}

function cancelResponseFor(method: string): unknown {
  if (method === 'mcpServer/elicitation/request') {
    return { action: 'cancel', content: null, _meta: null };
  }
  if (method === 'item/tool/call') {
    return {
      contentItems: [{ type: 'inputText', text: 'Cancelled by user.' }],
      success: false,
    };
  }
  if (method === 'item/permissions/requestApproval') {
    return { permissions: {}, scope: 'turn', strictAutoReview: false };
  }
  return { decision: 'cancel' };
}

function unsupportedResponseFor(method: string, params: Record<string, unknown>): unknown {
  if (method === 'mcpServer/elicitation/request') {
    return { action: 'decline', content: null, _meta: null };
  }
  if (method === 'item/permissions/requestApproval') {
    return {
      permissions: compactPermissionProfile(params.permissions),
      scope: 'turn',
      strictAutoReview: false,
    };
  }
  return {
    contentItems: [
      {
        type: 'inputText',
        text: 'ThreadTerm does not support this client-side tool yet.',
      },
    ],
    success: false,
  };
}

function compactPermissionProfile(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const next: Record<string, unknown> = {};
  if (value.network) next.network = value.network;
  if (value.fileSystem) next.fileSystem = value.fileSystem;
  return next;
}

function parseSkills(response: unknown): SkillOption[] {
  if (!isRecord(response) || !Array.isArray(response.data)) return [];
  return response.data.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.skills)) return [];
    return entry.skills
      .filter(isRecord)
      .map((skill) => ({
        name: asString(skill.name) ?? '',
        path: asString(skill.path) ?? '',
        description:
          asString(skill.shortDescription) ??
          (isRecord(skill.interface) ? asString(skill.interface.shortDescription) : null) ??
          asString(skill.description) ??
          '',
        enabled: skill.enabled !== false,
      }))
      .filter((skill) => skill.name && skill.path);
  });
}

function stringifyCompact(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

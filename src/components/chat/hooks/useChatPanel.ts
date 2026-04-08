import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../utils/api';
import { useSessionStatusStore } from '../../../stores/sessionStatusStore';
import { useToastStore } from '../../../stores/toastStore';
import type { PendingPermissionRequest } from '../../../stores/sessionStatusStore';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import type {
  ChatPhase,
  ChatMessage,
  ChatMessageKind,
  QueuedOutgoingMessage,
  FlatFileNode,
  FileTreeNode,
  ReferencedFile,
} from '../types/chatTypes';
import {
  MODEL_DEFAULTS,
  MODEL_OPTIONS,
  PROVIDER_THEME,
  CHAT_RESPONSE_TYPES,
  THINKING_MESSAGE_TYPES,
} from '../utils/chatConstants';
import { buildCommandList } from '../components/CommandSuggestions';
import { useCustomSlashCommands } from '../../../hooks/useCustomSlashCommands';
import {
  makeMessageId,
  flattenFiles,
  normalizeTreeNodes,
  extractText,
  normalizeDisplayText,
  shouldSkipNoisyMessage,
  toToolResultPreview,
  stripReferencedMentions,
  stripEmbeddedFileContext,
  scoreMentionCandidate,
  getProviderMessageType,
  getStorageKeyForModel,
  getSessionLaunchArgs,
  hasBypassLaunchArgs,
  inferCodexPermissionModeFromSession,
  getInitialProvider,
  inferProviderFromProjectSession,
} from '../utils/chatUtils';

type UseChatPanelProps = {
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  sendMessage: (message: unknown) => boolean;
  latestMessage: any | null;
  messageSequence: number;
  getBufferedMessagesSince: (sequence: number) => Array<{ sequence: number; message: any }>;
  externalMessageUpdate?: number;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (targetSessionId: string) => void;
};

// Keep a consumer position across ChatPanel unmount/remount so stream chunks that
// arrive while hidden can be replayed from WebSocketContext buffer.
let chatLastProcessedMessageSequence = 0;

export function useChatPanel({
  selectedProject,
  selectedSession,
  sendMessage,
  messageSequence,
  getBufferedMessagesSince,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onReplaceTemporarySession,
  onNavigateToSession,
}: UseChatPanelProps) {
  const { t } = useTranslation('chat');
  const { customCommands } = useCustomSlashCommands();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [phase, setPhase] = useState<ChatPhase>('idle');
  const [projectFiles, setProjectFiles] = useState<FlatFileNode[]>([]);
  const [projectFileTree, setProjectFileTree] = useState<FileTreeNode[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [isFilePickerOpen, setIsFilePickerOpen] = useState(false);
  const [filePickerQuery, setFilePickerQuery] = useState('');
  const [filePickerView, setFilePickerView] = useState<'search' | 'tree'>(() => {
    try {
      return localStorage.getItem('chat-file-picker-view') === 'search' ? 'search' : 'tree';
    } catch {
      return 'tree';
    }
  });
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>({});
  const [mentionQuery, setMentionQuery] = useState('');
  const [isMentionOpen, setIsMentionOpen] = useState(false);
  const [model, setModel] = useState<string>(MODEL_DEFAULTS.claude);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id ?? null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<{ used: number; total: number } | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [isCmdOpen, setIsCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState('');
  const [cmdActiveIndex, setCmdActiveIndex] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const filePickerRef = useRef<HTMLDivElement>(null);
  const filePickerToggleRef = useRef<HTMLButtonElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const contentBlockTypeByIndexRef = useRef<Record<number, string>>({});
  const currentSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  const suppressNextSessionSwitchResetRef = useRef<string | null>(null);
  const lastSyncedSelectionRef = useRef<{ projectName: string; sessionId: string | null } | null>(null);
  const queuedOutgoingRef = useRef<QueuedOutgoingMessage[]>([]);
  const isSendingRef = useRef(false);
  const isComposingRef = useRef(false);
  const suppressInputEchoRef = useRef<{ value: string; until: number } | null>(null);
  const dismissedComposerAssistRef = useRef<{ value: string; cursorPos: number } | null>(null);
  const lastLocalActivityAtRef = useRef<number>(Date.now());
  const initialScrollPendingRef = useRef(true);
  const shouldJumpToBottomRef = useRef(true);
  const lastProcessedSequenceRef = useRef<number>(chatLastProcessedMessageSequence);

  const [provider, setProvider] = useState<SessionProvider>(getInitialProvider);
  const resolvedSessionProvider = useMemo<SessionProvider | null>(() => {
    const inferred = inferProviderFromProjectSession(selectedSession?.id, selectedProject);
    if (inferred) {
      return inferred;
    }
    const raw = selectedSession?.__provider;
    if (raw === 'claude' || raw === 'codex') {
      return raw;
    }
    return null;
  }, [selectedProject, selectedSession?.__provider, selectedSession?.id]);
  const activeProvider = resolvedSessionProvider || provider;

  const mentionablePathSet = useMemo(() => new Set(projectFiles.map((file) => file.path)), [projectFiles]);
  const fileOnlyNodes = useMemo(() => projectFiles.filter((node) => node.type === 'file'), [projectFiles]);
  const allSelectableFilePaths = useMemo(() => fileOnlyNodes.map((node) => node.path), [fileOnlyNodes]);

  const mentionSuggestions = useMemo(() => {
    if (!isMentionOpen) {
      return [];
    }
    return projectFiles
      .map((entry) => ({
        entry,
        score: scoreMentionCandidate(entry, mentionQuery),
      }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.entry.type !== b.entry.type) return a.entry.type === 'directory' ? -1 : 1;
        if (a.entry.path.length !== b.entry.path.length) return a.entry.path.length - b.entry.path.length;
        return a.entry.path.localeCompare(b.entry.path);
      })
      .slice(0, 14)
      .map((item) => item.entry);
  }, [isMentionOpen, mentionQuery, projectFiles]);

  const cmdFilteredCommands = useMemo(() => {
    if (!isCmdOpen) return [];
    const commands = buildCommandList(activeProvider, customCommands);
    return commands.filter((c) =>
      c.cmd.toLowerCase().startsWith(`/${cmdQuery.toLowerCase()}`),
    );
  }, [isCmdOpen, cmdQuery, activeProvider, customCommands]);

  const filePickerSuggestions = useMemo(() => {
    const query = filePickerQuery.trim().toLowerCase();
    const filtered = query
      ? fileOnlyNodes.filter((file) => file.path.toLowerCase().includes(query))
      : fileOnlyNodes;
    return filtered.slice(0, 300);
  }, [fileOnlyNodes, filePickerQuery]);

  const phaseLabel = useMemo(() => {
    if (phase === 'thinking') return t('thinking.title');
    if (phase === 'tool') return t('tools.settings');
    if (phase === 'writing') return 'Generating response...';
    if (phase === 'done') return 'Completed';
    return '';
  }, [phase, t]);

  const providerTheme = useMemo(() => PROVIDER_THEME[activeProvider] || PROVIDER_THEME.claude, [activeProvider]);
  const canSwitchModelInSession = true;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (behavior === 'auto' && messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, []);

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const patchMessage = useCallback((messageId: string, updater: (msg: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((msg) => (msg.id === messageId ? updater(msg) : msg)));
  }, []);

  const appendAssistantText = useCallback((text: string) => {
    if (!text) return;
    lastLocalActivityAtRef.current = Date.now();

    setMessages((prev) => {
      let assistantId = activeAssistantMessageIdRef.current;
      if (!assistantId) {
        assistantId = makeMessageId();
        activeAssistantMessageIdRef.current = assistantId;
      }

      const existingIndex = prev.findIndex((msg) => msg.id === assistantId);
      if (existingIndex === -1) {
        return [
          ...prev,
          {
            id: assistantId,
            kind: 'assistant',
            text,
            provider: activeProvider,
            timestamp: Date.now(),
            streaming: true,
          },
        ];
      }

      const next = [...prev];
      const existing = next[existingIndex];
      next[existingIndex] = {
        ...existing,
        kind: 'assistant',
        text: `${existing.text}${text}`,
        streaming: true,
        provider: activeProvider,
      };
      return next;
    });
  }, [activeProvider]);

  const completeAssistant = useCallback(() => {
    const assistantId = activeAssistantMessageIdRef.current;
    if (!assistantId) return;
    setMessages((prev) => {
      const idx = prev.findIndex((msg) => msg.id === assistantId);
      if (idx === -1) return prev;
      const existing = prev[idx];
      if (!existing.text.trim()) {
        return prev.filter((msg) => msg.id !== assistantId);
      }
      const next = [...prev];
      next[idx] = { ...existing, streaming: false };
      return next;
    });
    activeAssistantMessageIdRef.current = null;
  }, []);

  const addSystemEventMessage = useCallback((kind: ChatMessageKind, text: string) => {
    if (!text) return;
    appendMessage({
      id: makeMessageId(),
      kind,
      text,
      provider: activeProvider,
      timestamp: Date.now(),
    });
  }, [activeProvider, appendMessage]);

  const updateComposerAssistState = useCallback((nextValue: string, textarea: HTMLTextAreaElement | null) => {
    const cursorPos = textarea?.selectionStart ?? nextValue.length;
    const beforeCursor = nextValue.slice(0, cursorPos);
    const mentionMatch = beforeCursor.match(/@([^\s@]*)$/);
    const dismissal = dismissedComposerAssistRef.current;

    if (dismissal && (dismissal.value !== nextValue || dismissal.cursorPos !== cursorPos)) {
      dismissedComposerAssistRef.current = null;
    }

    if (mentionMatch) {
      if (
        dismissedComposerAssistRef.current &&
        dismissedComposerAssistRef.current.value === nextValue &&
        dismissedComposerAssistRef.current.cursorPos === cursorPos
      ) {
        setIsMentionOpen(false);
        setMentionQuery('');
        return;
      }

      setMentionQuery(mentionMatch[1] || '');
      setIsMentionOpen(true);
      setIsFilePickerOpen(false);
      return;
    }

    setIsMentionOpen(false);
    setMentionQuery('');
  }, []);

  const clearComposerInput = useCallback((rawValue: string) => {
    suppressInputEchoRef.current = {
      value: rawValue,
      until: Date.now() + 800,
    };

    const clearIfEcho = () => {
      const textarea = inputRef.current;
      if (!textarea) {
        return;
      }
      if (textarea.value === rawValue) {
        textarea.value = '';
        setInput('');
      }
    };

    dismissedComposerAssistRef.current = null;
    setInput('');
    setAttachedFiles([]);
    setIsFilePickerOpen(false);
    setFilePickerQuery('');
    setIsMentionOpen(false);
    setMentionQuery('');

    const textarea = inputRef.current;
    if (textarea) {
      textarea.value = '';
      textarea.setSelectionRange(0, 0);
    }

    requestAnimationFrame(clearIfEcho);
    setTimeout(clearIfEcho, 220);
  }, []);

  const loadProjectFiles = useCallback(async () => {
    setIsLoadingFiles(true);
    try {
      const response = await api.getFiles(selectedProject.name);
      if (!response.ok) {
        setProjectFiles([]);
        setProjectFileTree([]);
        setExpandedDirectories({});
        return;
      }
      const data = await response.json();
      const normalizedTree = normalizeTreeNodes(Array.isArray(data) ? data : []);
      const flattened = flattenFiles(normalizedTree);
      const rootExpanded = normalizedTree
        .filter((node) => node.type === 'directory')
        .reduce<Record<string, boolean>>((acc, node) => {
          acc[node.path] = true;
          return acc;
        }, {});

      setProjectFiles(flattened);
      setProjectFileTree(normalizedTree);
      setExpandedDirectories((prev) => ({ ...rootExpanded, ...prev }));
    } catch (error) {
      console.error('[Chat] Failed to load project files:', error);
      setProjectFiles([]);
      setProjectFileTree([]);
      setExpandedDirectories({});
    } finally {
      setIsLoadingFiles(false);
    }
  }, [selectedProject.name]);

  const normalizeHistoryMessages = useCallback((rawMessages: any[], historyProvider: SessionProvider): ChatMessage[] => {
    const normalized: ChatMessage[] = [];

    for (const item of rawMessages) {
      const timestamp = item?.timestamp ? new Date(item.timestamp).getTime() : Date.now();

      if (item?.type && THINKING_MESSAGE_TYPES.has(String(item.type).toLowerCase())) {
        // Thinking traces are treated as transient state in chat mode.
        continue;
      }

      if (item?.type === 'tool_use') {
        const toolName = item?.toolName || 'Tool';
        const toolInput = normalizeDisplayText(item?.toolInput);
        normalized.push({
          id: makeMessageId(),
          kind: 'tool',
          text: `${toolName}${toolInput ? `\n${toolInput}` : ''}`,
          provider: historyProvider,
          timestamp,
        });
        continue;
      }

      if (item?.type === 'tool_result') {
        const output = toToolResultPreview(item?.output || item?.toolResult?.content);
        normalized.push({
          id: makeMessageId(),
          kind: 'tool',
          text: output ? `Tool result\n${output}` : 'Tool result',
          provider: historyProvider,
          timestamp,
        });
        continue;
      }

      const rawContent =
        item?.message?.content ??
        item?.content?.content ??
        item?.content?.message?.content ??
        item?.content;
      const role = item?.message?.role || item?.role || item?.content?.role || item?.content?.message?.role;

      if (Array.isArray(rawContent)) {
        const textChunks: string[] = [];

        for (const block of rawContent) {
          const blockType = block?.type;

          if (blockType && THINKING_MESSAGE_TYPES.has(String(blockType).toLowerCase())) {
            // Skip persisted thinking blocks in chat transcript view.
            continue;
          }

          if (blockType === 'tool_use') {
            const toolName = block?.name || 'Tool';
            const toolInput = normalizeDisplayText(block?.input);
            normalized.push({
              id: makeMessageId(),
              kind: 'tool',
              text: `${toolName}${toolInput ? `\n${toolInput}` : ''}`,
              provider: historyProvider,
              timestamp,
            });
            continue;
          }

          if (blockType === 'tool_result') {
            const output = toToolResultPreview(block?.content ?? block?.output ?? block);
            normalized.push({
              id: makeMessageId(),
              kind: 'tool',
              text: output ? `Tool result\n${output}` : 'Tool result',
              provider: historyProvider,
              timestamp,
            });
            continue;
          }

          const text = normalizeDisplayText(block);
          if (text) {
            textChunks.push(text);
          }
        }

        const combinedText = textChunks.join('\n\n').trim();
        if (!combinedText || shouldSkipNoisyMessage(combinedText)) {
          continue;
        }

        const normalizedText = role === 'user' ? stripEmbeddedFileContext(combinedText) : combinedText;
        if (!normalizedText || shouldSkipNoisyMessage(normalizedText)) {
          continue;
        }

        normalized.push({
          id: makeMessageId(),
          kind: role === 'user' ? 'user' : 'assistant',
          text: normalizedText,
          provider: historyProvider,
          timestamp,
        });
        continue;
      }

      const content = normalizeDisplayText(rawContent);

      const normalizedText = role === 'user' ? stripEmbeddedFileContext(content) : content;

      if (!normalizedText || shouldSkipNoisyMessage(normalizedText)) {
        continue;
      }

      normalized.push({
        id: makeMessageId(),
        kind: role === 'user' ? 'user' : 'assistant',
        text: normalizedText,
        provider: historyProvider,
        timestamp,
      });
    }

    return normalized;
  }, []);

  const loadSessionHistory = useCallback(async () => {
    if (!selectedSession?.id) {
      setMessages([]);
      setTokenBudget(null);
      return;
    }

    const sessionProvider = selectedSession.__provider;
    const historyProvider: SessionProvider =
      sessionProvider === 'claude' || sessionProvider === 'codex'
        ? sessionProvider
        : activeProvider;

    setHistoryLoading(true);
    try {
      const response = await api.sessionMessages(
        selectedProject.name,
        selectedSession.id,
        null,
        0,
        historyProvider,
      );

      if (!response.ok) {
        setMessages([]);
        return;
      }

      const payload = await response.json();
      const rawMessages = payload?.messages || payload?.session?.messages || [];
      setMessages(normalizeHistoryMessages(Array.isArray(rawMessages) ? rawMessages : [], historyProvider));
    } catch (error) {
      console.error('[Chat] Failed to load session history:', error);
      setMessages([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [
    activeProvider,
    normalizeHistoryMessages,
    selectedProject.name,
    selectedSession?.__provider,
    selectedSession?.id,
  ]);

  const finishRequest = useCallback((nextPhase: ChatPhase = 'done', sessionIdOverride?: string | null) => {
    setIsSending(false);
    isSendingRef.current = false;
    setPhase(nextPhase);
    completeAssistant();
    const targetSessionId = sessionIdOverride || currentSessionIdRef.current;
    if (targetSessionId) {
      onSessionNotProcessing?.(targetSessionId);
      onSessionInactive?.(targetSessionId);
    }
  }, [completeAssistant, onSessionInactive, onSessionNotProcessing]);

  const [pendingPermission, setPendingPermissionLocal] = useState<PendingPermissionRequest | null>(() => {
    const sid = selectedSession?.id;
    return sid ? (useSessionStatusStore.getState().pendingPermissions[sid] ?? null) : null;
  });

  useEffect(() => {
    return useSessionStatusStore.subscribe((state) => {
      const sid = currentSessionIdRef.current;
      setPendingPermissionLocal(sid ? (state.pendingPermissions[sid] ?? null) : null);
    });
  }, []);

  const handlePermissionResponse = useCallback((allow: boolean, answer?: string) => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return;

    const pending = useSessionStatusStore.getState().pendingPermissions[sessionId];
    if (!pending) return;

    useSessionStatusStore.getState().clearPendingPermission(sessionId);
    useSessionStatusStore.getState().setProcessing(sessionId);

    sendMessage({
      type: 'claude-permission-response',
      requestId: pending.requestId,
      allow,
      ...(answer !== undefined && { message: answer }),
    });
  }, [sendMessage]);

  const handleLatestMessage = useCallback((message: any) => {
    if (!message || typeof message !== 'object') {
      return;
    }

    const messageType = message.type as string | undefined;
    if (!messageType) {
      return;
    }

    if (messageType === 'session-created' && typeof message.sessionId === 'string') {
      currentSessionIdRef.current = message.sessionId;
      suppressNextSessionSwitchResetRef.current = message.sessionId;
      setCurrentSessionId(message.sessionId);
      onReplaceTemporarySession?.(message.sessionId);
      onNavigateToSession?.(message.sessionId);
      onSessionActive?.(message.sessionId);
      onSessionProcessing?.(message.sessionId);
      return;
    }

    if (messageType === 'claude-permission-request' && typeof message.requestId === 'string') {
      const permSessionId = typeof message.sessionId === 'string'
        ? message.sessionId
        : currentSessionIdRef.current;
      // Status + pending permission are handled by useSessionStatusTracker at App level
      // Just add a chat message so the user sees context in the conversation
      const toolName = typeof message.toolName === 'string' ? message.toolName : 'tool';
      if (toolName !== 'AskUserQuestion') {
        addSystemEventMessage('status', t('permission.requestPending', { tool: toolName }));
      }
      return;
    }

    if (messageType === 'claude-permission-cancelled') {
      const reason = typeof message.reason === 'string' && message.reason
        ? message.reason
        : 'unknown';
      addSystemEventMessage('status', `Permission request cancelled (${reason}).`);
      return;
    }

    const activeSessionId = currentSessionIdRef.current;
    if (
      message.sessionId &&
      activeSessionId &&
      message.sessionId !== activeSessionId
    ) {
      const isTemporarySession = activeSessionId.startsWith('new-session-');
      const canPromoteTemporarySession =
        isSending &&
        isTemporarySession &&
        CHAT_RESPONSE_TYPES.has(messageType);

      if (canPromoteTemporarySession) {
        currentSessionIdRef.current = message.sessionId;
        suppressNextSessionSwitchResetRef.current = message.sessionId;
        setCurrentSessionId(message.sessionId);
        onReplaceTemporarySession?.(message.sessionId);
        onNavigateToSession?.(message.sessionId);
        onSessionActive?.(message.sessionId);
        onSessionProcessing?.(message.sessionId);
      } else {
        return;
      }
    }

    if (messageType === 'claude-response') {
      const payload = message.data;
      const payloadType = payload?.type;

      if (payloadType === 'content_block_delta') {
        const blockIndex = typeof payload?.index === 'number' ? payload.index : null;
        const activeBlockType = blockIndex !== null ? contentBlockTypeByIndexRef.current[blockIndex] : '';
        const deltaType = payload?.delta?.type;
        if (
          activeBlockType === 'thinking' ||
          activeBlockType === 'redacted_thinking' ||
          deltaType === 'thinking_delta' ||
          deltaType === 'signature_delta'
        ) {
          setPhase('thinking');
          return;
        }
        const text = extractText(payload?.delta);
        if (text) {
          setPhase('writing');
          appendAssistantText(text);
        }
        return;
      }

      if (payloadType === 'content_block_start') {
        const blockType = payload?.content_block?.type;
        const blockIndex = typeof payload?.index === 'number' ? payload.index : null;
        if (blockIndex !== null && typeof blockType === 'string') {
          contentBlockTypeByIndexRef.current[blockIndex] = blockType;
        }
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          setPhase('thinking');
          return;
        }
        if (blockType === 'tool_use') {
          setPhase('tool');
          const toolName = payload?.content_block?.name || 'Tool';
          const toolInput = extractText(payload?.content_block?.input);
          addSystemEventMessage('tool', `${toolName}${toolInput ? `\n${toolInput}` : ''}`);
          return;
        }
      }

      if (payloadType === 'content_block_stop') {
        const blockIndex = typeof payload?.index === 'number' ? payload.index : null;
        if (blockIndex !== null) {
          delete contentBlockTypeByIndexRef.current[blockIndex];
        }
        return;
      }

      if (payloadType === 'message_stop') {
        contentBlockTypeByIndexRef.current = {};
        return;
      }

      if (payloadType === 'assistant' || payload?.message?.role === 'assistant') {
        const text = extractText(payload?.message?.content ?? payload?.content);
        if (text) {
          setPhase('writing');
          appendAssistantText(text);
        }
        return;
      }

      if (payloadType === 'tool_use') {
        setPhase('tool');
        addSystemEventMessage('tool', `${payload?.name || 'Tool'}\n${extractText(payload?.input)}`);
        return;
      }

      if (payloadType === 'tool_result') {
        setPhase('tool');
        addSystemEventMessage('tool', `Tool result\n${extractText(payload?.content)}`);
        return;
      }

      // Ignore unknown Claude payload variants in chat view to avoid leaking internal traces.
      return;
    }

    if (messageType === 'codex-response') {
      const payload = message.data;
      const itemType = payload?.itemType;
      const normalizedItemType = typeof itemType === 'string' ? itemType.toLowerCase() : '';
      const normalizedPayloadType = typeof payload?.type === 'string' ? payload.type.toLowerCase() : '';

      if (payload?.type === 'turn_started') {
        setPhase('thinking');
        return;
      }

      if (
        normalizedItemType.includes('reasoning') ||
        normalizedItemType.includes('analysis') ||
        normalizedPayloadType.includes('reasoning') ||
        normalizedPayloadType.includes('analysis')
      ) {
        setPhase('thinking');
        return;
      }

      if (itemType === 'agent_message') {
        setPhase('writing');
        const text = extractText(payload?.message?.content);
        if (text) {
          appendAssistantText(text);
        }
        return;
      }

      if (itemType === 'command_execution' || itemType === 'mcp_tool_call' || itemType === 'file_change') {
        setPhase('tool');
        const details = extractText(payload?.output || payload?.result || payload?.changes);
        addSystemEventMessage('tool', `${itemType}${details ? `\n${details}` : ''}`);
        return;
      }

      if (itemType === 'web_search' || itemType === 'todo_list' || itemType === 'error') {
        setPhase('tool');
        const details = extractText(payload?.output || payload?.result || payload?.items || payload?.message);
        addSystemEventMessage('tool', `${itemType}${details ? `\n${details}` : ''}`);
      }

      // Ignore unknown Codex payload variants in chat view to avoid leaking internal traces.
      return;
    }

    if (messageType === 'token-budget') {
      const data = message.data;
      if (data && typeof data.used === 'number' && typeof data.total === 'number') {
        setTokenBudget({ used: data.used, total: data.total });
      }
      return;
    }

    if (
      messageType === 'claude-complete' ||
      messageType === 'codex-complete'
    ) {
      contentBlockTypeByIndexRef.current = {};
      finishRequest('done', message.sessionId || currentSessionIdRef.current);
      return;
    }

    if (
      messageType === 'claude-error' ||
      messageType === 'codex-error' ||
      messageType === 'error'
    ) {
      contentBlockTypeByIndexRef.current = {};
      const text = message.error || message.message || 'Request failed.';
      addSystemEventMessage('error', String(text));
      useToastStore.getState().addToast(String(text), 'error');
      finishRequest('idle', message.sessionId || currentSessionIdRef.current);
    }
  }, [
    addSystemEventMessage,
    appendAssistantText,
    finishRequest,
    onNavigateToSession,
    onReplaceTemporarySession,
    onSessionActive,
    onSessionProcessing,
    sendMessage,
  ]);

  const shouldProcessBufferedMessage = useCallback((message: any): boolean => {
    if (!message || typeof message !== 'object') {
      return false;
    }

    const messageType = typeof message.type === 'string' ? message.type : '';
    if (!messageType) {
      return false;
    }

    const messageSessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
    const activeSessionId = currentSessionIdRef.current;

    if (messageType === 'session-created') {
      return !activeSessionId || activeSessionId.startsWith('new-session-');
    }

    if (!messageSessionId) {
      return true;
    }

    if (!activeSessionId) {
      return false;
    }

    if (messageSessionId === activeSessionId) {
      return true;
    }

    return activeSessionId.startsWith('new-session-') && CHAT_RESPONSE_TYPES.has(messageType);
  }, []);

  const buildPromptWithFileContext = useCallback(async (rawInput: string, references: string[]) => {
    if (!references.length) {
      return { prompt: rawInput, files: [] as ReferencedFile[] };
    }

    const normalizedReferences = Array.from(
      new Set(
        references
          .map((filePath) => filePath.trim())
          .filter((filePath) => filePath.length > 0),
      ),
    );

    if (!normalizedReferences.length) {
      return { prompt: rawInput, files: [] as ReferencedFile[] };
    }

    const fileRefs: ReferencedFile[] = normalizedReferences.map((path) => ({ path, loaded: true }));
    const referenceLines = normalizedReferences.map((path) => `- ${path}`);
    const prompt = `${rawInput}

Referenced paths:
${referenceLines.join('\n')}

Use these as file path references only. Read file contents from the workspace when needed.`;

    return { prompt, files: fileRefs };
  }, []);

  const sendChatMessage = useCallback(async (queuedDraft?: QueuedOutgoingMessage) => {
    const draftInput = queuedDraft?.rawInput ?? input;
    if (!draftInput.trim()) {
      return;
    }

    const activeMessageProvider = queuedDraft?.provider ?? activeProvider;
    const activeModel = queuedDraft?.model ?? model;
    const activeAttachedFiles = queuedDraft?.attachedFiles ?? attachedFiles;
    lastLocalActivityAtRef.current = Date.now();
    const rawInput = queuedDraft?.rawInput ?? draftInput.trim();
    const mentionPaths = queuedDraft
      ? []
      : Array.from(rawInput.matchAll(/@([^\s@]+)/g))
        .map((match) => match[1])
        .filter((path) => mentionablePathSet.has(path));
    const referencePaths = queuedDraft
      ? queuedDraft.referencePaths
      : Array.from(new Set([...activeAttachedFiles, ...mentionPaths]));
    const displayInput = queuedDraft?.displayInput || stripReferencedMentions(rawInput, referencePaths) || rawInput;
    const userMessageId = queuedDraft?.userMessageId || makeMessageId();

    if (!queuedDraft) {
      appendMessage({
        id: userMessageId,
        kind: 'user',
        text: displayInput,
        provider: activeMessageProvider,
        timestamp: Date.now(),
        files: referencePaths.length
          ? referencePaths.map((path) => ({ path, loaded: true }))
          : undefined,
      });
    }

    if (!queuedDraft) {
      // Clear composer immediately to keep send interaction snappy even when file context loading is slow.
      clearComposerInput(draftInput);
    }

    if (!queuedDraft && isSending) {
      queuedOutgoingRef.current.push({
        rawInput,
        displayInput,
        referencePaths,
        userMessageId,
        attachedFiles: [...activeAttachedFiles],
        provider: activeMessageProvider,
        model: activeModel,
      });
      return;
    }

    const { prompt, files } = await buildPromptWithFileContext(displayInput, referencePaths);
    patchMessage(userMessageId, (msg) => ({ ...msg, files }));

    const workingDirectory = selectedProject.fullPath || selectedProject.path || '';
    const options: Record<string, unknown> = {
      cwd: workingDirectory,
      projectPath: workingDirectory,
    };

    if (typeof activeModel === 'string' && activeModel.trim().length > 0) {
      options.model = activeModel.trim();
    }

    const activeSessionId = currentSessionIdRef.current;
    if (activeSessionId && !activeSessionId.startsWith('new-session-')) {
      options.sessionId = activeSessionId;
    }

    const sessionLaunchArgs = getSessionLaunchArgs(selectedSession, activeMessageProvider);
    if (sessionLaunchArgs.length > 0) {
      options.sessionArgs = sessionLaunchArgs;
    }

    const forceBypassFromLaunchArgs = hasBypassLaunchArgs(selectedSession, activeMessageProvider);
    if (forceBypassFromLaunchArgs) {
      options.permissionMode = 'bypassPermissions';
    } else if (activeMessageProvider === 'codex') {
      options.permissionMode = inferCodexPermissionModeFromSession(selectedSession);
    }

    const sent = sendMessage({
      type: getProviderMessageType(activeMessageProvider),
      command: prompt,
      options,
    });

    if (!sent) {
      setPhase('idle');
      setIsSending(false);
      isSendingRef.current = false;
      activeAssistantMessageIdRef.current = null;
      addSystemEventMessage('error', 'WebSocket disconnected. Please wait for reconnection and try again.');
      return;
    }

    setIsSending(true);
    isSendingRef.current = true;
    setPhase('thinking');

    const assistantMessageId = makeMessageId();
    activeAssistantMessageIdRef.current = assistantMessageId;
    appendMessage({
      id: assistantMessageId,
      kind: 'assistant',
      text: '',
      provider: activeMessageProvider,
      timestamp: Date.now(),
      streaming: true,
    });

    const sessionForTracking = (options.sessionId as string) || currentSessionIdRef.current;
    if (sessionForTracking) {
      onSessionActive?.(sessionForTracking);
      onSessionProcessing?.(sessionForTracking);
    }
  }, [
    appendMessage,
    attachedFiles,
    buildPromptWithFileContext,
    clearComposerInput,
    input,
    isSending,
    model,
    addSystemEventMessage,
    patchMessage,
    onSessionActive,
    onSessionProcessing,
    mentionablePathSet,
    activeProvider,
    selectedSession,
    sendMessage,
  ]);

  const abortCurrentRequest = useCallback(() => {
    if (!isSending) return;
    if (!currentSessionId) {
      isSendingRef.current = false;
      finishRequest('idle');
      return;
    }
    sendMessage({
      type: 'abort-session',
      sessionId: currentSessionId,
      provider: activeProvider,
    });
    isSendingRef.current = false;
    finishRequest('idle');
  }, [activeProvider, currentSessionId, finishRequest, isSending, sendMessage]);

  const handleSelectMention = useCallback((filePath: string) => {
    setAttachedFiles((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));

    const textarea = inputRef.current;
    if (!textarea) {
      setInput((prev) => prev.replace(/@([^\s@]*)$/, '').trimEnd());
      setIsMentionOpen(false);
      return;
    }

    const cursorPos = textarea.selectionStart ?? input.length;
    const before = input.slice(0, cursorPos).replace(/@([^\s@]*)$/, '');
    const after = input.slice(cursorPos);
    const nextValue = `${before}${after}`
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^\s+/g, '');
    dismissedComposerAssistRef.current = null;
    setInput(nextValue);
    setIsMentionOpen(false);
    setMentionQuery('');

    requestAnimationFrame(() => {
      const nextCursor = before.length;
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  }, [input]);

  const toggleAttachedFile = useCallback((filePath: string) => {
    setAttachedFiles((prev) => (
      prev.includes(filePath)
        ? prev.filter((item) => item !== filePath)
        : [...prev, filePath]
    ));
  }, []);

  const toggleDirectoryExpanded = useCallback((directoryPath: string) => {
    setExpandedDirectories((prev) => ({
      ...prev,
      [directoryPath]: !prev[directoryPath],
    }));
  }, []);

  const selectAllFromCurrentPickerView = useCallback(() => {
    const selectable = filePickerView === 'tree'
      ? allSelectableFilePaths
      : filePickerSuggestions.map((item) => item.path);

    if (!selectable.length) {
      return;
    }

    setAttachedFiles((prev) => Array.from(new Set([...prev, ...selectable])));
  }, [allSelectableFilePaths, filePickerSuggestions, filePickerView]);

  // --- Textarea event handlers ---

  const handleInputChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    const suppression = suppressInputEchoRef.current;
    if (suppression && Date.now() < suppression.until && nextValue === suppression.value) {
      return;
    }
    suppressInputEchoRef.current = null;
    setInput(nextValue);
    updateComposerAssistState(nextValue, event.target);

    // Slash command detection: show suggestions when input starts with "/"
    if (nextValue.startsWith('/')) {
      const query = nextValue.slice(1).split(/\s/)[0] ?? '';
      // Only show if user hasn't typed a space yet (still completing the command)
      if (!nextValue.slice(1).includes(' ')) {
        setCmdQuery(query);
        setCmdActiveIndex(0);
        setIsCmdOpen(true);
      } else {
        setIsCmdOpen(false);
      }
    } else {
      setIsCmdOpen(false);
    }
  }, [updateComposerAssistState]);

  const handleSelectCommand = useCallback((cmd: string) => {
    setInput(cmd + ' ');
    setIsCmdOpen(false);
    setCmdQuery('');
    setCmdActiveIndex(0);
    // Focus and move cursor to end
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        const len = cmd.length + 1;
        el.setSelectionRange(len, len);
      }
    });
  }, []);

  const handleInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current || event.nativeEvent.isComposing) {
      return;
    }

    // Command suggestions keyboard handling
    if (isCmdOpen && cmdFilteredCommands.length > 0) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsCmdOpen(false);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCmdActiveIndex((prev) => (prev + 1) % cmdFilteredCommands.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCmdActiveIndex((prev) => (prev - 1 + cmdFilteredCommands.length) % cmdFilteredCommands.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const selected = cmdFilteredCommands[cmdActiveIndex] || cmdFilteredCommands[0];
        if (selected) {
          // Custom commands insert their prompt template instead of the /command
          handleSelectCommand(selected.isCustom && selected.prompt ? selected.prompt : selected.cmd);
        }
        return;
      }
    }

    if (event.key === 'Escape' && isMentionOpen) {
      event.preventDefault();
      dismissedComposerAssistRef.current = {
        value: event.currentTarget.value,
        cursorPos: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
      };
      setIsMentionOpen(false);
      setMentionQuery('');
      return;
    }

    if (isMentionOpen && mentionSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionActiveIndex((prev) => (prev + 1) % mentionSuggestions.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionActiveIndex((prev) => (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const selected = mentionSuggestions[mentionActiveIndex] || mentionSuggestions[0];
        if (selected) {
          handleSelectMention(selected.path);
        }
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      setIsFilePickerOpen(false);
      setIsCmdOpen(false);
      void sendChatMessage();
    }
  }, [cmdActiveIndex, cmdFilteredCommands, handleSelectCommand, handleSelectMention, isCmdOpen, isMentionOpen, mentionActiveIndex, mentionSuggestions, sendChatMessage]);

  const handleInputSelect = useCallback((event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    updateComposerAssistState(event.currentTarget.value, event.currentTarget);
  }, [updateComposerAssistState]);

  const handleInputFocus = useCallback((event: React.FocusEvent<HTMLTextAreaElement>) => {
    setIsFilePickerOpen(false);
    updateComposerAssistState(event.currentTarget.value, event.currentTarget);
  }, [updateComposerAssistState]);

  const handleInputBlur = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    requestAnimationFrame(() => {
      if (window.scrollX !== 0) {
        window.scrollTo({ left: 0, top: window.scrollY, behavior: 'auto' });
      }
    });
  }, []);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
  }, []);

  // --- Effects ---

  useEffect(() => {
    if (resolvedSessionProvider) {
      setProvider((prev) => (prev === resolvedSessionProvider ? prev : resolvedSessionProvider));
    }
  }, [resolvedSessionProvider]);

  useEffect(() => {
    localStorage.setItem('selected-provider', activeProvider);
    const storedModel = localStorage.getItem(getStorageKeyForModel(activeProvider));
    setModel(storedModel || MODEL_DEFAULTS[activeProvider]);
  }, [activeProvider]);

  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);

  useEffect(() => {
    localStorage.setItem(getStorageKeyForModel(activeProvider), model);
  }, [activeProvider, model]);

  useEffect(() => {
    localStorage.setItem('chat-file-picker-view', filePickerView);
  }, [filePickerView]);

  useEffect(() => {
    if (!isFilePickerOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const targetNode = event.target as Node | null;
      if (!targetNode) {
        return;
      }
      if (filePickerRef.current?.contains(targetNode)) {
        return;
      }
      if (filePickerToggleRef.current?.contains(targetNode)) {
        return;
      }
      setIsFilePickerOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [isFilePickerOpen]);

  useEffect(() => {
    const options = MODEL_OPTIONS[activeProvider] || [];
    if (!options.some((item) => item.value === model)) {
      setModel(MODEL_DEFAULTS[activeProvider]);
    }
  }, [activeProvider, model]);

  useEffect(() => {
    const selectedId = selectedSession?.id ?? null;
    const selection = { projectName: selectedProject.name, sessionId: selectedId };
    const previousSelection = lastSyncedSelectionRef.current;
    const isProjectChanged = !previousSelection || previousSelection.projectName !== selection.projectName;
    const isSessionChanged = !previousSelection || previousSelection.sessionId !== selection.sessionId;

    if (!isProjectChanged && !isSessionChanged) {
      return;
    }

    const isLikelyTransientSessionLoss =
      !selectedId &&
      !isProjectChanged &&
      !!currentSessionIdRef.current &&
      (isSendingRef.current || activeAssistantMessageIdRef.current !== null);

    if (isLikelyTransientSessionLoss) {
      return;
    }

    // Keep current in-flight chat state when route updates to the just-created session.
    if (selectedId && suppressNextSessionSwitchResetRef.current === selectedId) {
      suppressNextSessionSwitchResetRef.current = null;
      currentSessionIdRef.current = selectedId;
      setCurrentSessionId(selectedId);
      lastSyncedSelectionRef.current = selection;
      return;
    }

    lastSyncedSelectionRef.current = selection;
    initialScrollPendingRef.current = true;
    shouldJumpToBottomRef.current = true;
    currentSessionIdRef.current = selectedId;
    setCurrentSessionId(selectedId);
    activeAssistantMessageIdRef.current = null;
    contentBlockTypeByIndexRef.current = {};
    queuedOutgoingRef.current = [];
    setIsSending(false);
    isSendingRef.current = false;
    setPhase('idle');
    setHistoryLoading(Boolean(selectedId));
    void loadSessionHistory();
  }, [loadSessionHistory, selectedProject.name, selectedSession?.id]);

  // Pre-fill input from session template if a pending template message exists
  useEffect(() => {
    const pending = window.__pendingTemplateMessage;
    if (!pending) return;
    delete window.__pendingTemplateMessage;
    // Small delay to ensure the textarea is mounted
    const timer = setTimeout(() => {
      setInput(pending);
      const textarea = inputRef.current;
      if (textarea) {
        textarea.value = pending;
        textarea.setSelectionRange(pending.length, pending.length);
        textarea.focus();
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedSession?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Do not auto-reload current session history on external project updates.
  // Streaming state in chat is authoritative while this panel is active; reloading
  // can race against persistence and temporarily hide local/streamed messages.

  useEffect(() => {
    void loadProjectFiles();
  }, [loadProjectFiles]);

  useEffect(() => {
    if (!isMentionOpen || mentionSuggestions.length === 0) {
      setMentionActiveIndex(0);
      return;
    }

    setMentionActiveIndex((prev) => {
      if (prev < 0) return 0;
      if (prev >= mentionSuggestions.length) return mentionSuggestions.length - 1;
      return prev;
    });
  }, [isMentionOpen, mentionSuggestions]);

  useEffect(() => {
    const normalizedSequence = Number.isFinite(messageSequence) && messageSequence > 0
      ? Math.floor(messageSequence)
      : 0;

    if (lastProcessedSequenceRef.current > normalizedSequence) {
      lastProcessedSequenceRef.current = 0;
      chatLastProcessedMessageSequence = 0;
    }

    if (normalizedSequence <= lastProcessedSequenceRef.current) {
      return;
    }

    const pendingMessages = getBufferedMessagesSince(lastProcessedSequenceRef.current);
    if (!pendingMessages.length) {
      lastProcessedSequenceRef.current = normalizedSequence;
      chatLastProcessedMessageSequence = normalizedSequence;
      return;
    }

    for (const bufferedMessage of pendingMessages) {
      if (!bufferedMessage || typeof bufferedMessage !== 'object') {
        continue;
      }

      const sequence = Number.isFinite(bufferedMessage.sequence)
        ? Math.floor(bufferedMessage.sequence)
        : 0;
      if (sequence <= lastProcessedSequenceRef.current) {
        continue;
      }

      if (shouldProcessBufferedMessage(bufferedMessage.message)) {
        handleLatestMessage(bufferedMessage.message);
      }
      lastProcessedSequenceRef.current = sequence;
    }

    chatLastProcessedMessageSequence = lastProcessedSequenceRef.current;
  }, [getBufferedMessagesSince, handleLatestMessage, messageSequence, shouldProcessBufferedMessage]);

  useEffect(() => {
    return () => {
      if (lastProcessedSequenceRef.current > chatLastProcessedMessageSequence) {
        chatLastProcessedMessageSequence = lastProcessedSequenceRef.current;
      }
    };
  }, []);

  useEffect(() => {
    if (isSending) {
      return;
    }

    const queued = queuedOutgoingRef.current.shift();
    if (!queued) {
      return;
    }

    void sendChatMessage(queued);
  }, [isSending, sendChatMessage]);

  useLayoutEffect(() => {
    if (initialScrollPendingRef.current || shouldJumpToBottomRef.current || historyLoading) {
      scrollToBottom('auto');
      if (!historyLoading) {
        initialScrollPendingRef.current = false;
        shouldJumpToBottomRef.current = false;
      }
      return;
    }

    scrollToBottom('auto');
  }, [historyLoading, isSending, messages, phase, scrollToBottom]);

  useLayoutEffect(() => {
    if (!historyLoading && initialScrollPendingRef.current) {
      scrollToBottom('auto');
      initialScrollPendingRef.current = false;
      shouldJumpToBottomRef.current = false;
    }
  }, [historyLoading, scrollToBottom]);

  return {
    // For SessionHeader
    activeProvider,
    providerTheme,
    model,
    canSwitchModelInSession,
    setProvider,
    setModel,

    // For MessageList
    messages,
    historyLoading,
    messagesContainerRef,
    messagesEndRef,

    // For InputArea
    input,
    isSending,
    phase,
    phaseLabel,
    attachedFiles,
    setAttachedFiles,
    isFilePickerOpen,
    setIsFilePickerOpen,
    filePickerQuery,
    setFilePickerQuery,
    filePickerView,
    setFilePickerView,
    filePickerSuggestions,
    projectFileTree,
    expandedDirectories,
    toggleDirectoryExpanded,
    toggleAttachedFile,
    selectAllFromCurrentPickerView,
    isLoadingFiles,
    isMentionOpen,
    mentionSuggestions,
    mentionActiveIndex,
    setMentionActiveIndex,
    handleSelectMention,
    sendChatMessage,
    abortCurrentRequest,
    isCmdOpen,
    cmdQuery,
    cmdActiveIndex,
    cmdFilteredCommands,
    handleSelectCommand,
    inputRef,
    filePickerRef,
    filePickerToggleRef,
    handleInputChange,
    handleInputKeyDown,
    handleInputSelect,
    handleInputFocus,
    handleInputBlur,
    handleCompositionStart,
    handleCompositionEnd,

    // Shared
    selectedProject,
    selectedSession,

    // Permission request
    pendingPermission,
    handlePermissionResponse,

    // Token budget
    tokenBudget,
  };
}

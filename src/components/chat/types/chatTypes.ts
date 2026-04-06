import type { SessionProvider } from '../../../types/app';

export type ChatPhase = 'idle' | 'thinking' | 'tool' | 'writing' | 'done';
export type ChatMessageKind = 'user' | 'assistant' | 'tool' | 'thinking' | 'status' | 'error';

export type ReferencedFile = {
  path: string;
  loaded: boolean;
  truncated?: boolean;
  error?: string;
};

export type ChatMessage = {
  id: string;
  kind: ChatMessageKind;
  text: string;
  provider: SessionProvider;
  timestamp: number;
  files?: ReferencedFile[];
  streaming?: boolean;
};

export type QueuedOutgoingMessage = {
  rawInput: string;
  displayInput: string;
  referencePaths: string[];
  userMessageId: string;
  attachedFiles: string[];
  provider: SessionProvider;
  model: string;
};

export type FlatFileNode = {
  path: string;
  name: string;
  type: 'file' | 'directory';
};

export type FileTreeNode = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
};

export type ProviderThemeConfig = {
  panel: string;
  header: string;
  headerTitle: string;
  headerIcon: string;
  brandBadge: string;
  assistantBubble: string;
  userBubble: string;
  composer: string;
  sendButton: string;
  picker: string;
  activePickRow: string;
};

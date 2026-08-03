import { normalizeComparablePath } from '../lib/worktreePaths';

export type AgentSessionProvider =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'gemini'
  | 'kimi'
  | 'grok';

export type TitleKind = 'explicit' | 'generated' | 'unknown' | 'firstPrompt';

export type AgentSessionAvailability =
  | 'available'
  | 'missingCli'
  | 'unavailable'
  | 'error';

export type AgentSessionMetadataState = 'found' | 'missing' | 'unavailable' | 'error';

export interface AgentSessionSummary {
  provider: AgentSessionProvider;
  id: string;
  projectPath: string;
  nativeTitle?: string | null;
  titleKind: TitleKind;
  firstUserMessagePreview?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  messageCount?: number | null;
  gitBranch?: string | null;
  sourceKind?: string | null;
  parentSessionId?: string | null;
  resumable: boolean;
}

export interface AgentSessionPage {
  provider: AgentSessionProvider;
  availability: AgentSessionAvailability;
  items: AgentSessionSummary[];
  nextCursor?: string | null;
  scannedAt: number;
  warning?: string | null;
}

export interface ListAgentSessionsRequest {
  provider: AgentSessionProvider;
  cursor?: string | null;
  limit?: number | null;
  query?: string | null;
}

/** Exact visible-card metadata lookup key. Separate from recovery catalog state. */
export interface AgentSessionMetadataKey {
  provider: AgentSessionProvider;
  sessionId: string;
  projectPath?: string | null;
}

export interface AgentSessionMetadataResult {
  key: AgentSessionMetadataKey;
  state: AgentSessionMetadataState;
  summary?: AgentSessionSummary | null;
  warning?: string | null;
}

export interface ResolveAgentSessionMetadataRequest {
  keys: AgentSessionMetadataKey[];
}

export const AGENT_SESSION_PROVIDERS: AgentSessionProvider[] = [
  'claude',
  'codex',
  'opencode',
  'gemini',
  'kimi',
  'grok',
];

export const AGENT_SESSION_PROVIDER_LABELS: Record<AgentSessionProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  kimi: 'Kimi Code',
  grok: 'Grok Build',
};

export const MAX_AGENT_SESSION_METADATA_KEYS = 100;

export function isAgentSessionProvider(value: string): value is AgentSessionProvider {
  return (
    value === 'claude'
    || value === 'codex'
    || value === 'opencode'
    || value === 'gemini'
    || value === 'kimi'
    || value === 'grok'
  );
}

export function agentSessionMetadataCacheKey(
  provider: AgentSessionProvider,
  sessionId: string,
  projectPath: string | null | undefined,
): string {
  const projectIdentity = projectPath ? normalizeComparablePath(projectPath) : '';
  return `${provider}\0${sessionId}\0${projectIdentity}`;
}

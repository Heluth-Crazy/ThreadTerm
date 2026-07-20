export type AgentSessionProvider = 'claude' | 'codex' | 'opencode' | 'gemini';

export type TitleKind = 'explicit' | 'generated' | 'unknown' | 'firstPrompt';

export type AgentSessionAvailability =
  | 'available'
  | 'missingCli'
  | 'unavailable'
  | 'error';

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

export const AGENT_SESSION_PROVIDERS: AgentSessionProvider[] = [
  'claude',
  'codex',
  'opencode',
  'gemini',
];

export const AGENT_SESSION_PROVIDER_LABELS: Record<AgentSessionProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
};

export function isAgentSessionProvider(value: string): value is AgentSessionProvider {
  return (
    value === 'claude' || value === 'codex' || value === 'opencode' || value === 'gemini'
  );
}

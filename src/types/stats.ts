// Token statistics shapes — mirror of the Rust `stats::types` (camelCase).

export interface UsageSummary {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface StatBucket {
  key: string;
  label: string;
  usage: UsageSummary;
  totalTokens: number;
  inputOutputTokens: number;
  cacheTokens: number;
  costUsd: number;
  calls: number;
}

export interface AgentStats {
  totalTokens: number;
  inputOutputTokens: number;
  cacheTokens: number;
  totalCostUsd: number;
  totalCalls: number;
  sessionCount: number;
  usage: UsageSummary;
  byModel: StatBucket[];
  byProject: StatBucket[];
  bySession: StatBucket[];
}

export type StatsScope = 'all' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'grok';
export type StatsRange = 'today' | '7d' | '30d' | 'all';

export interface StatsProgressEvent {
  requestId: number;
  scanned: number;
  total: number;
}

export interface StatsDoneEvent {
  requestId: number;
  stats: AgentStats;
}

export interface StatsErrorEvent {
  requestId: number;
  error: string;
}

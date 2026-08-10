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
export type StatsStatusFilter = 'all' | 'success' | 'failure';
export type StatsSourceFilter = 'all' | 'proxy' | 'session_log';

export interface StatsDashboardFilters {
  appType?: string;
  model?: string;
  status?: StatsStatusFilter;
  source?: StatsSourceFilter;
  /** Exact selected project/worktree path; omit for all projects. */
  projectPath?: string;
}

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

export interface StatsOverview {
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalTokens: number;
  realTotalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number;
  successRate: number;
  totalCostUsd: number;
  unpricedRequestCount: number;
  sessionCount: number;
  proxyRequestCount: number;
  sessionLogRequestCount: number;
}

export interface StatsTrendPoint {
  periodStart: number;
  requestCount: number;
  successCount: number;
  totalTokens: number;
  realTotalTokens: number;
  costUsd: number;
}

export interface StatsBreakdown {
  key: string;
  label: string;
  provider: string;
  usage: UsageSummary;
  totalTokens: number;
  realTotalTokens: number;
  costUsd: number;
  calls: number;
  successCalls: number;
  failureCalls: number;
  unpricedCalls: number;
  cacheHitRate: number;
}

export interface StatsRequestLog {
  requestId: string;
  provider: string;
  appType: string;
  model: string;
  requestModel: string;
  pricingModel: string;
  usage: UsageSummary;
  totalTokens: number;
  realTotalTokens: number;
  costUsd: number;
  pricingStatus: string;
  statusCode?: number | null;
  success: boolean;
  error?: string | null;
  latencyMs?: number | null;
  firstTokenMs?: number | null;
  durationMs?: number | null;
  streaming: boolean;
  sessionId?: string | null;
  projectPath?: string | null;
  dataSource: string;
  createdAt: number;
}

export interface StatsDashboard {
  overview: StatsOverview;
  trends: StatsTrendPoint[];
  byProvider: StatsBreakdown[];
  byModel: StatsBreakdown[];
  requestLogs: StatsRequestLog[];
  nextCursor?: string | null;
  pricingVersion: string;
}

export interface StatsPricingEntry {
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheWritePerMtok: number;
  cacheReadPerMtok: number;
  enabled: boolean;
}

export interface StatsProxyStatus {
  running: boolean;
  host?: string | null;
  port?: number | null;
  url?: string | null;
  routePrefix?: string | null;
}

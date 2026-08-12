import type { AgentSessionCatalogProgress } from '../types/agentSession';

export const AGENT_SESSION_CATALOG_STALL_TIMEOUT_MS = 20_000;
export const AGENT_SESSION_CATALOG_STALLED_ERROR =
  'agent_session_catalog_stalled';

export function isValidAgentSessionCatalogProgress(
  progress: AgentSessionCatalogProgress,
): boolean {
  return (
    Number.isFinite(progress.completed)
    && progress.completed >= 0
    && Number.isFinite(progress.elapsedMs)
    && progress.elapsedMs >= 0
    && (
      progress.total === null
      || progress.total === undefined
      || (
        Number.isFinite(progress.total)
        && progress.total >= 0
        && progress.completed <= progress.total
      )
    )
  );
}

export function mergeAgentSessionCatalogProgress(
  previous: AgentSessionCatalogProgress | null,
  next: AgentSessionCatalogProgress,
): AgentSessionCatalogProgress {
  const sameRequest = previous?.requestId === next.requestId;
  const sameRequestPhase = sameRequest && previous.phase === next.phase;
  return {
    ...next,
    completed: sameRequestPhase
      ? Math.max(previous.completed, next.completed)
      : next.completed,
    elapsedMs: sameRequest
      ? Math.max(previous.elapsedMs, next.elapsedMs)
      : next.elapsedMs,
  };
}

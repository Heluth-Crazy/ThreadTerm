import { invoke, isTauriEnv } from './tauri-bridge';
import { useAttentionStore } from '../stores/attentionStore';
import { useBackgroundRunStore } from '../stores/backgroundRunStore';
import { useSessionStatusStore } from '../stores/sessionStatusStore';
import type { ApprovalRequest, AttentionItem } from '../stores/attentionStore';
import type { SessionStatusEntry } from '../stores/sessionStatusStore';
import type { BackgroundRun } from '../types/background-run';

interface ApprovalActionSnapshot {
  approvalRequest?: ApprovalRequest;
  statusEntry?: SessionStatusEntry;
  attentionItems: Record<string, AttentionItem>;
  backgroundRuns: Record<string, BackgroundRun>;
}

function isTerminalRunStatus(status: BackgroundRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isRunForSession(run: BackgroundRun, sessionId: string): boolean {
  return run.sessionId === sessionId || run.id === sessionId;
}

function updateBackgroundRunsForSession(
  sessionId: string,
  updater: (run: BackgroundRun) => BackgroundRun,
): void {
  useBackgroundRunStore.setState((state) => {
    let changed = false;
    const runs = { ...state.runs };

    for (const [runId, run] of Object.entries(state.runs)) {
      if (!isRunForSession(run, sessionId) || isTerminalRunStatus(run.status)) {
        continue;
      }

      const nextRun = updater(run);
      if (nextRun !== run) {
        runs[runId] = nextRun;
        changed = true;
      }
    }

    return changed ? { runs } : state;
  });
}

function captureApprovalActionSnapshot(sessionId: string): ApprovalActionSnapshot {
  const attentionStore = useAttentionStore.getState();
  const backgroundRunStore = useBackgroundRunStore.getState();
  const sessionStore = useSessionStatusStore.getState();

  return {
    approvalRequest: attentionStore.approvalRequests[sessionId],
    statusEntry: sessionStore.statuses[sessionId],
    attentionItems: Object.fromEntries(
      Object.entries(attentionStore.attentionItems).filter(([, item]) => item.sessionId === sessionId),
    ),
    backgroundRuns: Object.fromEntries(
      Object.entries(backgroundRunStore.runs).filter(([, run]) => isRunForSession(run, sessionId)),
    ),
  };
}

function restoreApprovalActionSnapshot(sessionId: string, snapshot: ApprovalActionSnapshot): void {
  useAttentionStore.setState((state) => {
    const approvalRequests = { ...state.approvalRequests };
    const attentionItems = { ...state.attentionItems };

    if (snapshot.approvalRequest) {
      approvalRequests[sessionId] = snapshot.approvalRequest;
    } else {
      delete approvalRequests[sessionId];
    }

    for (const [id, item] of Object.entries(attentionItems)) {
      if (item.sessionId === sessionId && !snapshot.attentionItems[id]) {
        delete attentionItems[id];
      }
    }
    Object.assign(attentionItems, snapshot.attentionItems);

    return { approvalRequests, attentionItems };
  });

  useSessionStatusStore.setState((state) => {
    const statuses = { ...state.statuses };

    if (snapshot.statusEntry) {
      statuses[sessionId] = snapshot.statusEntry;
    } else {
      delete statuses[sessionId];
    }

    return { statuses };
  });

  useBackgroundRunStore.setState((state) => {
    const runs = { ...state.runs };

    for (const [runId, run] of Object.entries(runs)) {
      if (isRunForSession(run, sessionId) && !snapshot.backgroundRuns[runId]) {
        delete runs[runId];
      }
    }

    Object.assign(runs, snapshot.backgroundRuns);

    return { runs };
  });
}

export async function respondToApprovalRequest(
  sessionId: string,
  requestId: string,
  approved: boolean,
): Promise<void> {
  if (!isTauriEnv()) {
    throw new Error('Approval actions are only available in the Tauri desktop runtime right now.');
  }

  const attentionStore = useAttentionStore.getState();
  const sessionStore = useSessionStatusStore.getState();
  const snapshot = captureApprovalActionSnapshot(sessionId);

  if (approved) {
    attentionStore.approveRequestOptimistic(sessionId);
    sessionStore.setProcessing(sessionId);
    updateBackgroundRunsForSession(sessionId, (run) => ({
      ...run,
      status: 'running',
      requiresApproval: false,
      awaitingInput: false,
      attentionReason: undefined,
    }));
  } else {
    attentionStore.denyRequestOptimistic(sessionId);
    sessionStore.setNeedsAttention(sessionId, 'permission');
    updateBackgroundRunsForSession(sessionId, (run) => ({
      ...run,
      status: 'needs_attention',
      requiresApproval: false,
      attentionReason: 'approval',
    }));
  }

  attentionStore.resolveAttentionItemsForSession(sessionId);

  try {
    await invoke('ai_approve_tool', {
      sessionId,
      permissionId: requestId,
      approved,
    });

    attentionStore.clearApprovalRequest(sessionId);
  } catch (error) {
    restoreApprovalActionSnapshot(sessionId, snapshot);
    throw error;
  }
}

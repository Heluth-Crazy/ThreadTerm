/**
 * Pure policy for which workspace editor / diff views stay mounted.
 *
 * Hard protections (never unload):
 * - dirty tabs
 * - current (active) tab on the selected workspace
 * - diff tabs that are active on the selected workspace
 *
 * Clean inactive file tabs may stay mounted only while inside a small LRU
 * budget so rapid tab switches stay warm without unbounded CodeMirror growth.
 */

export const MAX_WARM_CLEAN_WORKSPACE_EDITORS = 2;

export interface WorkspaceEditorMountCandidate {
  /** Workspace id (worktree-scoped). cardId kept as optional legacy alias. */
  workspaceId: string;
  tabId: string;
  kind: 'file' | 'diff' | string;
  dirty: boolean;
  current: boolean;
  /** True when this workspace is the selected/active workspace shell. */
  selectedWorkspace: boolean;
  /** @deprecated use selectedWorkspace */
  focusedCard?: boolean;
  /** @deprecated use workspaceId */
  cardId?: string;
}

export interface WorkspaceEditorMountDecision {
  mount: boolean;
  reason: 'dirty' | 'current' | 'diff-active' | 'warm-clean' | 'cold-clean';
}

function isSelected(candidate: WorkspaceEditorMountCandidate): boolean {
  return candidate.selectedWorkspace || Boolean(candidate.focusedCard);
}

function scopeKey(candidate: WorkspaceEditorMountCandidate): string {
  return `${candidate.workspaceId || candidate.cardId || ''}::${candidate.tabId}`;
}

/**
 * Decide mount set for candidates. Tabs metadata remain elsewhere; this only
 * answers which heavy editors should keep CodeMirror / preview DOM alive.
 */
export function selectMountedWorkspaceEditors(
  candidates: readonly WorkspaceEditorMountCandidate[],
  warmCleanLimit: number = MAX_WARM_CLEAN_WORKSPACE_EDITORS,
): {
  mounted: WorkspaceEditorMountCandidate[];
  decisions: WorkspaceEditorMountDecision[];
} {
  const decisions: WorkspaceEditorMountDecision[] = [];
  const protectedOnes: WorkspaceEditorMountCandidate[] = [];
  const cleanInactive: WorkspaceEditorMountCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.dirty) {
      protectedOnes.push(candidate);
      decisions.push({ mount: true, reason: 'dirty' });
      continue;
    }
    if (candidate.current && isSelected(candidate)) {
      protectedOnes.push(candidate);
      decisions.push({
        mount: true,
        reason: candidate.kind === 'diff' ? 'diff-active' : 'current',
      });
      continue;
    }
    // Warm budget only applies to clean inactive tabs on the selected workspace.
    if (isSelected(candidate)) {
      cleanInactive.push(candidate);
      continue;
    }
    decisions.push({ mount: false, reason: 'cold-clean' });
  }

  const warmBudget = Math.max(0, warmCleanLimit);
  const warmClean = warmBudget === 0 ? [] : cleanInactive.slice(-warmBudget);
  const warmIds = new Set(warmClean.map((c) => scopeKey(c)));

  for (const candidate of cleanInactive) {
    const key = scopeKey(candidate);
    if (warmIds.has(key)) {
      decisions.push({ mount: true, reason: 'warm-clean' });
    } else {
      decisions.push({ mount: false, reason: 'cold-clean' });
    }
  }

  return {
    mounted: [...protectedOnes, ...warmClean],
    decisions,
  };
}

/** Hard protection predicate used by tests and UI guards. */
export function isWorkspaceEditorProtected(candidate: WorkspaceEditorMountCandidate): boolean {
  if (candidate.dirty) return true;
  if (candidate.current && isSelected(candidate)) return true;
  return false;
}

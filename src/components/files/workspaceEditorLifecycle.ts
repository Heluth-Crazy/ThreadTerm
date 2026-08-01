/**
 * Pure policy for which workspace editor / diff views stay mounted.
 *
 * Hard protections (never unload):
 * - dirty tabs
 * - current (active) tab on the focused card
 * - diff tabs that are active on the focused card
 *
 * Clean inactive file tabs may stay mounted only while inside a small LRU
 * budget so rapid tab switches stay warm without unbounded CodeMirror growth.
 */

export const MAX_WARM_CLEAN_WORKSPACE_EDITORS = 2;

export interface WorkspaceEditorMountCandidate {
  cardId: string;
  tabId: string;
  kind: 'file' | 'diff' | string;
  dirty: boolean;
  current: boolean;
  focusedCard: boolean;
}

export interface WorkspaceEditorMountDecision {
  mount: boolean;
  reason: 'dirty' | 'current' | 'diff-active' | 'warm-clean' | 'cold-clean';
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
    if (candidate.current && candidate.focusedCard) {
      protectedOnes.push(candidate);
      decisions.push({
        mount: true,
        reason: candidate.kind === 'diff' ? 'diff-active' : 'current',
      });
      continue;
    }
    // Warm budget only applies to clean inactive tabs on the focused card.
    // Other cards keep tab metadata but unload clean editors to preserve
    // per-session isolation.
    if (candidate.focusedCard) {
      cleanInactive.push(candidate);
      continue;
    }
    decisions.push({ mount: false, reason: 'cold-clean' });
  }

  // Keep the most recently listed clean tabs (callers should pass LRU order).
  // Note: Array#slice(-0) returns the full array, so treat 0 as "no warm set".
  const warmBudget = Math.max(0, warmCleanLimit);
  const warmClean =
    warmBudget === 0 ? [] : cleanInactive.slice(-warmBudget);
  const warmIds = new Set(warmClean.map((c) => `${c.cardId}::${c.tabId}`));

  for (const candidate of cleanInactive) {
    const key = `${candidate.cardId}::${candidate.tabId}`;
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
  if (candidate.current && candidate.focusedCard) return true;
  return false;
}

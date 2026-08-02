/**
 * Sampling mirror for workspace/editor counts used by LifecycleDiagnosticsHost.
 * Does not affect product lifecycle behaviour.
 */

export interface WorkspaceEditorDiagnosticsSample {
  tabCount: number;
  dirtyTabCount: number;
  activeTabCount: number;
  liveEditorInstanceCount: number | null;
  selectedWorkspaceId?: string | null;
  conflictTabCount?: number;
}

let latest: WorkspaceEditorDiagnosticsSample = {
  tabCount: 0,
  dirtyTabCount: 0,
  activeTabCount: 0,
  liveEditorInstanceCount: null,
  selectedWorkspaceId: null,
  conflictTabCount: 0,
};

export function publishWorkspaceEditorDiagnostics(
  sample: WorkspaceEditorDiagnosticsSample,
): void {
  latest = { ...sample };
}

export function getWorkspaceEditorDiagnostics(): WorkspaceEditorDiagnosticsSample {
  return latest;
}

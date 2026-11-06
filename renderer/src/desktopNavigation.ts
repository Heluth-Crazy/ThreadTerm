export type DesktopNavigateTarget = { sessionId?: string; workspaceId?: string; action?: 'command-palette' | 'computers' | 'new-session' | 'add-project'; projectId?: string; path?: string };

export type DesktopDialogAction = { kind: 'new-session'; projectId?: string; path?: string } | { kind: 'add-project' };

/** Actions which deliberately open a dialog after Electron has switched to the target machine view. */
export function desktopDialogAction(target: DesktopNavigateTarget): DesktopDialogAction | undefined {
  if (target.action === 'new-session') return { kind: 'new-session', projectId: target.projectId, path: target.path };
  if (target.action === 'add-project') return { kind: 'add-project' };
  return undefined;
}

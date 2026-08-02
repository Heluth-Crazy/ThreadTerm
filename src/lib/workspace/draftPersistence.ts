/**
 * Desktop adapter: persist dirty drafts from the file editor into the
 * authoritative workspace service (worktree-scoped tabs).
 */

import { workspaceClient } from './client';
import { relativeFromRoot } from './paths';
import { DESKTOP_MAIN_SURFACE } from './types';

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const revisionByTab = new Map<string, number>();

function key(workspaceId: string, tabId: string): string {
  return `${workspaceId}::${tabId}`;
}

export interface PersistDraftInput {
  rootPath: string;
  path: string;
  title: string;
  contents: string;
  dirty: boolean;
}

/**
 * Ensure the worktree is registered, open/focus the file tab metadata, and
 * when dirty, debounce a durable full-text draft patch. Returns whether the
 * latest write was acknowledged (`synced`) or still pending/failed.
 */
export async function persistDesktopFileDraft(
  input: PersistDraftInput,
): Promise<'idle' | 'pending' | 'synced' | 'error'> {
  if (!input.rootPath) return 'idle';
  if (!input.dirty) return 'idle';

  try {
    const workspace = await workspaceClient.ensure(input.rootPath);
    const relativePath = relativeFromRoot(input.rootPath, input.path);
    const tab = await workspaceClient.openTab(workspace.id, {
      kind: 'file',
      title: input.title,
      relativePath,
    });
    await workspaceClient.ensureDraft(workspace.id, tab.id);
    const mapKey = key(workspace.id, tab.id);

    return await new Promise((resolve) => {
      const existing = debounceTimers.get(mapKey);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        mapKey,
        setTimeout(() => {
          void (async () => {
            try {
              let revision = revisionByTab.get(mapKey) ?? 0;
              if (!revisionByTab.has(mapKey)) {
                const draft = await workspaceClient.getDraft(workspace.id, tab.id);
                revision = draft?.revision ?? 0;
              }
              const result = await workspaceClient.applyDraftPatch(
                {
                  workspaceId: workspace.id,
                  tabId: tab.id,
                  baseRevision: revision,
                  changes: [],
                  fullText: input.contents,
                },
                { surfaceId: DESKTOP_MAIN_SURFACE, requireLease: false },
              );
              revisionByTab.set(mapKey, result.revision);
              resolve('synced');
            } catch {
              resolve('error');
            } finally {
              debounceTimers.delete(mapKey);
            }
          })();
        }, 400),
      );
      resolve('pending');
    });
  } catch {
    return 'error';
  }
}

export function clearDraftPersistenceState(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  revisionByTab.clear();
}

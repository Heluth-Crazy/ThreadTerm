/**
 * Minimal desktop adapter: persist dirty drafts produced by the current
 * card-scoped file editor into the authoritative workspace service.
 * Does not change navigation ownership (still card-scoped until child 2).
 */

import { isTauriEnv } from '../tauri-bridge';
import { workspaceAuthority } from './api';
import { DESKTOP_MAIN_SURFACE } from './types';

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const revisionByTab = new Map<string, number>();

function key(workspaceId: string, tabId: string): string {
  return `${workspaceId}::${tabId}`;
}

function relativeFromRoot(rootPath: string, absoluteOrRelative: string): string {
  const root = rootPath.replace(/[\\/]+$/, '');
  const path = absoluteOrRelative;
  const normalizedRoot = root.replace(/\\/g, '/');
  const normalizedPath = path.replace(/\\/g, '/');
  if (normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase() + '/')) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  if (normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase() + '\\')) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  // Already relative or unrelated — pass through.
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
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
  if (!isTauriEnv() || !input.rootPath) return 'idle';
  if (!input.dirty) return 'idle';

  try {
    const workspace = await workspaceAuthority.ensure(input.rootPath);
    const relativePath = relativeFromRoot(input.rootPath, input.path);
    const tab = await workspaceAuthority.openTab(workspace.id, {
      kind: 'file',
      title: input.title,
      relativePath,
    });
    await workspaceAuthority.ensureDraft(workspace.id, tab.id);
    const mapKey = key(workspace.id, tab.id);

    return await new Promise((resolve) => {
      const existing = debounceTimers.get(mapKey);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        mapKey,
        setTimeout(() => {
          void (async () => {
            try {
              const baseRevision = revisionByTab.get(mapKey) ?? 0;
              // Load authoritative revision if we have not tracked it yet.
              let revision = baseRevision;
              if (!revisionByTab.has(mapKey)) {
                const draft = await workspaceAuthority.getDraft(workspace.id, tab.id);
                revision = draft?.revision ?? 0;
              }
              const result = await workspaceAuthority.applyDraftPatch(
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

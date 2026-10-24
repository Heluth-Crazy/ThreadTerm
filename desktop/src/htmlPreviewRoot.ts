import { realpath } from 'node:fs/promises';
import { normalize } from 'node:path';
import type { Project, Worktree } from '@threadterm/protocol';

export type HtmlPreviewRootRequest = { projectId: string; worktreePath?: string };
export type HtmlPreviewRootCatalog = {
  projects(): Promise<readonly Project[]>;
  worktrees(projectId: string): Promise<readonly Worktree[]>;
};

const identity = (path: string): string => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);

/** Select a root from runtime-owned records; a renderer path is only an identity hint. */
export async function resolveHtmlPreviewRoot(catalog: HtmlPreviewRootCatalog, request: HtmlPreviewRootRequest): Promise<string> {
  const project = (await catalog.projects()).find(item => item.id === request.projectId);
  if (!project) throw new Error('Preview project is unavailable');
  const root = await realpath(project.path);
  if (request.worktreePath === undefined) return root;
  const requested = await realpath(request.worktreePath);
  if (identity(requested) === identity(root)) return root;
  const trees = await catalog.worktrees(project.id);
  for (const tree of trees) {
    if (tree.projectId !== project.id || tree.missing) continue;
    try {
      const candidate = await realpath(tree.path);
      if (identity(candidate) === identity(requested)) return candidate;
    } catch { /* Missing records cannot grant access. */ }
  }
  throw new Error('Preview worktree is unavailable');
}

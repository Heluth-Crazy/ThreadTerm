/**
 * Compatibility re-export — desktop workspace content is worktree-scoped via
 * useWorkspaceSession. Prefer importing from `../workspace`.
 */
export { useWorkspaceSession as useWorkspaceContent } from '../workspace/useWorkspaceSession';

/**
 * 项目 slice —— 左侧栏项目 / worktree 选择。
 *
 * 选中项目或 worktree 时会一并退出聚焦模式（`focusedCardId` 归 navigation
 * slice 所有），让用户看到过滤后的卡片网格。
 */
import { pathBasename } from '../../lib/worktreePaths';
import type { ProjectSlice, TerminalSliceCreator } from './types';

export const createProjectSlice: TerminalSliceCreator<ProjectSlice> = (set) => ({
  selectedProjectPath: null,
  selectedWorktreePath: null,
  selectedWorktreeLabel: null,

  selectProject: (path) =>
    set((state) => {
      if (
        state.selectedProjectPath === path &&
        state.selectedWorktreePath === null &&
        state.selectedWorktreeLabel === null
      ) {
        return state;
      }
      // When switching projects, exit focus mode so the user sees the
      // filtered grid of the newly-selected project.
      return {
        selectedProjectPath: path,
        selectedWorktreePath: null,
        selectedWorktreeLabel: null,
        focusedCardId: null,
      };
    }),

  selectWorktree: (projectPath, worktreePath, label) =>
    set((state) => {
      const selectedWorktreeLabel = label?.trim() || pathBasename(worktreePath);
      if (
        state.selectedProjectPath === projectPath &&
        state.selectedWorktreePath === worktreePath &&
        state.selectedWorktreeLabel === selectedWorktreeLabel
      ) {
        return state;
      }
      return {
        selectedProjectPath: projectPath,
        selectedWorktreePath: worktreePath,
        selectedWorktreeLabel,
        focusedCardId: null,
      };
    }),
});

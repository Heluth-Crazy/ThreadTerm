# OpenWork Desktop - Upgrade Specification

## Project Overview

Sync Windows worktree feature to Mac and implement UI improvements for multi-file selection and settings modal.

## Target Platform

- macOS (x64, arm64)
- Windows (x64)

## New Feature Requirements

### 1. Worktree Sync (from Windows)

**Background**: Windows implementation completed 8 steps for multi-branch worktree feature. Mac needs to sync these features.

**Required Changes**:
- Worktree settings persistence (`~/.openwork/worktree-settings.json`)
- Branch worktree creation API
- Short directory naming strategy (branch-hash)
- Mapping docs generation (worktree-map.md, worktree-map.json)
- isGitRepo detection and UI gating
- Sidebar parent-child grouping
- Multi-expand toggle fix

### 2. Multi-File Selection UI Improvements

**Goal**: Improve file picker UI in chat panel with better UX

**Requirements**:
- Better file chips display with icons and remove button
- Count badge on toggle button showing selected files
- Keyboard navigation (Arrow keys to move focus, Enter to select/deselect)
- Focus management (Tab to cycle through files, Escape to close)
- Smooth animations for selection state changes

### 3. Worktree Branch Creation Within Project Directory

**Goal**: New branch worktrees should be created within the project directory, not outside

**Requirements**:
- When creating branch worktree, use project's parent directory as base
- Validate path stays within allowed workspace root
- Update UI to reflect "within project" behavior
- Remove separate worktree root path requirement

### 4. Multi-Branch Action Button

**Goal**: Add branch workspace creation action in project menu

**Requirements**:
- Add Git branch icon button in project action menu (same row as edit/rename/delete)
- Show only for git repositories
- Click triggers branch name input dialog
- Visual consistency with other action buttons

### 5. Settings Modal - Agent Parameters

**Goal**: Add agent launch parameter configuration

**Requirements**:
- In Settings > 智能体 tab, add "参数设置" section
- Input field for custom CLI arguments (e.g., `--dangerously-enable-native-tool-use-blocks`)
- Save parameters to localStorage/config
- Append parameters when starting new Claude Code or Codex sessions
- Remove old permission-related code

### 6. Settings Modal - Simplified Tabs

**Goal**: Only keep 3 tabs in settings

**Requirements**:
- Keep: 智能体 (Agent), Git, 外观 (Appearance)
- Remove: 所有其他 tab 内容
- Clean up old settings code
- Ensure settings persist correctly

## Success Criteria

1. All Windows worktree features work on Mac
2. Multi-file selection works with keyboard navigation
3. Branch worktrees created within project directory
4. Branch action visible in project menu for git repos
5. Agent parameters can be configured and used in new sessions
6. Settings modal has exactly 3 tabs
7. No regression in existing functionality

## Testing Requirements

- Test each feature with browser automation
- Verify no regression in existing features
- Test on both macOS and Windows if possible

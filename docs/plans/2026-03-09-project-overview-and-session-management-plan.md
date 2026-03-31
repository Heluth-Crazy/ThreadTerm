# Project Overview And Session Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a project-level overview workflow that keeps the sidebar lightweight, routes every project click to a dedicated project overview page, supports provider-grouped bulk session deletion, and presents worktrees on the right side with Windows-compatible interaction behavior.

**Architecture:** Keep the existing workbench shell and sidebar, but split project browsing into two right-side surfaces: the existing global projects overview and a new selected-project overview page. Move project management actions and grouped session management into the selected-project overview, while the sidebar adds only a lightweight hover/focus summary card. Reuse the current single-session deletion APIs for batch delete by orchestrating sequential requests in the frontend rather than introducing a new backend endpoint in v1.

**Tech Stack:** React 18, TypeScript, react-router state already used by AppContent/useProjectsState, existing sidebar/workbench components, existing REST endpoints in `src/utils/api.js`, Tailwind utility styling.

---

## Preconditions

This repo currently does not include a dedicated unit test runner for the frontend. Do not add Vitest/Jest/Playwright as part of this feature.

Validation for each task should use:
- `npm run typecheck`
- `npm run build`
- targeted manual smoke in the running app

Manual smoke should be performed on desktop layout with Windows-safe interaction assumptions:
- hover-only affordances must also work on focus
- cards must not overflow at common Windows scaling levels
- destructive actions must be explicit and confirmed

### Task 1: Extend Workbench Navigation For Selected Project Overview

**Files:**
- Modify: `src/types/workbench.ts`
- Modify: `src/hooks/useWorkbenchNavigation.ts`
- Modify: `src/components/app/AppContent.tsx`
- Modify: `src/components/workbench/MainContentRouter.tsx`
- Modify: `src/components/workbench/projects/ProjectsSidebarPanel.tsx`

**Step 1: Add the new projects view state**

Update `ProjectsView` so it can represent:
- global overview
- selected project overview
- workspace

Recommended shape:

```ts
export type ProjectsView = 'overview' | 'project-overview' | 'workspace';
```

Keep default state at global `'overview'`.

**Step 2: Route project selection to project overview, not workspace**

Wire project-selection flow so that when a sidebar project row is clicked:
- `selectedProject` is set as today
- `selectedSession` remains `null`
- `projectsView` becomes `'project-overview'`
- right side renders selected project overview

Do not change session click behavior in this task.

**Step 3: Keep session navigation on workspace view**

When a session is selected or a new session is created, existing logic should still switch the projects area into `'workspace'`.

Review these edges:
- URL session restore
- `onSelectSession`
- `onNewSession`
- `replaceTemporarySession`
- refresh after existing session is active

**Step 4: Update router branching**

`MainContentRouter` should branch as follows for `activeNav === 'projects'`:
- `'overview'` => current global projects overview page
- `'project-overview'` => new selected-project overview page
- `'workspace'` => current `MainContent`

**Step 5: Run validation**

Run:

```bash
npm run typecheck
npm run build
```

Manual check:
- app opens to global projects overview
- clicking a project opens project overview
- clicking a session still opens workspace

**Step 6: Commit**

```bash
git add src/types/workbench.ts src/hooks/useWorkbenchNavigation.ts src/components/app/AppContent.tsx src/components/workbench/MainContentRouter.tsx src/components/workbench/projects/ProjectsSidebarPanel.tsx
git commit -m "feat: add project overview navigation state"
```

### Task 2: Extract Project Overview View Models And Helpers

**Files:**
- Create: `src/components/workbench/projects/projectOverviewModels.ts`
- Create: `src/components/workbench/projects/useProjectOverviewState.ts`
- Modify: `src/types/app.ts`

**Step 1: Extract reusable project/session/worktree helpers**

Move the selected-project derivation logic into a dedicated helper module.

Include pure helpers for:
- total Claude session count
- total Codex session count
- last activity timestamp
- last used session
- recent session shortlist
- worktree list derived from current `projects`
- source-project vs worktree labels

Suggested exported types:

```ts
export type ProjectOverviewSessionRecord = {
  session: ProjectSession;
  provider: SessionProvider;
  timestampMs: number;
  label: string;
};

export type ProjectWorktreeSummary = {
  project: Project;
  branchLabel: string | null;
  claudeCount: number;
  codexCount: number;
  lastActivityMs: number;
};
```

**Step 2: Create overview state hook**

Add `useProjectOverviewState.ts` to manage transient UI state only:
- active provider manage mode (`claude` / `codex` / none)
- selected Claude session ids
- selected Codex session ids
- pending delete state
- action in progress state

The hook should expose small handler primitives, not page markup.

**Step 3: Confirm app model fields are sufficient**

Use the already-present worktree-related fields in `Project`:
- `isGitWorktree`
- `sourceProjectName`
- `repoRoot`
- `worktreePath`
- `worktreeBaseRoot`

Do not add new backend fields unless manual inspection proves current fields are insufficient.

**Step 4: Validation**

Run:

```bash
npm run typecheck
```

Manual spot-check by importing the helpers into the page before styling completion, ensuring no type regressions.

**Step 5: Commit**

```bash
git add src/components/workbench/projects/projectOverviewModels.ts src/components/workbench/projects/useProjectOverviewState.ts src/types/app.ts
git commit -m "refactor: add project overview view models"
```

### Task 3: Build The Selected Project Overview Page

**Files:**
- Create: `src/components/workbench/projects/ProjectOverviewPage.tsx`
- Modify: `src/components/workbench/MainContentRouter.tsx`
- Modify: `src/components/workbench/projects/ProjectsOverviewPage.tsx`
- Modify: `src/i18n/locales/zh-CN/sidebar.json`
- Modify: `src/i18n/locales/en/sidebar.json`
- Modify: `src/i18n/locales/ja/sidebar.json`
- Modify: `src/i18n/locales/ko/sidebar.json`
- Modify: `src/i18n/locales/zh-CN/common.json`
- Modify: `src/i18n/locales/en/common.json`
- Modify: `src/i18n/locales/ja/common.json`
- Modify: `src/i18n/locales/ko/common.json`

**Step 1: Keep the global overview page separate**

Do not overload `ProjectsOverviewPage.tsx` with selected-project management.

Use it only for the global overview/home surface.

Add a new `ProjectOverviewPage.tsx` for the selected-project experience.

**Step 2: Implement overview layout sections**

The new page should render these sections in order:
- project summary metrics
- continue working
- project actions
- provider-grouped sessions
- worktrees

The page should accept at minimum:

```ts
{
  project: Project;
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onSelectSession: (session: ProjectSession) => void;
  onNewSession: (project: Project, provider?: string) => void;
  onRefreshProjects?: () => Promise<void> | void;
}
```

**Step 3: Continue working section**

Show:
- last used session as primary CTA
- recent 3 sessions as secondary list
- new Claude session button
- new Codex session button

Important behavior:
- opening any listed session must switch the app back into workspace view through existing handlers
- no view-memory behavior should be implemented

**Step 4: Project actions section**

Move these actions here:
- rename
- star/unstar
- delete

Reuse current APIs and interaction patterns where possible.

Do not keep dense always-visible action buttons in the sidebar after this feature is complete.

**Step 5: Add i18n strings**

Add all new overview, worktree, manage-mode, and bulk-delete copy to the existing locale files.

Do not hardcode Chinese strings in the new page.

**Step 6: Validation**

Run:

```bash
npm run typecheck
npm run build
```

Manual check:
- project overview renders correctly on desktop
- last used session CTA opens the correct session
- new session buttons create correct provider sessions
- text wraps correctly in English and Chinese

**Step 7: Commit**

```bash
git add src/components/workbench/projects/ProjectOverviewPage.tsx src/components/workbench/MainContentRouter.tsx src/components/workbench/projects/ProjectsOverviewPage.tsx src/i18n/locales/zh-CN/sidebar.json src/i18n/locales/en/sidebar.json src/i18n/locales/ja/sidebar.json src/i18n/locales/ko/sidebar.json src/i18n/locales/zh-CN/common.json src/i18n/locales/en/common.json src/i18n/locales/ja/common.json src/i18n/locales/ko/common.json
git commit -m "feat: add selected project overview page"
```

### Task 4: Add Provider-Grouped Session Management And Bulk Delete

**Files:**
- Modify: `src/components/workbench/projects/ProjectOverviewPage.tsx`
- Modify: `src/components/workbench/projects/useProjectOverviewState.ts`
- Modify: `src/utils/api.js`
- Modify: `src/components/sidebar/hooks/useSidebarController.ts`

**Step 1: Reuse existing delete endpoints instead of adding a new backend API**

Batch deletion in v1 should call current endpoints sequentially:
- Claude: `api.deleteSession(projectName, sessionId)`
- Codex: `api.deleteCodexSession(sessionId)`

Do not add a dedicated batch endpoint yet.

**Step 2: Add manage mode per provider group**

For each provider section:
- normal mode => plain navigation list
- manage mode => checkboxes + group toolbar

Toolbar actions:
- select all
- clear selection
- delete selected
- exit manage mode

Selections must be isolated by provider.

**Step 3: Add delete confirmation flow**

Confirmation copy must include both count and provider, for example:
- `Delete 3 Claude sessions from this project?`
- `Delete 2 Codex sessions from this project?`

The confirmation state should be owned by the project overview hook, not the sidebar hook.

**Step 4: Refresh data after delete**

After successful delete:
- clear selection state for that provider group
- refresh projects from source of truth
- if the last-used session was deleted, remove the continue shortcut gracefully

**Step 5: Keep single-delete behavior consistent**

If the existing sidebar still allows single deletion during transition, its behavior should remain consistent with the overview page.

Avoid duplicating delete request logic; extract shared helper logic if needed.

**Step 6: Validation**

Run:

```bash
npm run typecheck
npm run build
```

Manual check:
- enter Claude manage mode, multi-select, delete, refresh
- enter Codex manage mode, multi-select, delete, refresh
- manage mode exits cleanly after delete or cancel
- no cross-provider selection leakage

**Step 7: Commit**

```bash
git add src/components/workbench/projects/ProjectOverviewPage.tsx src/components/workbench/projects/useProjectOverviewState.ts src/utils/api.js src/components/sidebar/hooks/useSidebarController.ts
git commit -m "feat: add grouped session bulk deletion"
```

### Task 5: Add Worktree Presentation In Project Overview

**Files:**
- Modify: `src/components/workbench/projects/ProjectOverviewPage.tsx`
- Modify: `src/components/workbench/projects/projectOverviewModels.ts`
- Modify: `src/i18n/locales/zh-CN/sidebar.json`
- Modify: `src/i18n/locales/en/sidebar.json`
- Modify: `src/i18n/locales/ja/sidebar.json`
- Modify: `src/i18n/locales/ko/sidebar.json`

**Step 1: Derive worktree list from current projects payload**

Implement worktree derivation from current project metadata.

Expected grouping rule:
- source project overview shows related worktrees
- worktree overview may optionally show its source project context

Do not render worktree rows inside the left sidebar tree.

**Step 2: Render worktree cards/list rows**

Each worktree item should show:
- display name
- branch
- path
- Claude session count
- Codex session count
- last activity

Use compact rows/cards, not a dense table in v1.

**Step 3: Support navigation**

Clicking a worktree item should:
- select the worktree project
- keep projects area in `'project-overview'`
- open the selected worktree's overview page

**Step 4: Validation**

Run:

```bash
npm run typecheck
npm run build
```

Manual check:
- source project overview shows expected worktrees
- clicking a worktree opens that worktree overview rather than chat/terminal
- worktree list does not appear in left sidebar

**Step 5: Commit**

```bash
git add src/components/workbench/projects/ProjectOverviewPage.tsx src/components/workbench/projects/projectOverviewModels.ts src/i18n/locales/zh-CN/sidebar.json src/i18n/locales/en/sidebar.json src/i18n/locales/ja/sidebar.json src/i18n/locales/ko/sidebar.json
git commit -m "feat: show worktrees in project overview"
```

### Task 6: Simplify Sidebar Project Rows And Add Summary Card

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectList.tsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarContent.tsx`
- Create: `src/components/sidebar/view/subcomponents/SidebarProjectSummaryCard.tsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarHeader.tsx`
- Modify: `src/index.css`

**Step 1: Remove heavy always-visible project action cluster**

Reduce the sidebar project row to:
- label
- minimal status indicators
- selected state
- compact expand/collapse affordance only if still needed for sessions during transition

The sidebar should stop being the primary place for rename/star/delete.

**Step 2: Add lightweight summary card**

Create `SidebarProjectSummaryCard.tsx` and show it on:
- hover for pointer users
- focus for keyboard users

Card fields:
- Claude count
- Codex count
- worktree count
- branch
- recent activity
- latest session label
- short path

**Step 3: Ensure keyboard parity**

The card must not be hover-only.

Minimum keyboard behavior:
- card appears on project-row focus
- card disappears on blur
- focus order is preserved

**Step 4: Keep Windows-safe layout**

Adjust CSS for:
- DPI scaling tolerance
- no clipped summary card content
- no tiny hit targets
- no motion-heavy reveal

Avoid hover implementations that depend on pixel-perfect pointer placement.

**Step 5: Validation**

Run:

```bash
npm run typecheck
npm run build
```

Manual check:
- sidebar feels lighter than before
- hover card is readable and stable
- keyboard focus reveals same summary info
- row density still works with long project names and paths

**Step 6: Commit**

```bash
git add src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx src/components/sidebar/view/subcomponents/SidebarProjectList.tsx src/components/sidebar/view/subcomponents/SidebarContent.tsx src/components/sidebar/view/subcomponents/SidebarProjectSummaryCard.tsx src/components/sidebar/view/subcomponents/SidebarHeader.tsx src/index.css
git commit -m "feat: simplify project rows and add summary card"
```

### Task 7: Integrate Final Flow And Run Full Manual Smoke

**Files:**
- Modify: `src/components/app/AppContent.tsx`
- Modify: `src/components/workbench/projects/ProjectsSidebarPanel.tsx`
- Modify: `src/components/workbench/MainContentRouter.tsx`
- Modify: `src/hooks/useProjectsState.ts`

**Step 1: Remove stale assumptions about project click landing in workspace**

Review all project-selection entry points and make sure none still force workspace unless a session is actually selected.

Check:
- app startup
- project click from sidebar
- worktree click from project overview
- refresh after delete or rename

**Step 2: Ensure last used session and selected project stay coherent**

Make sure project overview never shows session actions for another project due to stale selected state.

If the selected session belongs to a different project than the current overview target:
- show that session only in workspace mode
- do not leak it into the wrong overview page

**Step 3: Full verification pass**

Run:

```bash
npm run typecheck
npm run build
```

Then run the app and manually verify:
- global projects overview still works
- clicking a project opens selected project overview
- continuing the last session opens workspace
- creating Claude/Codex sessions from overview works
- rename/star/delete from overview works
- batch deletion works for both provider groups
- worktree list shows and navigates correctly
- sidebar summary card works on hover and focus
- desktop layout remains stable at common Windows-style scaling widths

**Step 4: Commit**

```bash
git add src/components/app/AppContent.tsx src/components/workbench/projects/ProjectsSidebarPanel.tsx src/components/workbench/MainContentRouter.tsx src/hooks/useProjectsState.ts
git commit -m "feat: finish project overview workflow"
```

## Notes For Implementation

- Do not add advanced session filters in this feature.
- Do not add left-sidebar worktree nesting in this feature.
- Do not add project-page memory for chat/terminal/overview in this feature.
- Prefer extracting view-model helpers over embedding aggregation logic directly in JSX.
- Prefer reusing existing APIs over adding backend endpoints unless an actual blocker appears.
- Keep Windows compatibility explicit in spacing, hover/focus parity, and confirmation flows.

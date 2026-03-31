# Projects Overview Continue-Working Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rework the `Projects` overview into a dense continue-working home that prioritizes global recent sessions, then quick-start actions, then compact project entry points.

**Architecture:** Keep the current workbench routing and project/session data model intact. Implement the new behavior inside the existing `ProjectsOverviewPage` by reshaping derived data and layout, reusing sidebar star state and existing session navigation callbacks instead of introducing new backend APIs.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, `lucide-react`, `react-i18next`, existing OpenWork workbench components/utilities

---

## Constraints And Notes

- There is no dedicated frontend test runner in this repo today.
- Do not introduce Vitest, Playwright, or another new test stack for this slice.
- Safety gates for this work are:
  - `npm run typecheck`
  - `npm run build`
  - manual browser smoke-check of the `Projects` overview screen
- Keep user-facing behavior aligned with the approved design:
  - top priority is `global recent sessions`
  - the page should feel like a work-resume home, not an analytics dashboard
  - keep spacing tighter than the current implementation
- Do not change terminal/chat transport, project/session selection, or backend project APIs in this slice.

### Task 1: Audit And Lock The Current Data Shape

**Files:**
- Inspect: `src/components/workbench/projects/ProjectsOverviewPage.tsx`
- Inspect: `src/types/app.ts`
- Inspect: `src/components/sidebar/utils/utils.ts`
- Inspect: `src/hooks/useProjectsState.ts`
- Inspect: `src/i18n/locales/zh-CN/sidebar.json`
- Inspect: `src/i18n/locales/en/sidebar.json`

**Step 1: Record the actual input data the overview can rely on**

Check these fields and note the fallback order to keep behavior consistent:
- `project.displayName`, `project.name`, `project.path`, `project.fullPath`
- `project.sessions`, `project.codexSessions`
- `session.summary`, `session.title`, `session.name`
- `session.lastActivity`, `session.createdAt`, `session.updated_at`
- `session.__provider`, `session.__projectName`

Expected outcome: a short implementation note in the plan execution log or commit message describing the fallback order used for labels and timestamps.

**Step 2: Confirm Overview only needs frontend-derived state**

Verify that the current callbacks already support the target behaviors:
- `onSelectProject(project)`
- `onSelectSession(session)`
- `onNewSession(project, provider?)`

Expected outcome: no backend/API work added for this slice.

**Step 3: Commit the audited baseline**

```bash
git add docs/plans/2026-03-07-projects-overview-continue-working-plan.md
git commit -m "docs: add projects overview implementation plan"
```

### Task 2: Rebuild Overview-Derived Session And Project Collections

**Files:**
- Modify: `src/components/workbench/projects/ProjectsOverviewPage.tsx`

**Step 1: Extract the page's pure helper logic to the top of the file**

Add small, file-local helpers for:
- global recent-session aggregation across Claude and Codex
- stable timestamp resolution per provider
- compact session label resolution
- recent project sorting by latest session activity
- starred project filtering that reuses `loadStarredProjects()`

Keep them in the same file unless the file becomes obviously unmanageable.

**Step 2: Replace the current “stats/environment-heavy” derivations with continue-working derivations**

Implement derived collections for:
- `recentSessions`: global, cross-project, newest first, capped for first-screen usability
- `primaryProject`: current best target for quick-start actions
- `starredProjects`: compact set for direct project entry
- `recentProjects`: compact set sorted by latest activity

Expected behavior:
- no analytics cards or synthetic readiness metrics remain in the primary reading path
- if timestamps are missing, sorting degrades safely instead of crashing

**Step 3: Verify the file still type-checks before layout changes**

Run:
```bash
npm run typecheck
```

Expected: PASS with no new errors from `ProjectsOverviewPage.tsx`.

**Step 4: Commit**

```bash
git add src/components/workbench/projects/ProjectsOverviewPage.tsx
git commit -m "refactor: derive continue-working overview data"
```

### Task 3: Redesign The Main Overview Layout Around Recent Sessions

**Files:**
- Modify: `src/components/workbench/projects/ProjectsOverviewPage.tsx`

**Step 1: Replace the current top hero with a recent-sessions-first layout**

Implement a first section that:
- leads with a short heading and compact supporting copy
- renders global recent sessions as the dominant block
- gives each row a clear click target into the session
- shows project name, provider, and relative time without large empty gaps

The recent-session row should feel dense and operational, not card-heavy marketing UI.

**Step 2: Add a compact quick-start block directly under or beside recent sessions**

Quick-start actions should include:
- new Claude session
- new Codex session
- open project terminal or shell-oriented workspace target
- create project

Behavior rules:
- use `primaryProject` if available for provider launches
- if no project exists, the create-project action should remain the obvious first move
- avoid long explanatory text

**Step 3: Move starred projects and recent projects into secondary, tighter sections**

Render them as compact entry lists/cards with:
- project label
- one-line path summary
- optional last-activity hint

Do not let these sections dominate the first screen over recent sessions.

**Step 4: Remove or demote the old environment/stats block**

Delete the “dashboard-like” count cards unless one tiny supporting summary remains genuinely useful. The approved direction is a resume-work home, not a metrics panel.

**Step 5: Run visual safety checks**

Run:
```bash
npm run typecheck
npm run build
```

Expected: both PASS.

**Step 6: Commit**

```bash
git add src/components/workbench/projects/ProjectsOverviewPage.tsx
git commit -m "feat: redesign projects overview for continue-working flow"
```

### Task 4: Add Missing Copy And Provider Presentation Details

**Files:**
- Modify: `src/i18n/locales/zh-CN/sidebar.json`
- Modify: `src/i18n/locales/en/sidebar.json`
- Optional parity follow-up: `src/i18n/locales/ja/sidebar.json`
- Optional parity follow-up: `src/i18n/locales/ko/sidebar.json`

**Step 1: Add or rename overview copy for the new hierarchy**

Add concise strings for things like:
- overview heading/subheading
- recent sessions label
- quick start label
- no recent sessions empty copy
- no projects empty copy
- provider chip labels if needed
- direct actions such as “Continue”, “Open terminal”, “Create project”

Keep copy short and operational.

**Step 2: Align provider naming across session rows and quick-start actions**

Use stable labels that match the rest of the product:
- `Claude`
- `Codex`

If provider pills are introduced, ensure their colors/shapes stay subtle and readable.

**Step 3: Run type/build validation after locale edits**

Run:
```bash
npm run typecheck
npm run build
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/i18n/locales/zh-CN/sidebar.json src/i18n/locales/en/sidebar.json src/i18n/locales/ja/sidebar.json src/i18n/locales/ko/sidebar.json
git commit -m "feat: add continue-working overview copy"
```

### Task 5: Manual Smoke Check In Browser

**Files:**
- Verify only: `src/components/workbench/projects/ProjectsOverviewPage.tsx`
- Verify only: `src/components/app/AppContent.tsx`
- Verify only: `src/components/workbench/MainContentRouter.tsx`

**Step 1: Start the app locally**

Run:
```bash
npm run dev
```

Expected: server and Vite client both start successfully.

**Step 2: Verify core overview flows in the browser**

Manual checks:
- click `Projects` in the activity bar and confirm the main panel opens directly to the overview
- confirm the first screen prioritizes recent sessions rather than stats cards
- click a recent session and confirm it opens the matching project/session
- click a starred project and confirm it opens the project workspace
- click quick-start Claude and Codex actions and confirm they target a sensible project when available
- verify empty states with low/no session data still look intentional
- verify no long smooth scroll animation occurs on entry

**Step 3: Record regressions, fix, and rerun validation**

If anything breaks, fix it immediately and rerun:
```bash
npm run typecheck
npm run build
```

**Step 4: Commit final verified state**

```bash
git add src/components/workbench/projects/ProjectsOverviewPage.tsx src/i18n/locales/zh-CN/sidebar.json src/i18n/locales/en/sidebar.json src/i18n/locales/ja/sidebar.json src/i18n/locales/ko/sidebar.json
git commit -m "test: verify projects overview continue-working flow"
```

## Expected End State

After completing this plan:
- `Projects` opens to a compact continue-working home
- the first visual priority is global recent sessions
- quick-start actions are obvious but secondary
- starred/recent projects remain easy to reach without crowding the main flow
- no fake environment dashboard dominates the page
- the change is verified through typecheck, build, and manual browser smoke

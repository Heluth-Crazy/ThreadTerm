# Projects Workspace Alignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align the Projects sidebar and in-project workspace shell with the OpenWork workbench rhythm without changing project/session behavior or tool functionality.

**Architecture:** Keep the existing routing and project/session flows intact, then apply a medium-touch UI alignment pass in two places: the `ProjectsSidebarPanel` header area and the `MainContent` workspace shell. Reuse existing components wherever possible so `Chat`, `Terminal`, `Files`, `Git`, and `Hybrid` keep their current internals.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, i18next, Vite

---

### Task 1: Refine the Projects Sidebar header and overview entry

**Files:**
- Modify: `src/components/workbench/projects/ProjectsSidebarPanel.tsx`
- Modify: `src/i18n/locales/zh-CN/sidebar.json`
- Modify: `src/i18n/locales/en/sidebar.json`
- Modify: `src/i18n/locales/ja/sidebar.json`
- Modify: `src/i18n/locales/ko/sidebar.json`

**Step 1: Review the current Projects sidebar component**

Open `src/components/workbench/projects/ProjectsSidebarPanel.tsx` and note which parts are only top-level framing versus the embedded legacy `Sidebar` component.

**Step 2: Add the missing i18n keys for the Projects sidebar header copy**

Add concise strings for:

- projects domain title
- short helper description
- overview entry helper label if needed

Keep the copy operational and compact across all four locale files.

**Step 3: Replace the thin top strip with a compact workbench-style header block**

Update `ProjectsSidebarPanel.tsx` so the top area includes:

- a small eyebrow or domain label
- a compact title
- a short helper sentence
- a stronger `Overview` button with consistent rounded corners, hover, and active state

**Step 4: Preserve sidebar behavior exactly**

Verify the component still passes the same `sidebarProps` into the embedded `Sidebar` and still routes to overview only through `onSelectOverview`.

**Step 5: Run static validation for this task**

Run: `npm run typecheck`
Expected: PASS

### Task 2: Add a unified workspace shell around MainContent

**Files:**
- Modify: `src/components/main-content/view/MainContent.tsx`
- Inspect: `src/components/main-content/view/subcomponents/MainContentHeader.tsx`
- Inspect: `src/components/main-content/view/subcomponents/MainContentStateView.tsx`

**Step 1: Inspect existing height and overflow expectations**

Read `MainContent.tsx`, `MainContentHeader.tsx`, and `MainContentStateView.tsx` to identify where `h-full`, `flex`, `min-h-0`, and `overflow-hidden` must be preserved.

**Step 2: Introduce a subtle workspace shell for non-empty project views**

Update `MainContent.tsx` so `shell`, `chat`, `files`, and `git` share a consistent outer frame with:

- compact page padding
- a unified top section around `MainContentHeader`
- a content surface with matching radius/border/background

Do not change the selected tab logic.

**Step 3: Keep inner tool containers height-safe**

Ensure each active tool branch still uses `min-h-0` and `overflow-hidden` appropriately so the tool surfaces do not clip or collapse.

**Step 4: Leave hybrid mode special**

Do not force `hybrid` into the same card shell if it breaks density. Keep its special-case behavior while aligning only the safe outer framing if necessary.

**Step 5: Run static validation for this task**

Run: `npm run typecheck`
Expected: PASS

### Task 3: Align empty/loading state framing with the workbench shell

**Files:**
- Modify: `src/components/main-content/view/MainContent.tsx`
- Inspect: `src/components/main-content/view/subcomponents/MainContentStateView.tsx`

**Step 1: Review how empty/loading states are currently inserted**

Confirm whether the states render outside or inside the workspace shell and whether they visually break the rhythm compared to overview pages.

**Step 2: Adjust only the outer framing**

Wrap or position `MainContentStateView` so loading and empty project states inherit the same outer page rhythm without changing their internal copy or logic.

**Step 3: Verify no empty-state regressions**

Check that the empty state still appears when there is no selected project and `activeTab !== 'hybrid'`.

**Step 4: Run static validation for this task**

Run: `npm run typecheck`
Expected: PASS

### Task 4: Run browser smoke for Projects domain flow

**Files:**
- No code changes required unless issues are found

**Step 1: Start the development server**

Run: `npm run dev`
Expected: frontend at `http://localhost:5174/` and backend at `http://localhost:3002/`

**Step 2: Verify Projects overview to workspace handoff**

Open the app in Chrome and confirm:

- the Projects sidebar top area matches the newer workbench rhythm
- entering a project feels visually continuous with the overview page

**Step 3: Verify workspace tabs still render correctly**

Switch through available tabs:

- `Chat`
- `Terminal`
- `Files`
- `Git`

Confirm each still fills the available height and does not gain broken clipping or double scroll containers.

**Step 4: Verify Overview return path**

Use the Projects sidebar `Overview` entry and confirm it still returns to the projects overview page.

**Step 5: Stop the dev server after validation**

Terminate the dev server cleanly.

### Task 5: Final verification and cleanup

**Files:**
- Review: `src/components/workbench/projects/ProjectsSidebarPanel.tsx`
- Review: `src/components/main-content/view/MainContent.tsx`
- Review: locale files changed in Task 1

**Step 1: Run the full validation set**

Run: `npm run typecheck && npm run build`
Expected: PASS

**Step 2: Review the final diff for scope discipline**

Run: `git diff -- src/components/workbench/projects/ProjectsSidebarPanel.tsx src/components/main-content/view/MainContent.tsx src/i18n/locales/zh-CN/sidebar.json src/i18n/locales/en/sidebar.json src/i18n/locales/ja/sidebar.json src/i18n/locales/ko/sidebar.json`
Expected: only Projects-domain alignment changes, no behavior rewrites

**Step 3: Prepare a concise implementation summary**

Summarize:

- what changed visually
- what behavior was intentionally preserved
- what validation passed

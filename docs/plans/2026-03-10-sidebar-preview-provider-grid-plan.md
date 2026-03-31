# Sidebar Preview Provider Grid Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the sidebar project preview card resilient to future provider growth and remove explanatory worktree copy from the selected-project overview page.

**Architecture:** Keep the existing sidebar preview card structure but convert the top stat area from a fixed three-item row into a compact two-column provider grid. Move worktree information into the metadata row, and remove the right-side worktree description copy without changing any data flow.

**Tech Stack:** React 18, TypeScript, Tailwind utility classes, existing sidebar/workbench components, i18n JSON files.

---

### Task 1: Refactor Sidebar Preview Stat Layout

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx`

**Step 1: Convert the stat area to a provider-first grid**

- keep compact stat items
- render provider items in a two-column grid
- remove `Worktrees` from the grid

**Step 2: Move worktree info into the metadata row**

- keep the existing worktree badge for worktree projects
- add a compact worktree count label in the metadata row for source projects or shared display
- ensure long labels can truncate safely

**Step 3: Validate compactness**

- ensure the card does not grow excessively
- ensure current Claude/Codex counts still read clearly
- keep hover/focus/expanded preview behavior unchanged

### Task 2: Remove Worktree Explanatory Copy From Project Overview

**Files:**
- Modify: `src/components/workbench/projects/SelectedProjectOverviewPage.tsx`

**Step 1: Remove the section description**

- keep the `Related Worktrees` title
- remove the explanatory subtitle line
- preserve spacing quality after removal

### Task 3: Validate

**Files:**
- Review only touched files

**Step 1: Run checks**

```bash
npm run typecheck
npm run build
```

**Step 2: Manual smoke**

- confirm the sidebar preview card is visually stable
- confirm worktree label no longer overflows
- confirm the right-side worktree section no longer shows the explanatory sentence

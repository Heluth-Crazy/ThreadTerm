# Project Overview And Session Management Design

**Date:** 2026-03-09
**Status:** Approved design
**Scope:** Projects sidebar, project overview page, session management, worktree presentation

---

## Goal

Improve project navigation and project-level management in OpenWork without making the left sidebar heavier.

The new experience should:
- keep the left project list lightweight
- provide quick project insight on hover/focus
- route every project click to a dedicated project overview page
- centralize project actions on the right side
- support grouped bulk deletion of Claude and Codex sessions
- present worktrees in the project overview instead of expanding them in the left sidebar
- remain compatible with macOS and Windows desktop behavior

---

## Problem Statement

The current project list mixes navigation and operations too tightly.

Current issues:
- project rows carry too many inline action icons
- project state is not visible until the user expands and inspects sessions manually
- project click behavior goes directly into workspace context, which is efficient for repeat use but weak for project-level management
- session deletion is single-item only
- worktree relationships can make the left sidebar visually heavy if rendered directly as nested children

The result is a sidebar that is doing too much while the right side is not yet acting as the main project management surface.

---

## Design Principles

1. Keep the sidebar navigational, not operational.
2. Put rich project management on the right side.
3. Make high-value project context visible before opening a workspace.
4. Keep Claude and Codex semantics explicit.
5. Treat worktrees as project structure, not as equal-weight top-level clutter.
6. Avoid interaction models that become fragile on Windows due to dense hover-only actions.

---

## Chosen Approach

Adopt a hybrid model:
- the left sidebar keeps a compact project list
- hover/focus on a project row shows a lightweight project summary card
- clicking a project always opens a project overview page on the right
- the project overview page becomes the single surface for project operations, session management, and worktree navigation

This keeps discovery fast without overloading the sidebar.

---

## Alternatives Considered

### Option A: Hover Card Only

Keep the current click behavior and only add a hover/focus info card.

Pros:
- smallest implementation cost
- almost no navigation model changes

Cons:
- project operations stay scattered
- session bulk deletion still lacks a natural home
- worktree presentation remains unresolved

### Option B: Heavy Hover Card With Actions

Put project stats and actions directly into the hover card.

Pros:
- fewer clicks for project actions

Cons:
- hover surfaces become unstable and crowded
- poor keyboard parity
- higher accidental-trigger risk
- weaker Windows desktop ergonomics when pointer movement is less precise or when focus states are used more heavily

### Option C: Hybrid Sidebar + Project Overview

Add lightweight preview on hover/focus and move project management to a dedicated overview page.

Pros:
- clear separation of concerns
- scalable for future project-level features
- clean place for grouped session deletion and worktree navigation

Cons:
- introduces one more navigation step before entering chat/terminal

Recommendation: Option C.

---

## Information Architecture

### Left Sidebar

The left sidebar remains a compact navigation surface.

Each project row should show only:
- project name
- optional star state indicator
- minimal structural/status hints such as worktree count or activity presence

The following should be removed from the default always-visible row state:
- rename icon
- delete icon
- dense inline action cluster
- worktree child rows

Project rows should support:
- hover summary card on pointer devices
- focus summary card for keyboard navigation
- click to open the project overview page

### Right Side Project Overview

Clicking any project opens a project overview page every time.

This page is the default landing surface for that project and does not remember the previously visited child page.

The overview page should contain four main sections:
- overview metrics
- continue working
- session management
- worktrees

---

## Sidebar Hover/Focus Summary Card

The sidebar summary card is intentionally lightweight and mostly read-only.

Suggested fields:
- Claude session count
- Codex session count
- worktree count
- current branch if available
- recent activity time
- latest session title or last active session label
- short path display

The card should not become a second control panel.

Out of scope for the first version:
- rename from card
- delete from card
- bulk operations from card

Interaction rules:
- show on hover for pointer users
- show on focus for keyboard users
- dismiss on blur / pointer leave
- keep compact enough to avoid covering neighboring rows excessively

Windows compatibility note:
- hover must not be the only access path to project insight
- focus-triggered parity is required
- the card must tolerate lower-resolution scaling and DPI differences without overflowing outside the app window

---

## Project Overview Page Structure

### 1. Overview Metrics

Display project-level summary information:
- project name
- path
- git branch
- whether it is a worktree or source project
- Claude session count
- Codex session count
- worktree count
- last activity timestamp

This section is primarily informational.

### 2. Continue Working

This section provides the fastest re-entry path.

Required content:
- last used session entry
- direct continue action
- recent session shortlist, such as the latest 3 sessions
- quick actions to create a new Claude session or a new Codex session

Constraint:
- although the page always opens as overview, the user should be able to jump into the last used session in one click

### 3. Project Actions

Project operations move out of the sidebar and into the overview page.

Actions:
- rename project
- star / unstar project
- delete project

Design direction:
- actions should be visible but not visually dominant
- destructive action must remain clearly separated and confirmed

### 4. Session Management

Sessions are grouped by provider.

Groups:
- Claude Sessions
- Codex Sessions

Each group shows:
- count
- recent sessions list
- management mode trigger

In normal mode:
- rows are read-only navigation items with metadata
- clicking a row opens that session

In management mode:
- checkbox appears for each session
- group header shows select all / clear / delete selected
- deletion requires confirmation

Bulk deletion scope:
- current project only
- grouped by provider
- no advanced filters in v1

Explicitly not in scope for v1:
- delete by date range
- delete empty sessions only
- delete by status
- cross-project bulk deletion

### 5. Worktrees Section

Worktrees are not rendered as nested items in the left sidebar.

Instead, the project overview shows a dedicated worktrees section.

Each worktree item should display:
- worktree name or label
- branch
- path
- Claude session count
- Codex session count
- last activity

Clicking a worktree item navigates to that worktree's own project overview page.

This keeps the left navigation shallow while preserving project hierarchy.

---

## Data Model Implications

No major backend model rewrite is required if the current project payload already contains:
- `sessions`
- `codexSessions`
- worktree-related metadata such as `isGitWorktree`, `sourceProjectName`, `worktreePath`, `worktreeBaseRoot`, `repoRoot`, or related fields

Frontend-derived view models will likely be needed for:
- project summary counts
- last used session per project
- grouped session management state
- worktree grouping under a source project

Likely derived structures:
- `ProjectSummaryViewModel`
- `ProjectOverviewSessionGroup`
- `ProjectWorktreeSummary`

Selection state for bulk delete should remain local UI state and not pollute project persistence.

---

## Navigation Flow

### Project Click

When the user clicks a project in the sidebar:
- select the project
- clear direct workspace landing behavior
- navigate to project overview
- do not auto-enter chat or shell

### Session Entry From Overview

When the user clicks a recent or grouped session:
- select that session
- navigate into the existing session route
- allow the main content area to switch from overview into the session workspace

### Worktree Entry From Overview

When the user clicks a worktree item:
- select that worktree project
- open that worktree's overview page first
- do not skip directly into chat or shell

---

## Interaction Details

### Project Row Density

The sidebar row should become more compact and less noisy.

Recommended changes:
- remove always-visible trailing action cluster
- keep subtle status indicators only
- preserve clear selected state and hover affordance

### Session Bulk Delete Mode

Recommended model:
- each provider group has a `Manage` action
- entering manage mode reveals checkboxes and group actions
- leaving manage mode clears transient selection

Why this model:
- avoids permanent checkbox noise
- keeps normal navigation fast
- scales well for many sessions

### Confirmation Behavior

For destructive operations:
- project delete remains confirmed
- batch session delete must show count and provider in confirmation copy

Examples:
- `Delete 3 Claude sessions from this project?`
- `Delete 2 Codex sessions from this project?`

---

## Error Handling

### Project Overview Data Issues

If some counts or worktree data are missing:
- show partial overview, not a hard error
- fallback unknown values gracefully
- keep core actions available when safe

### Batch Delete Failure

If batch session deletion partially fails:
- show failure summary
- refresh project sessions afterward
- clear only successfully deleted selections if partial success reporting is available
- otherwise reset manage mode and reload from server truth

### Stale Navigation State

If the last used session no longer exists:
- show overview page normally
- suppress the continue shortcut for that missing session
- do not auto-redirect

---

## Accessibility

Required behaviors:
- hover summary card must also open on focus
- session management controls must be keyboard reachable
- provider groups need clear text labels, not color-only distinction
- selected state, manage mode, and destructive actions must be screen-reader friendly

---

## Windows Compatibility Considerations

This feature must work equally in macOS and Windows desktop builds.

Compatibility constraints:
- no hover-only critical functionality
- keyboard focus must reveal the same summary information as hover
- layout must tolerate Windows font rendering and DPI scaling
- summary cards and overview layouts must avoid pixel-tight spacing that only looks correct on macOS
- destructive actions should not depend on subtle icon affordances alone
- worktree presentation should not rely on drag-heavy interactions or narrow hit areas

Implementation guidance:
- prefer explicit buttons and text labels for project actions in the overview page
- keep the sidebar interaction model simple and stable
- avoid animation-heavy hover panels that feel delayed or jittery on Windows devices

---

## Testing Strategy

### Functional Tests

Need coverage for:
- clicking project opens overview page instead of workspace
- hover/focus summary card displays correct counts
- last used session shortcut opens the correct session
- provider-group manage mode enables multi-select
- grouped batch delete deletes only selected sessions in the selected provider group
- worktree list renders and navigates into the selected worktree overview

### Regression Checks

Need verification that:
- normal session navigation still works
- project rename / star / delete still works after moving UI entry points
- sidebar remains performant with many projects
- Windows desktop layout does not overflow or hide summary content unexpectedly

### Manual Cross-Platform Checks

On both macOS and Windows desktop builds:
- hover card alignment
- keyboard focus card behavior
- project overview default landing behavior
- worktree navigation flow
- batch delete confirmation and refresh behavior

---

## Rollout Scope

### In Scope For V1

- lightweight sidebar summary card
- project click opens overview
- project overview page with metrics and actions
- last used session shortcut
- provider-grouped session management
- grouped bulk delete
- worktree section in overview

### Out Of Scope For V1

- advanced session filtering
- inline sidebar worktree tree view
- drag-and-drop project management
- cross-project session cleanup
- card-level destructive actions
- remembering last visited child page per project

---

## Recommendation Summary

Ship the hybrid model.

This gives OpenWork a cleaner information architecture:
- sidebar for navigation
- overview page for management
- workspace for execution

It directly addresses the current pain points without making the sidebar heavier, and it leaves room for later project-level capabilities while keeping Windows compatibility explicit from the start.

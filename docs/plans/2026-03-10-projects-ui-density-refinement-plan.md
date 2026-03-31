# Projects UI Density Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Tighten the projects sidebar and selected-project overview visual rhythm so they feel denser and cleaner without changing current routing, data flow, or feature scope.

**Architecture:** Keep the current project-overview workflow intact and limit changes to component-level styling, spacing, and interaction treatment. Refine only the already-added sidebar project row/summary-card and selected-project overview components so the UI stays behaviorally stable while becoming more compact and visually consistent.

**Tech Stack:** React 18, TypeScript, Tailwind utility classes, existing workbench/sidebar components, i18n JSON locale files.

---

## Preconditions

There is no dedicated frontend test runner in this repo for this feature area. Validation should use:

- `npm run typecheck`
- `npm run build`
- manual smoke in the running desktop-width browser view

Do not introduce new component systems, layout frameworks, or animation libraries for this pass.

### Task 1: Tighten Selected Project Overview Layout Rhythm

**Files:**
- Modify: `src/components/workbench/projects/SelectedProjectOverviewPage.tsx`

**Step 1: Reduce top-level vertical spacing**

Update the page wrapper and section wrappers to reduce vertical gaps by one density step:

- outer page stack gap
- hero section padding
- grid gap between hero and action column
- gap between the main lower columns

**Step 2: Tighten hero stats and action cluster**

Adjust the header block so stat tiles and action controls feel lighter:

- reduce `StatTile` padding
- tighten label/value spacing inside stat tiles
- normalize button heights in the action area
- slightly flatten secondary action styling so buttons read as controls, not content cards

**Step 3: Tighten section headers and item lists**

For session and worktree sections:

- reduce title/description/content spacing
- reduce row padding slightly
- keep rows readable at common desktop widths
- keep provider badges and metadata legible after tightening

**Step 4: Preserve state clarity**

Ensure the following remain obvious after spacing changes:

- hover row background
- focus-visible affordance
- destructive button state
- selected/manage mode controls

**Step 5: Validate**

Run:

```bash
npm run typecheck
npm run build
```

Manual smoke:

- open a project overview page
- confirm hero area shows more information on first screen
- confirm session lists and worktree list remain readable

### Task 2: Tighten Sidebar Project Row And Summary Card

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectList.tsx`

**Step 1: Reduce project-row weight**

Adjust the project row presentation without changing functionality:

- reduce row internal padding by one step
- slightly reduce icon container weight
- tighten title/path spacing
- keep expand button comfortable to click

**Step 2: Refine summary card density**

Update the lightweight preview card so it reads as a compact summary instead of a second full card:

- reduce card padding
- tighten stat mini-cards
- reduce metadata line spacing
- keep selected/hover/focus preview behavior unchanged

**Step 3: Preserve cross-platform interaction quality**

Check that:

- hover still feels stable
- focus-visible still reveals the same info as hover
- selected state remains visually distinct
- nothing depends on precise pointer placement

**Step 4: Validate**

Run:

```bash
npm run typecheck
npm run build
```

Manual smoke:

- scan multiple sidebar projects at once
- hover/focus a row and inspect summary-card stability
- expand session lists and ensure density changes do not crowd the UI

### Task 3: Normalize Shared Visual Rhythm Between Left And Right Surfaces

**Files:**
- Modify: `src/components/workbench/projects/SelectedProjectOverviewPage.tsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx`
- Modify: `src/index.css` (only if a tiny shared utility/token adjustment is truly necessary)

**Step 1: Compare repeated patterns**

Review the following repeated patterns and normalize their density where appropriate:

- corner radius hierarchy
- border opacity and background layering
- secondary text line height
- button vertical rhythm

**Step 2: Make only minimal shared adjustments**

If repeated classes diverge unnecessarily:

- align them directly in the components, or
- introduce only a very small shared CSS refinement in `src/index.css`

Avoid broad token or theme changes in this task.

**Step 3: Validate visually**

Manual smoke:

- switch attention between left sidebar and right project overview
- confirm both feel like one visual system
- confirm neither side now looks obviously heavier than the other

### Task 4: Locale And Copy Guardrail Review

**Files:**
- Review: `src/i18n/locales/zh-CN/sidebar.json`
- Review: `src/i18n/locales/en/sidebar.json`
- Review: `src/i18n/locales/ja/sidebar.json`
- Review: `src/i18n/locales/ko/sidebar.json`

**Step 1: Verify no new copy is required**

Because this pass is visual-only, confirm no new UI strings are introduced unnecessarily.

**Step 2: If labels are shortened in markup, verify translations still fit**

Check that existing strings still work with tighter spacing and do not cause obvious layout overflow in likely cases.

**Step 3: Validate**

Manual smoke:

- spot-check at least the current primary locale view
- ensure buttons and badges still fit after density changes

### Task 5: Final Validation And Handoff

**Files:**
- Review only the files touched in Tasks 1-4

**Step 1: Run final checks**

Run:

```bash
npm run typecheck
npm run build
```

**Step 2: Final manual smoke checklist**

Confirm:

- project click still opens project overview
- session click still opens workspace
- sidebar preview card works on hover and focus
- project overview first screen is denser but still readable
- provider session management still behaves identically
- worktree section layout remains stable

**Step 3: Prepare concise review summary**

Summarize:

- what visual rhythm changed
- what intentionally did not change
- any residual issues found during manual smoke

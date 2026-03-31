# Projects UI Density Refinement Design

**Date:** 2026-03-10
**Scope:** Projects sidebar project rows, lightweight summary card, selected project overview page

## Goal

On top of the new project-overview workflow, tighten the visual rhythm of the projects UI without changing navigation, data flow, or feature scope. The result should show slightly more useful information per screen while keeping the current card language, readability, and Windows-safe interaction behavior.

## Current Context

The current project overview workflow is already in place:

- clicking a project opens a dedicated project overview page
- clicking a session still enters the workspace
- worktrees are shown on the right-side overview rather than nested in the sidebar
- the sidebar project row can show a lightweight hover/focus summary card

Functionally this is correct. The remaining issue is visual pacing:

- some cards are still thicker than they need to be
- section spacing leaves avoidable empty vertical gaps
- action buttons and stat tiles are slightly heavier than the surrounding information density
- the sidebar preview card still feels a bit like a second full card stacked under the row

## Constraints

This refinement must preserve the current behavior:

- no routing changes
- no changes to project/session/worktree data flow
- no new modules or feature surfaces
- no reintroduction of left-sidebar worktree trees
- no hover-only critical information
- maintain keyboard focus parity and Windows-friendly spacing

## Options Considered

### Option 1: Aggressive compression

Reduce padding, heights, and typography noticeably across both panes.

Pros:
- maximizes information density quickly

Cons:
- high risk of making the workbench feel cramped
- hover/focus states become harder to distinguish cleanly
- more likely to regress Windows scaling comfort

### Option 2: Pure polish

Keep density almost unchanged and focus mostly on border, shadow, and color refinement.

Pros:
- lowest risk
- easiest to land visually

Cons:
- does not materially improve scan speed or first-screen usefulness

### Option 3: Balanced tightening

Slightly reduce spacing and component weight while preserving the existing card-based layout and interaction model.

Pros:
- improves first-screen efficiency without changing structure
- keeps the current OpenWork workbench language intact
- safer for Windows scaling and keyboard usage

Cons:
- less dramatic than a full visual redesign

## Decision

Use **Option 3: Balanced tightening**.

This gives a controlled improvement in scan speed and perceived quality while keeping the current structure stable.

## Design

### 1. Sidebar project list

Keep the current structure of:

- project row
- lightweight summary card on hover/focus/selected
- expandable session list

Refinements:

- reduce project row internal padding by one step
- slightly reduce icon container visual weight
- tighten title/path vertical rhythm
- make the preview card shallower and less “card-inside-card”
- keep summary stats readable but more compact
- preserve strong distinction between `hover`, `focus-visible`, and `selected`

The summary card remains read-only and secondary. It should support scanning, not become a second management surface.

### 2. Selected project overview page

Keep the current page structure:

- top project header / action area
- continue last session card
- provider-grouped session sections
- worktree section and source-project linkage

Refinements:

- reduce vertical gaps between major sections
- tighten stat tile padding and value-to-label rhythm
- make session rows and worktree rows feel more like high-quality list items than heavy cards
- reduce unnecessary whitespace between section title, description, and content
- slightly flatten secondary buttons so actions read as controls rather than content blocks

This should improve first-screen usefulness without changing information hierarchy.

### 3. State treatment

Interaction states should become clearer through rhythm, not louder color.

Rules:

- `hover`: light surface change
- `focus-visible`: explicit ring/outline with clear keyboard affordance
- `selected`: stable background emphasis, stronger than hover but calmer than an active button
- destructive actions remain visually clear but compact

### 4. Windows compatibility

The visual tightening should be conservative enough to survive common Windows desktop scaling.

Requirements:

- no micro-hit-targets
- no clipped text in common content lengths
- no dense hover interactions that require precise pointer placement
- focus parity remains intact for keyboard users

## Non-Goals

This pass will not:

- change any routes or views
- redesign the global visual system
- add new project metrics
- change session-management behavior
- move actions between left and right surfaces
- add animations beyond existing transitions

## Validation

Success criteria:

- the sidebar shows slightly more information without feeling crowded
- the project overview page reveals more useful content on first screen
- section spacing feels tighter and more intentional
- hover/focus/selected states remain easy to tell apart
- `npm run typecheck` and `npm run build` still pass
- manual desktop smoke on the running app shows no layout breakage

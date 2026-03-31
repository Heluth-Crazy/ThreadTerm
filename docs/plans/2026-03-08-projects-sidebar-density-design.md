# Projects Sidebar Density Design

**Date:** 2026-03-08

## Goal

Tighten the visual density and interaction feedback of the Projects tree and session list so the sidebar feels calmer, more deliberate, and better aligned with the new OpenWork workbench rhythm, without changing any displayed information or interaction logic.

## Scope

This pass only affects the Projects sidebar tree area:

- project list header spacing and search rhythm
- project item density and interaction feedback
- session list density and interaction feedback
- inline action affordances for project/session rows

This pass does **not** change:

- what information is shown
- search behavior
- project/session ordering
- expand/collapse logic
- rename/delete/new session behavior
- worktree or branch logic

## Problem Statement

The Projects workbench shell is now more consistent, but the inner project tree still uses looser spacing and mixed interaction styles:

- project rows and session rows are taller than necessary
- hover, selected, and action-reveal feedback vary between rows
- search/header rhythm is slightly looser than the surrounding workbench surfaces
- session subtree indentation and spacing feel more like a legacy utility list than part of the updated workbench

## Recommended Approach

Use a medium-touch visual pass:

- tighten row padding, icon gaps, and vertical spacing
- make hover and selected feedback cleaner and more consistent
- keep all current labels, timestamps, counts, provider markers, and path details visible
- preserve touch targets and action discoverability

## Component Changes

### Sidebar Header

Refine the search area rhythm so it sits closer to the new compact Projects workbench header:

- slightly reduce top margin around the search field
- keep search height readable, but reduce surrounding whitespace
- unify icon/button hover feel with the updated row interaction language

### Project Rows

For desktop project rows:

- reduce vertical padding slightly
- tighten title/path/session-count spacing
- reduce visual heaviness of secondary controls until hover
- make selected state clearer without adding noise

For mobile project rows:

- keep touch-friendly targets, but reduce excess interior spacing
- keep editing and action buttons usable

### Session Subtree

- tighten the left indent and vertical spacing between session rows
- reduce visual looseness between the `New Session` button, existing sessions, and the `load more` control
- keep tree readability intact

### Session Rows

For desktop session rows:

- reduce row height and vertical padding
- tighten title/meta spacing
- make hover/action reveal feel smoother and less abrupt

For mobile session rows:

- keep the delete affordance and active state, but reduce extra slack space

## Interaction Principles

- `hover`: clearer background response, lower visual noise
- `selected`: stable and readable, not flashy
- `processing/active`: keep the indicator, but let the row structure remain dominant
- `row actions`: stay hidden by default on desktop, reveal more cleanly on hover/focus

## Risks

### 1. Over-tightening may hurt readability

We should avoid collapsing rows so far that timestamps, counts, and provider markers feel crowded.

### 2. Hover-only actions may become harder to hit

The action zone must remain easy to target once revealed.

### 3. Session tree indentation can become ambiguous

Any reduction in indent or spacing still needs to preserve project/session hierarchy at a glance.

## Validation

- `npm run typecheck`
- `npm run build`
- browser smoke with:
  - search visible and usable
  - project row hover/selected states intact
  - expand/collapse still working
  - session rows readable with title/time/count/provider still present
  - action buttons still reachable on hover

## Success Criteria

This pass is successful if:

- the sidebar feels denser without feeling cramped
- project and session rows use a more coherent feedback language
- no information disappears
- no project/session behavior changes

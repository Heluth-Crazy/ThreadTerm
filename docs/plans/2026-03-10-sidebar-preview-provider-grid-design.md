# Sidebar Preview Provider Grid Design

**Date:** 2026-03-10
**Scope:** Sidebar project preview card, selected project overview worktree section copy

## Goal

Refine the sidebar project preview card so it can safely scale from the current Claude/Codex counts to future providers such as Gemini, while keeping the preview compact. Remove non-user-facing explanatory copy from the right-side worktree section.

## Problem

The current preview card uses a fixed three-stat layout where `Worktrees` is treated like a peer stat tile. This creates two issues:

- the `Worktrees` label is more prone to overflow in the compact sidebar card
- future providers such as `Gemini` would exceed the practical width of the current fixed row

The right-side worktree section also contains explanatory copy intended for design rationale rather than end-user value.

## Decision

Use a two-column adaptive stat grid for provider counts in the sidebar preview card.

Design details:

- top section becomes a compact provider stat grid
- each provider count uses the same compact stat item structure
- the grid should tolerate 2-4 provider items without redesign
- `Worktrees` moves out of the stat grid and into the lower metadata row
- the lower metadata row continues to show last activity and worktree context
- if the current project itself is a worktree, keep a lightweight worktree badge
- remove the explanatory sentence under `Related Worktrees` on the selected-project overview page

## Non-Goals

This pass does not:

- add Gemini functionality yet
- change project/session/worktree behavior
- change routing or session management
- redesign the full sidebar card

## Validation

Success looks like this:

- the preview card no longer overflows with the current `Worktrees` label
- provider counts are structurally ready for a future Gemini item
- the preview card remains compact and readable
- the right-side worktree section starts directly with content, without internal design commentary

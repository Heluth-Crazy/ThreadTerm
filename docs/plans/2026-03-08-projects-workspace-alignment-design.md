# Projects Workspace Alignment Design

**Date:** 2026-03-08

## Goal

Align the `Projects` domain so the secondary sidebar and in-project workspace feel like one coherent OpenWork surface, while preserving all existing project selection, session selection, tab switching, and tool behavior.

## Scope

This design only covers the `Projects` domain inside the workbench:

- `ProjectsSidebarPanel`
- the in-project main workspace shell that wraps `MainContentHeader` and the existing `Chat / Terminal / Files / Git` areas

This design does **not** change:

- backend or API behavior
- data sources or sorting rules
- project/session selection logic
- tab order
- chat rendering internals
- terminal rendering internals
- file tree behavior
- git panel behavior

## Problem Statement

The workbench now has a clearer information architecture, but the `Projects` domain still feels visually split in two places:

1. The secondary sidebar uses a thin utility layout with a single `Overview` row followed by the legacy project/session sidebar.
2. The in-project workspace switches from the workbench shell into a different visual rhythm, with looser structural continuity between the workbench page system and the actual project tools.

This makes the transition from `Projects Overview` into a specific project feel abrupt, even though the navigation model is now unified.

## Design Principles

### 1. Preserve behavior, improve continuity

The user already approved that this pass is about alignment, not restructuring. We keep the same routes and interactions, and only improve the visual and structural handoff.

### 2. Use OpenWork workbench rhythm, not a VS Code clone

The sidebar structure may echo IDE navigation, but the page design should remain OpenWork-specific: compact, calm, direct, and utility-first.

### 3. Wrap existing tools, do not rewrite them

`Chat`, `Terminal`, `Files`, and `Git` each have existing complexity. This pass should unify their outer container and transitions rather than refactor their internals.

## Recommended Approach

Use a medium-touch alignment pass:

- refine the `ProjectsSidebarPanel` into a denser workbench-side rail with a compact domain header and a stronger overview entry
- add a shared workspace shell around `MainContentHeader` and the active project tab body
- keep `hybrid` as a special case and avoid forcing it into a carded layout if that harms usability

This gives the user a clearly improved sense of continuity without creating regressions in the tool surfaces.

## Component Design

### Projects Sidebar Panel

#### Current

- a border-separated top strip containing only the `Overview` button
- legacy sidebar below

#### Proposed

Keep the legacy sidebar body, but rebuild the top portion as a compact workbench header:

- small `OpenWork` eyebrow or project-domain label
- section title based on `Projects`
- concise helper copy explaining that overview and project sessions live here
- prominent `Overview` entry styled like other workbench navigation entries

Visual adjustments:

- tighter top spacing
- clearer hover/active state
- stronger grouping between the domain header and the project tree
- consistent rounded corners and border rhythm with overview pages

Behavior remains unchanged:

- clicking `Overview` still routes to `projectsView = overview`
- project/session entries still come from the existing sidebar implementation

### In-Project Workspace Shell

#### Current

`MainContent` renders `MainContentHeader`, then directly switches among `shell`, `chat`, `files`, `git`, and `hybrid` views.

#### Proposed

Introduce a lightweight workspace shell inside `MainContent`:

- compact outer page padding matching workbench pages
- a unified top section wrapping `MainContentHeader`
- a consistent content surface for `shell`, `chat`, `files`, and `git`
- matching border radius, border opacity, and background treatment

The shell should create a stronger handoff from project overview into the active tool without changing the actual tool implementations.

### Empty and Loading States

Where `MainContentStateView` is used for project-empty or loading states, align its surrounding spacing and containment with the workbench rhythm so that switching between `overview` and `workspace` does not feel like leaving the same app area.

### Hybrid Mode

`hybrid` remains special.

Reason:

- it behaves like a broader multi-project terminal surface
- it already uses a dedicated layout strategy
- wrapping it too aggressively risks harming density and usability

So this pass only aligns its outer framing where safe and leaves its core layout untouched.

## Data and Routing

No data model changes are required.

No route changes are required.

The implementation should keep using:

- `activeNav`
- `projectsView`
- existing selected project/session state
- existing sidebar callbacks
- existing tab switch behavior in `MainContentHeader`

## Internationalization

This pass should add or update only the strings needed for:

- the refined `Projects` sidebar header copy
- any new compact workspace labels, if introduced

Use the existing locale files:

- `src/i18n/locales/zh-CN/sidebar.json`
- `src/i18n/locales/en/sidebar.json`
- `src/i18n/locales/ja/sidebar.json`
- `src/i18n/locales/ko/sidebar.json`

Prefer concise operational language rather than promotional copy.

## Validation

Minimum validation for this pass:

- `npm run typecheck`
- `npm run build`
- browser smoke on:
  - projects overview to project workspace transition
  - switching between `Chat / Terminal / Files / Git`
  - returning to `Overview`
  - mobile/desktop layout sanity if the changed wrappers affect responsive spacing

## Risks

### 1. Wrapper styles may clip inner tool surfaces

`ChatPanel`, `TerminalGrid`, `FileTree`, and `GitPanel` all expect certain height/overflow behavior. The outer shell must preserve `min-h-0`, `overflow-hidden`, and flex behavior carefully.

### 2. Header padding may create double framing

If the header and body are both carded too heavily, the workspace may feel boxed twice. The shell should be subtle.

### 3. Sidebar changes may compete with the legacy sidebar visuals

The top area must feel like a natural entry point rather than a second unrelated component above the tree.

## Success Criteria

This pass is successful if:

- entering a project feels like a continuation of the same workbench system
- the projects sidebar and project workspace share a consistent visual rhythm
- all existing project/session actions still behave the same
- the user can still move quickly between overview, projects, sessions, and tabs without any new friction

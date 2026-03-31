# Workbench Overview And MCP Visual Design

## Goal

Unify the visual rhythm of the `Projects Overview` and `MCP` workbench pages so they match the denser `Skills` workbench styling without changing behavior, data flow, or API contracts.

## Scope

- Tighten spacing in the overview hero, quick-start, and project/session list sections.
- Strengthen visual hierarchy in the MCP page with clearer provider headers, counts, chips, and action grouping.
- Keep existing translations, navigation, and save/load flows unchanged.

## Approach

### Option A: Light CSS token pass

Only adjust padding, gaps, and border radii in-place.

Pros:
- Low risk
- Fastest to ship

Cons:
- Does not improve hierarchy enough
- Leaves pages feeling visually inconsistent with `Skills`

### Option B: Component-level hierarchy polish

Adjust spacing and also reorganize headers, badges, and action clusters within the existing components.

Pros:
- Better visual consistency with current workbench direction
- No changes to backend or routing
- Clearer information density without introducing new concepts

Cons:
- Slightly larger JSX edits

### Option C: Shared workbench shell extraction

Create new shared layout primitives for all workbench pages.

Pros:
- Strong long-term consistency

Cons:
- Too large for this pass
- Higher regression risk

## Recommendation

Use Option B. It provides visible improvement now while keeping risk contained to existing view components.

## Planned Changes

### Projects Overview

- Compress hero spacing and nested panels.
- Make quick-start feel like a compact utility rail, not a secondary landing page.
- Tighten session/project rows and align empty states with the new card rhythm.
- Normalize section spacing between starred and recent project sections.

### MCP

- Treat provider sections more like operational workspaces with clearer counts and action buttons.
- Improve server row hierarchy using badges and metadata grouping.
- Make the top page header match the denser workbench style used in `Skills`.
- Tighten form container spacing and action footer rhythm.

## Validation

- `npm run typecheck`
- `npm run build`
- Frontmost Chrome smoke check for:
  - Chinese overview page
  - Chinese MCP page
  - English overview page
  - English MCP page

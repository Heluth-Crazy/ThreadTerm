# Settings Workbench Visual Design

## Goal

Bring the embedded Settings workbench into the same visual system as Projects Overview, Skills, and MCP without changing settings behavior, storage, or routing.

## Scope

- Restyle the embedded `Settings` shell used by the workbench.
- Improve the tab header, content spacing, and footer action rhythm.
- Update a few high-impact child views so they no longer feel visually detached from the workbench.

## Approach

### Option A: Restyle wrapper only

Only change the outer container around the existing settings content.

Pros:
- Very low risk

Cons:
- Inner content still looks inconsistent

### Option B: Wrapper plus key child components

Restyle the embedded shell and the most visible child components used inside it.

Pros:
- Strong visual improvement with contained risk
- Preserves all existing settings logic

Cons:
- Requires touching several view files

### Option C: Rebuild settings workbench from scratch

Create a new workbench-native settings implementation and migrate logic across.

Pros:
- Strongest long-term consistency

Cons:
- Too large and risky for this pass

## Recommendation

Use Option B. Keep the settings logic intact, but bring the embedded shell and its key subviews into the workbench visual language.

## Planned Changes

- Make the embedded settings header and tabs match the current workbench density.
- Convert tab controls into a more deliberate segmented-workspace style.
- Tighten footer actions and save-state messaging.
- Update agent picker, appearance cards, language selector, and git settings cards so they match the workbench panels.

## Validation

- `npm run typecheck`
- `npm run build`
- Frontmost Chrome smoke check for embedded Settings in Chinese and English

# Extensions Overview Refinement Design

## Goal

Refine `Extensions Overview` into a tighter management home that matches the visual rhythm of the rest of the OpenWork workbench, while preserving its role as a lightweight entry page instead of turning it into a dashboard.

## Problems To Solve

The current overview page is functionally correct, but it still feels looser and more presentational than the updated `Skills` and `MCP` pages. The main issues are:

- the page header behaves more like a hero than a workbench header
- the `Skills` and `MCP` cards are not fully parallel in their internal hierarchy
- the `MCP` card still reads like a mini stats block instead of a configuration summary
- the bottom hint area feels more like a generic status panel than a practical next-step area
- some wording still mixes English product labels with localized action language

## Product Direction

`Extensions Overview` remains a lightweight management home:

- it summarizes the current extension state
- it gives the next obvious actions
- it does not become an analytics or reporting dashboard
- it should feel immediately scannable and operational

## Target Structure

### 1. Header

The header should match the density of `Projects Overview`, `Skills`, and `MCP`:

- small product eyebrow
- title
- one short subtitle
- compact refresh action

The top area should consume less vertical space than before.

### 2. Primary Cards

Keep the two-card layout:

- `Skills`
- `MCP`

But make the cards truly parallel in structure:

- title + count badge
- one-sentence explanation
- compact primary and secondary actions
- one focused content block that explains current state

### 3. Skills Card

The `Skills` card should emphasize:

- total skills
- writable roots
- recent updates
- direct path to `Skills` page and skill creation

The recent list should behave like a compact “recently changed entries” block, not a larger showcase area.

### 4. MCP Card

The `MCP` card should emphasize:

- overall configured server count
- Claude and Codex counts
- configuration state rather than abstract “connection status” framing
- direct path to `MCP` page and add flow

The card should read like a config summary, not a metrics tile.

### 5. Guidance Area

Replace the current “status hints” feel with a more practical recommendations area:

- keep at most a few short items
- prefer action-oriented language
- keep one neutral “ready” recommendation even when all states are healthy
- visually align it with the rest of the workbench sections

## Copy Strategy

Chinese copy should avoid unnecessary mixed-language action labels where a localized action is clearer. Product terms like `Skills` and `MCP` can remain where they are part of the actual product concept, but action labels should read naturally in Chinese.

Examples:

- `打开技能`
- `新建技能`
- `打开 MCP`
- `添加 MCP`

The same structural parallelism should be preserved across `zh-CN`, `en`, `ja`, and `ko` locale files.

## Technical Approach

This work stays entirely in the frontend overview layer:

- refine `ExtensionsOverviewPage.tsx`
- lightly refine derived hint semantics in `useExtensionsOverview.ts`
- update locale strings under `workbench.extensionsOverview`

No API, storage, or navigation changes are needed.

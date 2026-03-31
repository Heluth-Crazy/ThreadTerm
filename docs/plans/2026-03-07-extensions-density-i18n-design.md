# Extensions Density and I18n Alignment Design

## Goal

Align the `Skills` and `MCP` workbench pages with the existing OpenWork project-level UI rhythm so they feel like part of the same product, while removing page-level i18n drift and preserving all current data flows and backend APIs.

## Context

The current `Extensions Overview` direction is in place, but the detailed `Skills` and `MCP` pages still feel visually looser than the surrounding workbench. The main issues are:

- page header density is inconsistent with `Projects Overview`
- list cards and form sections use larger spacing than the rest of the workbench
- `SkillEditorPage` and `MCP` editor sections feel like separate mini-apps rather than integrated workbench panes
- some text remains structurally inconsistent across locales, especially around provider labels, field naming, empty states, and page descriptions

The goal is not to redesign the domain from scratch. The goal is to tighten and unify the existing pages.

## Scope

In scope:

- `Skills` page density alignment
- `SkillEditorPage` toolbar, empty state, create state, and edit/preview rhythm alignment
- `MCP` page density alignment
- `MCP` provider card, server row, and form grouping cleanup
- i18n cleanup for `zh-CN`, `en`, `ja`, and `ko`
- preserving the current navigation and creation bridges from `Extensions Overview`

Out of scope:

- backend/API changes
- MCP persistence changes
- skill file format changes
- introducing a new generic component system just for this work
- redesigning the extensions information architecture again

## Design Principles

### 1. Match the existing workbench rhythm

Use `Projects Overview` and the already-landed `Extensions Overview` as the density baseline:

- tighter page headers
- less vertical whitespace between title, subtitle, and actions
- smaller repeated list spacing
- more compact card internals without harming readability

### 2. Keep structure familiar

Do not move core user actions to new places. Existing flows remain intact:

- search, refresh, create in `Skills`
- open/edit/delete and add in `MCP`
- edit/preview/save/delete in `SkillEditorPage`

### 3. Reduce “page within a page” feeling

Both `SkillEditorPage` and the `MCP` form should feel embedded in the workbench pane, not like a full isolated settings screen. The fix is layout tightening and section hierarchy cleanup, not feature removal.

### 4. Treat i18n as product consistency

The problem is not only untranslated strings. It is also naming drift. Provider labels, section titles, action labels, helper copy, and empty states should follow a consistent tone across locales.

## Target UX

### Skills

The left rail remains a dedicated skills list, but with tighter spacing:

- smaller title stack
- search + refresh aligned to the same control rhythm used elsewhere
- new skill action remains prominent but not oversized
- each skill row uses denser metadata and shorter description spacing
- group headers consume less vertical space

The right pane keeps the same functionality, but the editor becomes more workbench-like:

- tighter header and badge spacing
- create-state fields grouped more compactly
- edit/preview controls behave like a toolbar row
- empty state loses excess whitespace
- preview content remains readable but starts higher on the page

### MCP

The page keeps the two-provider structure because it is useful and already understood, but:

- page header becomes denser and aligned with `Skills`
- provider cards become tighter and more list-oriented
- server rows emphasize useful data first: name, provider, transport, scope, command/url
- action buttons keep the current behavior but consume less space
- the create/edit form becomes a tighter grouped pane with a clearer hierarchy

### I18n

All copy under the extensions domain should follow these rules:

- action labels are concise and parallel
- field labels map to product vocabulary already used in OpenWork
- provider labels remain stable across pages
- empty/loading/error copy uses the same tone and sentence style
- locale files stay structurally aligned so future edits do not drift again

## Error Handling

This work should not alter error semantics. Existing save/load/delete failures remain intact. The only change is that visual treatment should be consistent across `Skills`, `MCP`, and overview pages.

## Testing Strategy

Validation should focus on:

- type safety
- production build
- browser smoke tests for `Extensions -> Overview -> Skills/MCP`
- visual checks that creation flows still open correctly
- locale smoke for at least `zh-CN` and `en`

## Implementation Strategy

Use an incremental approach in three slices:

1. unify page shells and density tokens in `Skills` and `MCP`
2. tighten `SkillEditorPage` and `MCP` form internals without changing behavior
3. clean locale structure and verify no user-visible English drift remains in Chinese mode

This keeps the work survivable in a dirty worktree and reduces the chance of breaking stable flows.

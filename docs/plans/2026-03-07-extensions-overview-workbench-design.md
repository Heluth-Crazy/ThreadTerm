# Extensions Overview Workbench Design

## Goal

Add a workbench-native `Extensions Overview` page so clicking `扩展 / Extensions` lands on a meaningful home before entering `Skills` or `MCP`, while keeping the existing `Skills` and `MCP` pages intact.

## User Intent

The workbench should mirror the mental model already established for `项目 / Projects`:
- a top-level workbench domain
- a secondary sidebar with stable subviews
- a main content area that starts from a lightweight overview page

For `扩展 / Extensions`, the overview should not be a decorative landing page. It should act as a compact management home that helps the user decide whether to go to `Skills` or `MCP` next.

## Constraints

- Do not add new backend storage or tables.
- Do not redesign `Skills` or `MCP` behavior.
- Reuse existing APIs for summaries.
- Preserve workbench state persistence across refreshes.
- Keep the page visually aligned with the current `Overview / Skills / MCP / Settings` workbench rhythm.

## Approaches Considered

### Option A: Pure jump page

Create an `Extensions Overview` page with only two large buttons: `Skills` and `MCP`.

Pros:
- Lowest implementation risk
- No additional data loading logic

Cons:
- Low information value
- Feels like an unnecessary extra click layer
- Does not establish `Extensions` as a real workbench domain

### Option B: Lightweight management home

Create an `Extensions Overview` page with two main entry cards and small summary data pulled from existing APIs.

Pros:
- Makes the overview useful immediately
- Keeps implementation bounded
- Supports future extension growth without overbuilding now

Cons:
- Requires some front-end aggregation logic
- Slightly more state handling than Option A

### Option C: Full extension dashboard

Create a richer dashboard with multiple sections, health checks, recommendations, and historical activity.

Pros:
- Most powerful long-term framing

Cons:
- Too large for the current phase
- Requires backend and data model expansion to be meaningful
- High risk of becoming a fake dashboard with low signal

## Recommendation

Use Option B.

This gives `Extensions` a real information architecture and a useful first screen, but keeps the implementation constrained to navigation, front-end data aggregation, and i18n.

## Information Architecture

### Top-Level Workbench Domains

- `项目 / Projects`
- `扩展 / Extensions`
- `设置 / Settings`

### Projects Domain

Keep the current lightweight structure:
- `overview`
- `workspace`

No new project subdomains are introduced in this phase.

### Extensions Domain

Add a stable three-view structure:
- `overview`
- `skills`
- `mcp`

This makes the `Extensions` domain structurally symmetric with `Projects`:
- `Projects` starts at overview and drills into workspace
- `Extensions` starts at overview and drills into skills or MCP

## Navigation Model

### Activity Bar

Clicking `Extensions` should default to `extensionsView = 'overview'`.

### Secondary Sidebar

The `Extensions` secondary sidebar should contain:
- `总览 / Overview`
- `Skills`
- `MCP`

### Main Content

The `Extensions` content router should resolve:
- `overview` -> new `ExtensionsOverviewPage`
- `skills` -> existing `ExtensionsSkillsPage`
- `mcp` -> existing `ExtensionsMcpPage`

### Persistence

Refresh should preserve the current workbench state via the existing `openwork.workbench` localStorage payload.

## Extensions Overview Page

The overview should be a compact management home, not a dashboard.

### Header

- Title: `扩展 / Extensions`
- Subtitle: a short sentence describing this page as the unified home for `Skills` and `MCP`
- Optional primary action kept minimal; avoid clutter

### Primary Cards

#### Skills Card

Show:
- total installed skills
- 1 to 3 recent skills
- small context such as root/provider where useful

Actions:
- `进入 Skills / Open Skills`
- `新建技能 / New Skill`

#### MCP Card

Show:
- total configured MCP servers
- Claude count
- Codex count
- empty-state cue if nothing is configured

Actions:
- `进入 MCP / Open MCP`
- `添加 MCP / Add MCP`

### Bottom Summary Strip

Show 1 or 2 status hints derived from current state, for example:
- skills exist but no MCP is configured
- Claude MCP exists but Codex MCP is empty
- both systems are configured and ready

No charts, no analytics framing, no heavy dashboard widgets.

## Data Strategy

### Skills Summary

Use the existing skills list API and derive:
- total count
- most recent 1 to 3 items
- optional root/provider context

### MCP Summary

Use the existing Claude MCP and Codex MCP APIs and derive:
- total count
- per-provider count
- empty or partial configuration states

### Status Hints

Derive entirely on the front end from the combined summary results.

No new backend endpoints are required in this phase.

## State Model Changes

Extend the existing workbench state with:
- `extensionsView: 'overview' | 'skills' | 'mcp'`

Defaults:
- `activeNav` stays unchanged
- `extensionsView` should default to `overview`

## i18n

Add `Extensions Overview` strings to the `sidebar` namespace for at least:
- `zh-CN`
- `en`

The new overview page should follow the same i18n pattern already used by `Projects Overview`, `Skills`, and `MCP`.

## Error Handling

The overview should degrade gracefully if one summary source fails.

Recommended behavior:
- show inline error state in the affected card if only one source fails
- keep the other card usable
- avoid blocking the entire page if one fetch fails

## Visual Direction

Match the current workbench system:
- compact spacing
- card-based hierarchy
- small summary pills and metadata rows
- no marketing-style hero layout
- no fake analytics widgets

## Validation

### Automated

- `npm run typecheck`
- `npm run build`

### Manual Browser Smoke

Verify in frontmost Chrome:
- clicking `Extensions` opens the new overview by default
- sidebar switches between `Overview`, `Skills`, and `MCP`
- overview renders useful summaries in Chinese
- overview renders useful summaries in English
- existing `Skills` and `MCP` pages remain functional

## Out of Scope

- skill marketplace or remote catalog
- MCP health checks or live daemon monitoring
- new persistence model for extensions
- backend aggregation endpoints
- project-level extension policies

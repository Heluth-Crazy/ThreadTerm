# OpenWork Navigation and Extensions Design

Date: 2026-03-07
Status: Approved
Scope: Web and desktop shell architecture, product naming, extensions management

## Summary

This design upgrades the application from a project-only sidebar layout into an IDE-style workbench branded as `OpenWork`.

The approved direction introduces:
- a VS Code-like `Activity Bar`
- a `Secondary Sidebar` that changes by top-level domain
- a `Main Content` router driven by explicit navigation state
- a new `Extensions` domain containing `Skills` and `MCP`
- complete removal of `MCP` from the Settings information architecture
- product renaming from `claudecodeui`-style naming to `OpenWork`

The goal is to evolve the app from a Claude-centric session panel into a broader agent workbench while preserving the existing project/session runtime and cross-platform compatibility.

## Goals

- Add a top-level navigation model with `Projects`, `Extensions`, and `Settings`
- Keep the current project/session workflow intact under the new shell
- Move `MCP` management out of Settings and into `Extensions`
- Add `Skills` management for Claude Code and Codex skills
- Support creating and editing `SKILL.md` files inside the app
- Keep Windows and macOS behavior aligned by pushing platform-specific logic to the backend
- Rebrand the product as `OpenWork`

## Non-Goals

- No marketplace for remote skills in the first release
- No rich-text skill editor in the first release
- No full route-system rewrite in the first release
- No changes to the existing terminal/chat message transport in this phase
- No worktree redesign in this phase

## Product Naming

The product name should be treated as `OpenWork` across:
- application title
- desktop window title
- build artifacts and packaging labels where practical
- visible UI copy
- documentation and user-facing references

Implementation note:
- the local filesystem checkout directory does not need to be force-renamed by the app
- code identifiers and package names should be migrated selectively and safely rather than by broad destructive replacement
- legacy internal identifiers may remain temporarily where renaming risk is high, but user-facing naming should consistently read `OpenWork`

## Information Architecture

### Top-Level Shell

The application shell becomes a three-part layout:
- `Activity Bar`: a narrow left rail with top-level navigation icons/buttons
- `Secondary Sidebar`: the context-specific navigation/content column
- `Main Content`: detail and work area

Initial `Activity Bar` entries:
- `Projects`
- `Extensions`
- `Settings`

The `Activity Bar` only switches navigation domains. It does not display project trees or settings forms directly.

### Domain Responsibilities

`Projects`
- owns work objects and active workspaces
- includes project overview, project list, and project workspaces

`Extensions`
- owns capability extensions
- includes `Skills` and `MCP`

`Settings`
- owns application preferences and environment configuration
- excludes `MCP`

## State Model

The shell introduces explicit top-level state:
- `activeNav = projects | extensions | settings`

Additional view state:
- `projectsView = overview | workspace`
- `extensionsView = skills | mcp`

Existing project-local state remains:
- `selectedProject`
- `selectedSession`
- `activeTab = chat | shell | files | git | hybrid`

This keeps top-level navigation separate from project workspace tabs.

## Projects Domain

### Projects Landing

Selecting `Projects` opens a project overview page rather than immediately opening a specific project.

The overview page includes:
- quick actions: create/import project, create Claude session, create Codex session
- starred projects
- recent projects
- continue session list across projects
- environment status summary
- empty-state guidance

The page should help users resume work quickly rather than act as an analytics dashboard.

### Secondary Sidebar in Projects

The second column contains:
- search
- an explicit `Overview` entry
- the project list

Existing project list capabilities are preserved where possible:
- starring
- worktree/subproject hierarchy
- session expansion
- new session actions
- rename/delete project actions

Behavior:
- clicking `Overview` returns the main panel to the projects landing page
- clicking a project opens that project's workspace
- clicking a session opens that session directly

### Project Workspace

The current workspace model remains in place under a selected project:
- `chat`
- `shell`
- `files`
- `git`
- `hybrid`

If a project has no active session, the default workspace opens to `chat` with a clear empty state to start a new session.

## Extensions Domain

### Navigation

The second column under `Extensions` contains:
- `Skills`
- `MCP`

The extensions domain is global by default and not tied to a currently selected project.

### Skills

`Skills` becomes a lightweight management surface for installed and user-created skills.

First-release capabilities:
- scan installed skills
- group by source or target agent where practical
- create a new skill
- edit `SKILL.md`
- delete a skill
- create from template
- basic validation
- open containing folder

Recommended editor model:
- file-driven Markdown editing
- optional helper fields/templates
- no rich-text editing in the first release

Main states:
- skill list
- skill detail summary
- skill editor

Important constraint:
- frontend must not hardcode skill directories
- backend should provide discovered skill roots and writable targets for macOS/Windows compatibility

### MCP

`MCP` becomes a first-class extensions page rather than a Settings tab.

Capabilities:
- list configured servers
- add/edit/remove servers
- support `stdio` and `http/sse`
- edit `env`, `scope`, command/url, and raw JSON
- provide status and compatibility hints for Claude and Codex

Migration rule:
- user-facing `MCP` entry points move entirely under `Extensions`
- backend API routes may be reused initially to reduce risk

## Settings Changes

`MCP` is removed from the Settings information architecture.

Required cleanup:
- remove Settings navigation entry for `MCP`
- remove settings-specific MCP copy and tabs
- move or adapt the existing `McpServersContent` into the `Extensions` domain
- keep non-MCP settings intact

## Persistence and Restore

The app should persist and restore:
- `activeNav`
- `projectsView`
- `extensionsView`
- `activeTab`
- last selected project/session where valid

Expected restore behavior:
- refreshing the app returns to the last top-level domain
- if the last domain was `Projects`, restore overview or workspace appropriately
- if the last domain was `Extensions`, restore `Skills` or `MCP`
- if the last domain was `Settings`, restore the last selected settings tab

This addresses prior UX regressions where refreshes or mode switches could unexpectedly return users to terminal-oriented views.

## Compatibility Strategy

### Preserve Existing Runtime Model

To reduce risk, the first release should:
- reuse the existing project/session data model
- reuse current chat/shell/file/git workspace components
- avoid changing the terminal/chat transport layer
- reuse existing MCP backend APIs where practical

### Backend Responsibility

Cross-platform variability should live in the backend, especially for:
- skill discovery paths
- writable skill locations
- file read/write behavior for `SKILL.md`
- path separators and line endings
- MCP config read/write and environment handling

The frontend should operate on structured API responses and text content, not OS-specific assumptions.

## Implementation Architecture

Recommended new shell-level components:
- `AppShell`
- `ActivityBar`
- `SecondarySidebarRouter`
- `MainContentRouter`
- `ProjectsSidebarPanel`
- `ExtensionsSidebarPanel`
- `SettingsSidebarPanel`
- `ProjectsOverviewPage`
- `ExtensionsSkillsPage`
- `SkillEditorPage`
- `ExtensionsMcpPage`

Recommended reuse/migration:
- reuse project list components under `ProjectsSidebarPanel`
- reuse project workspace components inside the routed main content
- migrate `McpServersContent` into the extensions domain
- keep existing settings content except MCP

## Phased Delivery

### Phase 1: Shell
- add `Activity Bar`
- add top-level navigation state
- keep current project workspace functioning

### Phase 2: Projects Domain
- add projects overview page
- add overview entry in the second sidebar
- keep current project/session flows intact

### Phase 3: Extensions Domain
- move `MCP` from Settings to `Extensions`
- implement extensions navigation
- add `Skills` list and basic editor

### Phase 4: Stabilization
- remove leftover settings-side MCP code
- finalize persistence/restore rules
- verify macOS and Windows desktop behavior
- align visible branding with `OpenWork`

## Risks

Primary risks:
- shell state coupled to the current project-only sidebar
- refresh/restore regressions after adding top-level navigation
- incomplete MCP cleanup leaving broken Settings states
- cross-platform skill path handling
- desktop layout/scroll/focus issues after introducing dual sidebars
- over-aggressive renaming of internal identifiers causing regressions

## Validation Focus

Must verify:
- switching between `Projects`, `Extensions`, and `Settings` preserves expected state
- refresh restores the previous top-level domain and subview
- `Extensions -> MCP` fully replaces Settings-based MCP access
- `Skills` can be scanned, created, edited, and saved
- macOS and Windows path handling works for skill management
- desktop and web layout behave correctly with dual sidebars
- user-facing names consistently show `OpenWork`

## Recommendation

Proceed with a VS Code-style shell (`Activity Bar` + `Secondary Sidebar` + `Main Content`) while preserving the current project/session runtime model.

Treat `OpenWork` as the product name everywhere user-facing, and migrate internal names incrementally and safely.

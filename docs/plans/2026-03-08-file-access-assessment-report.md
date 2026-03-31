# File Access Assessment Report

**Date:** 2026-03-08

## Scope

This report covers the phase-1 main path only:

- project file tree and file content flows
- chat file references
- terminal-related file access assumptions
- Git-related file access flows
- command-related file access on the main path
- hidden / legacy modules are cataloged only for cleanup risk, not for first remediation

## Assessment Rules

### File access mode policy target

Future design target:

- user-facing modes: `自动`, `兼容模式`, `高性能模式`
- internal modes: `Auto`, `Terminal First`, `Direct`
- `Auto` platform bias:
  - Windows -> prefer `Terminal First`
  - macOS -> prefer `Direct`

### File type emphasis

Stronger terminal-first candidates:

- code files: `js`, `jsx`, `ts`, `tsx`, `py`, `go`, `java`, etc.
- config files: `json`, `yaml`, `yml`, `toml`, `.env`
- script files: `sh`, `ps1`, `bat`, `cmd`

Lower-priority exceptions for now:

- `sql`
- `md`

### Priority meaning

- `P0`: main-path project file access very likely to fail in the restricted Windows environment; first migration candidates
- `P1`: important but secondary or mixed-mode flows; review after P0
- `P2`: extension/config/legacy areas; catalog now, remediate later

## Main Path Inventory

| Area | User entry | Frontend caller | Backend endpoint / handler | Current access style | File types | Priority | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Project file tree | `Files` tab, chat file picker, mention suggestions | `src/components/FileTree.jsx`, `src/components/chat/ChatPanel.tsx` via `api.getFiles()` | `GET /api/projects/:projectName/files` in `server/index.js` | Direct process-level `getFileTree` with `fsPromises` | Mixed project files | P0 | Core dependency for multiple surfaces |
| Read text file | code editor open | `src/components/CodeEditor.jsx` via `api.readFile()` | `GET /api/projects/:projectName/file` in `server/index.js` | Direct `fsPromises.readFile` | code/config/script/text | P0 | High-risk direct project file read |
| Save text file | code editor save | `src/components/CodeEditor.jsx` via `api.saveFile()` | `PUT /api/projects/:projectName/file` in `server/index.js` | Direct `fsPromises.writeFile` | code/config/script/text | P0 | High-risk direct project file write |
| Binary preview | image/file preview | `src/components/ImageViewer.jsx` | `GET /api/projects/:projectName/files/content` in `server/index.js` | Direct `createReadStream` | images/binary | P0 | Needs separate binary strategy under terminal-first model |
| Create folder | project creation helpers / filesystem browse flows | `api.createFolder()` | `POST /api/create-folder` in `server/index.js` | Direct `fs.promises.mkdir` | directory metadata | P0 | Writes filesystem structure outside current project too |
| Browse filesystem | project creation wizard | `src/components/ProjectCreationWizard.jsx` via `api.browseFilesystem()` | `GET /api/browse-filesystem` in `server/index.js` | Direct access + `getFileTree` | directory metadata | P1 | Main-path adjacent; important for workspace setup |
| Chat file references | chat `@` mention, picker, attached files | `src/components/chat/ChatPanel.tsx` | Uses `GET /api/projects/:projectName/files`, then message send via websocket | Mixed: tree listing is direct, send itself is path-only passthrough | paths only at send time | P0 for picker dependency, low for send path | Sending does not currently read file contents into OpenWork |
| Terminal session workspace access | chat/session terminal use | `src/components/Shell.jsx`, `src/components/terminal-grid/*` | `/shell` websocket in `server/index.js` | Terminal/CLI-driven | provider-owned workspace access | P0 reference path | This is the desired pattern direction |
| Git diff/file content | Git panel diff and file-with-diff | `src/components/GitPanel.jsx` | `server/routes/git.js` | Mixed: git CLI plus direct `fs.readFile/stat` | working-tree files | P1 | Some flows already CLI-driven, but working-tree reads still direct |
| Git status/branch/pull/push | Git panel actions | `src/components/GitPanel.jsx` | `server/routes/git.js` | CLI-driven via `git` spawn/exec | repo metadata | P1 | Lower risk relative to direct file reads |
| Command load/execute | custom `.claude/commands` loading | `server/routes/commands.js` | `POST /api/commands/load`, `POST /api/commands/execute` | Direct `fs.readFile` in server | command markdown/text | P1 | Not provider-native slash commands; main-path adjacent only |

## Detailed Findings

### 1. Project file APIs in `server/index.js` are the highest-risk cluster

The most important current project file endpoints are implemented directly in the main Express server process:

- `GET /api/projects/:projectName/files`
- `GET /api/projects/:projectName/file`
- `PUT /api/projects/:projectName/file`
- `GET /api/projects/:projectName/files/content`
- `GET /api/browse-filesystem`
- `POST /api/create-folder`

These endpoints rely on backend-process filesystem access using `fs`, `fsPromises`, `createReadStream`, and `getFileTree`. In the user's restricted Windows environment, this is the most likely source of encrypted or inaccessible file results.

### 2. Chat send flow is safer than the surrounding picker flow

`src/components/chat/ChatPanel.tsx` currently:

- loads project files through `api.getFiles()` for mention and picker UX
- builds the outgoing message by appending a `Referenced paths:` block
- tells the provider to read file contents from the workspace when needed

So the chat composer itself is not a direct OpenWork file-content reader today. The risky dependency is the file-tree loading that powers the picker and mention UX.

### 3. Terminal path already matches the desired trust model

The terminal stack (`Shell.jsx` plus the `/shell` websocket flow) already works by launching provider or plain shell sessions in the workspace context. That is the closest current pattern to the target architecture for restricted environments.

This is why the recommended migration path is a managed terminal-backed file channel rather than more direct server-side `fs` work.

### 4. Git routes are mixed, not uniformly safe

`server/routes/git.js` is partly safe by architecture because much of it uses `git` CLI execution, but it still contains direct working-tree reads, for example in:

- diff/file preview helpers that call `fs.stat`
- working-tree content reads through `fs.readFile`

These are phase-1 review items, but still secondary to the main `server/index.js` project file endpoints.

### 5. Command routes are still process-level file readers

`server/routes/commands.js` loads command definitions from `.claude/commands` using direct `fs.readFile`. This is not part of the first user-critical path, but it clearly conflicts with the new global principle when those command files live in sensitive workspace locations.

## Current Cleanup Audit Notes

### TaskMaster is not removable by assumption

TaskMaster-related code is still wired into the current repository in multiple places:

- `server/routes/taskmaster.js`
- `server/routes/mcp-utils.js`
- `src/App.tsx` providers
- `src/contexts/TaskMasterContext.jsx`
- `src/contexts/TasksSettingsContext.jsx`
- `src/components/MobileNav.jsx`
- `src/components/sidebar/view/Sidebar.tsx`
- `src/components/TaskMasterStatus.jsx`
- `src/components/TaskIndicator.jsx`
- sidebar list item rendering through `tasksEnabled`

Assessment:

- reachability: still indirectly reachable
- deletion safety: unsafe without dedicated dependency audit
- recommendation: keep in `P2` backlog, do not delete during phase 1

### Skills and MCP are current-product features, not cleanup candidates

The current repository contains active workbench integrations for:

- Skills
- MCP

These are current-product features and must be assessed later for file-access compliance, not treated as stale legacy code.

## Windows Reference Repository Findings

The reference directory `../openwork-source-v1.21.0-20260306-1030` is useful only in a narrow way:

- it contains codex/terminal-oriented handling that may inform terminal-backed migration patterns
- it does **not** represent the current feature source of truth for Skills, MCP, TaskMaster, or current workbench structure

Important finding:

- the reference repository does **not** provide a ready-made migration for the current project file APIs
- the project file endpoints there are still direct server-side file readers/writers in the same general area

So the older repository helps with terminal/session implementation ideas, but not with directly solving the current main-path file API problem.

## Recommended Phase-1 Migration Order

### P0 first

1. `GET /api/projects/:projectName/files`
2. `GET /api/projects/:projectName/file`
3. `PUT /api/projects/:projectName/file`
4. `POST /api/create-folder`
5. `GET /api/projects/:projectName/files/content`

Reason:

- these define the core project file experience
- they directly touch project contents or directory structure
- they are the most likely to fail in the restricted Windows environment

### P1 next

1. `GET /api/browse-filesystem`
2. Git routes that still read working-tree files directly
3. command load/execute file reading for `.claude/commands`

Reason:

- they matter, but they are not the first thing to break the current coding loop once a project is already open

### P2 later

1. Skills file access
2. MCP config file access
3. TaskMaster and hidden-module cleanup review

Reason:

- these need a separate dependency and reachability audit
- they should not block the first file-access foundation

## Proposed Global File Access Mode Contract

### User-facing modes

- `自动`
- `兼容模式`
- `高性能模式`

### Internal modes

- `Auto`
- `Terminal First`
- `Direct`

### Default behavior

- default setting value: `自动`
- `Auto` maps internally by platform:
  - Windows -> prefer `Terminal First`
  - macOS -> prefer `Direct`

### Fallback rule

If a file flow is required to use terminal-backed access and that path is not yet supported, OpenWork should not silently fall back to direct access in restricted mode. The system should surface the limitation and ask the user to decide.

## Managed Terminal File Channel Recommendation

The preferred migration target is not to reuse visible terminal panes directly.

Instead, phase 1 should introduce a dedicated managed terminal-backed file access adapter that can later support operations such as:

- list files
- read text file
- write text file
- create directory
- fetch metadata
- handle binary fetch through a dedicated strategy

Benefits:

- safer for restricted Windows environments
- avoids coupling file operations to visible UI terminal panes
- keeps shell quoting and platform adaptation centralized

## Explicit Deferrals

The following work should remain paused until the file-access foundation is approved:

- chat provider slash-command autocomplete
- deeper expansion of chat file intelligence beyond path references
- broad cleanup of TaskMaster or other hidden modules

## Recommended Next Implementation Entry Point

Start with `GET /api/projects/:projectName/files`.

Reason:

- it is shared by FileTree and ChatPanel file selection
- it will validate the terminal-backed adapter on a read-heavy but controlled operation
- once it is stable, the same adapter can be reused for read/save flows

## Open Questions For User Approval

1. Whether binary file preview should be included in the first implementation batch or deferred until text/directory flows are stable.
2. Whether `browse-filesystem` should remain `Direct` under `Auto` on macOS while becoming terminal-first only on Windows.
3. Whether `.claude/commands` custom command loading should be treated as part of the first restricted-environment migration or left to phase 1.5 after the core project file APIs.

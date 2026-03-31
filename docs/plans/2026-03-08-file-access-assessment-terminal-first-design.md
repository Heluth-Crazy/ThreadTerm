# File Access Assessment And Terminal-First Design

**Date:** 2026-03-08

## Goal

Establish a global file-access policy for OpenWork so project-file operations can avoid Windows encryption failures caused by direct process-level file access, while preserving current product behavior as much as possible and prioritizing the highest-risk user-facing flows first.

## Background

The current project contains many file-access paths implemented through the OpenWork server process using `fs` or `fs/promises`. This is acceptable on the current macOS environment for many workflows, but it conflicts with the user's Windows environment where:

- terminal execution is allowlisted
- unknown process-level file access may return encrypted or inaccessible content

This means OpenWork cannot continue treating process-level file access as the universal default for project files.

## Product Constraint

From this point forward, OpenWork should follow a global rule:

- for project/workspace file operations, prefer terminal-context file access over direct process-level file access
- if a feature cannot be implemented safely under that rule, stop and ask the user before falling back to direct access

Important boundary:

- `sql` and `md` files are currently exempt from the strongest enforcement requirement
- code files, config files, and script files are the strongest candidates for terminal-first handling
- product behavior and feature scope should continue to follow the current repository, not the older Windows reference repository

## Scope

### Phase 1: Assess and design around the main user path

This phase focuses on the highest-priority file-access flows:

- project file tree loading
- project file read/save endpoints
- binary file preview endpoints used by project UI
- chat file reference and mention flows
- terminal-related file access assumptions
- Git routes that read working-tree files directly
- command-related file access on the main path

### Out of immediate remediation scope, but still assessed

These modules must be cataloged, but not immediately rewritten during phase 1 unless they are found to block the main path:

- Skills
n- MCP
- TaskMaster
- hidden or weakly reachable legacy modules

## Current Findings Summary

### 1. Main project file APIs are process-level today

The current repository directly exposes project file operations from `server/index.js`, including endpoints such as:

- `/api/browse-filesystem`
- `/api/create-folder`
- `/api/projects/:projectName/file`
- `/api/projects/:projectName/files/content`
- `/api/projects/:projectName/files`

These use `fs`, `fsPromises`, or `createReadStream` directly in the backend process and are therefore high-risk in the user's Windows encryption environment.

### 2. Chat file references are less dangerous than they first appear

The current chat flow loads the project file tree for mentions and file picking, but message sending currently builds a prompt that only references paths and explicitly asks the provider to read file contents from the workspace when needed.

That means:

- chat send itself is not currently reading project file content into the OpenWork process
- but the surrounding file tree and picker data still rely on direct backend file enumeration

### 3. Git routes are mixed

Many Git flows use `git` commands, which is good because that naturally leans toward terminal/CLI execution. However, some routes still read working-tree files directly using `fs.readFile` and related calls, which makes them candidates for terminal-first migration.

### 4. The Windows reference repository is not the feature source of truth

The older Windows directory appears useful mainly as a reference for codex terminal/session handling. It does not mirror the current repository's full feature surface for Skills, MCP, TaskMaster, and related workbench additions. Therefore:

- current repository behavior is the feature truth
- the Windows directory can only be used as a narrow implementation reference for terminal-oriented access patterns

## Recommended Architecture

### Global File Access Mode

Add a global application setting for file access behavior.

User-facing options:

- `自动`
- `兼容模式`
- `高性能模式`

Internal modes:

- `Auto`
- `Terminal First`
- `Direct`

Behavior:

- `Auto`
  - default user-facing mode
  - internally prefers `Terminal First` on Windows
  - internally prefers `Direct` on macOS unless a flow is explicitly upgraded
- `兼容模式` (`Terminal First`)
  - force terminal-context file access for supported flows
- `高性能模式` (`Direct`)
  - force current direct-access behavior where allowed

This gives the product a safe default for the target Windows environment without forcing all macOS users into a slower path.

### Managed Terminal File Channel

Do not reuse arbitrary visible chat or terminal panes for file operations.

Instead, introduce a managed terminal-backed execution channel dedicated to file access. This channel should:

- run commands inside the project context
- be reusable/persistent enough to avoid excessive startup cost
- expose a narrow structured interface for file operations
- centralize shell quoting, encoding, and OS adaptation

Why this is preferred over reusing visible panes:

- visible panes have session state, provider state, and UX coupling
- background managed channels are more predictable and testable
- file operations need a protocol, not just raw terminal text

### Structured Operation Layer

The managed terminal file channel should not expose raw shell commands to the rest of the app. Instead, OpenWork should create a small internal adapter layer with operations such as:

- list directory / tree
- read text file
- write text file
- ensure directory exists
- fetch binary file safely when supported
- get file metadata

The rest of the app should call the adapter, not shell commands directly.

## Main-Path Migration Strategy

### P0: Must review first

These are the highest-risk flows because they directly touch project files and are likely to break in the Windows encryption environment:

- project file tree endpoint
- project read file endpoint
- project save file endpoint
- create folder endpoint
- binary content endpoint used by image preview

### P1: Review after P0

These are important but secondary because some are already partially CLI-based or are not always triggered in the primary workflow:

- Git routes that read working-tree files directly
- command-related custom file loading on the main path
- browse filesystem for project selection/suggestions

### P2: Catalog now, remediate later

These modules remain in assessment scope but not in first remediation scope unless dependency analysis proves otherwise:

- Skills
- MCP
- TaskMaster
- legacy hidden modules with residual call chains

## Deletion / Cleanup Policy

A hidden feature is not automatically removable.

For any candidate module or route, the assessment must record:

- where it is still imported or called
- whether the user can still reach it indirectly
- whether current functionality depends on it
- whether removal would affect current behavior
- whether it conflicts with terminal-first file-access rules

Only after that analysis should cleanup be proposed.

## Risk Analysis

### 1. Terminal-first is safer but not free

Terminal-backed file access introduces:

- shell quoting and encoding complexity
- platform adaptation work for Windows vs POSIX shells
- extra latency compared with direct `fs`
- structured protocol requirements for reliable parsing

These costs are acceptable if isolated behind a dedicated adapter rather than spread across routes.

### 2. Not every file category needs the same rule

The user explicitly exempted `sql` and `md` from the strongest rule. The design should therefore distinguish between:

- high-risk file categories that should prefer terminal access
- lower-risk categories that may remain direct until proven problematic

### 3. Binary file flows need special handling

Text file operations can be expressed through controlled command output. Binary file access is more complicated and may require base64 or a dedicated transport strategy. This should be called out explicitly rather than hidden behind a naive shell command.

## Settings Design

The file access mode should be added to the current settings experience as a settings block, not as a brand-new navigation section.

Requirements:

- present user-friendly Chinese labels
- keep technical internal mode names clean in code
- explain that `自动` adapts by platform
- explain that `兼容模式` is intended for restricted Windows environments
- explain that `高性能模式` may fail under enterprise encryption policies

## Deliverables For This Planning Cycle

This planning cycle should produce two concrete outputs:

1. a graded assessment of main-path file access flows
2. a remediation plan that introduces global file access mode plus terminal-first migration order

## Success Criteria

This planning work is successful if it results in:

- a clear P0/P1/P2 assessment of current file-access flows
- a consistent global policy for terminal-first file access
- a practical migration order for the highest-risk user path
- a settings design that supports both the restricted Windows machine and future open-source usage
- enough clarity to postpone slash-command chat work until the file-access foundation is no longer likely to cause rework

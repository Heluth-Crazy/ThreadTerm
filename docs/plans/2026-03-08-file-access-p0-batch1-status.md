# File Access P0 Batch 1 Status

**Date:** 2026-03-08

## Completed In This Batch

- Added a shared file access mode contract for project file operations.
- Added frontend request header propagation using `x-openwork-file-access-mode`.
- Added backend mode resolution with these internal values:
  - `Auto`
  - `Terminal First`
  - `Direct`
- Implemented a terminal-backed file tree adapter for:
  - macOS / POSIX shells via `/bin/bash`
  - Windows via PowerShell
- Migrated `GET /api/projects/:projectName/files` to use the new adapter.
- Preserved the existing file-tree response shape used by `FileTree` and chat file references.

## Current Effective Behavior

- `Auto`
  - Windows => `Terminal First`
  - macOS => `Direct`
- `Terminal First`
  - Forces shell-backed file tree enumeration.
- `Direct`
  - Preserves the current direct `fs` path.

## Frontend Storage / Transport

- Local storage key: `openwork-file-access-mode`
- Request header: `x-openwork-file-access-mode`

## Verified In This Batch

- Direct and terminal-backed file trees return matching paths for the current repository at depth 3.
- `npm run typecheck`
- `npm run build`
- `node --check` on touched modules

## Remaining P0 Endpoints

- `GET /api/projects/:projectName/file`
- `PUT /api/projects/:projectName/file`
- `POST /api/create-folder`
- `GET /api/projects/:projectName/files/content`

## Notes

- This batch does not yet expose a settings UI for file access mode.
- This batch does not yet migrate Git working-tree reads or hidden/legacy modules.

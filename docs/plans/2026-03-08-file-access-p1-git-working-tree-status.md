# File Access P1 Git Working-Tree Status

**Date:** 2026-03-08

## Completed In This Batch

- Migrated Git working-tree text reads away from direct `fs.readFile`.
- Added project-root path containment checks for Git working-tree file reads.
- Reused the shared file access mode header in Git routes.
- Returned `X-OpenWork-File-Access-Mode` on Git responses that read current working-tree files.

## Routes Updated

- `GET /api/git/diff`
  - untracked file diff generation now reads file content through the file-access adapter
- `GET /api/git/file-with-diff`
  - current working-tree content now reads through the file-access adapter
- `POST /api/git/generate-commit-message`
  - untracked-file content fallback now reads through the file-access adapter

## Verified In This Batch

- `GET /api/git/diff` smoke-tested with a temporary Git repository and an untracked file in `Terminal First` mode
- `GET /api/git/file-with-diff` smoke-tested with a temporary Git repository and an untracked file in `Terminal First` mode
- `node --check server/routes/git.js`
- `npm run typecheck`
- `npm run build`

## Remaining Git File-System Usage

- `fs.stat`
  - still used to distinguish directories from files before generating editor/diff responses
- `fs.rm` / `fs.unlink`
  - still used for discard and untracked delete flows

## Residual Risk

- Git routes still contain historical project-path fallback logic that can mis-handle paths containing `-` when the normal project resolution path is bypassed.
- Directory detection inside Git routes still depends on direct process-level stat calls.
- Delete/discard flows are not migrated yet because this batch only targeted working-tree reads.

# File Access P0 Batch 2 Status

**Date:** 2026-03-08

## Completed In This Batch

- Migrated `POST /api/create-folder` to the shared file-access adapter.
- Migrated `GET /api/projects/:projectName/file` to the shared file-access adapter.
- Migrated `PUT /api/projects/:projectName/file` to the shared file-access adapter.
- Migrated `GET /api/projects/:projectName/files/content` to the shared file-access adapter.
- Added shared project-path resolution and error mapping in `server/index.js` for these endpoints.
- Added terminal-backed helpers for:
  - read text file
  - write text file through shell stdin
  - create directory
  - read binary file as base64 then decode in server memory

## Important Behavior

- In terminal-first mode, file writes no longer place file content onto the shell command line.
- Text content is written through shell stdin to avoid command-length issues on Windows.
- Binary file responses now buffer in server memory when terminal-first mode is active.

## Verified In This Batch

- Adapter smoke test for both `Direct` and `Terminal First`:
  - create directory
  - write text file
  - read text file
  - read binary file
  - list file tree
- Error-path smoke test for both modes:
  - missing parent directory
  - missing file
- `npm run typecheck`
- `npm run build`
- `node --check` on touched server modules

## Residual Risk

- Terminal-first binary reads are currently buffer-based, not streamed.
- Very large binary previews may need a follow-up transport strategy.
- Settings UI for file access mode is still not exposed yet.

## Next Recommended Work

- Expose file access mode in Settings.
- Continue P1 migration for Git working-tree direct reads.
- Assess whether `browse-filesystem` should also move to the same adapter in the next batch.

# File Access Follow-up Status

**Date:** 2026-03-08

## Completed In This Follow-up Round

- Finished migrating remaining Git working-tree reads to the shared file-access adapter.
- Finished migrating Git working-tree directory detection and delete flows to the shared file-access adapter.
- Added file access mode controls to Settings > Appearance.
- Added i18n strings for the new settings block in:
  - English
  - Simplified Chinese
  - Japanese
  - Korean
- Migrated `GET /api/browse-filesystem` to the shared file-access adapter.

## Verified In This Round

- Adapter smoke test for path info and deletion in `Direct` and `Terminal First`
- Git route smoke test for:
  - `GET /api/git/diff` on an untracked file in `Terminal First`
  - `GET /api/git/file-with-diff` on an untracked file in `Terminal First`
  - `POST /api/git/delete-untracked` on an untracked directory in `Terminal First`
- `node --check` on touched server modules
- `npm run typecheck`
- `npm run build`

## Remaining Residuals

- `server/index.js` still contains the old local `getFileTree()` helper, but it is no longer used by main-path file browsing routes.
- Git repository validation still uses direct `fs.access` for repository existence checks.
- Historical project-path fallback logic in Git routes still deserves a separate cleanup pass.

# Reveal in ThreadTerm Files: go to the file

## Problem (owner, 2026-11-13)
"reveal in files 应该直接定位到目录为止，现在只是把文件页打开，功能不完善。"
"Reveal in ThreadTerm Files" opens the Files view and stops. It should take the user straight to the file.

Code today: FileWorkspace.tsx (menu item `file-reveal`) dispatches `threadterm:workbench` with `{view:"files"}` and
no path in embedded mode; standalone it only calls setToolsOpen(true). ExplorerView already expands the ancestors of
`activePath` and scrolls the selected row (lines ~83–120), but reveal never hands it the target.

## Required behaviour
1. One click on "Reveal in ThreadTerm Files" does all of the following:
   - opens the Files view if it is closed;
   - loads and expands every ancestor folder of the file;
   - selects the file's row and scrolls it into view;
   - moves keyboard focus to that row, so the arrow keys continue from there.
2. The Files view may already be open, the file may already be selected, or the same reveal may be repeated after
   the user scrolled or collapsed folders. In every case it still reveals again: a reveal is a request, not a state
   change.
3. If the file is hidden by a filter in the Files view, the reveal makes it visible: clear or bypass the filter and
   expand. Never report success while the row is not shown.
4. If the file no longer exists, select and reveal its nearest existing parent folder and show a short notice.
5. Every in-app "reveal in Files" entry point uses the same path-aware request: file tab menu, file bar, Source
   Control rows, search results, Quick Open, and chat or terminal file references if they offer it. Inventory them
   with CodeGraph and a text search, and list them in impact.md.
6. Remote-machine and worktree sessions reveal in their own Files tree, under the same root and provenance rules as
   opening the file. A path outside the workspace root, such as a registered external file, is not offered; keep
   today's rule.
7. Keep everything that works today: the Explorer (OS) reveal action, and active-file auto-reveal when switching tabs.

## Out of scope
OS Explorer reveal, Rust/runtime changes, and visual redesign. Match the existing Mac-style tree rows.

## Acceptance
- Unit tests for the request/ancestor logic.
- An Electron probe that opens a deep file, collapses the tree, and fires Reveal from at least three entry points.
  It asserts that the ancestors are expanded, the row is selected, in the viewport and focused, and that the
  missing-file fallback works.
- `npm run check:fast -- --working-tree` passes, plus the tests `codegraph affected` lists.

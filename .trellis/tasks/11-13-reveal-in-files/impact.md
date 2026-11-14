# Impact (before product edits)

CodeGraph queries run from the indexed main repository, read-only, because tt-reveal is unindexed. Main index includes owner WIP and a .maintenance copy; only renderer paths in tt-reveal will change. No sync/index/build or owner edits.

`codegraph impact <symbol> -d 2` completed for FileWorkspaceInstance, ExplorerView, WorkbenchSideBar, WorkbenchCommand, SessionWorkspace, PaneWorkbench, WorkbenchActions, SourceControlView, SearchView, QuickOpen, PaneWorkspace, fileTabMenuItems, sourceControlMenuItems. New helpers/tests/probe have no pre-existing symbols. Empty test/caller results were checked with text search.

- FileWorkspaceInstance -> FileWorkspace -> Pane, ProjectOverview, SettingsTools; QA editor-navigation-integrated/performance fixtures. Risk: preserve OS reveal, external-file suppression and automatic tab reveal; keep edits localized.
- ExplorerView -> FileWorkspaceInstance/WorkbenchSideBar -> SessionWorkspace. Risk: async request ordering, stale scope results, root/missing ancestor, repeated request focus/scroll, hidden views. Existing filter only suppresses .git; explicit reveal must bypass it without changing normal tree filtering.
- WorkbenchSideBar/WorkbenchCommand -> SessionWorkspace -> App/MachineApp. Risk: open/close lifecycle, inactive worktree/remote scopes, focus only after row render.
- WorkbenchActions/PaneWorkbench -> views and pane/workspace hosts. Risk: callbacks must retain target project/worktree provenance.
- SourceControlView/SearchView/QuickOpen -> sidebar/session/App. Risk: preserve existing open actions; reveal is a shared additive menu action.
- fileTabMenuItems/sourceControlMenuItems -> PaneWorkspace/SourceControlView; tests: contextMenuSurfaceItems.test.ts, workbench/conflictStage.test.ts.

## Entry-point inventory (CodeGraph + literal search)
- FileWorkspace file-reveal (line 1128): sole existing in-app Reveal action, shared file bar/pane surface menu; embedded sends view only, standalone opens tools only.
- PaneWorkspace file tab context menu: send/pin/copy only; add same path-aware reveal for non-external tabs.
- SourceControlView rows: open changes/send/stage/copy/discard only; add reveal via host callback.
- SearchView results: open only; add reveal via host callback.
- QuickOpen workspace results: open only; add reveal, close picker first. External results excluded.
- Chat/terminal references: filesystem.resolve(sessionId, reference) -> openScopedFile -> FileWorkspace; no existing in-app reveal action on reference surfaces (OS reveal remains out of scope). Their opened file menu uses the shared request.
- Remote/worktree opening already resolves projectId/worktreePath. Reveal must carry those exact values, never derive provenance from relative path or local machine OS APIs. External registrations keep action hidden.

No tests found within three hops of ExplorerView. Acceptance adds request/ancestor unit tests and real-runtime Electron regression; affected-file test listing and full check:fast to follow before commit.

Additional impacts before edits: sortEntries and revealTreeRow -> ExplorerView -> its two hosts. revealSelected/standaloneActions not graph symbols; confirmed nested closures by source. onKey/openExplorerMenu traced inside ExplorerView; root fallback must not offer rename/delete of the registered root.
- Final flow investigation: codegraph explore focusedWorkspaceTab/SessionWorkspace/activeFilePath, impact focusedTab (nested binding absent; parent SessionWorkspace impact already recorded). Manual tab activation updates layout.activeTabId while focusTarget keeps last programmatic destination. Read actual active tab in focusTarget pane to preserve auto-reveal after tab clicks. Tests: workspace-tabs/session-file-views already in gate; real alternate-worktree probe reproduces the old stale binding.


## Affected tests and review
- `codegraph affected` over all changed indexed renderer files reports 227 transitive entries. The main index also contains .maintenance mirrors, owner-only file-location tests and prototype support scripts; absent files cannot be run in this worktree. Rust pty_lifecycle is excluded by the explicit no-Rust-work instruction.
- check:fast covers all renderer .test.ts (including revealInFiles), desktop/protocol/sidecar tests, QA unit/bundled tests and visual consistency.
- Supplemental existing suites outside that gate: desktop/src/browser/policy.test.mjs, qa/lib/qa-cleanup.test.mjs, qa/opencode-v2-contract.test.mjs and renderer/src/components/diffRevert.test.mts: 23 passed. qa/chat-draft.test.ts, qa/chat-visual-required.test.ts, renderer/src/bootSplashTimeline.test.mts, renderer/src/components/sessionHistory.test.mts, renderer/src/navigation.test.mts and renderer/src/projectScope.test.mts: 22 passed using the gate's test-bundle approach for extensionless TS imports.
- Read-only review completed for helper/Explorer and all host/menu routing. Corrected scope-state reset, late request cancellation, alternate-tree reset, duplicate Git subscription, picker dismissal and active-tab tracking. No CSS changes; existing Mac-style tree and wb-issue notice reused.

# Design impact analysis (before edits)

Graph queried read-only from ThreadTerm-v3, where the index lives. Its source reflects the owner checkout; actual edits use tt-design source. Maintenance copies in graph output are excluded from this work.

- `WebPreview`: PanelBrowser -> PaneWorkspace -> SessionWorkspace. Risk: native bounds, keyboard forwarding, access controls, browser actions; preserve browser commands and confirmations.
- `usePageCommentPreview`, `PageCommentControls`, `PageCommentForm`: FilePreview, SandboxedHtmlPreview, WebPreview -> FileWorkspace/PaneWorkspace. Risk: cancelling picks must delete only unsaved shots; retain legacy file preview flow unless design option explicitly enabled.
- `ScreenshotMarkup`: WebPreview -> panel/panes. Risk: rasterization geometry, undo, save and cancel; extend tool union/parser atomically with ellipse renderer.
- `MarkupTool`, `parseMarkup`: serializeMarkup and ScreenshotMarkup; tests qa/browser-markup.test.mjs and qa/browser-markup-mount.test.mjs.
- `CommandPalette`: App/MachineApp. Risk: command must target one visible browser, never broadcast to hidden tabs.
- Graph impact commands run for every symbol above with `-d 2` before implementation. No empty caller set treated as unused.

Validation targets: page picker/core tests, review comment tests, browser markup tests, browser native/page-comment probe, new batch Design Mode probe, check:fast, affected graph output.

## Additive Design UI and bridge
- New `DesignToolbar`, `DesignHint`, `DesignNoteCard` graph queries return not found in owner index. New symbols are local additions; callers are PageCommentForm and WebPreview; text searches confirmed no preexisting implementation.
- `pickPageTarget`, `markPageTarget` impact: preview hook, flashPageComment, FilePreview/WebPreview/SandboxedHtmlPreview, desktop registration. Additive optional fields preserve callers.
- `MarkupMark`, `serializeMarkup` impact: ScreenshotMarkup plus parser. Ellipse follows rectangle's normalized two-point geometry.
- Design stylesheet changes geometry of browser-owned selectors only; cg primitives remain untouched.

## QA surface migration
- Ran impact on browser-markup-mount.test.mjs before migrating direct-toolbar lookups to reachable popup items. Retained all 10 tests, including screenshot lifecycle/retry, unchanged glyph identity, Read fencing and Off cancelling pending grants.
- Ran affected for all changed renderer/desktop/protocol files. Graph lists broad protocol dependents and stale .maintenance copies; current production suites are covered by check:fast, with focused native browser probes added separately. No Rust source changed or compilation requested.

## Final integration impacts
- `captureHandoff` -> registerBrowser -> registerIpc/main: temporarily attach only its own leased view while capturing; validate fenced CSS viewport in isolated world. Native capture/navigation/owner tests and new lease restoration test cover the risk.
- `PageShotPacket` -> usePageShotDraft/addPageShotToDraft/ScreenshotMarkup/WebPreview: optional targetRect carries normalized markup bounds in page CSS pixels; existing drafts ignore this additive capture-only field.
- New `markupBounds` -> ScreenshotMarkup -> WebPreview: computes actual mark union instead of full-page note targets; tests include all drawing tools and independent capture/CSS sizes.
- `remoteFiles.persistRemotePageShot` / reviewComments.put -> existing persist-page-shot / attachment.upload/read: remove only the local-vs-remote gate, retain owner/session/root/schema checks and bounded reads. Local and remote promotion tests pass.
- Added `isCurrentPick`, revision guards and note-card async fencing to the already impacted usePageCommentPreview/DesignNoteCard. Delayed-save and delayed-inspector regression tests preserve a newer selection.
- Existing pickPageTarget optional point uses the same native/iframe ownership, sanitizer and screenshot path. Snapshot Shift-click appends to an open note, preserving its body/CSS draft.
- Final `codegraph affected` on all changed production files reported 626 entries, including retired maintenance copies outside this worktree. The current repository credential-free test suites are exercised by check:fast; focused Chromium/native Electron probes cover the actual Design Mode flow. No missing graph caller set was interpreted as unused.

Final point extension impact: pickPageTarget/pickNativePage retain trusted frame/native ownership and the same PagePick sanitizer. Page CSS point coordinates are bounded independently of renderer frame dimensions. Context-only additions keep the existing note shot, avoiding detached capture waits. The renderer merges/deduplicates at most eight targets and preserves note text/styles by stable shot identity.

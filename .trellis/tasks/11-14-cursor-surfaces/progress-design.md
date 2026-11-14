# Track D progress

## Step 1 — pre-edit delivery map
- `usePageCommentPreview` calls `pickPageTarget` through the existing desktop bridge. Desktop validates the trusted frame, executes `pagePickerSource`, bounds all returned page strings with `sanitizePagePick`, and captures the selected crop.
- `PageCommentForm` calls `addPageComment`; `reviewComments.ts` persists a page draft in the existing reviewDrafts store with source/session provenance.
- `PendingComments` reads every screenshot through `readPageShot`, formats untrusted context using `formatReviewComments`, calls `FileCommentsHost.insert`, and releases drafts only after insertion succeeds.
- `SessionWorkspace` supplies that host and targets the existing session composer. Design Send will use the same session submit/queue path; To chat will keep insertion-only behavior.
- Native pages and saved HTML share the picker hook. Keep saved-file comments reachable and preserve pending drafts when Design Mode closes.

## Execution
- D1–D6 implementation underway. Work confined to tt-design. No Rust or dependency install planned.
- The source task explicitly authorizes implementation and commits. Main checkout's task/spec files are read-only references; local artifacts live here.

## D1 — toolbar and entry
- Native browser toolbar now uses one 38px row with back/reload/address, Annotate, one Agent popup, console badge and More. Forward, screenshot, find, developer tools, external browser and legacy review-comment actions remain in More.
- Ctrl+Shift+D is forwarded from native contents and scoped to the browser; palette captures a visible browser host for Toggle Design Mode.
- The 34px hint row uses supplied segmented controls and glyphs, batch switch and Done.

## D2/D3 — picking and note
- Shared picker additions preserve legacy saved-file comment behavior and desktop sanitization. Multi-pick, area modifiers, text edit, six computed styles and inspector bridge are implemented; review is tightening cumulative CSS history and gesture edge cases.
- Native note card has target/component, What should change field, thumbnail, CSS filter/live style preview, To chat and Send/Save. CSS preview refreshes the native snapshot after a change.
- Screenshot markup adds Ellipse and Ctrl+Z while retaining Rectangle/Arrow/Draw/Text and cancellation.

## D4/D5/D6 — delivery/context
- Pending notes use the existing durable review drafts. Send n sends one formatted message through the existing session send/queue admission; To chat retains insertion-only semantics.
- Dedicated sends preserve the user's existing composer text, context and images. Errors retain durable notes. Source-owner routing remains enforced.
- Full multi-element details, computed styles and CSS/text histories travel in the existing formatter. Chat chips open inline or persisted screenshot references via the attachment component.

## Validation underway
- First check:fast passed 12/13 steps; only old toolbar QA selectors failed. Updated all markup mount assertions for overflow/Agent popups; 10/10 now pass with original checks retained.
- Focused picker/core, markup, delivery and formatter suites pass. Electron Design Mode probe and four locale/theme captures are in progress.

## Integration review and final validation
- Reviewed/combined the desktop, delivery and QA subtasks in this worktree. No Rust changes or package installation. Shared cg-* rules and icon map remain unchanged.
- Fixed review findings: cumulative CSS edits and exact revert; live DOM-node replacement; stale note-save/inspector completions; terminal accepted send/queue responses; per-note cleanup receipts; >4 screenshot chips; durable local screenshot attachment promotion; moving/clearing native pins; page CSS viewport for markup geometry.
- Widened native capture investigation to the browser/renderer/occlusion flow (level 3). Diagnostic captures proved the normal occlusion snapshot contained the page while a detached handoff capture contained only the background. The main capture path now temporarily attaches only that leased view for capture and restores it in finally; a focused regression verifies success/error restoration.
- Actual native QA now covers five-note one-message Send, preserved composer draft, CSS before/after and live preview, screenshot assets after deleting transient captures/reloading, batch-off immediate Send, Alt-click To chat, Escape priority, browser shortcut and palette command. Four active-note captures match the supplied control geometry in both languages/themes.
- Final post-open Shift-click support maps snapshot pointer coordinates to page CSS coordinates and extends the existing pick/capture IPC, preserving body/CSS state and immutable provenance.

## Completion
All D1–D6 implementation steps are integrated. The final native probe also verified Shift-clicking a second element while a note is already open retains its text and CSS edits. Point extension returns bounded context through the existing picker IPC and deliberately retains the first screenshot; taking a new screenshot from the detached compositor was the pinpointed cause of the initial point-pick stall. Focused regression proves no capture wait occurs.

Final required check and commit are being recorded with this coherent feature set. No required product gap remains beyond the explicit bounded-input limits and validation scope documented in validation-design.md.

Final state: check:fast passed 13/13 stages (1264 renderer tests and 526 QA tests reported by their runners); native Design acceptance and Chromium picker probes pass. Four full-window active-note captures were visually reviewed. All work is ready in one coherent feature commit.

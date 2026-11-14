# Track D validation

## Scope and environment

Worktree: `D:/project/ThreadTerm/tt-design`, branch `feat/cursor-design-mode`. Owner checkout, tt-mac and tt-cursor were not edited. Graph queries ran against the owner index as instructed. No Rust sources/builds, dependency installation, or process-name kills.

Electron uses the existing `runtime/target-qa/debug/threadterm-v3-runtime.exe`, an isolated Echo ACP plugin/profile, and `TEMP`/`TMP=D:/project/ThreadTerm/tt-qa-temp`. Free physical memory was checked before native probes (over 15 GB). Cleanup stops only owned process handles. No installed/live provider was invoked.

## Verification

- `npm run check:fast -- --working-tree`: 13/13 stages pass. Includes protocol freshness, both typechecks, protocol tests, renderer tests, desktop tests, browser actions, Claude fixture build/tests, QA tests and visual consistency.
- `node qa/design-picker.mjs`: actual Playwright Chromium serialized-picker probe passes. Covers computed styles, multi-pick, Alt-centered geometry, text commit/cancel, CSS edit history/revert, replaced DOM nodes and native pin cleanup.
- `node --test qa/browser-handoff-native.test.mjs`: existing owner/navigation/capture tests plus leased capture success/error restoration.
- `node --test qa/browser-page-comments.test.mjs`: native capture scaling, renderer identity isolation, cancellation and explicit English/Chinese locale flags.
- `qa/browser-markup.test.mjs`: ellipse validation and actual mark bounds; `qa/browser-markup-mount.test.mjs`: all ten previous lifecycle/access checks retained and migrated to the overflow/Agent popups.
- `qa/design-delivery.test.mjs`: one-message batch, failures retain notes, To chat insertion, partial-cleanup retry/subset and mixed new-note delivery.
- `qa/design-note-lifecycle.test.mjs`: a delayed save/inspector cannot clear or overwrite a newer card.
- `node qa/page-comments.mjs --design-mode --rebuild`: actual Electron/runtime integration passes. Five saved pins become exactly one durable user message; Send preserves the existing composer draft. CSS before/after travels with the note. Every screenshot is promoted to the existing session attachment store; all five chips open after reload and after transient capture files are removed. Batch-off Send and Alt-click insertion also pass. Shortcut, palette and two-step Escape pass.

## Visual comparison

Prototype was opened in Playwright Chromium:
- `qa/results/design-mode/prototype-light.png`
- `qa/results/design-mode/prototype-dark.png`

Actual active-note captures at 1440x900:
- `qa/results/page-comments/design-note-en-light.png`
- `qa/results/page-comments/design-note-en-dark.png`
- `qa/results/page-comments/design-note-zh-CN-light.png`
- `qa/results/page-comments/design-note-zh-CN-dark.png`

Compared toolbar/hint order, 38px/34px rows, 24px ghost controls, 304px right-anchored note card, CSS property rows, pending pins, footer and semantic colors. Fixed CSS specificity causing legacy browser geometry and rounded CSS inputs, footer horizontal overflow, and detached-view blank previews. Captures assert no note-card horizontal overflow. The synthetic page itself retains its own colors in either app theme.

No cg-* primitive or glyph was added or restyled. Layout-only surface selectors use the supplied grammar and glyphs.

## Reused delivery path

Desktop picker -> sanitize/capture -> existing reviewDrafts -> formatReviewComments -> FileCommentsHost -> registered Chat submit/queue. To chat uses the existing insert-only path. Screenshot promotion reuses existing persist-page-shot / attachment.upload/read. Per-note delivery receipts prevent accepted messages being repeated after a draft-cleanup error.

## Limits

Voice dictation remains out of scope (Win+H can type into the note field). Context is intentionally bounded (eight picked elements, 300 computed properties, 1000-character text edits). No live authenticated provider or packaged Windows release was tested. The full Rust-inclusive `npm run check` remains the owner's required merge gate; no Rust/runtime source changed here. The older default `qa/page-comments.mjs` iframe scenario predates the native browser; this task's explicit `--design-mode` branch is the native acceptance probe.

Final post-open Shift-click acceptance: the native Electron probe selects the second target on the renderer snapshot with a real Shift modifier, waits for the two-element target line, and asserts the note text is unchanged before Save. The resulting multi-target/CSS note participates in the same five-note send and durable screenshot test. A focused native point-pick test proves this extension does not wait for a detached compositor or replace the existing image.

Final captures use Electron BrowserWindow.capturePage for the whole composited application (including native WebContentsView), rather than a renderer-only Playwright screenshot. The latter intermittently omitted the native snapshot layer during theme switches even though its saved bytes were correct. BrowserWindow captures were inspected in all four language/theme states; the live edited page, two-element target line, CSS before/after and full footer are visible. Final native report passed all five listed acceptance checks with zero console/page errors.

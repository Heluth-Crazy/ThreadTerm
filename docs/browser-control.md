# Browser control in the Windows portable build

Open a project browser page and choose **Agent access → Control → Allow Control**. Codex in that project/worktree can then use ThreadTerm's browser tools to read the page, navigate, click, fill text, hover, press the supported page keys, and select options. Windows administrator elevation is not needed for these operations.

The loaded page must remain visible. Each action targets the current document and an opaque reference from a fresh browser snapshot. Read and Off immediately remove mutation authority. Agent navigation revokes sharing; grant Control again on the destination page before further actions. Stop does not undo a change already sent to the page. A result marked `outcome_unknown` must never be retried automatically.

Ordinary page actions and arbitrary JavaScript evaluation have independent capability gates. Enabling ordinary Control does not silently enable `browser_eval` or remove its separate settings and per-snippet approval requirements.

The native action adapter is validated for the package's pinned Electron 44.3.0. Other Electron versions default to unavailable until their native behavior is validated.

## Verification

`npm run test:browser-actions` covers the native leaf and controller lifecycle. `qa/browser-control-packaged.mjs <absolute ThreadTerm.exe path>` launches an isolated packaged profile and actual runtime, drives the composed MCP through a public scripted ACP peer (with an optional debug-only Codex fixture), verifies all six operations against a real local browser page, and checks revoked grants. It does not use a live model account or claim live model conformance.

The full gate accepts `npm run check -- --release --test-threads=1`; use `CARGO_BUILD_JOBS=1` and `CARGO_PROFILE_DEV_DEBUG=line-tables-only` on low-memory Windows machines. Do not export `RUST_TEST_THREADS` into helper processes.

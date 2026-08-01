# macOS Release Acceptance — WebView Memory Lifecycle

This document is the macOS peer of the Windows sampler. ThreadTerm still uses a
system WebView (WKWebView). The business scenarios in `scenarios.md` are
identical; only process discovery and packaging differ.

## Build

From repo root on macOS:

```sh
npm ci
npm run build
npm run tauri:build -- --bundles app
```

Launch the Release `.app` produced under `src-tauri/target/release/bundle/macos/`.
Do **not** use `tauri dev` or Debug for acceptance numbers.

## Sample

```sh
chmod +x tools/webview-memory-lifecycle/sample-macos.sh
./tools/webview-memory-lifecycle/sample-macos.sh cold-start-t0
./tools/webview-memory-lifecycle/sample-macos.sh hot-state --settle 5,30,120
```

The script records:

- `ThreadTerm` app process RSS / footprint when available
- child `com.apple.WebKit.WebContent`, `GPU`, and related helper processes that
  share the app's process group / parent PID
- process counts by role

## App diagnostics

In the main window Web Inspector:

```js
copy(JSON.stringify(window.__threadtermLifecycleDiagnostics?.(), null, 2))
```

Save alongside the shell sample JSON.

## NSPanel / overlay notes

- selector and float are NSPanel-backed overlays on macOS. Destroy means the
  panel/WebView is torn down through the public overlay API — do not invent
  private KVC hooks for memory recovery.
- Default overlay prewarm on macOS is **on** historically; Batch 3 may change
  cold-start creation policy. For Batch 0 baselines, record the actual window
  set after cold start without pressing overlay hotkeys.

## Required scenarios

Run S0–S6 from `scenarios.md`. Minimum gate for marking the cross-platform
task complete (Batch 6):

- Full Release hot-state comparison vs the pre-opt baseline on the same Mac
- 20-round slope check
- Terminal restore correctness after cold surfaces (Batch 1/2 contract)
- selector / float / settings behavior parity with Windows product semantics

## Report fields

Use `report-template.md`. Explicitly mark any scenario that was **not** run as
`NOT RUN` — never claim pass without a machine report.

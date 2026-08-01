# WebView Memory Lifecycle — Sampling Tools

Release-only memory and resource lifecycle sampling for ThreadTerm
(task `08-01-webview-memory-lifecycle`).

These tools answer: **which painted surfaces are mounted, which WebView roles
exist, and how private memory behaves after cold start, hot usage, and 20
repeat rounds.** They deliberately do **not** launch extra WebViews, open user
files, or walk sensitive content.

## Rules

- Compare **Release** builds only. Debug samples are diagnostic-only.
- On Windows, filter `msedgewebview2.exe` by this app's EBWebView user-data
  directory. Never sum every WebView2 process on the machine.
- Record peak, 5s / 30s / 120s stable values, and the 20-round growth slope.
- Always record business counters (cards, PTY, mounted surfaces, CodeMirror,
  Chat rows) so a memory drop cannot be "explained" by stopping work.

## Windows (one-shot sample)

From the repo root in PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\tools\webview-memory-lifecycle\sample-windows.ps1 -Label cold-start-t0
```

Common options:

```powershell
# Sample three times after idle delays (seconds)
.\tools\webview-memory-lifecycle\sample-windows.ps1 `
  -Label hot-state `
  -SettleSeconds 5,30,120

# Write under a custom artifact folder
.\tools\webview-memory-lifecycle\sample-windows.ps1 `
  -Label round-01 `
  -OutDir docs\artifacts\webview-memory-lifecycle\pre-opt
```

Each run writes:

- `docs/artifacts/webview-memory-lifecycle/<label>-<timestamp>.json`
- a one-line summary to the console

### App-side business counters

With ThreadTerm running (Release), open DevTools on the main window and run:

```js
copy(JSON.stringify(window.__threadtermLifecycleDiagnostics?.(), null, 2))
```

Paste that object into the matching sample JSON under `appDiagnostics`, or save
it next to the sample as `<label>-app.json`.

## macOS (equivalent acceptance)

See `scenarios.md` and `macos-acceptance.md`. Sampling:

```bash
chmod +x tools/webview-memory-lifecycle/sample-macos.sh
./tools/webview-memory-lifecycle/sample-macos.sh cold-start-t0
./tools/webview-memory-lifecycle/sample-macos.sh hot-state --settle 5,30,120
```

## Scenario checklist

Follow `scenarios.md` in order for Batch 0 baselines and Batch 6 re-runs.
Fill `report-template.md` after each full pass.

## Safety

- Scripts only **read** process metrics and optional public diagnostics.
- They must not create windows, click UI, or mutate app state.
- Operator-driven scenarios in `scenarios.md` are the only place that exercise
  selector/float/settings/terminals.

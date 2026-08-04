# WebView Memory Lifecycle — Sampling Tools

Release-only memory and resource lifecycle sampling for the parent runtime
governance task and child WebView lifecycle task.

These tools answer: **which painted surfaces are mounted, which WebView roles
exist, and how private memory behaves after cold start, hot usage, and 20
repeat rounds.** They deliberately do **not** launch extra WebViews, open user
files, or walk sensitive content.

## Rules

- Compare **Release** builds only. Debug samples are diagnostic-only.
- On Windows, seed `msedgewebview2.exe` selection from this app's EBWebView
  user-data directory, then follow only that process tree. Never sum every
  WebView2 process on the machine.
- Record ThreadTerm main/WebView memory separately from owned Claude host/CLI,
  Codex app-server/CLI, and other PTY children. Raw command lines are never
  persisted.
- Record peak, 5s / 30s / 120s stable values, and the 20-round growth slope.
- Always record business counters (cards, PTY, mounted surfaces, CodeMirror,
  Chat rows) so a memory drop cannot be "explained" by stopping work.

## Windows full scenario pass (recommended)

Build and launch ThreadTerm Release, then run:

```powershell
npm run memory:sample:windows
```

The interactive runner walks S0–S6, samples T+0/5/30/120 using elapsed (not
cumulative) settle targets, captures round 1/10/20 stability, and writes
`analysis.md`. It never drives the UI; follow each prompt and prepare the state
described in `scenarios.md`.

If app diagnostics were saved as `<label>.json`, pass their folder directly:

```powershell
.\tools\webview-memory-lifecycle\run-windows-scenarios.ps1 `
  -DiagnosticsDir .\docs\artifacts\webview-memory-lifecycle\app-diagnostics
```

## Windows one-shot sample

From the repo root in PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\tools\webview-memory-lifecycle\sample-windows.ps1 -Label cold-start-t0
```

Common options:

```powershell
# Sample at elapsed T+0/5/30/120 seconds
.\tools\webview-memory-lifecycle\sample-windows.ps1 `
  -Label hot-state `
  -Scenario S1 `
  -SettleSeconds 0,5,30,120

# Write under a custom artifact folder
.\tools\webview-memory-lifecycle\sample-windows.ps1 `
  -Label round-01 `
  -OutDir docs\artifacts\webview-memory-lifecycle\pre-opt

# Merge a saved, read-only app diagnostics snapshot into every process sample
.\tools\webview-memory-lifecycle\sample-windows.ps1 `
  -Label long-chat `
  -Scenario S6 `
  -AppDiagnosticsPath .\long-chat-app.json `
  -SettleSeconds 0,5,30,120
```

Each run writes:

- `docs/artifacts/webview-memory-lifecycle/<label>-<timestamp>.json`
- a one-line summary to the console

Samples use schema v2 and include:

- PID-matched private working set (with an explicit per-process fallback)
- ThreadTerm main + app-specific WebView2 roles
- Claude host/CLI, Codex app-server/CLI, and PTY child counts/memory
- build kind and Git commit when available
- observed peak/final values across the requested settle series
- optional `appDiagnostics`

### App-side business counters

With ThreadTerm running (Release), open DevTools on the main window and run:

```js
copy(JSON.stringify(window.__threadtermLifecycleDiagnostics?.(), null, 2))
```

Save the copied object as JSON and pass it with `-AppDiagnosticsPath`. Do not
manually mutate generated process samples.

## macOS (equivalent acceptance)

See `scenarios.md` and `macos-acceptance.md`. Sampling:

```bash
chmod +x tools/webview-memory-lifecycle/sample-macos.sh
./tools/webview-memory-lifecycle/sample-macos.sh cold-start-t0
./tools/webview-memory-lifecycle/sample-macos.sh hot-state \
  --scenario S1 --settle 0,5,30,120 --app-diagnostics hot-state-app.json
```

macOS uses the same schema and process roles, with RSS instead of Windows
private working set. Compare like-for-like only on the same Mac.

## Analyze samples

```powershell
npm run memory:analyze -- `
  docs\artifacts\webview-memory-lifecycle\windows-release `
  --out docs\artifacts\webview-memory-lifecycle\windows-release\analysis.md
```

The analyzer accepts schema-v2 samples and existing schema-v1 artifacts. Labels
containing `round-N` are used to calculate final/first stable memory and the
linear slope; the acceptance gate is at most 110% after 20 rounds.

## Scenario checklist

Follow `scenarios.md` in order for Batch 0 baselines and Batch 6 re-runs.
Fill `report-template.md` after each full pass.

## Safety

- Samplers only **read** process metrics and optional public diagnostics.
- The analyzer only reads sample JSON and writes the explicitly requested
  report path.
- They must not create windows, click UI, or mutate app state.
- Operator-driven scenarios in `scenarios.md` are the only place that exercise
  selector/float/settings/terminals.

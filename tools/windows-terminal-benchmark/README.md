# Windows Terminal Benchmark Fixtures

These fixtures are for W0 baseline validation of ThreadTerm's current
xterm.js-in-WebView2 renderer on a real Windows desktop.

They do not require the Windows native renderer work. Run them inside a
ThreadTerm terminal and repeat the same scenarios in Windows Terminal for the
control result.

## Requirements

- Local physical Windows machine.
- Physical display attached to the GPU.
- ThreadTerm dev build or packaged build.
- Windows Terminal installed as the control terminal.
- DevTools available in ThreadTerm for WebGL/FPS/Performance capture.

Remote desktop, GitHub Actions, and ordinary VMs are not acceptable for the
visual pass/fail verdict because they change GPU composition and WebView2
rendering behavior.

## Quick Run

From the repo root in PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\tools\windows-terminal-benchmark\run-baseline.ps1
```

The runner captures environment metadata, then pauses before each visual test so
the operator can start DevTools Performance recording or screen recording.

## Individual Fixtures

```powershell
.\tools\windows-terminal-benchmark\capture-env.ps1
.\tools\windows-terminal-benchmark\large-output.ps1 -Megabytes 10
.\tools\windows-terminal-benchmark\large-output.ps1 -Megabytes 100
.\tools\windows-terminal-benchmark\selection-fixture.ps1 -Lines 2500
.\tools\windows-terminal-benchmark\unicode-fixture.ps1 -Repeat 20
```

Record results in `docs/windows-terminal-baseline-report.json`. Raw logs and
screenshots should go under `docs/artifacts/windows-terminal-baseline/`.

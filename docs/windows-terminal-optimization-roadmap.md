# ThreadTerm Windows Terminal Optimization Roadmap

Last updated: 2026-06-20

## Purpose

This document turns the Windows terminal renderer research into an executable
decision and validation chain. It defines how ThreadTerm should measure the
current xterm.js path, validate Windows native hosting, decide whether to pursue
TerminalControl or another native renderer, and keep macOS/Linux behavior stable
while the Windows path is explored.

The companion research report is [windows 环境优化方案](./windows环境优化方案.md).
That report explains why this is a renderer/host problem, not a ConPTY adoption
problem. This roadmap defines what to do next.

## Current Position

ThreadTerm already uses `portable-pty` in Rust. On Windows that means the app is
already on the native pseudoterminal path through `NativePtySystem`. The current
pain is above the PTY layer:

- terminal rendering is `@xterm/xterm` inside WebView2;
- input, selection, scrollback, IME, and text rendering are mediated by the
  browser/WebView renderer;
- advanced product features read terminal state through xterm-facing APIs and
  backend snapshots.

The target decision is therefore not "switch to ConPTY". The target decision is:

1. Keep the current xterm.js renderer and optimize it.
2. Add a Windows-only native renderer path behind a feature flag.
3. Reject native renderer work because hosting, packaging, or API constraints are
   worse than the xterm.js problems.

## Architecture Principles

Use these rules before approving implementation work:

- Native feel follows the rendering-surface boundary. Web/React remains the
  shared product UI, but platform-owned terminal surfaces may diverge when WebView
  cannot meet native text/input requirements.
- Windows native work must be below a stable adapter boundary. Product features
  should not import TerminalControl or xterm objects directly.
- IPC and host geometry updates are public contracts, not incidental calls. Any
  high-frequency boundary must be measured and batched.
- macOS/Linux must keep the current xterm.js path until there is a separate
  reason to change them.
- A Windows native path must always have an xterm.js fallback until production
  data proves fallback is unnecessary.

## Non-Goals

- Do not rewrite the PTY backend first. The existing Rust `portable-pty` path is
  kept unless a spike proves it blocks the selected renderer.
- Do not replace macOS/Linux rendering as part of Windows validation.
- Do not put a live native control into every card in the grid as the first
  implementation. Grid cards should stay snapshot/preview based.
- Do not depend on undocumented TerminalControl internals for product-critical
  buffer inspection.
- Do not remove xterm.js fallback during the validation phases.

## Source Evidence To Keep Current

When this roadmap is revisited, verify these sources again:

- Windows Terminal overview:
  https://learn.microsoft.com/en-us/windows/terminal/
- Windows Terminal WinUI architecture:
  https://blogs.windows.com/windowsdeveloper/2020/09/08/building-windows-terminal-with-winui/
- XAML Islands for desktop apps:
  https://learn.microsoft.com/en-us/windows/uwp/xaml-islands/xaml-islands
- Hosting UWP XAML controls in C++ desktop apps:
  https://learn.microsoft.com/en-us/windows/uwp/xaml-islands/host-standard-control-with-xaml-islands-cpp
- WebView2 windowed vs visual hosting:
  https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/windowed-vs-visual-hosting
- Project PTY creation:
  `src-tauri/src/pty/mod.rs`
- Current renderer:
  `src/components/Shell.jsx`
- Current xterm registry and inspection helpers:
  `src/components/terminal/xtermRegistry.ts`

## Workstreams

### W0: Baseline The Current xterm.js Path

Goal: know whether native renderer work is needed, and establish numbers that a
native candidate must beat.

Scope:

- Measure current xterm.js + WebGL behavior on Windows.
- Keep the PTY backend and existing UI unchanged.
- Record the same metrics on macOS only as a regression guard, not as a native
  renderer target.

Required scenarios:

- 10 MB continuous output.
- 100 MB continuous output.
- High-refresh TUI: `btop`, `htop`, `vim`, `tmux`, or equivalent WSL tools.
- Long selection across more than 2,000 lines.
- Mixed Unicode line set: CJK, emoji ZWJ sequences, Arabic/right-to-left text,
  box drawing, ligatures.
- IME: Microsoft Pinyin, Japanese IME, Korean IME.
- Font clarity at 11 px, 12 px, 13 px, and DPI 100%, 125%, 150%.
- Multi-terminal stress: 1 active terminal plus 8, 16, and 32 cards with
  snapshot previews.

Metrics:

- P50/P95 input-to-echo latency.
- P50/P95 `term.write()` completion latency.
- Output completion time.
- Scroll FPS or frame interval during continuous output.
- CPU, GPU, and memory peak.
- Selection copy correctness.
- IME candidate placement correctness.
- Unicode visual correctness notes with screenshots.

Artifacts:

- `docs/windows-terminal-baseline-report.json`.
- Raw benchmark logs under `docs/artifacts/windows-terminal-baseline/`.
- A short conclusion: "xterm optimization only", "native spike justified", or
  "repeat after instrumentation fixes".

Gate W0:

- If xterm.js meets acceptable UX after low-risk tuning, stop native renderer
  work and pursue xterm optimization only.
- If at least three high-priority pain scenarios remain reproducibly bad, start
  W1.

### W1: Windows Native Host Spike

Goal: prove that ThreadTerm can place and manage a native Windows surface inside
or beside the Tauri/WebView2 window without using TerminalControl yet.

This spike exists to validate the host model before terminal complexity is added.

Scope:

- Windows-only code path guarded by `cfg(target_os = "windows")`.
- A dev-only frontend probe component, not user-facing product UI.
- A native child surface or overlay surface that follows a React placeholder's
  geometry.
- Focus, visibility, z-order, resize, DPI, and teardown behavior.

Do not include:

- TerminalControl.
- PTY process ownership changes.
- Product terminal replacement.
- macOS/Linux changes beyond type-safe no-op stubs if needed.

Validation environments:

- GitHub Actions `windows-latest`: compile, unit tests, command registration,
  no real UI verdict.
- Local Windows desktop or Windows VM: required for actual pass/fail.
- Optional future self-hosted Windows runner: screenshot and interaction
  automation.

Required checks on real Windows:

- The native surface appears at the exact React placeholder bounds.
- It follows resize and reposition within one animation frame budget or within a
  documented measured threshold.
- It hides when the owning card/window hides.
- It does not draw above unrelated modals or menus.
- It does not disappear behind WebView2 unexpectedly.
- It receives and releases keyboard focus correctly.
- Mouse clicks, drag gestures, and scroll events do not leak to the wrong layer.
- DPI changes do not create coordinate drift.
- Teardown leaves no orphan window or process.

Artifacts:

- `docs/windows-native-host-spike-report.md`.
- Screenshots/video from the local Windows run.
- A matrix for z-order, focus, resize, DPI, teardown.
- Any required build/packaging notes.

Gate W1:

- Pass: native surface hosting is stable enough to test a terminal renderer.
  Start W2.
- Conditional pass: hosting is viable only as a separate floating/detail window.
  Start W2 with "detail/float only" scope.
- Fail: native host cannot coexist with Tauri/WebView2 reliably. Stop native
  renderer work and return to xterm optimization.

### W2: Terminal Renderer Candidate Spike

Goal: validate one real Windows native terminal renderer candidate on top of the
host model.

Candidate order:

1. TerminalControl or a maintained Windows Terminal based control.
2. A small custom DirectWrite/Direct2D renderer fed by the existing Rust
   terminal snapshot model.
3. A rejected path document if neither candidate exposes the required APIs.

TerminalControl-specific questions:

- Can it be embedded in the host model selected by W1?
- Can it consume the existing Rust PTY byte stream, or does it require owning the
  child process/session itself?
- If it owns the process, what happens to attachSnapshot, ack/backpressure,
  block parser, mobile bridge, and AI session lifecycle?
- Can theme, font, copy/paste, selection, focus, IME, and resize be controlled
  through stable APIs?
- Can it be packaged without unacceptable Windows App SDK, MSIX, VC runtime, or
  installer constraints?

Required checks:

- Launch one shell in one active card/detail surface.
- Type ASCII, CJK through IME, and paste multiline text.
- Resize while output is flowing.
- Copy selected text.
- Run one TUI app for 30 minutes without focus/input drift.
- Verify the existing xterm path still works when the native flag is off.

Artifacts:

- `docs/windows-terminal-renderer-spike-report.md`.
- Candidate API capability matrix.
- Packaging/runtime dependency matrix.
- Compatibility verdict for existing ThreadTerm features.

Gate W2:

- Pass: native renderer candidate supports the required product path without
  taking over backend ownership in a way that breaks shared features. Start W3.
- Conditional pass: renderer is useful only for a narrow mode, for example a
  Windows-only focused terminal window. Decide whether that product mode is worth
  the maintenance cost.
- Fail: candidate cannot be embedded, cannot be packaged, or breaks shared
  terminal semantics. Stop native renderer work.

### W3: TerminalAdapter Architecture

Goal: introduce the abstraction needed to let xterm.js and a Windows native
renderer coexist.

This stage should be behavior-preserving for the current xterm path.

Required abstractions:

- `TerminalRendererKind`: `xterm` or `windows-native`.
- `TerminalAdapter`: lifecycle, focus, input/output, resize, theme/font,
  copy/paste, selection.
- `TerminalInspectionProvider`: visible buffer, scrollback range, cursor
  position, snapshot source.
- `TerminalViewRegistry`: neutral replacement or wrapper around
  `xtermRegistry`.
- `PtyEngine`: current Tauri bridge commands and events, kept independent of
  renderer.

Design rule:

- Renderer adapters may own display and user interaction.
- Backend snapshot/emulator remains the source for product features that need
  durable inspection across windows, previews, mobile bridge, and restore.

Acceptance criteria:

- Existing xterm behavior remains unchanged.
- Existing Shell, float window, block overlay, block inspector, preview, and
  mobile bridge tests pass.
- New adapter contract tests run without mounting a real terminal renderer.
- Native adapter can be disabled at runtime and at build time.

Gate W3:

- Pass: xterm is fully behind the adapter, with no user-visible regression.
  Start W4.
- Fail: adapter introduces regressions or cannot represent current features.
  Rework the abstraction before native integration.

### W4: Windows Native Renderer Product Integration

Goal: ship the native renderer path behind a disabled-by-default Windows feature
flag.

Initial product scope:

- One active card/detail terminal at a time.
- Optional floating terminal after detail mode is stable.
- Grid stays preview/snapshot based.
- xterm remains fallback for every Windows session.

Do not initially support:

- Every grid card as a live native terminal.
- Native renderer in selector previews.
- Removing xterm-backed readBufferRange behavior.

Acceptance criteria:

- Feature flag off: current behavior exactly preserved.
- Feature flag on: active Windows terminal uses native renderer when available.
- Fallback triggers on creation failure, renderer crash, missing runtime, or
  unsupported OS/build.
- Fallback preserves session output through backend snapshot.
- Logs clearly identify which renderer each session uses.

Gate W4:

- Pass: enable internal dogfood on Windows.
- Conditional pass: keep native renderer limited to a separate focused/floating
  window if in-grid hosting is unstable.
- Fail: keep adapter work, disable native renderer, and return to W0/W1 findings.

### W5: Decision For Broader Rollout

Goal: decide whether Windows native renderer becomes a supported mode.

Required evidence:

- It beats xterm baseline in at least three user-visible pain scenarios.
- It has no P0/P1 regressions in session restore, input, selection, copy/paste,
  preview, block events, floating window, and app lifecycle.
- It has a documented packaging and runtime story.
- It has a documented fallback story.
- It has at least one week of internal Windows dogfood without critical issues.

Rollout decisions:

- Keep xterm-only: native path rejected or not worth cost.
- Keep hybrid experimental: useful but limited to advanced opt-in.
- Ship hybrid supported: Windows native renderer supported, xterm fallback kept.
- Revisit full native terminal stack: only if public APIs and product integration
  prove stronger than expected.

## Decision Matrix

| Evidence | Decision |
| --- | --- |
| xterm baseline is acceptable after tuning | Do not build native renderer. Continue xterm optimization. |
| Native host fails W1 | Do not pursue TerminalControl. Document failure and return to xterm path. |
| Native host passes, TerminalControl cannot embed/package | Evaluate custom renderer only if pain remains severe. |
| TerminalControl embeds but must own process/session | Reject for main product path unless backend feature parity is redesigned. |
| TerminalControl/native candidate passes W2 but grid hosting is unstable | Limit native renderer to focused detail or float window. |
| Native candidate passes W2 and adapter passes W3 | Build Windows-only hybrid behind feature flag. |
| Hybrid beats xterm but fallback is still needed | Ship Windows native renderer as supported optional mode. |
| Hybrid beats xterm and fallback usage is near zero for multiple releases | Consider making native renderer default on Windows, but keep fallback. |

## TerminalAdapter Contract Draft

The implementation may evolve, but these capabilities define the intended
boundary.

```ts
export type TerminalRendererKind = 'xterm' | 'windows-native';

export interface TerminalCapabilities {
  nativeIme: boolean;
  nativeSelection: boolean;
  nativeAccessibility: boolean;
  readVisibleBuffer: boolean;
  readScrollbackRange: boolean;
  getCursorPosition: boolean;
  snapshotRestore: boolean;
}

export interface TerminalAdapter {
  readonly kind: TerminalRendererKind;
  readonly capabilities: TerminalCapabilities;

  create(sessionId: string): Promise<void>;
  destroy(): Promise<void>;
  attach(container: HTMLElement): Promise<void>;
  detach(): Promise<void>;
  focus(): Promise<void>;

  writeOutput(data: string, seq?: number): Promise<void>;
  sendInput(data: string): Promise<void>;
  resize(rows: number, cols: number): Promise<void>;

  copy(): Promise<void>;
  paste(text?: string): Promise<void>;
  hasSelection?(): Promise<boolean>;
  getSelectionText?(): Promise<string>;

  updateTheme(theme: unknown): Promise<void>;
  updateFont(font: unknown): Promise<void>;
}
```

Inspection should be separate:

```ts
export interface TerminalInspectionProvider {
  readVisibleBuffer(): Promise<unknown>;
  readScrollbackRange(startRow: number, endRow: number): Promise<unknown>;
  getCursorPosition(): Promise<{ row: number; col: number }>;
  snapshot(): Promise<unknown>;
}
```

Do not require the Windows native renderer to expose all inspection APIs at
first. Product features that require stable inspection should prefer backend
snapshot/emulator data.

## GitHub Actions Strategy

GitHub-hosted Windows runners are useful but not sufficient.

Use GitHub Actions for:

- Windows compile checks.
- Rust cfg correctness.
- Tauri command registration tests.
- TypeScript type checks.
- Unit tests for adapter contracts.
- Packaging/linking smoke checks where possible.

Do not use GitHub-hosted runners as final evidence for:

- real z-order;
- focus correctness;
- IME candidate placement;
- DPI behavior;
- native child window visual clipping;
- interactive terminal usability.

For those, require local Windows desktop/VM evidence or a future self-hosted
Windows runner with an interactive desktop session.

## macOS/Linux Protection Rules

- All Windows native code must be behind `cfg(target_os = "windows")`.
- All frontend native renderer entry points must be behind runtime feature flags.
- xterm remains the default renderer on macOS/Linux.
- Shared adapter changes must run existing terminal, floating window, preview,
  and bridge tests.
- Do not add Windows-specific assumptions to `projectPath`, session id, card
  order, or provider session logic.

## Risk Register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Native child surface fights WebView2 z-order | Critical | W1 host spike must pass before renderer work. |
| TerminalControl cannot be consumed as stable public API | Critical | W2 can reject TerminalControl and stop work. |
| TerminalControl must own process/session | High | Keep current PTY backend as required for main path unless product semantics are redesigned. |
| Adapter abstraction leaks xterm details | High | Contract tests and neutral `TerminalViewRegistry`. |
| macOS behavior regresses during abstraction | High | Keep xterm default and run full existing terminal tests. |
| Native renderer improves font but breaks restore/preview/block features | High | W2/W4 gates require shared feature compatibility. |
| Benchmark results are subjective | Medium | W0 defines raw metrics, screenshots, and fixture scripts. |
| Packaging adds runtime burden | Medium | W2 requires installer/runtime matrix before product work. |

## Required Reports

Each validation stage must produce a short report before the next stage starts.

### Report Template

```md
# <Stage> Report

Date:
Machine:
Windows version:
DPI:
GPU/driver:
ThreadTerm commit:
Feature flags:

## Summary

## What Was Tested

## Results

## Failures / Regressions

## Decision

Choose one:
- continue
- continue with reduced scope
- stop and return to xterm path

## Follow-Up Tasks
```

## Recommended Next Action

Create the W0 baseline task first. Do not start TerminalControl integration until
there is a baseline report and a W1 host spike report.

Minimum next task:

1. Add benchmark fixture commands/scripts for Windows output, TUI, Unicode, IME,
   and selection scenarios.
2. Produce `docs/windows-terminal-baseline-report.json`.
3. Decide whether W1 is justified from measured pain, not assumptions.

# ThreadTerm Manual QA Report - 2026-04-26

## Scope

- App under test: current source build from `/Users/demo6598qq.com/Desktop/project/OpenWork`
- Runtime: `npm run tauri:dev`
- Platform tested interactively: macOS via Computer Use
- Compatibility focus: macOS + Windows desktop paths
- Existing installed `OpenWork` app was not used because it is older than the current source.

## Test Checklist

| Area | Case | Result | Notes |
| --- | --- | --- | --- |
| Startup | Launch source-built Tauri app | Pass | `ThreadTerm` main window opened from `target/debug/threadterm`. |
| Empty state | Sidebar and main empty state render | Pass | Empty project/sidebar copy and "new terminal" CTA visible. |
| Create dialog | Open via toolbar button | Pass | Dialog opens, create button disabled until required fields are present. |
| Create dialog | Absolute path auto-fills project name | Pass | `/tmp/openwork-manual-test` filled project name as `openwork-manual-test`. |
| Create dialog | Recent project chip fills form | Pass | Existing project chip restored name/path. |
| Shell terminal | Create Shell terminal | Pass with UX warning | Shell spawned and accepted input. Login shell printed `.openclaw/... compdef` error. |
| Shell terminal | Run `pwd` | Pass | Output returned `/private/tmp/openwork-manual-test`, expected macOS symlink resolution from `/tmp`. |
| Custom terminal | Create custom command terminal | Pass with UX warning | `printf 'custom-ok\n'` executed and output appeared. Startup shell noise appears before/around command output. |
| Keyboard | `Ctrl+N` opens create dialog | Pass | Opened dialog while terminal focused. |
| Keyboard | `Ctrl+Tab` switches terminal | Pass | Switched between Shell and Custom terminal views. |
| Keyboard | `Ctrl+2` jumps to second terminal | Pass | Focused the custom terminal. |
| Keyboard | `Ctrl+Shift+M` returns to grid | Fail | Main grid becomes blank although cards remain in accessibility tree. |
| Sidebar | Collapse/expand sidebar | Pass | Icon-only collapsed mode and expanded mode work. |
| Project filter | Project sidebar counts | Pass | Counts updated to 1 then 2 terminals. |
| Notifications | Open notification center | Pass | Reply notification rendered with project context. |
| Notifications | Send test notification from settings | Pass | UI reported successful handoff to system notification service. |
| Settings | Appearance mode switch | Pass | System/light/dark toggles applied instantly. |
| Settings | Theme pack switch | Pass | Dracula and ThreadTerm Default toggled correctly. |
| Settings | Language switch | Pass | English and Simplified Chinese switched live. |
| Settings | Hotkey rebind cancel | Pass | Rebind listening state exits on Esc. |
| Settings | Hotkey rebind + reset | Partial | Rebind UI saved `CmdOrCtrl+Alt+P`; reset restored default. Actual global trigger was not observed through Computer Use. |
| Overlay selector | Pin terminal for selector | Partial | Pin state can change through hidden accessibility element, but visible card controls are blocked by blank grid bug. |
| Overlay selector | Trigger selector with default/rebound hotkey | Not verified | Computer Use key events did not fire the Rust global shortcut handler; no selector window appeared and no Tauri log was emitted. Requires physical-keyboard or lower-level OS-event verification. |
| Floating terminal | Selector to float | Blocked | Blocked by inability to visibly use selector/hotkey path in this run. |
| Windows compatibility | Static PTY shell fallback | Pass static | `default_shell()` uses `powershell.exe`, falling back to `cmd.exe` under `target_os = "windows"`. |
| Windows compatibility | Static overlay fallback | Pass static | Non-macOS overlay path uses `WebviewWindowBuilder` instead of `NSPanel`. |
| Windows compatibility | Startup script present | Pass static | `start.ps1` exists; Windows runtime was not available for interactive testing. |

## Verification Commands

All checks passed:

```bash
npm run typecheck
npx vitest run src/components/terminal/TerminalEventBridge.test.tsx src/components/terminal/providerSession.test.ts src/components/terminal/useProjectGroups.test.ts src/stores/overlayStore.test.ts src/stores/terminalStore.test.ts src/theme/themePacks.test.ts
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml pty::tests
```

Observed results:

- TypeScript: passed
- Vitest: 6 files, 62 tests passed
- Frontend build: passed, generated `dist/index.html`, `dist/selector.html`, `dist/float.html`
- Cargo check: passed
- PTY tests: 7 passed

## Bugs and UI Defects

### TT-QA-001 - Terminal grid renders blank after returning from focused terminal

- Severity: High
- Platform observed: macOS source-built Tauri app
- Repro:
  1. Create a terminal.
  2. Enter focused terminal view.
  3. Click "Back to grid" or press `Ctrl+Shift+M`.
- Expected: terminal cards and the "new terminal" tile are visible in the grid.
- Actual: the main content area becomes blank white. Sidebar counts still show terminals. Accessibility tree still exposes card text and buttons, and clicking those hidden elements can focus/pin cards.
- Impact: visible card actions are effectively unusable, including pinning for overlay selector, copying path, reveal project, close, and ordinary card selection.
- Notes: This blocks the normal selector/floating-terminal workflow because pinning is a card-grid action.

### TT-QA-002 - Closed create dialog remains in accessibility tree

- Severity: Medium
- Platform observed: macOS source-built Tauri app
- Repro:
  1. Open create terminal dialog.
  2. Create a terminal.
  3. Query the UI tree after the dialog visually closes.
- Expected: closed modal controls are removed from the accessibility tree and cannot receive focus.
- Actual: hidden create-dialog headings, fields, and buttons remain visible to the accessibility tree after creation.
- Impact: screen readers and automated UI tools can see inactive controls, creating focus confusion and false interaction targets.

### TT-QA-003 - Global overlay hotkey could not be triggered in this Computer Use run

- Severity: Medium / Needs human repro
- Platform observed: macOS source-built Tauri app
- Repro attempted:
  1. Pin a terminal.
  2. Press default `CmdOrCtrl+Shift+Space` through Computer Use.
  3. Rebind slot A to `CmdOrCtrl+Alt+P`.
  4. Press `Ctrl+Alt+P` through Computer Use.
- Expected: selector overlay appears and Tauri logs `overlay hotkey A fired`.
- Actual: no selector appeared and no hotkey log was emitted. Rebind UI did save and reset successfully.
- Impact: overlay/floating-terminal end-to-end path could not be fully validated with Computer Use.
- Caveat: this may be a limitation of Computer Use injecting app-scoped key events instead of true OS global key events. Verify with a physical keyboard before treating as a product regression.

### TT-QA-004 - Shortcut labels are inconsistent for macOS users

- Severity: Low
- Platform observed: macOS source-built Tauri app
- Examples:
  - Toolbar says `Ctrl+N` for new terminal.
  - Bottom hint says `Ctrl+\``, `Ctrl+Tab`, `Ctrl+1-9`.
  - Settings says `⌘` represents macOS Command and Windows/Linux use Ctrl.
- Expected: shortcut copy clearly matches the actual supported modifier per platform.
- Actual: macOS UI mixes `Ctrl` and `⌘/Ctrl` language, which makes cross-platform expectations unclear.
- Impact: users may try the wrong modifier on macOS or Windows.

### TT-QA-005 - Login-shell startup errors pollute terminal preview and notifications

- Severity: Low
- Platform observed: macOS source-built Tauri app
- Repro:
  1. Create a Shell terminal in an environment whose login shell emits an rc error.
- Expected: app distinguishes environment startup noise from terminal task output, or provides a clearer diagnostic.
- Actual: `.openclaw/completions/openclaw.zsh:3685: command not found: compdef` appears in terminal output, card preview, and notification content.
- Impact: first-run experience looks broken even when the PTY itself is working.
- Caveat: root cause is user shell configuration, but the product could soften the UX.

## Residual Risk

- Post-fix re-test on 2026-04-26:
  - Fixed TT-QA-001 by making the grid layer explicitly visible when focus is cleared and by removing the grid/card entrance animation that could leave the layer visually hidden.
  - Fixed TT-QA-002 by unmounting `CreateTerminalDialog` immediately when closed and adding dialog accessibility attributes while open.
  - Fixed TT-QA-004 by changing the affected terminal shortcut labels to `⌘/Ctrl`.
  - Mitigated TT-QA-005 by filtering shell completion startup noise from card previews and notification snippets.
  - Added a macOS overlay prewarm safeguard that restores the app activation policy after hidden overlay windows are created.
- Automated post-fix interaction re-test against the local build passed:
  - empty state and toolbar shortcut labels include `⌘/Ctrl`
  - create dialog opens, enables after required fields, and is removed after create/cancel
  - focused terminal view hides the grid, `Ctrl+Shift+M` returns to a visible grid, and the hidden terminal layer remains `visibility: hidden`
  - card-grid add tile and bottom shortcut hint show `⌘/Ctrl`
- Post-fix commands passed: `npm run typecheck`, targeted Vitest suite (7 files / 68 tests), `npm run build`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `cargo test --manifest-path src-tauri/Cargo.toml pty::tests` (7 tests).
- `cargo tauri build --debug` successfully rebuilt the `.app` bundle before the dmg packaging script was interrupted; the dmg step repeatedly hung in `bundle_dmg.sh`, so dmg packaging remains unverified in this pass.
- Computer Use could still only reliably attach to the old installed `ThreadTerm` bundle or to browser/CDP targets, not to the freshly built debug `.app` window, so physical macOS app-window verification should be repeated outside this harness.
- Windows was only statically reviewed in this session; a Windows 10/11 runtime pass is still required for real global shortcuts, PowerShell/cmd behavior, notification identity, WebView2, and window z-order.
- macOS global selector/floating terminal still needs physical-keyboard verification because Computer Use did not trigger the global shortcut handler.
- I did not clear the test terminals from the dev app state because that would remove local app data created during testing.

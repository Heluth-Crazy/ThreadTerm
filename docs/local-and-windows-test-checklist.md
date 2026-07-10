# ThreadTerm Local And Windows Verification Checklist

> Last verified: 2026-07-04
> Scope: local release verification and reusable Windows test checklist for `exp/windows-native-terminal-host`.
> Privacy rule: this document uses `<repo-root>` and relative paths only. Do not add local usernames, absolute home directories, API keys, pairing tokens, QR codes, device names, remote URLs, prompts, terminal transcripts, or raw session paths.

## Local Verification Summary

Local platform: macOS arm64.

Run all commands from `<repo-root>`.

| Area | Command | Result | Notes |
|---|---|---|---|
| Aggregated check | `npm run check` | PASS | ESLint reported 31 warnings and 0 errors; TypeScript passed; Vitest passed; mobile build passed; Rust clippy passed. |
| Unit tests | `npm run test` | PASS | 78 test files, 571 tests passed. |
| Desktop production build | `npm run build` | PASS | `main` chunk: 292.34 kB; `WorkspaceCodeEditor` lazy chunk: 440.20 kB. |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` | PASS | 207 Rust tests passed. |
| Lite Rust compile check | `cargo check --manifest-path src-tauri/Cargo.toml --no-default-features` | PASS | 19 expected `dead_code` warnings from disabled mobile bridge stubs/protocol types. |
| Desktop e2e | `npm run test:e2e:desktop` | PASS | 4 Playwright tests passed. |
| Mobile e2e | `npm run test:e2e:mobile` | PASS | 20 Playwright tests passed after verifying optional `ptyLive` protocol compatibility. |
| Release packaging | `npx tauri build` | PASS | Generated release executable, `.app`, and `.dmg`. |
| Size benchmark | `npm run bench:size` | PASS | See artifact table below. |
| Startup benchmark | `npm run bench:startup` | PASS | Spawn-observed median: 0.39 ms across 3 iterations. |

Environment notes:

- `npm run tauri:build` uses `cargo tauri build` and requires the Rust `cargo-tauri` subcommand to be installed. On this machine it was not installed, so `npx tauri build` was used for the successful local package build.
- `npm run tauri:build:windows` uses the Node Tauri CLI and should be used on Windows for NSIS verification.
- Browserslist emitted an outdated `caniuse-lite` warning. This is non-blocking for the verification run.
- Playwright emitted `NO_COLOR`/`FORCE_COLOR` warnings. These are non-blocking.
- Vite emitted the known mixed dynamic/static import warning for `@tauri-apps/api/event`. This did not block production build or packaging.

## Artifact Bytes

These values came from `npm run bench:size` after the final local release build.

| Artifact | Bytes | Display size | Relative path |
|---|---:|---:|---|
| Frontend dist | 2,194,013 | 2.09 MiB | `dist` |
| Mobile dist | 583,216 | 0.56 MiB | `mobile-app/dist` |
| macOS DMG | 6,847,068 | 6.53 MiB | `src-tauri/target/release/bundle/dmg/ThreadTerm_0.3.0_aarch64.dmg` |
| macOS release binary | 14,914,720 | 14.22 MiB | `src-tauri/target/release/threadterm` |

For Windows, record the same benchmark output after `npm run tauri:build:windows`. The primary comparison target is the NSIS installer byte size.

## Standard Local Test Procedure

Use this sequence for local release validation. Stop at the first failure and record a sanitized failure report.

1. Confirm the branch and dirty state:
   ```sh
   git status --short --branch
   ```
2. Install dependencies if needed:
   ```sh
   npm install
   ```
3. Run the aggregated automated check:
   ```sh
   npm run check
   ```
4. Build the desktop frontend:
   ```sh
   npm run build
   ```
5. Run Rust tests:
   ```sh
   cargo test --manifest-path src-tauri/Cargo.toml
   ```
6. Verify the lite Rust configuration:
   ```sh
   cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
   ```
7. Run desktop browser e2e:
   ```sh
   npm run test:e2e:desktop
   ```
8. Run mobile browser e2e:
   ```sh
   npm run test:e2e:mobile
   ```
9. Build the release package:
   ```sh
   npx tauri build
   ```
10. Record artifact sizes:
    ```sh
    npm run bench:size
    ```
11. Record spawn-observed startup data:
    ```sh
    npm run bench:startup
    ```

## Windows Test Procedure

Run these commands from `<repo-root>` in PowerShell. Keep the output sanitized when copying results into issues or docs.

1. Force UTF-8 console encoding:
   ```powershell
   [Console]::InputEncoding  = [Text.UTF8Encoding]::new($false)
   [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
   chcp 65001 > $null
   ```
2. Confirm branch and dirty state:
   ```powershell
   git status --short --branch
   ```
3. Install dependencies:
   ```powershell
   npm install
   ```
4. Run automated checks:
   ```powershell
   npm run check
   npm run build
   cargo test --manifest-path src-tauri/Cargo.toml
   cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
   npm run test:e2e:desktop
   npm run test:e2e:mobile
   ```
5. Build the Windows NSIS installer:
   ```powershell
   npm run tauri:build:windows
   ```
6. Record package bytes:
   ```powershell
   npm run bench:size
   ```
7. Optional startup benchmark:
   ```powershell
   $env:THREADTERM_STARTUP_TARGET = "<path-to-threadterm.exe>"
   npm run bench:startup
   Remove-Item Env:\THREADTERM_STARTUP_TARGET
   ```

Record at minimum:

| Item | Value |
|---|---|
| Windows version | `<version>` |
| CPU architecture | `<x64 or arm64>` |
| NSIS installer bytes | `<bytes>` |
| Installed `threadterm.exe` bytes | `<bytes>` |
| Installed directory size | `<bytes>` |
| `dist` bytes | `<bytes>` |
| `mobile-app/dist` bytes | `<bytes>` |
| Startup benchmark median | `<ms>` |

## Manual Smoke Checklist

Use synthetic or non-sensitive terminal content. Do not paste raw command history into the checklist.

| Area | Check | Expected |
|---|---|---|
| Launch | Start the installed app. | Main window opens without crash or blank screen. |
| Terminal creation | Create a local terminal card. | The card starts and output is visible. |
| Terminal streaming | Run a command that prints multiple lines. | Output streams without freezing; scroll position is stable when scrolled up. |
| Exit and restart | Exit a terminal with a non-zero code, then restart. | Exit banner appears; restart creates a working PTY. |
| Session selector | Use `Ctrl+E` repeatedly and switch sessions at least 10 times. | Session list remains responsive. |
| Files and changes | After session switching, open Files and Changes views. | Both load normally; no permanent spinner. |
| Code editor | Open a text file from Files. | Editor loads after lazy chunk fetch and displays file content. |
| Git diff | Open a changed file diff. | Diff renders and remains usable after session switches. |
| Token stats | Open stats and refresh. | Totals render; do not record raw local paths or prompt/session text. |
| Settings | Open settings, switch language, close/reopen settings. | Language state is applied without blank windows. |
| Mobile bridge | Pair a test browser/device with full control. | Session list, terminal preview, detail xterm, and input round-trip work. |
| Mobile read-only | Pair or switch to read-only mode. | Input controls are hidden and terminal output remains visible. |
| Overlay lightweight mode | Enable lightweight mode on Windows. | Selector/float windows do not prewarm; overlay hotkeys are disabled as expected. |
| Overlay normal mode | Disable lightweight mode and use selector/float. | Overlay windows open only on demand and can be hidden/reopened. |
| External links | Click a safe URL in terminal output and an auth URL if available. | System browser opens the URL. If not, record as opener regression. |

## Windows WebView2 Memory Checks

Use these after launch, after opening selector/float, and after enabling lightweight mode. Record only aggregate numbers.

```powershell
Get-Process msedgewebview2 -ErrorAction SilentlyContinue |
  Measure-Object WorkingSet64 -Sum
```

Recommended checkpoints:

| Checkpoint | Expected trend |
|---|---|
| Fresh launch | Baseline WebView2 working set recorded. |
| After opening selector/float | Working set may increase. |
| After hiding selector/float | Working set should not grow continuously. |
| Lightweight mode enabled | Overlay-related extra WebView2 cost should drop or stay at zero. |

## Sanitized Failure Report Template

Use this template when a local or Windows run fails.

```text
Date:
Platform:
Branch:
Command or checklist item:
Result:
Sanitized symptom:
Expected:
Actual:
Artifact bytes, if relevant:
Private data removed: yes
Follow-up owner:
```

Do not include:

- Absolute user profile paths.
- Access tokens, pairing tokens, QR codes, API keys, or cookies.
- Prompt text, raw terminal transcript, local file contents, or provider session JSON.
- Remote repository URLs or private project names.
- Screenshots containing secrets, user directories, device names, or private terminal output.

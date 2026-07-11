# ThreadTerm Local And Windows Verification Checklist

> Last verified: 2026-07-11
> Scope: local release verification and reusable Windows test checklist for `exp/windows-native-terminal-host`.
> Certification status: unsigned internal verification only; this is not release certification, notarization, or Windows signing evidence.
> Privacy rule: this document uses `<repo-root>` and relative paths only. Do not add local usernames, absolute home directories, API keys, pairing tokens, QR codes, device names, remote URLs, prompts, terminal transcripts, or raw session paths.

## Local Verification Summary

Local platform: macOS arm64.

Run all commands from `<repo-root>`.

| Area | Command | Result | Notes |
|---|---|---|---|
| Aggregated check | `npm run check` | PASS | ESLint reported 31 warnings and 0 errors; TypeScript passed; Vitest passed; mobile build passed; Rust clippy passed. |
| Unit tests | `npm run test` | PASS | 84 test files, 654 tests passed. |
| Desktop production build | `npm run build` | PASS | 2,358 modules; `main` chunk: 297.38 kB; `WorkspaceCodeEditor` lazy chunk: 666.00 kB. |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` | PASS | 234 Rust tests passed. |
| Rust formatting | `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | PASS | No formatting differences. |
| Lite Rust compile check | `cargo check --manifest-path src-tauri/Cargo.toml --no-default-features` | PASS | 19 expected `dead_code` warnings from disabled mobile bridge stubs/protocol types. |
| Desktop e2e | `npm run test:e2e:desktop` | PASS | 4 Playwright tests passed. |
| Mobile e2e | `npm run test:e2e:mobile` | PASS | 20 Playwright tests passed after verifying optional `ptyLive` protocol compatibility. |
| Release packaging | `npm run tauri:build -- --bundles app` | PASS | Generated the current release executable and macOS `.app`; no current DMG was built. |
| Production dependency audit | `npm audit --omit=dev` | PASS | 0 vulnerabilities. |
| Rust dependency audit | `cargo audit` | NOT RUN / BLOCKING GAP | `cargo-audit` is not installed; add this to the release gate before certification. |
| Size benchmark | `npm run bench:size` | PASS | See artifact table below. |
| Startup benchmark | Not a release gate | NOT RUN | The current script measures only child-process spawn notification, not app readiness or first interaction. |

Environment notes:

- `npm run tauri:build` and `npm run tauri:build:windows` use the repository-locked Node Tauri CLI; no global `cargo-tauri` installation is required.
- Browserslist emitted an outdated `caniuse-lite` warning. This is non-blocking for the verification run.
- Playwright emitted `NO_COLOR`/`FORCE_COLOR` warnings. These are non-blocking.
- Vite emitted the known mixed dynamic/static import warning for `@tauri-apps/api/event`. This did not block production build or packaging.

## Artifact Bytes

These values came from `npm run bench:size` after the final local release build.

| Artifact | Bytes | Display size | Relative path |
|---|---:|---:|---|
| Frontend dist | 2,739,734 | 2.61 MiB | `dist` |
| Mobile dist | 585,027 | 0.56 MiB | `mobile-app/dist` |
| macOS release binary | 15,364,080 | 14.65 MiB | `src-tauri/target/release/threadterm` |

The benchmark also discovered an older 6,847,068-byte DMG in `src-tauri/target`; it predates this verification build and is deliberately excluded from the current artifact table. For Windows, record the same benchmark output immediately after `npm run tauri:build:windows`. The primary comparison target is the fresh NSIS installer byte size.

## Standard Local Test Procedure

Use this sequence for local release validation. Stop at the first failure and record a sanitized failure report.

1. Confirm the branch and dirty state:
   ```sh
   git status --short --branch
   ```
2. Install dependencies if needed:
   ```sh
   npm ci
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
6. Verify Rust formatting:
   ```sh
   cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
   ```
7. Verify the lite Rust configuration:
   ```sh
   cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
   ```
8. Run desktop browser e2e:
   ```sh
   npm run test:e2e:desktop
   ```
9. Run mobile browser e2e:
   ```sh
   npm run test:e2e:mobile
   ```
10. Audit production npm dependencies:
   ```sh
   npm audit --omit=dev
   ```
11. Run the Rust dependency audit; a missing command or any unreviewed advisory blocks release certification:
    ```sh
    cargo audit
    ```
12. Build the current-platform release package:
    ```sh
    npm run tauri:build -- --bundles app
    ```
13. Record artifact sizes:
    ```sh
    npm run bench:size
    ```

Do not use `npm run bench:startup` as pass/fail evidence until it waits for explicit backend-ready, window-visible, and first-interactive markers.

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
   npm ci
   ```
4. Run automated checks:
   ```powershell
   npm run check
   npm run build
   cargo test --manifest-path src-tauri/Cargo.toml
   cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
   cargo check --manifest-path src-tauri/Cargo.toml --no-default-features
   npm run test:e2e:desktop
   npm run test:e2e:mobile
   npm audit --omit=dev
   cargo audit
   ```
5. Build the Windows NSIS installer:
   ```powershell
   npm run tauri:build:windows
   ```
6. Record package bytes:
   ```powershell
   npm run bench:size
   ```
7. Verify the generated installer on a clean standard-user Windows account, including signature/SmartScreen behavior, install, upgrade, launch, and uninstall.

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
| Authenticode signature | `<valid / absent / invalid>` |
| SmartScreen result | `<result>` |
| Standard-user install / upgrade / uninstall | `<pass / fail>` |

## Manual Smoke Checklist

Use synthetic or non-sensitive terminal content. Do not paste raw command history into the checklist.

| Area | Check | Expected |
|---|---|---|
| Launch | Start the installed app. | Main window opens without crash or blank screen. |
| Terminal creation | Create a local terminal card. | The card starts and output is visible. |
| Terminal streaming | Run a command that prints multiple lines. | Output streams without freezing; scroll position is stable when scrolled up. |
| Exit and restart | Exit a terminal with a non-zero code, then restart. | Exit banner appears; restart creates a working PTY. |
| Session selector | Use `Cmd/Ctrl+E` repeatedly and switch sessions at least 10 times. | Session list remains responsive. |
| Files and changes | After session switching, open Files and Changes views. | Both load normally; no permanent spinner. |
| Code editor | Open a text file from Files. | Editor loads after lazy chunk fetch and displays file content. |
| Git diff | Open a changed file diff. | Diff renders and remains usable after session switches. |
| Token stats | Open stats and refresh. | Totals render; do not record raw local paths or prompt/session text. |
| Settings | Open settings, switch language, close/reopen settings. | Language state is applied without blank windows. |
| Mobile bridge | Pair a test browser/device with full control. | Session list, terminal preview, detail xterm, and input round-trip work. |
| Mobile read-only | Pair or switch to read-only mode. | Input controls are hidden and terminal output remains visible. |
| Overlay lightweight mode | Enable lightweight mode on Windows. | Selector/float windows do not prewarm; overlay hotkeys are disabled as expected. |
| Overlay normal mode | Disable lightweight mode and use selector/float. | Windows creates overlays on demand; macOS may prewarm them. Both can be hidden and reopened. |
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

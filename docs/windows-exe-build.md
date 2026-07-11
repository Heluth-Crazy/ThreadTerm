# Windows EXE Build

This guide creates the ThreadTerm NSIS installer on Windows. It describes a
build procedure, not a previously verified Windows release.

## Requirements

- A supported 64-bit Windows development host.
- Node.js 22 LTS and npm 10 or newer.
- Rust installed with the MSVC toolchain.
- Visual Studio Build Tools 2022 with the **Desktop development with C++**
  workload and a compatible Windows SDK.
- WebView2 available for development and acceptance testing.

Use a native Windows checkout. Building the web assets on macOS/Linux is not a
substitute for compiling and testing the Windows application.

## Build

Open PowerShell in a clean checkout and run:

```powershell
npm ci
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:build:windows
```

`npm run tauri:build:windows` resolves the local `@tauri-apps/cli` from the
repository. Do not install or call a global `cargo tauri` command. The script
applies `src-tauri/tauri.windows.conf.json`, requests the NSIS bundle, and uses
the Windows-specific non-transparent main-window configuration.

Tauri's `beforeBuildCommand` runs `npm run build && npm run build:mobile`, so a
clean checkout builds both desktop and embedded mobile assets before Rust
packaging. It must not rely on an existing `dist` or `mobile-app/dist` folder.

After a successful build, inspect the newly generated installer under:

```text
src-tauri/target/release/bundle/nsis/
```

The exact filename depends on the configured version and target architecture.
Record the commit, toolchain versions, filename, byte size, and checksum rather
than hard-coding an expected name.

## Signing status

The unsigned installer produced by a local build is for controlled internal
testing only. It is **not** ready for public distribution.

Authenticode remains a **BLOCK** until the release owner has:

- [ ] supplied an approved code-signing certificate through a secure signing
  environment;
- [ ] signed the executable payloads and final NSIS installer with SHA-256 and
  a trusted timestamp service;
- [ ] verified every final signature and certificate chain, for example with
  `signtool verify /pa /all /v <artifact>`;
- [ ] calculated and published checksums after signing;
- [ ] retained signing logs that identify the exact release artifacts without
  exposing credentials.

Do not commit certificates, private keys, passwords, or signing service tokens.

## Windows acceptance — BLOCK

Run these checks against the final signed installer on a clean, real Windows
environment. Record pass/fail evidence for the exact artifact.

- [ ] Install for the intended user scope, then launch from the installed
  shortcut.
- [ ] Confirm the main window starts without an extra console window and renders
  correctly at 100%, 125%, and 150% display scaling where available.
- [ ] Create a Shell card and verify input, output, resize, Unicode text, and a
  long-running command.
- [ ] Confirm the default shell path prefers `pwsh.exe`, then
  `powershell.exe`, and finally `cmd.exe`, and that
  the documented `cmd.exe` fallback works on a controlled test environment.
- [ ] Run the Windows section of
  [Global overlay manual test](global-overlay-manual-test.md), including
  multi-monitor and background-hotkey checks.
- [ ] Send a test notification and verify it in Windows Notification Center.
- [ ] Restart the app and verify settings, pinned cards, and window state.
- [ ] Test upgrade from the previous supported release and uninstall; confirm
  the expected user-data behavior is documented and observed.
- [ ] Check Windows Security/SmartScreen behavior and the Authenticode publisher
  shown by Explorer.

VM testing and CI builds may supplement this checklist, but neither closes the
real-Windows release block.

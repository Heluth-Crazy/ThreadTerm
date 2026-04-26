# Contributing to ThreadTerm

ThreadTerm is currently scoped to the Tauri desktop terminal manager. Contributions should stay within the retained desktop architecture unless a new product direction is explicitly approved.

## Prerequisites

- Node.js 22 LTS and npm 10+
- Rust toolchain from <https://rustup.rs>
- Tauri CLI: `cargo install tauri-cli`
- Optional AI CLIs in `PATH`: `claude`, `codex`, `gemini`, etc.

Windows contributors also need Visual Studio Build Tools 2022 with the `Desktop development with C++` workload.

## Development

```bash
npm install
npm run tauri:dev
```

Useful checks:

```bash
npm run typecheck
npx vitest run src/components/terminal/TerminalEventBridge.test.tsx src/components/terminal/providerSession.test.ts src/components/terminal/useProjectGroups.test.ts src/stores/overlayStore.test.ts src/stores/terminalStore.test.ts src/theme/themePacks.test.ts
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml pty::tests
```

## Current Structure

```text
src/                  React UI for the main, selector, and floating windows
src/windows/          Secondary Vite window entries
src/stores/           Zustand stores for terminal and overlay state
src-tauri/src/        Tauri backend modules: db, notification, overlay, provider_sessions, pty
src-tauri/icons/      Tauri bundle icons, including Windows assets
docs/                 Build, packaging, and manual regression notes
```

The retained runtime entries are:

- `index.html` -> main terminal manager
- `selector.html` -> global selector overlay
- `float.html` -> floating terminal

## Pull Requests

- Keep PRs focused on one behavior or cleanup area.
- Preserve Windows desktop support when touching PTY startup, Tauri config, icons, or launch scripts.
- Include screenshots or recordings for UI changes.
- Update README or docs when user-facing behavior changes.
- Run the checks above before requesting review.

## Commit Convention

Use Conventional Commits:

```text
feat: add terminal card action
fix: preserve float input focus
refactor: remove unused workbench store
docs: update Windows packaging guide
```

## Release

Use the Tauri build pipeline:

```bash
npm run tauri:build
```

Packaging details are documented in `docs/build-release.md` and `docs/windows-exe-build.md`.

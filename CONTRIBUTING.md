# Contributing to ThreadTerm

ThreadTerm is currently scoped to the Tauri desktop terminal manager. Contributions should stay within the retained desktop architecture unless a new product direction is explicitly approved.

## Prerequisites

- Node.js 22 LTS and npm 10+
- Rust toolchain from <https://rustup.rs>
- Optional AI CLIs in `PATH`: `claude`, `codex`, `gemini`, etc.

Windows contributors also need Visual Studio Build Tools 2022 with the `Desktop development with C++` workload.

## Development

```bash
npm install
npm run tauri:dev
```

The repository-pinned Tauri CLI is used automatically. For platform-aware
prerequisite checks, run `./start.sh` on macOS/Linux or `.\start.ps1` from
Windows PowerShell.

Useful checks:

```bash
npm run check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## Current Structure

```text
src/                  React UI for the main, selector, and floating windows
src/windows/          Secondary Vite window entries
src/stores/           Zustand stores for terminal and overlay state
src-tauri/src/        Tauri backend: PTY, bridge, overlay, files, stats, Codex, DB, notifications
src-tauri/icons/      Tauri bundle icons, including Windows assets
docs/                 Public guides, packaging notes, media, and manual regression steps
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
- Keep generated review media and local QA scratch files out of commits.
- Run the checks above before requesting review.

Use the pull request template and include the exact verification commands you ran.

## Reporting Issues

Use the GitHub issue templates when possible:

- Bug reports should include platform, app mode, reproduction steps, expected behavior, actual behavior, and logs or screenshots when available.
- Feature requests should describe the workflow, not just the UI control.
- Packaging issues should state whether the app was run through `npm run tauri:dev`, `npm run tauri:build`, or a downloaded bundle.

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

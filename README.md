<div align="center">
  <img src="public/logo.svg" alt="ThreadTerm" width="64" height="64">
  <h1>ThreadTerm</h1>
  <p><a href="README.zh-CN.md">简体中文</a> | English</p>
</div>

ThreadTerm is a desktop terminal manager for project-bound shell and AI CLI sessions. It keeps multiple terminal sessions visible as cards, lets you pin important sessions to a global selector, and can open a selected session in an always-on-top floating terminal.

## Current Scope

ThreadTerm currently focuses on the Tauri desktop app:

- **Terminal cards**: create terminals bound to project directories and run a shell, Claude, Codex, Gemini, Python, Node, Docker, or a custom command.
- **Project sidebar**: group cards by project path and filter the grid without leaving the terminal workflow.
- **Focused terminal view**: double-click a card to expand it into a full terminal view while keeping the card/session state alive.
- **Global selector**: press `Cmd/Ctrl + Shift + Space` to show pinned sessions over the current app.
- **Floating terminal**: pick a pinned card and continue typing in an always-on-top terminal window.
- **Notifications**: ThreadTerm tracks PTY state changes and can surface waiting/error/reply notifications.
- **Cross-platform desktop**: macOS and Windows are first-class targets; Linux may work depending on desktop-environment support for global shortcuts.

## Requirements

- Node.js 22 LTS and npm 10+
- Rust toolchain from <https://rustup.rs>
- Tauri CLI: `cargo install tauri-cli`
- Optional AI CLIs available in `PATH`: `claude`, `codex`, `gemini`, etc.

## Development

Install dependencies:

```bash
npm install
```

Run the desktop app:

```bash
npm run tauri:dev
```

Run frontend-only Vite preview:

```bash
npm run client
```

Build the desktop app:

```bash
npm run tauri:build
```

## Verification

Core checks used for this branch:

```bash
npm run typecheck
npx vitest run src/components/terminal/TerminalEventBridge.test.tsx src/components/terminal/providerSession.test.ts src/components/terminal/useProjectGroups.test.ts src/stores/overlayStore.test.ts src/stores/terminalStore.test.ts src/theme/themePacks.test.ts
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml pty::tests
```

Manual overlay regression steps are in [docs/global-overlay-manual-test.md](docs/global-overlay-manual-test.md).

## Architecture

Runtime entries:

- `index.html` -> main Terminal Manager window.
- `selector.html` -> global selector overlay window.
- `float.html` -> floating terminal window.

Retained backend modules:

- `src-tauri/src/pty.rs`: local PTY lifecycle, output events, session state, recent-output replay.
- `src-tauri/src/overlay.rs`: global shortcuts, selector/float windows, macOS full-screen Space handling, non-macOS window fallback.
- `src-tauri/src/db.rs`: small SQLite settings table for overlay hotkeys and float bounds.
- `src-tauri/src/notification.rs`: OS notification dispatch for packaged desktop builds.
- `src-tauri/src/provider_sessions.rs`: lightweight Claude/Codex session discovery for lazy resume.

## Windows Notes

Windows support is preserved:

- Release builds keep `windows_subsystem = "windows"` to avoid an extra console window.
- PTY startup uses `powershell.exe` when available, falling back to `cmd.exe`.
- Windows icons and Tauri bundle configuration remain in `src-tauri/icons/` and `src-tauri/tauri.conf.json`.

## Theme Credits

ThreadTerm includes original and third-party-inspired theme packs. Third-party
themes are credited in the app's Appearance settings and here:

- **ThreadTerm Default**: original ThreadTerm theme.
- **Catppuccin**: based on [Catppuccin](https://catppuccin.com/palette/) ([license](https://github.com/catppuccin/catppuccin/blob/main/LICENSE)).
- **Tokyo Night**: based on [tokyonight.nvim](https://github.com/folke/tokyonight.nvim) ([license](https://github.com/folke/tokyonight.nvim/blob/main/LICENSE)).
- **Gruvbox**: based on [gruvbox](https://github.com/morhetz/gruvbox) ([license](https://github.com/morhetz/gruvbox#license)).
- **Everforest**: based on [everforest](https://github.com/sainnhe/everforest) ([license](https://github.com/sainnhe/everforest/blob/master/LICENSE)).
- **Dracula**: based on [Dracula Theme](https://draculatheme.com/spec) ([license](https://github.com/dracula/dracula-theme/blob/main/LICENSE)).

The upstream projects do not endorse ThreadTerm; attribution is included to
respect the original theme authors and their licenses.

## License

ThreadTerm is proprietary software. Internal use and distribution are governed by your organization's terms.

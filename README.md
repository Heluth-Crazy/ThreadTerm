<div align="center">
  <img src="public/logo.svg" alt="ThreadTerm" width="72" height="72">
  <h1>ThreadTerm</h1>
  <p><strong>Project-bound terminal cards for shell and AI CLI sessions.</strong></p>
  <p>
    <a href="README.zh-CN.md">简体中文</a>
    ·
    English
  </p>
  <p>
    <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white">
    <img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=000">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white">
    <img alt="Rust" src="https://img.shields.io/badge/Rust-1.77%2B-000000?logo=rust&logoColor=white">
  </p>
</div>

ThreadTerm is a desktop terminal manager for developers who keep several project shells and AI CLI agents running at the same time. It turns sessions into persistent cards, groups them by project, lets you pin important sessions to a global selector, and can continue a session in an always-on-top floating terminal.

<p align="center">
  <img src="./docs/media/threadterm-grid.png" alt="ThreadTerm terminal grid" width="960">
</p>

<p align="center">
  <a href="#features">Features</a>
  ·
  <a href="#demo">Demo</a>
  ·
  <a href="#quick-start">Quick Start</a>
  ·
  <a href="#pinned-sessions-and-selector-modes">Selector Modes</a>
  ·
  <a href="#notifications">Notifications</a>
  ·
  <a href="#keyboard-shortcuts">Shortcuts</a>
  ·
  <a href="#architecture">Architecture</a>
</p>

## Why ThreadTerm?

AI coding tools and long-running project commands are easiest to lose when every terminal looks the same. ThreadTerm keeps each working context visible, named, resumable, and close at hand.

| Built for | What it helps with |
| --- | --- |
| Multi-project work | Keep terminal cards grouped by project path and switch without losing state. |
| AI CLI sessions | Run Claude, Codex, Gemini, or custom commands beside ordinary shell tasks. |
| Fast context switching | Pin important sessions and summon them with a global selector. |
| Focused work | Open one card as a full terminal or float it above other apps. |

## Features

| Capability | Details |
| --- | --- |
| Terminal cards | Create cards for Shell, Claude, Codex, Gemini, Python, Node, Docker, npm/yarn/pnpm, or a custom command. |
| Project sidebar | Group cards by project path and filter the grid without leaving the terminal workflow. |
| Focused terminal view | Double-click a card to expand it into a full terminal while keeping the card and PTY state alive. |
| Global selector | Press `Cmd/Ctrl + Shift + Space` to show pinned sessions over the current app. |
| Floating terminal | Pick a pinned card and continue typing in an always-on-top terminal window. |
| Notifications | Track PTY state changes, keep an in-app notification centre, and dispatch desktop OS notifications for attention-worthy events. |
| Theme packs | Switch between built-in terminal-inspired themes or import/export custom theme JSON. |
| Desktop targets | macOS and Windows are first-class targets; Linux may work depending on desktop-environment shortcut support. |

## Pinned Sessions and Selector Modes

The global selector has two layouts: Tile mode for scanning several sessions at once, and Carousel mode for focusing on one session with neighbouring cards still visible. Both modes only show pinned cards. If the selector says there are no pinned sessions, add cards to it first:

1. Create or locate a terminal card in the main grid.
2. Use the card's bottom action row and click the pin button. It sits beside the copy-path and reveal-project actions, and its tooltip says `Pin to overlay selector`.
3. The button changes to a pinned state. That card is now eligible for the selector, carousel, and floating terminal.
4. Open the selector with `Cmd/Ctrl + Shift + Space`. While the main window is focused, <kbd>Cmd/Ctrl</kbd> + <kbd>&#96;</kbd> opens the inline selector.
5. Press `M` inside the selector to switch between Tile mode and Carousel mode.
6. Press `Enter` to open the selected pinned card as a floating terminal, or press `1` to `6` to pick a pinned card directly.

<table>
  <tr>
    <th width="50%">Tile mode</th>
    <th width="50%">Carousel mode</th>
  </tr>
  <tr>
    <td><img src="./docs/media/threadterm-selector.png" alt="Selector tile mode"></td>
    <td><img src="./docs/media/threadterm-carousel.png" alt="Selector carousel mode"></td>
  </tr>
  <tr>
    <td>Best for scanning every pinned session at once.</td>
    <td>Best for reviewing a larger preview before opening a session.</td>
  </tr>
</table>

Notes:

- Up to 6 cards can be pinned at once.
- Click the same pin button again to remove a card from the selector.
- Tile mode is better when you want a quick overview of every pinned session.
- Carousel mode is better when you want a larger preview of the selected session before opening it.
- The selector remembers the last mode you used, so after switching modes it will keep opening that way.
- If you want different global shortcuts, open Settings with `Cmd/Ctrl + ,` and edit the overlay hotkeys.

## Notifications

ThreadTerm uses two notification layers so you can keep working without missing a session that needs attention:

| Layer | What it does |
| --- | --- |
| In-app notification centre | The bell button opens a right-side drawer with waiting, completed, failed, and attention events across all cards. |
| Desktop OS notifications | Packaged desktop builds dispatch native system notifications with sound and auto-cancel behavior when a new event lands. |

Clicking a notification brings you back to the relevant session. If the card is pinned, ThreadTerm can open it directly in the floating terminal; otherwise it focuses the card in the main window.

## Demo

<p align="center">
  <img src="./docs/media/threadterm-usage-demo.gif" alt="ThreadTerm usage demo" width="960">
</p>

<p align="center">
  <a href="./docs/media/threadterm-usage-demo.mp4">Download the MP4 demo</a>
</p>

<details open>
<summary><strong>Screenshots</strong></summary>

<table>
  <tr>
    <th width="50%">New terminal</th>
    <th width="50%">Notification centre</th>
  </tr>
  <tr>
    <td><img src="./docs/media/threadterm-create-terminal.png" alt="Create a new terminal"></td>
    <td><img src="./docs/media/threadterm-notifications.png" alt="Notification centre"></td>
  </tr>
  <tr>
    <th width="50%">Appearance settings</th>
    <th width="50%">Terminal grid</th>
  </tr>
  <tr>
    <td><img src="./docs/media/threadterm-settings.png" alt="Theme settings"></td>
    <td><img src="./docs/media/threadterm-grid.png" alt="Terminal grid"></td>
  </tr>
</table>

</details>

## Quick Start

### Requirements

| Requirement | Notes |
| --- | --- |
| Node.js 22 LTS and npm 10+ | Frontend tooling and package scripts. |
| Rust toolchain | Install from <https://rustup.rs>. |
| Tauri CLI | Install with `cargo install tauri-cli`. |
| Optional AI CLIs | Add `claude`, `codex`, `gemini`, or other tools to `PATH` if you want those presets to launch directly. |

### Run the desktop app

```bash
npm install
npm run tauri:dev
```

### Run the frontend-only preview

```bash
npm run client
```

### Build the desktop app

```bash
npm run tauri:build
```

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl + N` | Create a new terminal card. |
| `Cmd/Ctrl + 1..9` | Jump to a card by index. |
| `Cmd/Ctrl + Tab` | Cycle to the next card. |
| `Cmd/Ctrl + Shift + M` | Return from focused terminal view to the grid. |
| `Cmd/Ctrl + B` | Toggle the notification centre. |
| `Cmd/Ctrl + ,` | Open settings. |
| `Cmd/Ctrl + Shift + Space` | Show the global selector for pinned sessions. |
| <kbd>Cmd/Ctrl</kbd> + <kbd>&#96;</kbd> | Toggle the inline selector while the main window is focused. |
| `M` in selector | Switch between Tile mode and Carousel mode. |
| `Enter` in selector | Open the selected pinned card as a floating terminal. |

## Project Structure

```text
src/                  React UI for the main window
src/windows/          Selector and floating-terminal window entries
src/stores/           Zustand stores for terminal and overlay state
src-tauri/src/        Tauri backend: PTY, overlay, notification, settings, provider sessions
docs/                 Build, packaging, and public media
```

## Architecture

<details>
<summary><strong>Runtime entries and backend modules</strong></summary>

Runtime entries:

- `index.html` -> main Terminal Manager window.
- `selector.html` -> global selector overlay window.
- `float.html` -> floating terminal window.

Backend modules:

- `src-tauri/src/pty.rs`: local PTY lifecycle, output events, session state, and recent-output replay.
- `src-tauri/src/overlay.rs`: global shortcuts, selector/float windows, macOS full-screen Space handling, and non-macOS fallback behavior.
- `src-tauri/src/db.rs`: small SQLite settings table for overlay hotkeys and floating terminal bounds.
- `src-tauri/src/notification.rs`: OS notification dispatch for packaged desktop builds.
- `src-tauri/src/provider_sessions.rs`: lightweight Claude/Codex session discovery for lazy resume.

</details>

## Verification

<details>
<summary><strong>Core checks</strong></summary>

```bash
npm run typecheck
npx vitest run src/components/terminal/TerminalEventBridge.test.tsx src/components/terminal/providerSession.test.ts src/components/terminal/useProjectGroups.test.ts src/stores/overlayStore.test.ts src/stores/terminalStore.test.ts src/theme/themePacks.test.ts
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml pty::tests
```

Manual overlay regression steps are in [docs/global-overlay-manual-test.md](docs/global-overlay-manual-test.md).

</details>

## Windows Notes

Windows support is preserved:

- Release builds keep `windows_subsystem = "windows"` to avoid an extra console window.
- PTY startup uses `powershell.exe` when available, falling back to `cmd.exe`.
- Windows icons and Tauri bundle configuration remain in `src-tauri/icons/` and `src-tauri/tauri.conf.json`.

## Documentation

- [Contributing](CONTRIBUTING.md)
- [Roadmap](ROADMAP.md)
- [Build and release](docs/build-release.md)
- [Windows EXE build](docs/windows-exe-build.md)
- [Global overlay manual test](docs/global-overlay-manual-test.md)

## Theme Credits

<details>
<summary><strong>Third-party-inspired theme packs</strong></summary>

ThreadTerm includes original and third-party-inspired theme packs. Third-party themes are credited in the app's Appearance settings and here:

- **ThreadTerm Default**: original ThreadTerm theme.
- **Catppuccin**: based on [Catppuccin](https://catppuccin.com/palette/) ([license](https://github.com/catppuccin/catppuccin/blob/main/LICENSE)).
- **Tokyo Night**: based on [tokyonight.nvim](https://github.com/folke/tokyonight.nvim) ([license](https://github.com/folke/tokyonight.nvim/blob/main/LICENSE)).
- **Gruvbox**: based on [gruvbox](https://github.com/morhetz/gruvbox) ([license](https://github.com/morhetz/gruvbox#license)).
- **Everforest**: based on [everforest](https://github.com/sainnhe/everforest) ([license](https://github.com/sainnhe/everforest/blob/master/LICENSE)).
- **Dracula**: based on [Dracula Theme](https://draculatheme.com/spec) ([license](https://github.com/dracula/dracula-theme/blob/main/LICENSE)).

The upstream projects do not endorse ThreadTerm; attribution is included to respect the original theme authors and their licenses.

</details>

## License

See [LICENSE](LICENSE).

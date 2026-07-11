# Copilot Instructions for ThreadTerm

ThreadTerm is a Tauri desktop terminal manager for project-bound shell and AI CLI sessions.

## Commands

```bash
npm run client                 # Vite frontend only
npm run tauri:dev              # Tauri desktop development app
npm run build                  # Vite production build
npm run tauri:build            # Tauri desktop package build
npm run check                  # Lint, types, Vitest, mobile assets, Clippy
cargo test --manifest-path src-tauri/Cargo.toml
```

## Architecture

Runtime entries:

- `index.html` -> `src/main.jsx` -> `src/App.tsx` -> `TerminalManager`
- `selector.html` -> `src/windows/selector/main.tsx`
- `float.html` -> `src/windows/float/main.tsx`

Backend modules:

- `src-tauri/src/pty/`: local PTY lifecycle, input, resize, kill, snapshots, and output events.
- `src-tauri/src/bridge/`: LAN mobile bridge, pairing, protocol, and lifecycle management.
- `src-tauri/src/overlay/`: global shortcuts, selector window, floating terminal window, macOS panel behavior, and non-macOS fallback windows.
- `src-tauri/src/files.rs` and `src-tauri/src/git/`: workspace file and Git operations.
- `src-tauri/src/stats/`: provider-session token/statistics computation.
- `src-tauri/src/codex_app.rs`: Codex app-server process and protocol bridge.
- `src-tauri/src/db.rs`: small SQLite settings table.
- `src-tauri/src/notification.rs`: OS notification dispatch.
- `src-tauri/src/provider_sessions.rs`: Claude/Codex session lookup for lazy resume.

## Conventions

- Preserve Windows support in PTY startup, Tauri config, icons, launch scripts, and packaging docs.
- Keep the current Tauri desktop and embedded mobile-bridge architecture; do not reintroduce the removed Electron or legacy web-server stacks.
- Use `react-i18next` for user-facing strings.
- Keep Tailwind colors based on the CSS variables in `src/index.css`.
- Keep backend invoke commands limited to retained PTY, overlay, notification, and provider-session operations unless the product boundary changes.

# Copilot Instructions for ThreadTerm

ThreadTerm is a Tauri desktop terminal manager for project-bound shell and AI CLI sessions.

## Commands

```bash
npm run client                 # Vite frontend only
npm run tauri:dev              # Tauri desktop development app
npm run build                  # Vite production build
npm run tauri:build            # Tauri desktop package build
npm run typecheck              # TypeScript type checking
npx vitest run src/components/terminal/TerminalEventBridge.test.tsx src/components/terminal/providerSession.test.ts src/components/terminal/useProjectGroups.test.ts src/stores/overlayStore.test.ts src/stores/terminalStore.test.ts src/theme/themePacks.test.ts
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml pty::tests
```

## Architecture

Runtime entries:

- `index.html` -> `src/main.jsx` -> `src/App.tsx` -> `TerminalManager`
- `selector.html` -> `src/windows/selector/main.tsx`
- `float.html` -> `src/windows/float/main.tsx`

Backend modules:

- `src-tauri/src/pty.rs`: local PTY lifecycle, input, resize, kill, recent output, and status events.
- `src-tauri/src/overlay.rs`: global shortcuts, selector window, floating terminal window, macOS panel behavior, and non-macOS fallback windows.
- `src-tauri/src/db.rs`: small SQLite settings table.
- `src-tauri/src/notification.rs`: OS notification dispatch.
- `src-tauri/src/provider_sessions.rs`: Claude/Codex session lookup for lazy resume.

## Conventions

- Preserve Windows support in PTY startup, Tauri config, icons, launch scripts, and packaging docs.
- Do not add legacy web server, Electron, mobile, file editor, Git panel, task queue, or workbench code.
- Use `react-i18next` for user-facing strings.
- Keep Tailwind colors based on the CSS variables in `src/index.css`.
- Keep backend invoke commands limited to retained PTY, overlay, notification, and provider-session operations unless the product boundary changes.

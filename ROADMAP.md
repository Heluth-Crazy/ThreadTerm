# ThreadTerm Roadmap

This roadmap tracks the current Tauri desktop terminal manager.

## Current Product

- Project-bound terminal cards with shell and AI CLI launch presets.
- Project sidebar for grouping and filtering sessions.
- Focused terminal view that keeps PTY state alive.
- Global selector shown with `Cmd/Ctrl + Shift + Space`.
- Always-on-top floating terminal sharing the selected card PTY.
- PTY status tracking, attention detection, notifications, and recent-output replay.
- macOS and Windows desktop support.

## Near-Term Priorities

- Harden overlay focus behavior across macOS full-screen Spaces and Windows topmost windows.
- Improve selector carousel animation and keyboard navigation predictability.
- Expand automated coverage for overlay store, PTY event reconciliation, and card status transitions.
- Add manual smoke scripts for macOS and Windows packaging.
- Keep stale references and generated artifacts out of the retained desktop scope.

## Technical Direction

- Keep backend invoke surface limited to PTY, overlay, notifications, provider-session discovery, and minimal settings persistence.
- Keep Windows PTY fallback behavior: `powershell.exe`, then `cmd.exe`.
- Keep macOS overlay behavior implemented in `src-tauri/src/overlay.rs` with `tauri-nspanel`.
- Prefer small Zustand stores and direct Tauri invokes over additional service layers.
- Keep documentation synchronized with `README.md`, `docs/build-release.md`, and `docs/windows-exe-build.md`.

## Verification Baseline

```bash
npm run typecheck
npx vitest run src/components/terminal/TerminalEventBridge.test.tsx src/components/terminal/providerSession.test.ts src/components/terminal/useProjectGroups.test.ts src/stores/overlayStore.test.ts src/stores/terminalStore.test.ts src/theme/themePacks.test.ts
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml pty::tests
```

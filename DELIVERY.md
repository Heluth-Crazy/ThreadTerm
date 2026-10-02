# ThreadTerm V3 Windows delivery

Built September 10, 2026. Source is in the separate `ThreadTerm-v3` worktree on `feat/v3-electron-rebuild`; changes remain uncommitted as requested.

## Installer

`release-parity-safe-0bbac2a8375c495dafbe32cac5b48493/ThreadTerm Setup 0.1.0.exe`

- Windows x64 NSIS installer, 189,331,601 bytes, unsigned.
- SHA-256: `26E81FE3F91A6AB50053797D4A1A5BCC0A0E2ADBC80341DCBD28596948264ECF`
- Includes the independent Rust runtime, terminal MCP executable, Claude SDK host and native Claude SDK CLI. Desktop-launched SDK workers use Electron's embedded Node.
- Includes the native bitmap tray fix and final prototype parity renderer. Installer/uninstaller process checks are directory-scoped and read-only; they never terminate another ThreadTerm installation. Unsafe older uninstallers are rejected before upgrade. V3 shortcuts use the separate name `ThreadTerm V3`.
- V3 uses fresh local data; it does not import V2 storage. Native provider histories remain discoverable.

## Completed verification

- TypeScript desktop and renderer checks; production renderer/desktop builds; release Rust binaries.
- Rust: 95 tests passed; formatting and Clippy with warnings denied passed.
- Current protocol: 6 tests; output fanout: 2; preset/catalog/input helpers: 6; control lease/draft writer: 3. Earlier provider, state/ordering and SDK evidence remains under `qa/`.
- Real named-pipe IPC, PTY, replay/recovery, lease ownership, scoped files/Git, drafts and data relocation were exercised by the scripts and reports under `qa/`.
- Prototype comparison gallery: `qa/results/parity-review.html`, with 17 screens at 1280/1440/1920 in light/dark, 102 distinct screenshot pairs. Detailed action and visual evidence is in `PARITY-VERIFICATION.md`.
- Ended/imported preset restoration never claims control or starts providers. Live Chat rapid-navigation draft flush and live-to-ended text retention pass actual rendered UI tests (`qa/results/preset-restore-ui-final/2026-09-10T16-16-03-087Z/report.json`).
- Cache cleanup: restart clears only HTTP cache, retains cookie and SQLite draft, consumes a schedule once, and respects cancellation (`qa/results/cache-cleanup-smoke.json`).
- Final installed package, completed 16:49 UTC: plain non-Git directory sessions appear in the sidebar; a real command typed into TerminalSurface produced an exact standalone output row. Bundled Claude host answered without external Node on PATH. NSIS uninstall removed the isolated test application while retaining external SQLite data (`qa/results/installed-smoke.json`).
- Installation/upgrade/uninstallation preserved the existing preview process identities, V2 registration and V2 shortcut targets. The legacy installer guard returned exit 2 before executing an unsafe predecessor (`qa/results/installer-isolation/`).
- Real floating windows: explicit cycle-mode target/reuse, isolation from shared navigation, lightweight main-window routing, fullscreen/Escape preserving the PTY, and double-Ctrl last-active navigation all passed (`qa/results/floating-smoke.json`).

## Provider verification limits

| Provider | Observed result |
|---|---|
| Codex | Real structured turn and same-native-ID history/read/resume verified. |
| Kimi | Real structured turn and same-native-ID resume verified earlier; the latest scan timed out reading one older unrelated history record. |
| Claude Code | Native history/read available; bundled SDK startup checked without sending a prompt. Structured paid turn remains unverified because SDK authentication is absent. |
| Gemini | Adapter implemented; local CLI is absent, so live Chat/history verification could not run. |
| OpenCode | Native history/read available; actual paid request returned HTTP 401. A successful structured turn remains unverified. |

These are retained as setup/verification limits. CLI detection and credential presence are not treated as successful provider requests.

The historical account/API/update feature row is only partially delivered: provider-owned authentication and diagnostics exist, while a separate hosted account service and automatic-update feed have not been configured. The build does not claim those services are connected.

## Scope

The user's visible-preview mismatch was an older executable, not missing CSS in the current package. The current packaged renderer loads `index-hO6TUvRT.css` with 1,535 rules, a grid shell and a 240px sidebar. Its CSS matches the debugging build byte-for-byte. The fresh preview metadata and actual window screenshot are recorded in `qa/results/active-parity-preview.json`; real project data remains separate from QA fixtures.

Production implementation covers project/worktree scopes, terminal and Chat sessions, native history, inbox/follow/bookmarks, persistent workspaces and independent windows, CodeMirror files and Git actions, settings/themes, backup/relocation, desktop device management, terminal MCP, and recorded usage with unknown metrics preserved.

Commercial purchase/trial flows and AI Markdown download are excluded. Phone UI and VS Code extension remain deferred. The source-backed capability ledger and final audit are separate from live verification evidence; implemented does not mean every provider service was available in this environment.

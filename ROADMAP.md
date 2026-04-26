# ThreadTerm Roadmap

ThreadTerm is moving toward a stable desktop workbench for developers who keep
shells and AI CLI agents running across multiple projects.

## Product Direction

The next product bet is simple: ThreadTerm should not feel like another terminal
window. It should feel like a command center for long-running project work and
AI-assisted coding sessions.

That means the near-term roadmap prioritizes:

- a trustworthy first run on macOS and Windows
- clear AI CLI session state
- reliable notifications and one-click return paths
- small, well-documented workflows contributors can test

## v0.2 - Stable AI CLI Workbench

Goal: a new user can install ThreadTerm, create a project card, pin it, open the
selector, use carousel mode, receive notifications, and return to the right
session without reading source code.

| Track | Scope | Acceptance |
| --- | --- | --- |
| First-run experience | Document the first five minutes and keep the empty state focused on creating the first card. | README links to the guide; the guide covers card creation, pinning, selector modes, floating terminal, and notifications. |
| Release readiness | Harden macOS and Windows packaging instructions, including permissions and smoke tests. | A maintainer can follow the docs from clean checkout to packaged app on each platform. |
| AI CLI state | Make Claude, Codex, Gemini, and custom command cards clearly show running, waiting, completed, failed, and unread states. | Card status, notification copy, and click-through behavior all agree on the same session state. |
| Notification loop | Keep in-app and desktop OS notifications predictable. | Clicking a notification returns to the relevant card or floating terminal. |
| Open-source hygiene | Keep generated artifacts out, improve issue/PR templates, and keep README screenshots current. | New contributors have clear templates and do not need private context to report or reproduce issues. |

Non-goals for v0.2:

- plugin marketplaces
- a full task runner
- team sync or cloud accounts
- replacing the user's normal shell configuration

## v0.3 - AI Session Workflow

Goal: make ThreadTerm especially good at managing multiple AI CLI threads.

v0.3 starts with session visibility before adding heavier workflow controls:

| Slice | Scope | Acceptance |
| --- | --- | --- |
| v0.3.0 Session visibility | Show AI session badges for Claude, Codex, and Gemini cards; distinguish new session ids, resume-ready sessions, CLI-only sessions, custom commands, and missing CLIs. | Grid cards, focused terminal headers, and missing-CLI notifications explain the same state. |
| v0.3.1 Session organization | Add lightweight card notes or intent labels such as `review`, `fix`, and `research`. | Users can label AI cards and scan multiple sessions without relying only on project names. |
| v0.3.2 Return paths | Improve notification click-through and recovery fallback when a provider session cannot be resumed. | Clicking AI session notifications consistently returns to the right card or floating terminal on macOS and Windows. |

Planned themes after v0.3.0:

- clearer Claude/Codex/Gemini session resume flows
- project-level grouping for AI sessions and shell tasks
- card notes or labels for intent, such as `review`, `fix`, `research`
- richer notification summaries for "waiting for input" and "reply ready"
- better handling when an AI CLI is missing from `PATH`

## v0.4 - Extensibility and Power Use

Goal: let advanced users adapt ThreadTerm without turning the app into a broad
IDE or project management suite.

Possible themes:

- import/export for app settings and theme packs
- reusable command templates
- configurable terminal card presets
- optional workspace-level defaults
- stronger Linux compatibility notes if contributors validate real desktop
  environments

## Verification Baseline

Run this before merging changes that touch terminal lifecycle, overlay behavior,
notifications, packaging, or public docs:

```bash
npm run typecheck
npx vitest run src/components/terminal/TerminalEventBridge.test.tsx src/components/terminal/providerSession.test.ts src/components/terminal/useProjectGroups.test.ts src/stores/overlayStore.test.ts src/stores/terminalStore.test.ts src/theme/themePacks.test.ts
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml pty::tests
```

Manual overlay regression steps are maintained in
[docs/global-overlay-manual-test.md](docs/global-overlay-manual-test.md).

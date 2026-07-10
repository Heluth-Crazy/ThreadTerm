# ThreadTerm Deep Remediation Implementation Plan

Date: 2026-05-16
Source: `docs/ThreadTerm-Deep.md`
Status: Planning artifact, no code changes implied by this document

## Goal

Turn the deep-review findings into an executable remediation roadmap that can be
implemented in small, testable batches without changing the intended product
behavior.

The plan optimizes for:

- keeping existing desktop terminal behavior stable;
- keeping mobile pairing, read-only mode, and full-control mode compatible;
- isolating security protocol changes behind compatibility windows;
- making each work package independently testable and revertible.

## Guardrails

- Do not combine unrelated risk surfaces in one commit.
- Do not remove existing mobile auth/query-token behavior until a compatible
  replacement has shipped and been verified.
- Do not change terminal UX semantics while fixing rendering, preview, or
  performance issues.
- Prefer additive tests before behavior changes.
- Update `.trellis/spec/` when an implementation establishes a new contract.
- Run GitNexus impact analysis before editing existing symbols.

## Current-State Corrections

The deep report is useful but partially stale against the current working tree:

- `paired_devices` is no longer only a schema stub. `PairingStore` now persists
  and reloads hashed device tokens.
- LAN pairing no longer always maps `0.0.0.0` to `127.0.0.1`; current code
  attempts to resolve a LAN IPv4 address and only falls back to loopback.
- Mobile preview is no longer strictly based on the current raw output chunk;
  current code already prefers `terminal_output_snapshot`.

These corrections affect prioritization, not the need for remediation.

## Work Packages

### WP0 - Current Mobile Terminal Stabilization

Scope:

- Mobile terminal scroll performance.
- Active Session preview stability while streaming.
- Existing task: `05-14-fix-mobile-terminal-blank-cards-and-missing-input-feedback`.

Changes:

- Batch `fitAddon.fit()` calls behind `requestAnimationFrame`.
- Avoid sending `resize` when fitted cols/rows have not changed.
- Use a smaller xterm scrollback in `mode="preview"` while keeping detail
  scrollback intact.
- Skip stale snapshots that arrive after newer output has already been applied.
- Optionally batch consecutive `terminal_output` writes per animation frame
  while preserving byte order.

Functional impact:

- Intended behavior unchanged.
- Preview remains a live terminal thumbnail.
- Detail remains the full terminal view.
- No protocol, permission, or input semantics change.

Primary files:

- `mobile-app/src/MainTerminal.tsx`
- `mobile-app/src/MainTerminal.test.tsx`
- `mobile-app/src/terminalTranscript.ts`
- `mobile-app/src/terminalTranscript.test.ts`

Validation:

- `npx vitest run mobile-app/src/MainTerminal.test.tsx mobile-app/src/terminalTranscript.test.ts`
- `npm run typecheck`
- `npm run build:mobile`
- Manual: mobile Active Session preview streams without apparent loss; detail
  scrolls acceptably on a phone.

Rollback:

- Revert this package only; it should not touch backend protocol.

### WP1 - Low-Risk Correctness and Privacy Fixes

Scope:

- PTY exit-code precision.
- Remote-input audit privacy.
- Top-level validation scripts.

Changes:

- Preserve real child process exit codes using `status.code()` instead of
  collapsing all failures to `1`.
- Preserve `None`/unknown behavior for killed or signal-only exits.
- Replace remote input audit summaries with metadata or redacted summaries.
- Add top-level `test` and `check` scripts. Add `lint` only if ESLint config is
  actually present.

Functional impact:

- Terminal success/failure semantics remain the same.
- Diagnostics become more accurate.
- Remote control still sends exactly the same input.
- Audit log loses raw input content by design.

Primary files:

- `src-tauri/src/pty/events.rs`
- `src-tauri/src/bridge/server.rs`
- `src-tauri/src/db.rs` if audit schema/helper documentation changes
- `src/components/terminal/TerminalEventBridge.test.tsx`
- `src/components/terminal/BlockInspector.test.tsx`
- `package.json`

Validation:

- Rust tests covering exit code `0`, `1`, `127`, and unknown.
- Rust tests covering audit redaction/metadata.
- Frontend tests verifying non-`1` exit codes display correctly.
- `npm run typecheck`
- `npx vitest run`
- `cargo test`

Rollback:

- Exit-code and audit changes are independent and should be separate commits.

### WP2 - Provider Session Discovery Performance

Scope:

- AI provider session auto-discovery performance and UI responsiveness.

Changes:

- Move recursive filesystem scanning into `spawn_blocking`.
- Avoid repeated full scans during the 12-attempt discovery window by caching
  recent scan results for a short TTL.
- Tighten `since_ms` filtering before reading file contents.
- Keep frontend polling limits unchanged unless profiling shows they are the
  dominant cost.

Functional impact:

- Intended behavior unchanged.
- Session binding remains best-effort.
- Discovery may become faster and less disruptive.

Primary files:

- `src-tauri/src/provider_sessions.rs`
- `src/components/terminal/useProviderSessionLifecycle.ts`
- Provider session tests under Rust and Vitest as needed.

Validation:

- Unit tests for `since_ms` filtering and latest-session selection.
- Benchmark or fixture test with 100, 1000, and 5000 jsonl files if practical.
- Manual: create Codex/Claude card and confirm provider session still binds.

Rollback:

- Revert provider-session package only; it should not affect PTY execution.

### WP3 - Mobile Bridge Preview Data Stability

Scope:

- Bridge preview stability and consistency.
- This complements WP0, but works on backend preview generation.

Changes:

- Confirm preview generation always uses cumulative recent output or terminal
  snapshot, not a raw current chunk fallback when cumulative data is available.
- Add tests for split-line output across chunks.
- Consider preview event throttling only after correctness is covered.

Functional impact:

- Preview text may become more stable and less jumpy.
- Terminal output, WebSocket output, and mobile input remain unchanged.

Primary files:

- `src-tauri/src/pty/events.rs`
- `src-tauri/src/bridge/mod.rs`
- Rust bridge/PTY tests.

Validation:

- Rust tests: split line across chunks preserves expected preview context.
- Mobile manual: card preview footer summary does not flicker to half-lines.

Rollback:

- Revert backend preview package only.

### WP4 - Multi-Xterm Registry Correctness

Scope:

- Main window and floating window sharing the same PTY.
- Block overlay, block inspector, and buffer range capture.

Changes:

- Replace the single `Map<ptyId, Terminal>` assumption with an explicit
  active-terminal model or multi-instance registry.
- Make visible/foreground shell claim active ownership.
- Ensure `getAbsoluteCursorRow` and `readBufferRange` use the intended terminal
  instance.

Functional impact:

- Intended user behavior unchanged.
- Risk is medium because block overlay and inspector rely on registry behavior.

Primary files:

- `src/components/terminal/xtermRegistry.ts`
- `src/components/Shell.jsx`
- `src/components/terminal/TerminalEventBridge.tsx`
- `src/components/terminal/BlockOverlay.tsx`
- `src/components/terminal/BlockInspector.tsx`

Validation:

- Registry unit tests for two terminal instances sharing one PTY.
- Component/integration test for active instance selection.
- Manual: open a card in main window and float window, then verify block
  overlay/inspector output stays bound to the intended visible terminal.

Rollback:

- Revert this package independently. Do not combine with mobile bridge or PTY
  exit-code work.

### WP5 - Mobile Bridge Security Compatibility Layer

Scope:

- Authentication carrier.
- CORS/origin behavior.
- LAN publish-host UX.

Changes:

- Add a safer auth path: `Authorization: Bearer <token>` for HTTP snapshot and
  a WebSocket-compatible auth path, such as first-frame auth.
- Keep existing query-token behavior temporarily for compatibility.
- Emit warnings/spec notes for query-token path, then remove it in a later
  release after migration.
- Replace `CorsLayer::permissive()` with a narrower policy once the mobile
  browser flow is verified.
- Split bind host from publish host in settings. Keep automatic LAN IP
  detection, but allow manual publish-host override and do not silently produce
  a phone QR code that points to unreachable loopback.

Functional impact:

- Medium. Existing mobile clients must remain compatible during the migration
  window.
- UX may gain a publish-host field or explicit warning for LAN mode.

Primary files:

- `src-tauri/src/bridge/server.rs`
- `src-tauri/src/bridge/mod.rs`
- `src-tauri/src/bridge/pairing.rs`
- `src/mobile/bridge/wsClient.ts`
- `mobile-app/src/bridge/useBridgeConnection.ts`
- `src/components/settings/MobileAccessSettings.tsx`
- Mobile bridge tests.

Validation:

- Rust tests for query token, header token, missing token, invalid token.
- WebSocket tests for legacy and new auth paths.
- Frontend tests for LAN publish-host behavior.
- Manual: read-only QR, full-control QR, reconnect after app restart, LAN phone
  pairing.

Rollback:

- If the new auth path breaks real devices, disable it behind compatibility
  fallback while keeping old query-token path.

### WP6 - Tauri Capability and CSP Hardening

Scope:

- Tauri security surface.
- Capabilities and CSP.

Changes:

- Audit actual usage of `shell:allow-open`, `http:default`, filesystem scopes,
  and event/window permissions.
- Remove unused permissions only after tests or manual smoke confirm no feature
  depends on them.
- Introduce CSP incrementally. Avoid a single strict CSP jump that breaks Vite,
  xterm, theme styles, or asset loading.

Functional impact:

- Medium. Permissions are cross-cutting and failures may surface only at
  runtime.

Primary files:

- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`
- Tauri command call sites under `src/**`.

Validation:

- Desktop smoke: terminal create/input/resize, settings import/export,
  local-directory open, mobile pairing, notification, overlay/float/pet if
  enabled.
- `npm run build`
- `cargo check`
- `cargo test`

Rollback:

- One permission family per commit. Revert the family that breaks runtime
  behavior.

### WP7 - Spec and Workflow Capture

Scope:

- Persistent engineering knowledge.

Changes:

- Add/extend specs for:
  - mobile bridge auth and publish-host behavior;
  - remote input audit privacy;
  - PTY exit-code precision;
  - multi-xterm registry ownership;
  - mobile terminal preview and xterm rendering constraints.
- Keep spec entries in closed `<spec-entry>` format.

Functional impact:

- None directly.

Primary files:

- `.trellis/spec/frontend/quality-guidelines.md`
- `.trellis/spec/frontend/state-management.md`
- Other `.trellis/spec/**` files as appropriate.

Validation:

- Human review of spec entries.
- Ensure implementation tests reference the same contracts.

## Suggested Execution Order

1. WP0 - finish current mobile terminal task.
2. WP1 - low-risk correctness/privacy fixes.
3. WP2 - provider discovery performance.
4. WP3 - backend preview stability.
5. WP4 - multi-xterm registry correctness.
6. WP5 - mobile bridge security compatibility layer.
7. WP6 - capability and CSP hardening.
8. WP7 - update specs after each implementation package, not only at the end.

## Task Breakdown Proposal

Use separate Trellis tasks rather than expanding the current mobile bug task
forever:

- `mobile-terminal-rendering-stability` -> WP0
- `pty-exit-code-and-audit-hardening` -> WP1
- `provider-session-discovery-performance` -> WP2
- `mobile-bridge-preview-stability` -> WP3
- `xterm-registry-multi-instance-correctness` -> WP4
- `mobile-bridge-auth-and-publish-host-hardening` -> WP5
- `tauri-capability-csp-hardening` -> WP6
- `threadterm-deep-spec-capture` -> WP7

## Release Gates

Each package must pass its targeted tests. Before a release candidate, run:

- `npm run typecheck`
- `npx vitest run` or `npm test` after WP1 adds the script
- `npm run build:mobile`
- `npm run build`
- `cargo check`
- `cargo test`
- `npm run test:e2e:mobile` when mobile bridge or mobile app behavior changes

Manual gates:

- Desktop terminal create/input/resize.
- Mobile read-only pairing.
- Mobile full-control input.
- Mobile Active Session preview under streaming output.
- Main window + float window on the same PTY.
- Provider session binding for Codex and Claude.

## Stop Conditions

Stop and reassess before continuing if any package causes:

- mobile pairing to fail for an already-paired device;
- full-control input to send duplicate or missing bytes;
- desktop terminal output ordering regression;
- block inspector capturing output from the wrong terminal instance;
- permissions/CSP changes that break core desktop startup;
- GitNexus impact reports HIGH or CRITICAL for an intended small package.

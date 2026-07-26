# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

### Scenario: Local Directory Reveal via Tauri Command

#### 1. Scope / Trigger
- Trigger: Any frontend feature that opens a local filesystem directory from the
  desktop app.
- Applies to project/card reveal buttons, bottom-bar file explorer chips, and
  any future local directory opener.

#### 2. Signatures
- Frontend: `openLocalDirectory(path: string): Promise<void>`
- Backend command: `open_local_directory(path: String) -> Result<(), String>`

#### 3. Contracts
- Do not use `@tauri-apps/plugin-shell.open(path)` for filesystem paths.
  `shell:allow-open` is URL-oriented and rejects local paths under its
  mailto/tel/http(s) scope.
- The backend command must validate that the path is non-empty, absolute,
  exists, and is a directory before launching a platform opener.
- Keep `shell:allow-open` scoped to URLs; do not broaden it to arbitrary local
  filesystem paths to fix directory reveal.
- Browser/non-Tauri calls should no-op through the frontend helper.

#### 4. Validation & Error Matrix
- Empty path -> error.
- Relative path -> error.
- Missing path -> error.
- Existing file path -> error.
- Existing absolute directory -> launch platform opener or return opener error.

#### 5. Good/Base/Bad Cases
- Good: project reveal opens the selected project directory through
  `openLocalDirectory`.
- Base: card reveal opens the card working directory only in Tauri.
- Bad: `shell.open('/Users/example/project')`, because the shell plugin rejects
  local paths and emits scoped argument regex errors.

#### 6. Tests Required
- Frontend helper tests for Tauri invoke, non-Tauri no-op, and failure
  propagation.
- Rust validation tests for empty, relative, missing, file, and valid directory.
- Component tests or typechecked wiring for each local directory opener callsite.

#### 7. Wrong vs Correct

Wrong:
```typescript
import { open } from '@tauri-apps/plugin-shell';

await open(projectPath);
```

Correct:
```typescript
await openLocalDirectory(projectPath);
```

The correct version separates local filesystem reveal from URL opening and keeps
the Tauri permission boundary narrow.

<spec-entry category="quality" keywords="tauri,csp,capabilities,security,desktop-build" date="2026-05-16" source="src-tauri/tauri.conf.json:26">

### Scenario: Tauri CSP and Capability Boundaries

#### 1. Scope / Trigger
- Trigger: Any change to `src-tauri/tauri.conf.json`, `src-tauri/capabilities/**`, plugin usage, external font/network usage, or local bridge connectivity.

#### 2. Signatures
- Tauri config: `app.security.csp: string`
- Tauri dev config: `app.security.devCsp?: string`
- Capability file: `src-tauri/capabilities/default.json`
- Validation command: `npm exec tauri info`

#### 3. Contracts
- `csp` must not be `null` in production-oriented config.
- Development must use `devCsp` instead of loosening production `csp` when Vite or React Fast Refresh needs dev-only sources.
- The CSP must keep local Tauri/Vite resources working while denying object/frame embedding: include `object-src 'none'`, `frame-src 'none'`, and `base-uri 'self'`.
- Vite React dev injects an inline Fast Refresh preamble into each HTML entry, including `selector.html`; `devCsp` must allow that preamble with `script-src 'self' 'unsafe-inline'` while production `csp` keeps `script-src 'self'`.
- Keep `style-src 'unsafe-inline'` while React/theme code sets runtime style variables; remove it only after verifying all dynamic style injection is gone.
- If Google Fonts remain in `dist/index.html`, CSP must allow `https://fonts.googleapis.com` for styles and `https://fonts.gstatic.com` for fonts.
- Local dev and local bridge traffic require `http://localhost:*`, `http://127.0.0.1:*`, `ws://localhost:*`, and `ws://127.0.0.1:*` in `connect-src`.
- Do not broaden fs or shell capabilities to fix unrelated runtime errors. Add or remove capability permissions only with a matching callsite and test.

#### 4. Validation & Error Matrix
- Missing local bridge connect-src -> mobile/desktop bridge reconnects fail under CSP.
- Reusing production `script-src 'self'` as dev CSP -> Vite React Fast Refresh inline preamble is blocked and secondary windows such as `selector.html` can show a blank page.
- Missing Google font sources while font links remain -> font fetches are blocked.
- Removing `style-src 'unsafe-inline'` too early -> theme/style attributes may be blocked.
- Broadening fs scope without a callsite -> reject in review.

#### 5. Good/Base/Bad Cases
- Good: `tauri info` shows an explicit CSP and app builds still pass.
- Good: production `script-src` remains strict while `devCsp` has the minimal dev-only `unsafe-inline` needed for Vite React Refresh.
- Base: removed workflow fs and HTTPS import capabilities stay absent unless a
  new audited callsite is introduced.
- Bad: `csp: null`, `connect-src *`, or adding production `script-src 'unsafe-inline'` only to fix a dev-only Vite issue.

#### 6. Tests Required
- `jq empty src-tauri/tauri.conf.json src-tauri/capabilities/default.json`
- A config regression test must assert production `csp` keeps strict `script-src 'self'` and `devCsp` is the only script policy with `unsafe-inline`.
- `npm exec tauri info` to confirm the config is readable and shows the expected CSP.
- Full gates: `npm run check`, `npm run build:mobile`, `npm run build`, `cargo test`, and mobile e2e when mobile bridge behavior is in scope.

#### 7. Wrong vs Correct

Wrong:
```json
{ "security": { "csp": null } }
```

Correct:
```json
{ "security": { "csp": "default-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'" } }
```

</spec-entry>

<spec-entry category="quality" keywords="workspace,diff,codemirror,tauri,git,editor" date="2026-06-28" source="src/components/files/WorkspaceContentViews.tsx:187">

### Scenario: Workspace CodeMirror Editor and Editable Git Diff

#### 1. Scope / Trigger
- Trigger: Any change to main-content workspace file editing, CodeMirror integration, Git diff rendering, or Tauri commands that feed file/diff editor data.
- Applies to `src/components/files/**`, `src/lib/tauri-bridge.ts`, `src-tauri/src/git.rs`, `src-tauri/src/files.rs`, and workspace tab dirty-state wiring.

#### 2. Signatures
- Frontend file editor: `WorkspaceCodeEditor({ value, path, active, readOnly?, onChange?, onSave? })`
- Frontend diff editor: `WorkspaceMergeDiffEditor({ baseValue, currentValue, editable, onCurrentChange?, onSave? })`
- Frontend bridge: `git.changes.textDiff(projectPath: string, path: string): Promise<GitTextDiff>`
- Backend command: `git_file_text_diff(project_path: String, path: String) -> Result<GitTextDiff, String>`
- Save path: `workspaceFiles.write(rootPath, absolutePath, contents, currentModifiedUnixMs)`

#### 3. Contracts
- `GitTextDiff.sections[].kind` is `staged` or `unstaged`; only `unstaged` is editable in v1.
- Staged diff displays `HEAD` vs `Index` and must be read-only.
- Unstaged diff displays `Index` vs `Working tree`; edits and line/hunk reverts update an in-memory draft until the user saves.
- CodeMirror language extensions must load by file extension and be disabled above the syntax-highlight size threshold; do not recreate MergeView on every keystroke.
- Side-by-side `MergeView` diff panes may enable `EditorView.lineWrapping` only when both panes reserve identical gutter width; if the editable side has a line-action gutter, the read-only side must add an invisible placeholder gutter.
- MergeView CSS may make `.cm-scroller` `overflow-y: visible` for root-level vertical scrolling, but must preserve horizontal scrolling with `overflow-x: auto`.
- `Mod-s` is the only save shortcut in editor surfaces so macOS maps to `Cmd+S` and Windows/Linux maps to `Ctrl+S`.
- Saving must preserve CRLF-dominant files through `normalizeDraftForSave`.
- Workspace view identity is card-scoped even when two cards share the same
  root/path: React keys and dirty/open callbacks include `cardId + tabId`.
- Switching cards keeps dirty file/diff editors mounted so unsaved draft,
  undo, selection, and scroll remain local to the correct card. Clean editors
  may unmount to bound memory. Never use the currently focused card inside a
  callback owned by a retained hidden editor.
- Removing or archiving a card with dirty workspace tabs requires an explicit
  discard/recovery product contract. Do not silently unmount and claim the
  draft is preserved; until that UX exists, treat the path as a blocker.

#### 4. Validation & Error Matrix
- Repo-relative path is empty, absolute, parent-traversing, or Windows drive-like -> reject before running Git.
- Binary diff -> return/show binary state instead of creating editable sections.
- Missing working-tree file with unstaged deletion -> editable draft may be saved by creating the file inside the workspace root.
- File changed on disk after diff load -> `workspace_write_file` returns `file_conflict`.
- Untracked file with no staged diff -> show no textual diff and offer normal file open behavior.
- Soft-wrapped side-by-side diff lines with unequal gutter/content width -> unchanged sections can appear vertically misaligned.
- Switch from card A with a dirty editor to card B -> A remains mounted and
  hidden; updates from A continue to target A, never B.
- Remove/archive a card with dirty tabs and no confirmed recovery policy ->
  block or surface the unresolved product decision; do not silently discard.

#### 5. Good/Base/Bad Cases
- Good: click a modified file in Changes, edit the right diff pane, see dirty tab marker, save to working tree with the section mtime.
- Good: `Revert line` changes only the draft; if single-line mapping is unsafe, revert the current hunk and show a status message.
- Good: long unchanged lines in side-by-side diff wrap at the same visual column on both panes.
- Good: two cards open the same absolute path; card A keeps a dirty draft while
  card B loads a clean editor, with distinct component state and keys.
- Base: staged-only changes are visible but read-only.
- Bad: calling Git or writing files from the frontend directly, applying a revert immediately to disk without the explicit Save action, or enabling soft wrap while only one pane has an action gutter.
- Bad: rendering only the focused card's tabs and keeping `dirtyTabIds` while
  unmounting the actual editor; the marker survives but the unsaved draft does
  not.

#### 6. Tests Required
- Component tests for file edit save, CRLF preservation, diff load, diff draft
  save, dirty tab wiring, same-path cards, and dirty draft/local component
  state across card switches.
- Rust tests for `git_file_text_diff` editable unstaged sections and `workspace_write_file` restoring a missing file inside the workspace.
- Run `npm run typecheck`, targeted Vitest for workspace views/panels/tabs/i18n parity, `cargo check`, targeted Rust tests, `npm run build`, and `git diff --check`.

#### 7. Wrong vs Correct

Wrong:
```typescript
// Recreates the merge editor every time the right side changes.
useEffect(() => createMergeView(currentValue), [currentValue]);
```

Correct:
```typescript
// Keep the editor instance alive; CodeMirror transactions own per-keystroke updates.
useEffect(() => createMergeView(initialCurrentValue), [baseValue, languageExtensions]);
```

Wrong:
```typescript
const diffExtensions = [codeEditorTheme, EditorView.lineWrapping];
```

Correct:
```typescript
const baseDiffExtensions = [
  codeEditorTheme,
  EditorView.lineWrapping,
  createDiffLineActionPlaceholderGutter(),
];
const editableDiffExtensions = [
  codeEditorTheme,
  EditorView.lineWrapping,
  createDiffLineActionGutter(),
];
```

</spec-entry>

<spec-entry category="quality" keywords="desktop-native-feel,tauri,window-state,contextmenu,platform-material,webview" date="2026-05-30" source="src/lib/nativeDesktop.ts:1">

### Scenario: Desktop Native-Feel WebView Boundary

#### 1. Scope / Trigger
- Trigger: Any change to desktop native-feel behavior, Tauri window plugins,
  platform material/vibrancy, global context-menu policy, scrollbar platform
  styling, or multi-window WebView entrypoints.
- Applies to `src/lib/nativeDesktop.ts`, desktop HTML entrypoints,
  `src-tauri/src/lib.rs`, platform material code, `src/index.css`, and terminal
  host surfaces that need native context-menu exceptions.

#### 2. Signatures
- Frontend installer:
  `installNativeDesktopBehavior(doc?: Document, options?: { platformMaterial?: boolean }): () => void`
- Chrome text-selection installer:
  `installChromeTextSelectionPolicy(doc?: Document): () => void`
- Spellcheck installer:
  `installWebviewSpellcheckPolicy(doc?: Document): () => void`
- Overlay keep-warm loop:
  `installOverlayKeepWarmLoop(host?: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>): () => void`
- Frontend platform state:
  `detectNativePlatform(source?): 'macos' | 'windows' | 'linux' | 'unknown'`
- Frontend material sync:
  `syncPlatformMaterialAttribute(root?: HTMLElement): Promise<void>`
- Backend command:
  `native_platform_material_state() -> { enabled: bool, platform: NativePlatform }`
- Runtime gate env: `THREADTERM_PLATFORM_MATERIAL=1|true|on|yes`
- First-paint CSS experiment env:
  `VITE_THREADTERM_PLATFORM_MATERIAL=1|true|on|yes`

#### 3. Contracts
- Platform material is a gated spike, off by default. No env vars means the app
  keeps the existing opaque/fallback visual path.
- Only the main desktop entrypoint may pass `{ platformMaterial: true }`.
  Selector, float, pet, and future overlay entrypoints must install native
  context-menu/platform attributes with material disabled so transparent CSS
  never leaks into overlay windows.
- The backend reports material `enabled: true` only after the native material
  call succeeds. A supported platform plus enabled env var is not enough.
- Linux and unsupported platforms are no-op fallbacks and must not panic.
- `tauri-plugin-window-state` must persist only the `main` label. Overlay labels
  such as `selector`, `float`, and `pet` are self-positioning windows and must
  stay denied/filtered out of window-state restore.
- Global `contextmenu` handling must block normal chrome so WebKit/browser menus
  do not leak through, while allowing enabled `input`, `textarea`,
  `[contenteditable]`, and terminal/xterm surfaces marked by
  `.threadterm-xterm-host`, `.xterm`, `.xterm-viewport`, `.xterm-screen`, or
  `[data-terminal-context-menu]`.
- Desktop chrome text must default to non-selectable via
  `data-native-text-selection="chrome"`, but copyable content must explicitly
  opt back into text selection. The whitelist must cover `input`, `textarea`,
  enabled `[contenteditable]`, `pre`, `code`, `kbd`, `samp`, `.select-text`,
  `[data-selectable-text]`, and terminal/xterm surfaces.
- Do not put `user-select: none` only on `body` with a lower-specificity
  whitelist. Chromium/WebKit can leave nested `pre`/input content effectively
  non-selectable. Anchor whitelist rules under `body` with equal-or-higher
  specificity and verify computed `user-select: text` for copyable surfaces.
- Desktop spellcheck must default off on root/body and on mounted or later-added
  text editors. Preserve explicit `spellcheck` attributes so a field can opt in,
  and do not write spellcheck attributes onto non-text controls such as checkbox,
  radio, range, file, or button inputs.
- Prewarmed selector/float WebView entrypoints should run a tiny no-op
  `requestAnimationFrame` loop to keep WebKit's renderer scheduler warm. Scope
  this to intentionally prewarmed overlays; do not enable it globally in the
  main window or pet window without a measured reason.
- macOS selector/float NSWindows should disable WebKit occlusion detection in
  their platform configuration. This is macOS-only native plumbing; Windows and
  Linux keep the existing no-op/fallback behavior.
- macOS scrollbar styling should be left to WebKit/system defaults. Custom thin
  scrollbar selectors may target Windows/Linux/unknown platform markers only.

#### 4. Validation & Error Matrix
- Material env missing/false -> backend returns disabled; CSS material path stays
  off.
- Material env true but native apply fails -> backend returns disabled; frontend
  must restore `data-platform-material="disabled"`.
- Overlay entrypoint accidentally enables material -> selector/float/pet can
  become transparent or visually clipped; reject in review.
- Window-state includes overlay labels -> hotkey selector/float/pet geometry or
  focus can restore incorrectly; reject in review.
- Context-menu policy blocks editable controls -> copy/paste and text editing
  regress; add/fix tests.
- Context-menu policy allows ordinary chrome -> browser menu leaks and native
  feel regresses.
- Text-selection whitelist has lower specificity than the chrome default ->
  AI replies, code blocks, or inputs cannot be selected; verify with computed
  CSS, not only a visual glance.
- Spellcheck policy overwrites explicit `spellcheck="true"` -> intended user
  text fields lose their opt-in; reject in review.
- Spellcheck policy only touches currently mounted inputs -> late-mounted
  dialogs can still show web spellcheck redlines; use a MutationObserver or
  explicit component attributes.
- Keep-warm loop runs in the main window -> unnecessary perpetual rAF work;
  keep it scoped to selector/float overlays.

#### 5. Good/Base/Bad Cases
- Good: `src/main.jsx` calls
  `installNativeDesktopBehavior(document, { platformMaterial: true })`, while
  overlay entrypoints call `installNativeDesktopBehavior()` with the default
  disabled material path.
- Good: selector/float entrypoints call `installOverlayKeepWarmLoop()` after
  installing native desktop behavior; main/pet entrypoints do not.
- Good: chrome labels/buttons/drag regions cannot be selected, while `pre`,
  `code`, inputs, AI answer text, and terminal surfaces remain copyable.
- Base: no material env vars set; right-click is still native-feel blocked on
  chrome, input/terminal right-click still works, and the main window uses the
  existing visual treatment.
- Bad: using `VITE_THREADTERM_PLATFORM_MATERIAL=1` alone to force every WebView
  entrypoint into transparent CSS, or saving `selector`/`float`/`pet` through
  window-state.
- Bad: setting `body { user-select: none }` and assuming descendants remain
  selectable without a runtime/computed-style check.

#### 6. Tests Required
- TS tests for platform detection, context-menu allow/deny behavior, and default
  material-disabled installation.
- TS tests for text-selection root marker, spellcheck defaulting/explicit opt-in,
  dynamic input handling, and overlay keep-warm cleanup.
- Rust tests for env flag parsing and platform material state where pure logic is
  testable.
- Runtime/browser check for CSS specificity when changing the text-selection
  whitelist: assert `body` computes to `user-select: none` while a `pre` or
  copyable surface computes to `user-select: text`.
- Full gates: `npm run check`.
- Manual platform verification for macOS/Windows material first frame, material
  fallback, window-state restore, and overlay hotkey/focus behavior.

#### 7. Wrong vs Correct

Wrong:
```typescript
// In every WebView entrypoint.
installNativeDesktopBehavior(document, { platformMaterial: true });
```

Correct:
```typescript
// Main window only.
installNativeDesktopBehavior(document, { platformMaterial: true });

// Overlay windows.
installNativeDesktopBehavior();
```

Wrong:
```css
html[data-native-text-selection="chrome"] body {
  user-select: none;
}

html[data-native-text-selection="chrome"] :where(pre, input) {
  user-select: text;
}
```

Correct:
```css
html[data-native-text-selection="chrome"] body {
  user-select: none;
}

html[data-native-text-selection="chrome"] body :where(pre, input) {
  user-select: text;
}
```

</spec-entry>

<spec-entry category="quality" keywords="mobile-bridge,react-bundle,pairing,websocket,xterm,theme" date="2026-07-27" source="src-tauri/src/bridge/mod.rs:576">

### Scenario: Mobile Bridge React Client

#### 1. Scope / Trigger
- Trigger: Any change to the mobile bridge client, mobile bridge protocol, mobile static serving, pairing permission behavior, or post-pair session display.
- Applies to `mobile-app/`, `src/mobile/bridge/**`, `src-tauri/src/bridge/**`, and desktop theme broadcasting through `src/contexts/ThemeContext.jsx`.

#### 2. Signatures
- Mobile build: `npm run build:mobile` emits `mobile-app/dist/index.html`, `assets/index.css`, `assets/index.js`, `assets/vendor-react.js`, and `assets/vendor-xterm.js`.
- Static mobile shell: `GET /`, `GET /pair?server_id=<computer>&otp=<code>&permission=<read_only|full>`, and extensionless SPA paths serve `index.html`.
- Static assets: `GET /assets/index.css`, `GET /assets/index.js`, `GET /assets/vendor-react.js`, and `GET /assets/vendor-xterm.js` serve fixed bundle files.
- Pairing request: `POST /pair` with `{ otp, deviceName, permission, serverId }`.
- Desktop pairing command:
  `bridge_pair_qr(public_url: Option<String>, permission: Option<DevicePermission>) -> PairQrResponse`.
- Pairing authorization state: `PairingStore` owns the pending OTP permission
  ceiling, high-entropy one-time secret, authorization leases, and
  auth-revision notifications used by live WebSockets.
- Live updates: `GET /ws` authenticates with the first frame `{ protocol_version: 1, kind: "auth", token }`; query-string tokens are rejected.
- Snapshot fallback/API: `GET /snapshot` authenticates only with `Authorization: Bearer <deviceToken>`; query-string tokens are rejected.
- Browser pairing, snapshot, and WebSocket requests must be same-origin. The bridge does not emit cross-origin allow headers; mismatched `Origin` and `Host` are rejected.
- The bridge always binds `127.0.0.1`. QR generation may accept a complete HTTPS origin supplied by a mature secure tunnel, but must reject remote HTTP origins, paths, and query strings.
- Desktop UI code must use the official Tauri `isTauri()` detector first, with
  legacy `window.__TAURI_INTERNALS__` / `window.__TAURI__` checks only as
  fallback. Do not gate mobile bridge controls solely on an internal WebView
  global; WebView2 builds can otherwise look like browser mode and skip QR
  generation.
- Startup migration must replace any persisted non-loopback bind host with
  `127.0.0.1`. Do not reintroduce adapter discovery or wildcard binding as a
  fallback when no secure tunnel origin is supplied.
- Snapshot cards: `CardMeta` must include `id`, `status`, `projectPath`, `projectName`, `lastReplyPreview`, `summaryLine`, `hiddenLineCount`, and `recentOutputBytes`.
- Preview events: `kind: "preview"` must include `card_id`, `last_reply_preview`, `summary_line`, and `hidden_line_count`.
- Theme events: `kind: "theme"` must include `app`, `terminal`, and `mode`.
- Full-control input: mobile sends `{ kind: "input", card_id, data }`; Enter appends `\r`, Esc sends `\x1b`, and Ctrl-C sends `\x03`.
- Connection liveness: `useBridgeConnection` sends existing
  `{ kind: "ping" }` frames every `BRIDGE_HEARTBEAT_INTERVAL_MS` (5 seconds)
  and treats `BRIDGE_HEARTBEAT_TIMEOUT_MS` (15 seconds) without any server
  message as a stale connection.
- User-facing connection state extends transport state with `reconnecting` and
  `revoked`; the low-level `BridgeWsClient` still emits only
  `idle | connecting | open | closed | error`.
- Terminal transport identity: `snapshot.runtimeId`, `snapshot.streamSeq`,
  `terminal_output.runtimeId`, and `terminal_output.streamSeq`.
- Recovery request: mobile sends `{ kind: "terminal_resync" }`; the server
  responds to that device with the current state snapshot followed by every
  active terminal snapshot.
- Mobile feed budgets:
  `TERMINAL_FEED_CARD_BUDGET_BYTES = 4 * 1024 * 1024` and
  `TERMINAL_FEED_GLOBAL_BUDGET_BYTES = 32 * 1024 * 1024`.

#### 3. Contracts
- The mobile page is a React app built under `mobile-app/`, not a hand-maintained Rust HTML string template.
- Rust may embed only the fixed production bundle outputs listed above. If bundle filenames change, update both Vite output naming and `mobile_asset_bytes()`.
- `src-tauri/build.rs` must fail early when `mobile-app/dist/index.html` is
  missing. Production packaging builds it unconditionally; development must
  enter through `npm run dev:desktop`, which runs `build:mobile` before Vite so
  a clean checkout reaches Rust compilation with all embedded assets present.
- Static asset responses must set content type from the served file path. SPA fallback requests without an extension must still return `text/html`, not `application/octet-stream`.
- Mobile bundle filenames are fixed (`assets/index.js`, `assets/index.css`,
  vendor chunks), so all embedded mobile responses must use `no-store`.
  `index.html` must also append a version query to fixed asset URLs so clients
  that previously cached immutable no-query assets fetch the current bundle.
  Do not use immutable asset caching unless the bundle switches to content-hashed
  filenames and Rust `mobile_asset_bytes()` is updated with the hashed names.
- Pairing-page requests must set an explicit permission. Use `read_only` by
  default; enable `full` only from a deliberate full-control selection in the
  desktop pairing UI.
- Authorization is server-authoritative: `bridge_pair_qr` binds the selected
  maximum permission into the pending OTP before the URL is shown. The
  untrusted `PairRequest.permission` may attenuate a `full` OTP to `read_only`,
  but it must never elevate a read-only OTP.
- If a legacy or direct `POST /pair` request omits `permission`, backend
  pairing and persisted device rows must default to `read_only`, never `full`.
- `PairQrResponse.url` stays permission-neutral for response-shape
  compatibility. The desktop may append the same permission to the displayed
  URL as mobile UX metadata, but the URL/query value is not authorization.
- Issuing a new pairing code invalidates all older pending codes so switching
  from full control back to read-only cannot leave a usable full-control OTP.
- Pairing secrets carried by the QR URL must provide at least 128 bits of
  entropy and remain URL-safe. A six-digit online code is not acceptable for a
  LAN endpoint that can grant terminal control.
- The desktop owns a stable opaque `serverId`. Pair QR and pair response include
  it, every snapshot repeats it, and mobile clears its credential if the
  responding identity differs from the paired identity.
- Every authenticated WebSocket must subscribe to bridge-stop and auth-revision
  state. Revocation, expiry, or `bridge_stop` closes idle sockets; each inbound
  control message is revalidated before dispatch. `bridge_stop` waits for the
  server task and tracked HTTP/WebSocket work before reporting stopped.
- Mobile connection lifecycle events (`visibilitychange`, `online`,
  `pageshow`) must probe the existing socket. A healthy socket receives one
  `ping`; it must not be closed, replaced, or trigger an extra full snapshot
  request. A connecting socket is left alone. A missing, closed, or stale
  socket may start one deduplicated reconnect.
- Any valid server message refreshes the mobile liveness timestamp. The
  heartbeat timer closes and retries only after 15 seconds of server silence,
  using the existing capped exponential backoff.
- A new desktop process must create a new opaque `runtimeId`. Mobile treats a
  changed runtime id as an epoch boundary: clear old per-card output and
  sequence watermarks, then accept the new snapshots. Never compare a new
  process's PTY sequence with the previous process's sequence.
- `streamSeq` is a bridge-wide counter incremented only for terminal output
  broadcasts. PTY `seq` remains a per-card ordering guard; it cannot detect
  transport gaps because interleaved cards legitimately skip PTY sequence
  values from each other's perspective.
- A same-runtime `streamSeq` gap requests one deduplicated
  `terminal_resync`. Applying the returned state snapshot emits a local
  `recovery_boundary` before terminal snapshots so mounted xterm instances
  reset their old epoch without depending on a React rerender.
- Retained incremental terminal output is measured as UTF-8 bytes, not message
  count or JavaScript character count. Keep at most 4 MiB per card and 32 MiB
  globally; evict the least-recently-used card output first at the global
  boundary. Keep the latest server snapshot as the recovery baseline.
- Feed eviction must surface one local `history_truncated` notice with the
  cumulative omitted byte count. The notice is UI metadata and must never be
  written into xterm as if it were PTY output.
- Removing/archiving a card disposes its feed bucket immediately. A runtime
  change clears every retained output bucket and old transport watermark.
- Versioned `error` messages with `code: "auth_revoked"` or
  `code: "auth_expired"` are terminal for the current token: clear heartbeat
  and retry timers, close the socket, show re-pair guidance, and do not
  reconnect until the token changes. `bridge_stopped` remains recoverable.
- Every Full-control side effect acquires a per-device authorization lease
  atomically with revalidation and holds it through audit, PTY work, or desktop
  event dispatch. Revoke tombstones first, blocks new leases, and waits for
  existing leases; timeout is an explicit command error, never false success.
- Authenticated snapshot generation/serialization and WebSocket initial,
  resync, outbound, error, and close sends hold an active-device read/send
  lease. Revoke waits for both read/send and Full leases; bytes already
  serialized or accepted by the socket buffer are in-flight and not rollbackable.
- The outermost Axum middleware tracks requests before extractors/auth/DB work;
  WebSocket upgrade callbacks are tracked separately. Stop retains force-cancel
  for late registrations and returns an error if synchronous work cannot drain.
  A failed stop keeps its managed handle in runtime, reports conservative
  running/stopping status, rejects a new start generation, and can be retried
  after the tracked work exits.
- Mobile session credential keys are `threadterm.bridgeToken`,
  `threadterm.bridgePermission`, and `threadterm.bridgeServerId`. They live only
  in `sessionStorage`; startup must delete legacy durable credential copies
  from `localStorage`. A non-secret device display name may remain durable.
- A QR URL with `permission=read_only` must not inherit an existing stored `full` permission. Stored permission is used only for already-paired reconnects when no OTP is present.
- After successful HTTPS pairing, store the token and server identity for the
  current browser session and connect to `/ws`.
- Do not put device tokens into mobile WebSocket URLs by default. Browser WebSocket clients must authenticate with a first-frame `auth` message, then send `subscribe`.
- Never display or copy a phone QR whose public URL is not HTTPS. Keep the local
  bridge running, explain that a secure tunnel URL is required, and let the
  user provide the full HTTPS origin.
- Snapshot refetches after lag/backpressure should use the bearer header, not a query token.
- Query-token authentication is removed. Do not reintroduce it as a compatibility fallback.
- The WebSocket initial sequence must send `theme` first, then `snapshot`, then per-card `terminal_snapshot` messages. The client must merge these without dropping the latest terminal snapshot for the selected card.
- Render the initial `snapshot.cards` from the WebSocket snapshot message, then merge `preview`, `state`, `exit`, terminal output, terminal snapshots, and card lifecycle messages into the page state.
- Session cards must be real tap targets that open a detail view; do not render a static list with no click behavior.
- Session cards and details must show project context from `projectName` / `projectPath`, not only opaque session ids.
- Mobile preview rendering must use backend-provided `summaryLine` for the one-line semantic summary and keep `lastReplyPreview` for the thumbnail/body text. Do not derive the summary from input composer placeholders in the mobile DOM.
- Mobile detail views must render the live PTY through xterm.js using backend `terminal_snapshot` data for the initial screen and `terminal_output` messages for incremental output. Do not replace the detail terminal with line-filtered preview text; the list may still use `summaryLine` / `lastReplyPreview` as a thumbnail.
- Mobile xterm block components must keep the xterm instance alive for append-only
  output updates. Do not clear the host DOM and recreate `Terminal` whenever
  `block.data` grows; write only the appended suffix. Reset the existing
  terminal only when the data is replaced, shrinks, or a new block instance is
  mounted. This prevents mobile send/output streams from flashing on every
  `terminal_output` chunk.
- Mobile terminal block components must not gate xterm rendering behind a user
  interaction in preview mode. The Active Session preview frame is
  `pointer-events: none`, so any click-to-expand toggle is unreachable there;
  preview-mode blocks must render live xterm content immediately on mount and
  must not require `summary`/`tap-to-expand` chrome to be activated. Detail
  mode may keep a collapse affordance as long as the default state shows the
  xterm output. Stream classifiers that group output into sticky TUI blocks
  must assume those blocks will be rendered live in both preview and detail
  surfaces; do not rely on the user to expand a collapsed summary to make
  output visible.
- Full-control mobile pages should route keyboard data to bridge `input`. The auxiliary controls are Enter, Ctrl-C, and Esc only. Read-only pages must disable stdin, hide input controls, and keep an explicit read-only notice. Destructive close/kill controls are not part of the mobile page UX.
- Touch controls must keep the mobile keyboard stable without swallowing the action. If `touchstart` prevents default to preserve focus, run the command on touch and suppress the synthetic click so data is sent exactly once.
- Enter must defer reading the textarea by roughly 30ms before sending so iOS/Android composition and QuickType commits land before `\r` is appended.
- Enter must not send while IME composition is still active. Guard composing
  keydowns with `nativeEvent.isComposing` and the mobile/Safari fallback
  `keyCode === 229`, then let `compositionend` update the pending buffer before
  the next non-composing Enter sends.
- Mobile terminal transcript state must be recoverable from React state, not
  only from xterm DOM state. Viewport resize, `visualViewport` resize/scroll,
  orientation changes, `pageshow`, `pagehide`/`pageshow` recovery, and visible
  `visibilitychange` must replay/refit from stored terminal messages without
  dropping existing content.
- Mobile detail xterm should keep deep scrollback, but Active Session preview
  xterm must use bounded scrollback and requestAnimationFrame-coalesced fit
  calls. Only report bridge resize when fitted `{ cols, rows }` changes.
- When applying mobile `terminal_snapshot` / `terminal_output` messages,
  never let an older snapshot reset content after a newer output seq has been
  written. Repeated snapshots and already-applied outputs must be no-ops.
- Mobile xterm resize events may send bridge `resize` only for full-control devices. Local snapshot replay or hidden-view fitting must not issue read-only resize commands.
- Mobile card and detail layouts must set `min-width: 0` / `max-width: 100%` and wrap preview text with `overflow-wrap` so narrow phones never show horizontal overflow.
- Safe-area support must be explicit on mobile fixed surfaces: headers,
  scanner/detail nav, tab bar, and input bars should use
  `env(safe-area-inset-*)` via stable classes or equivalent CSS. Do not rely on
  the viewport meta tag alone.
- The desktop theme provider must push `bridge_broadcast_theme(app, terminal, mode)` when resolved tokens change. Mobile must apply app tokens and `mode` without requiring a reconnect. The mobile xterm surface may intentionally stay on a fixed dark DOM-rendered theme when required for iOS/WKWebView content visibility; do not reintroduce WebGL or a light terminal background without real-device verification that terminal text still paints.
- Do not show raw `protocolVersion`, `kind`, `cards`, `notifications`, or full JSON on the page.

#### 4. Validation & Error Matrix
- Missing OTP with a stored token -> reconnect to `/ws`.
- Missing OTP without a stored token -> show missing-code guidance.
- Stored token without the paired `serverId` -> clear it and require a new QR.
- Snapshot identity differs from the paired `serverId` -> clear the current
  session credential and show re-pair guidance.
- Pairing failure -> show retry button and error detail.
- Read-only QR with old full-control storage -> pair/read as `read_only`, not `full`.
- Read-only OTP with a tampered `permission: full` POST -> pair as
  `read_only`; never trust the client field as the authorization ceiling.
- Full OTP with missing/read-only request permission -> attenuate to
  `read_only`; grant `full` only when both the server OTP and request are full.
- New pairing code issued -> every previous pending OTP is invalid.
- Device revoked or token expired while WebSocket is idle -> send a versioned
  auth error and close the socket without waiting for a new client message.
- Bridge stopped with active WebSockets -> send `bridge_stopped`, close all
  sockets, and complete server shutdown before returning stopped status.
- Full command already in flight when revoke begins -> revoke blocks until its
  authorization lease drops; no later Full command can acquire a lease.
- Snapshot or authenticated WebSocket send already in flight when revoke begins
  -> revoke waits for its read/send lease and the socket's revocation close.
- Blocking HTTP extractor or synchronous operation exceeds stop deadline ->
  stop persists disabled state, returns a drain error, retains the stopping
  handle, rejects start, and a later stop retry removes it after drain.
- Pairing secret generation -> at least 128 bits, URL-safe, and collision-free
  across a representative generation test.
- WebSocket protocol mismatch -> show an error detail and do not render the raw payload.
- WebSocket upgrade without bearer auth -> require first-frame `auth`, then send initial `theme` and `snapshot`.
- WebSocket invalid/missing first-frame auth -> send a versioned `error` and close.
- Snapshot request with bearer token -> return the versioned snapshot.
- Snapshot request with missing/invalid bearer token or a query token -> return `401`.
- Cross-origin preflight -> no CORS grant; actual mismatched-origin protected request -> `403`.
- HTTPS tunnel origin entered in settings -> QR generation uses that origin while the bridge remains on `127.0.0.1`.
- Remote `http://` origin, or an HTTPS value containing a path/query -> reject without creating a phone QR.
- Tauri official `isTauri()` returns true while legacy globals are absent ->
  desktop-only mobile bridge controls remain enabled.
- Ordinary WebSocket close/error -> keep the page visible, show retry/reconnect,
  and retain the current session token. Identity mismatch, revoke, and expiry
  still clear or terminally retire that credential.
- Deliberate cleanup/reconnect -> close the stale client without scheduling a duplicate reconnect loop.
- Healthy foreground/online/pageshow event -> send `ping` on the existing
  socket; create zero new sockets and issue zero snapshot fallback requests.
- No server message for 15 seconds -> close the stale socket, show
  `reconnecting`, and enter capped backoff.
- `auth_revoked` or `auth_expired` -> show explicit re-pair guidance and create
  zero reconnect sockets until a replacement token is supplied.
- Old server closes without an auth error -> retain ordinary reconnect behavior
  for compatibility.
- Lag/backpressure message -> fetch `/snapshot` and merge it without clearing current terminal snapshots prematurely.
- Desktop runtime changes while the mobile page remains open -> clear old feed
  content and accept the new runtime's state and terminal snapshots.
- Same-runtime `streamSeq` jumps forward by more than one -> send exactly one
  `terminal_resync` until its state snapshot establishes a new baseline.
- Duplicate or older `streamSeq` -> ignore without requesting another resync.
- One card exceeds 4 MiB or all cards exceed 32 MiB of retained UTF-8 output ->
  discard oldest retained increments, preserve the latest snapshot, and expose
  one cumulative truncation notice.
- Card removed/archived -> its retained byte count reaches zero immediately.
- Missing production mobile bundle -> cargo build fails in `build.rs` before producing a broken app.
- Empty `cards` array -> show an empty session message, not a blank panel.
- Unknown static asset with an extension -> return `404`, not the app shell.

#### 5. Good/Base/Bad Cases
- Good: paired page connects live, applies the desktop app theme while keeping the terminal surface visibly dark, shows tappable project cards, opens xterm detail with project path, summary, preview lines, and full-control input only when paired as `full`.
- Good: returning to a healthy paired page reuses its socket; a revoked device
  stops retrying and explains that the desktop QR link must be opened again.
- Good: the desktop restarts while the phone stays open; the phone detects the
  new runtime, drops the obsolete sequence watermark, and resumes from fresh
  snapshots without a page refresh.
- Base: no live terminal sessions shows "No live terminal sessions yet."
- Base: old servers omit `runtimeId` / `streamSeq`; the client keeps the legacy
  snapshot/backpressure path rather than inventing false gaps.
- Good: a long markdown or terminal line wraps inside the phone viewport and does not resize the page horizontally.
- Bad: `JSON.stringify(await snapshot.json(), null, 2)` displayed directly in the mobile page.
- Bad: one long terminal line forces the page wider than the phone viewport.
- Bad: a card title/summary displays the AI CLI composer placeholder (for example `› Summarize recent commits`) instead of the last assistant response.
- Bad: a read-only QR opens a full-control input bar because an old `full`
  permission was already in durable browser storage.
- Bad: a phone QR points to `http://192.168.x.x`, or a device token appears in
  the URL, browser history, referrer, or durable `localStorage`.
- Bad: a touch Enter button preserves focus but sends nothing because the click was suppressed.
- Bad: every `pageshow` destroys a healthy socket and fetches another full
  snapshot, or an explicitly revoked token retries forever.
- Bad: use per-card PTY `seq` to infer WebSocket packet loss, because normal
  multi-card output creates legitimate gaps.
- Bad: retain 2,000 messages regardless of their byte size, or write
  "history truncated" into the terminal byte stream.

#### 6. Tests Required
- Rust bridge tests must assert static mobile assets are served, SPA fallback returns the built index with `text/html`, and unknown file assets return `404`.
- Rust protocol/server tests must assert `theme` serializes correctly and initial WebSocket messages send `theme` before `snapshot`.
- Mobile unit tests must cover session-only credentials, deletion of legacy
  durable credentials, server identity mismatch, read-only QR precedence over
  stored full permission, theme application, message validation, ANSI
  classification, and touch input de-duplication.
- Mobile input tests must cover IME/composition Enter behavior in addition to
  touch de-duplication, Enter, Esc, Ctrl-C, and read-only disabled state.
- Mobile e2e tests must run on Android Chrome and WebKit-backed iOS Safari
  emulation projects, exercising tab/detail navigation, xterm/TUI expansion,
  theme lock, long-text wrapping, full-control input, read-only mode,
  safe-area surfaces, scrollability, viewport resize/zoom-like changes,
  `visualViewport`, `visibilitychange`, `pagehide`/`pageshow`, lag snapshot
  recovery, and reconnect behavior.
- Typecheck and production builds must include both roots: `src/**` and `mobile-app/src/**`.
- Tauri packaging/build checks must run after `npm run build:mobile` so Rust `include_bytes!` paths point at current bundle files.
- Desktop settings tests must assert `mobileBridge.pairQr(secureUrl, permission)`
  is called for the initial code and every permission change, the displayed
  HTTPS URL mirrors that permission, and a failed refresh hides the stale code.
- Bridge preview tests must cover mobile summary noise such as Trellis hook lines, MCP startup noise, duplicate line cleanup, and AI CLI composer/input prompt lines.
- Rust bridge tests must cover first-frame WebSocket auth, bearer parsing, and
  rejection of query-token auth.
- Rust bridge tests must cover denied cross-origin preflight/request, missing
  token, invalid token, bearer snapshot auth, and query-token rejection.
- Settings tests must cover HTTPS tunnel origin, hidden loopback QR, and the
  fixed loopback bind address.
- Desktop bridge wrapper tests must cover official `isTauri()` detection and
  fallback globals.
- Rust pairing tests must cover read-only tamper resistance, full grant,
  attenuation, high-entropy/single-use secrets, and invalidation of older codes.
- Real Axum/WebSocket integration tests must prove revoke, expiry, and stop
  close already-authenticated idle sockets; a test that only rejects reconnect
  is insufficient.
- Bridge concurrency tests must prove revoke waits for an active Full lease,
  passive expiry prevents paced-input tail writes, stop reports an
  uninterruptible drain, force-cancel is retained for late registrations, and
  HTTP tracking starts before JSON/auth extractors.
- Mobile WS client tests must assert the token is sent in an `auth` frame before
  `subscribe`, `buildBridgeWsUrl()` uses `wss:` for HTTPS, and remote plaintext
  or incomplete origins are rejected.
- Mobile connection-hook fake-timer tests must cover healthy lifecycle probes,
  continuing pong responses, the 15-second silence timeout, terminal
  revoke/expiry behavior, and recovery after a replacement pairing token.
- Mobile e2e must assert foreground lifecycle events preserve one socket and do
  not fetch another snapshot, ordinary close reconnects, and revocation stops
  further socket creation on both Android Chrome and iOS Safari projects.
- Mobile terminal tests must assert preview/detail scrollback sizes, stale snapshot suppression after newer output, coalesced viewport fitting, and unchanged-size resize suppression.
- Protocol tests must assert camelCase `runtimeId` / `streamSeq` fields and
  parse `{ kind: "terminal_resync" }`.
- Feed tests must cover runtime rollover without page reload, one deduplicated
  resync for a stream gap, duplicate transport messages, 4 MiB per-card and
  32 MiB global byte limits, LRU eviction, truncation notice behavior, and
  immediate cleanup after card removal.
- Desktop sync tests must prove that sustained output cannot postpone mobile
  state publication beyond one second and that serialization is skipped when
  no mobile subscriber exists.

#### 7. Wrong vs Correct

Wrong:
```rust
async fn pair_page_handler() -> Html<String> {
    Html(format!("<script>{}</script>", generated_runtime_js()))
}
```

Correct:
```rust
async fn pair_page_handler() -> Response {
    mobile_asset_response("index.html")
}
```

Wrong:
```typescript
const permission = storedPermission ?? permissionFromQr ?? 'read_only';
```

Correct:
```typescript
const permission = otp ? (permissionFromQr ?? 'read_only') : (storedPermission ?? 'read_only');
```

Wrong:
```rust
let permission = request.permission.unwrap_or(DevicePermission::ReadOnly);
```

Correct:
```rust
let permission = match (&pending.max_permission, &request.permission) {
    (DevicePermission::Full, Some(DevicePermission::Full)) => DevicePermission::Full,
    _ => DevicePermission::ReadOnly,
};
```

Wrong:
```typescript
new WebSocket(`/ws?token=${deviceToken}`);
await fetch(`/snapshot?token=${deviceToken}`);
```

Correct:
```typescript
const ws = new WebSocket('/ws');
ws.send(JSON.stringify({ protocol_version: 1, kind: 'auth', token: deviceToken }));
await fetch('/snapshot', { headers: { Authorization: `Bearer ${deviceToken}` } });
```

Wrong:
```typescript
window.addEventListener('pageshow', () => {
  socket.close();
  connect();
  fetchSnapshot();
});
```

Correct:
```typescript
window.addEventListener('pageshow', () => {
  if (socketIsOpenAndFresh()) socket.send({ kind: 'ping' });
  else ensureOneReconnect();
});
```

Wrong:
```typescript
// PTY seq is card-local evidence and cannot identify global transport gaps.
if (message.seq > lastCardSeq + 1) requestResync();
```

Correct:
```typescript
if (message.runtimeId !== activeRuntimeId) resetRuntime();
if (message.streamSeq > lastStreamSeq + 1) requestTerminalResyncOnce();
```

</spec-entry>

<spec-entry category="quality" keywords="mobile-workbench,bridge,snapshot,projection,notifications,pty-state,theme" date="2026-07-26" source="src/mobile/bridge/workbenchProjection.ts:1">

### Scenario: Recoverable Mobile Workbench Projection

#### 1. Scope / Trigger
- Trigger: Any change to the mobile Workbench, its desktop projection, Bridge
  snapshot state, notification mirroring, mobile terminal-status display, or
  mobile app/terminal theme ownership.
- Applies to `src/mobile/bridge/**`, `TerminalManager`, `tauri-bridge`,
  `src-tauri/src/bridge/**`, and `mobile-app/src/**`.

#### 2. Signatures
- Desktop projection:
  `buildMobileWorkbenchProjection(input: MobileWorkbenchProjectionInput): MobileWorkbenchProjection`
- Notification projection:
  `notificationsToMobile(notifications): NotificationEntry[]`
- Frontend Tauri boundary:
  `mobileBridge.syncState(cards, notifications, workbench): Promise<void>`
- Rust command:
  `bridge_sync_state(cards, notifications, workbench) -> Result<(), String>`
- Recoverable snapshot field:
  `Snapshot.workbench?: MobileWorkbenchProjection | null`

#### 3. Contracts
- Desktop `useWorkbenchModel` is the only owner of attention, summary,
  execution-group, and rule derivation. Mobile receives a bounded serializable
  projection and must not recreate those rules from cards or notifications.
- The mobile projection is global and must not inherit the desktop Workbench's
  current project/worktree UI filter.
- Cards, notifications, and Workbench projection update one Rust mirror under
  one lock and emit one snapshot. The legacy `bridge_sync_cards` command may
  update cards for compatibility but must preserve the current notification and
  Workbench mirrors.
- `workbench` and expanded notification fields are additive v1 fields. Missing
  `workbench` replaces any stale mobile projection with `null`; it must not
  reuse data from a previous connection.
- Mobile capabilities describe real actions. Until the Bridge implements them,
  structured-request response, rule edits, and notification read-state updates
  remain `false` and the UI renders explanation text instead of fake controls.
- Incremental `state` and `exit` messages must update both `CardMeta.status` and
  `CardMeta.ptyState`. Mobile status rendering prefers `ptyState` when present,
  so updating only `status` leaves stale snapshot state visible.
- Mobile app theme preference may override the application chrome mode, but
  xterm and terminal chrome continue to consume the latest Bridge
  `terminal` tokens without remounting the xterm instance.
- The root navigation is `workbench | terminal | settings`; only a pushed
  terminal detail mounts xterm. Workbench/list navigation must not create
  hidden xterm instances.
- Project/worktree scope labels must avoid redundant names. A card whose
  effective worktree path equals its project path displays only the project
  name; a distinct worktree displays `projectName · branchLabel`, falling back
  to the worktree directory label only when branch metadata is absent and
  suppressing the suffix if it is still identical to the project name.

#### 4. Validation & Error Matrix
- Legacy snapshot without `workbench` -> keep cards/notifications compatible
  and show the explicit Workbench compatibility state.
- Reconnect after desktop state changed -> one snapshot restores cards,
  notifications, rules, attention items, and execution groups consistently.
- Legacy `bridge_sync_cards` after a full state sync -> replace cards without
  clearing the current notification/projection mirrors.
- `exit(code != 0)` after a snapshot with
  `ptyState = waiting_for_input` -> both status fields become `failed`, and the
  terminal list displays failed.
- Read-only pairing -> Workbench remains visible, terminal detail has no input,
  and unsupported mutation actions remain absent.
- Mobile light-mode override with a dark server terminal palette -> app chrome
  becomes light while xterm keeps the server terminal background/foreground.

#### 5. Good/Base/Bad Cases
- Good: the desktop derives one global projection, atomically syncs it with
  notifications and cards, and a reconnect restores the same Workbench view.
- Good: an `exit(137)` event immediately changes a previously waiting terminal
  badge to failed without waiting for another full snapshot.
- Base: an older desktop omits `workbench`; the mobile terminal and settings
  surfaces still work and Workbench reports that projection data is unavailable.
- Bad: mobile infers approval/review/stalled items from `CardMeta`, creating a
  second rules engine that can disagree with desktop.
- Bad: sync cards, notifications, and projection through separate commands,
  exposing mixed-generation snapshots.
- Bad: update `card.status` but leave `card.ptyState` unchanged.

#### 6. Tests Required
- Pure projection tests must assert stable field mapping, bounded payloads,
  notification routing metadata, capabilities, and no inferred progress.
- Tauri-wrapper and `TerminalManager` tests must assert one
  `bridge_sync_state` call with global project/worktree data.
- Rust tests must assert notification/projection recovery from a later snapshot,
  atomic mirror behavior, and legacy card-sync preservation.
- Mobile reducer tests must assert missing-projection replacement and
  `status`/`ptyState` parity for state and exit messages.
- Mobile component/E2E tests must cover default Workbench navigation,
  full-screen return context, read-only input removal, 360 px width containment,
  server terminal-theme retention, and reconnect/backpressure recovery in both
  Chromium and WebKit.
- Terminal scope-label tests must cover a root project such as `Test` without
  rendering `Test · Test`, plus a linked worktree with a distinct branch label.

#### 7. Wrong vs Correct

Wrong:
```typescript
await mobileBridge.syncCards(cards);
await mobileBridge.syncNotifications(notifications);
await mobileBridge.syncWorkbench(workbench);
```

Correct:
```typescript
await mobileBridge.syncState(cards, notifications, workbench);
```

Wrong:
```typescript
card.id === message.card_id ? { ...card, status: message.status } : card;
```

Correct:
```typescript
card.id === message.card_id
  ? { ...card, status: message.status, ptyState: message.status }
  : card;
```

</spec-entry>

<spec-entry category="quality" keywords="desktop-pet,tauri-overlay,cross-webview,zustand,notifications" date="2026-05-12" source="src/pet/PetBridge.tsx:30">

### Scenario: Desktop Pet Cross-Webview Overlay

#### 1. Scope / Trigger
- Trigger: Any change to the desktop pet overlay, desktop notification dispatch,
  cross-window state sync, or persisted pet settings.
- Applies to `src/pet/**`, `src/components/settings/DesktopPetSettings.tsx`,
  `src/components/terminal/NotificationBridge.tsx`,
  `src/stores/terminalStore.ts`, `src-tauri/src/overlay/**`, and `pet.html`.

#### 2. Signatures
- Frontend persisted config: `DesktopPetConfig`.
- Frontend event producer: `PetBridge` emits `pet://state-update` and
  `pet://notify`.
- Pet window event consumer: `usePetSync()` listens for those events and emits
  `pet://settings-update`.
- Rust commands:
  - `pet_show() -> Result<(), String>`
  - `pet_hide() -> Result<(), String>`
  - `pet_set_position(x: f64, y: f64) -> Result<(), String>`
  - `pet_set_expanded(expanded: bool, size: Option<f64>) -> Result<(), String>`
  - `pet_focus_main_to_card(card_id: String) -> Result<(), String>`
  - `pet_open_notification_center() -> Result<(), String>`

#### 3. Contracts
- Pet is opt-in. New installs and migrations must default `enabled` to `false`.
- `notificationMode` must be one of `off`, `system`, `pet`, or `both`.
- OS notification dispatch belongs in `NotificationBridge`; pet notification
  dispatch belongs in `PetBridge`. Do not put side-effecting Tauri calls inside
  `terminalStore.pushNotification`.
- Main-window Zustand state is not shared with the pet webview. All pet runtime
  data must cross through Tauri events, not direct store imports in the pet
  window.
- `PetStatePayload` is derived data. It must include only attention cards,
  recent notifications, unread count, config, and `updatedAt`.
- Programmatic window creation is required for `pet.html`; do not add a static
  `tauri.conf.json` window that would create a duplicate non-NSPanel pet window.
- On macOS, the pet window uses `tauri-nspanel`; non-macOS falls back to a
  hidden, always-on-top, decorationless `WebviewWindow`.

#### 4. Validation & Error Matrix
- Non-Tauri browser mode -> render the pet/settings UI without invoking native commands.
- Disabled pet -> call `pet_hide` and suppress `pet://notify`.
- `notificationMode: off` -> no OS notification and no pet notification.
- `notificationMode: system` -> OS notification only.
- `notificationMode: pet` -> pet event only.
- `notificationMode: both` -> both channels dispatch once.
- Unknown persisted config values -> normalize back to documented defaults.
- Missing card for `pet://focus-card` -> ignore instead of throwing.

#### 5. Good/Base/Bad Cases
- Good: enabling the pet shows `pet.html`, positions it from the persisted
  config, and emits an attention-card payload.
- Base: no attention cards renders an empty pet panel while keeping the sprite visible.
- Good: clicking a pet card focuses the main window, marks the card read, and
  closes overlay UI.
- Bad: importing `useTerminalStore` in the pet webview and expecting it to share
  main-window runtime state.
- Bad: changing `pushNotification` to call native notification APIs directly.

#### 6. Tests Required
- Unit tests for `normalizePetConfig` defaults and invalid persisted values.
- Unit tests for `buildPetState` filtering, ordering, preview derivation, and
  notification caps.
- Component tests for `DesktopPetSettings` controls and browser/Tauri disabled states.
- Unit tests for `shouldDispatchOsNotification`.
- Settings export/import tests must include `petConfig`.
- Build gates must include `npm run typecheck`, `npx vitest run`,
  `npm run build`, `cargo check`, `cargo build`, and `cargo test`.
- Browser smoke tests should load `pet.html`, assert the sprite is visible, and
  expand the panel without page errors.

#### 7. Wrong vs Correct

Wrong:
```typescript
pushNotification(notification) {
  void invoke('notification_send_os', notification);
  void emit('pet://notify', notification);
}
```

Correct:
```typescript
useTerminalStore.subscribe((state, prev) => {
  if (state.notifications !== prev.notifications && state.petConfig.enabled) {
    void emit('pet://notify', newestNotification);
  }
});
```

Wrong:
```json
{ "label": "pet", "url": "pet.html", "visible": false }
```

Correct:
```rust
PanelBuilder::<_, OverlayPetPanel>::new(app, PET_LABEL)
    .url(WebviewUrl::App("pet.html".into()))
    .build()?;
```

</spec-entry>

<spec-entry category="quality" keywords="terminal,right-surface,session-dock,workspace-panel,xterm-resize,keyboard-priority" date="2026-06-30" source="src/components/terminal/KeyboardBridge.tsx:78">

### Scenario: Terminal right-side surfaces share one stable layout slot

#### 1. Scope / Trigger
- Trigger: Any frontend change to terminal right-side surfaces, including workspace files/changes, stats, archive, bookmarks, or recent-session dock.
- Applies to `TerminalManager`, `SessionDock`, and any future terminal-side panel.

#### 2. Contracts
- In focus mode, the workspace files/changes rail is permanent whenever the focused card has a cwd; it is not a toggleable panel.
- Auxiliary right-side surfaces (stats, archive, bookmarks, recent-session dock) must render in the same fixed-width flex `aside` slot and temporarily replace the workspace rail.
- Do not make one right-side surface a floating overlay while another surface participates in flex layout.
- Session dock priority may still be last-opened-wins, but it must use the same slot as workspace/files so switching between them does not resize the terminal content.
- The session dock must not use edge hover triggers; it opens/closes from the global keyboard shortcut only.
- The focused terminal header height must align with the workspace panel header stack (`WorkspacePanel` tab row + cwd row) so the split boundary has continuous horizontal rules.
- If an auxiliary surface closes, the slot should restore the permanent workspace rail without changing the terminal column width.
- When the terminal content becomes active again after being hidden by file/diff tabs or other focus-mode layers, `Shell` must recover the xterm surface and scroll to the bottom unless text is selected.
- Programmatic terminal bottom recovery must update both xterm and React state: clear `scrolledUp`, reset pending new-line counters, and repaint after `scrollToBottom`.
- Selecting a recent session from the dock should focus that card and make its terminal tab active; existing file/diff tabs for that session may remain open but should not steal focus.
- While the session dock is active, `KeyboardBridge` owns `0-9`, `ArrowUp`, `ArrowDown`, `Home`, `End`, `Enter`, and `Escape` before terminal/global shortcut handlers, then forwards them to `SessionDock`.
- Do not ignore session-dock navigation just because the event target is xterm's hidden `textarea`; only editable targets inside the dock itself may opt out.

#### 3. Validation & Error Matrix
- Switching Files/Changes -> Recent sessions -> Files/Changes must not repeatedly resize or reflow xterm.
- Entering focus mode may resize the terminal once to account for the permanent workspace rail; switching auxiliary surfaces after that should keep the same content width.
- If session dock is rendered outside the shared `aside`, expect terminal fit/reflow flicker when users rapidly alternate surfaces.
- If the workspace rail is toggleable again, expect toolbar clicks to repeatedly resize xterm and refresh terminal layout.
- If terminal activation only calls `fit/refresh/focus`, xterm can reopen at the top of scrollback after a header-height or tab visibility change.
- If programmatic bottom recovery only calls xterm `scrollToBottom`, the React scroll indicator can stay stale and leave an empty-looking terminal with a visible "scroll to bottom" prompt.
- If session-dock keyboard handling lives only in the dock component, earlier global capture listeners or xterm's focused hidden `textarea` can make number/arrow selection appear broken.

#### 4. Tests Required
- Component regression tests should assert session dock is hosted inside the right-side `aside` when it takes priority over the workspace rail.
- Tests should cover restoring the workspace rail after a shortcut-opened session dock closes.
- Tests should cover number-key and arrow/Enter session selection from the dock.
- Tests should cover xterm-like `textarea` focus and `KeyboardBridge` forwarding while `[data-session-dock-active="true"]` is present.

</spec-entry>

<spec-entry category="quality" keywords="workbench,attention,codex,requests,terminal,navigation" date="2026-07-25" source="src/lib/workbench/deriveAttentionItems.ts:1">

### Scenario: Deterministic Terminal Attention Workbench

#### 1. Scope / Trigger
- Trigger: Any change to the Workbench page, primary terminal navigation,
  attention rules, provider request adapters, or Workbench side-panel actions.
- Applies to `src/lib/workbench/**`, `src/components/workbench/**`,
  `codexRequestStore`, `CodexRequestBridge`, `CodexChatView`,
  `ProjectSidebar`, and `TerminalManager`.
- The Workbench is a deterministic read model over existing terminal state. It
  is not a task orchestrator, mission graph, verification engine, or LLM steward.

#### 2. Signatures

```typescript
type PrimaryView = 'workbench' | 'terminals';

interface WorkbenchRules {
  includeWaiting: boolean;
  includeFailed: boolean;
  includeCompletedReview: boolean;
  stalledEnabled: boolean;
  stalledThresholdMinutes: number;
  stalledExcludedCardIds: string[];
}

function deriveAttentionItems(input: {
  cards: readonly TerminalCard[];
  notifications: readonly NotificationEntry[];
  supervisorAlerts: readonly SupervisorAlert[];
  codexRequests: readonly PendingCodexRequest[];
  rules: WorkbenchRules;
  now: number;
  selectedProjectPath?: string | null;
  selectedWorktreePath?: string | null;
}): AttentionItem[];
```

Codex request observation is application-scoped:

```typescript
codexApp.onRequest(handler): Promise<() => void>;
codexApp.onDisconnected(handler): Promise<() => void>;
codexApp.respondRequest(requestId, response): Promise<void>;
```

`CodexRequestBridge` owns observation and notification projection.
`CodexChatView` remains the only UI that calls `respondRequest`.

#### 3. Contracts
- `primaryView` selects Workbench or the existing `CardGrid`; `viewMode`
  continues to own `grid | focus`. Switching primary pages must not kill,
  archive, recreate, or unmount an already-mounted PTY merely for navigation.
- Workbench code must not import or render `TerminalView`, `Shell`, xterm, or a
  WebGL preview. It consumes bounded card previews, events, notifications, and
  request metadata.
- Apply the existing exact project/worktree matching helpers before deriving
  counts, attention items, or execution-context groups.
- Source priority for the same waiting semantic is:
  structured request > unacted Supervisor alert > unread notification >
  terminal state. Distinct structured requests remain distinct.
- A failed card is hidden while an automatic restart attempt is pending.
  Workbench rules never create a second retry limit.
- Completion evidence is disjunctive: an unread `completed` notification or
  `card.status === "completed"` independently projects one `review` item.
  A normal agent reply commonly transitions `running -> idle` while emitting
  the notification, so the projection must not also require the card to remain
  `completed`. An idle card leaves Workbench only after that completion signal
  is acknowledged; an idle card with no unread signal remains in All terminals.
- No-progress detection is off by default. Enabling it is an explicit opt-in
  across provider and custom terminal types; users may exclude dev servers,
  watchers, and other long-running cards individually. Do not branch Workbench
  behavior on model brand names.
- Execution contexts are grouped by `projectPath + effectiveWorktreePath`.
  They are not tasks and must not show inferred dependencies or percentages.
- Workbench actions are navigation-only. Approval, rejection, terminal input,
  restart, archive, file writes, and verification remain in their authoritative
  existing surfaces.
- Workbench detail panels must remain width-contained on narrow windows. The
  panel root and vertical scroll body use `min-width: 0`, `max-width: 100%`,
  and horizontal overflow containment so descendant min-content cannot widen
  the shared flex `aside`.
- Terminal-derived detail previews preserve producer line breaks but allow
  arbitrary wrapping for unbroken prompt/box-drawing runs. A repeated Unicode
  rule, long path, or command token must wrap inside the preview card rather
  than extend beyond its border or create document-level horizontal scrolling.
- Do not render cost, token, test, diff, port, or verification claims unless a
  real structured source for that exact field is available.
- `CodexRequestBridge` is mounted once near the other application bridges.
  Pending request payloads are bounded, deduplicated, and memory-only.
- A successful Codex response removes the pending request and its notification.
  A failed response retains both so the user can retry. Disconnect removes
  requests that can no longer be executed and records a disconnect generation.

#### 4. Validation & Error Matrix
- Request has a valid `cardId` -> bind directly to that card.
- Request lacks `cardId` but has a bound thread id -> resolve through
  `TerminalCard.codexAppThreadId`.
- Request cannot resolve to a live card -> log and drop it; do not create a
  dead-end Workbench action.
- Duplicate request id -> keep the first pending request and do not push a
  second notification.
- Listener registration resolves after component cleanup -> call the returned
  unlistener immediately.
- Codex app-server disconnects -> remove request notifications, clear pending
  executable projections, and surface the disconnect in mounted Chat views.
- Non-structured provider signal -> show `Open terminal`, never synthetic
  Approve/Reject actions.
- Selected project/worktree contains no cards -> show a scoped empty state,
  not the global first-run message.
- Unbroken terminal preview at a 407 px viewport -> signal bounds stay inside
  the detail panel, `signal.scrollWidth <= signal.clientWidth`, and document
  width does not exceed the viewport.

#### 5. Good/Base/Bad Cases
- Good: a Codex approval arrives while its Chat view is unmounted; the
  application bridge records it, Workbench shows `View request`, and opening it
  focuses the existing Codex terminal where the response is sent.
- Good: a Grok or custom CLI reaches `waiting` through generic PTY state;
  Workbench shows a provider-neutral waiting item and opens its terminal.
- Base: an idle card with no unread signal remains available in All terminals
  but does not consume Workbench execution-context space.
- Good: a terminal preview containing a long box-drawing rule wraps within the
  latest-signal card while retaining its explicit line breaks.
- Bad: putting Approve/Reject buttons in an attention row and writing directly
  to a PTY based on regex output.
- Bad: calling an execution-context group a verified task or inventing progress,
  cost, test counts, or diffs from output text.
- Bad: relying on `overflow-y: auto` alone in the side panel; an unbroken child
  can still contribute a large flex min-content width and escape the panel.

#### 6. Tests Required
- Pure projection tests: source precedence, structured-request multiplicity,
  recovery removal, project/worktree filtering, pending-restart suppression,
  provider-neutral no-progress opt-in/exclusions, group severity, and the
  `normal running -> idle with unread completed notification -> review ->
  acknowledged idle removal` transition.
- Store/bridge tests: request dedup and cap, thread fallback, unresolved
  request degradation, disconnect cleanup, and late-listener cleanup.
- Chat tests: card isolation, unchanged response payload, success cleanup, and
  notification cleanup.
- Component tests: exactly three primary actions, default Workbench, lossless
  Workbench/All terminals switching, return-to-origin behavior, capability
  degradation, local-only rules, hidden unavailable evidence, and explicit
  width/wrapping classes for unbroken terminal signals.
- Desktop browser regression: use a narrow viewport and assert both document
  and latest-signal geometry have no horizontal overflow.
- Required gates: `npm run typecheck`, targeted Workbench/Codex/terminal
  Vitest, `npm run check`, and `git diff --check`.

#### 7. Wrong vs Correct

Wrong:

```typescript
// A row guesses that every AI CLI supports direct approval.
onClick={() => pty.write(card.id, 'y\r')}
```

Correct:

```typescript
// The Workbench only navigates to the authoritative interaction surface.
onClick={() => onOpenTerminal(item.cardId)}
```

Wrong:

```typescript
// Requests disappear when this card view is unmounted.
useEffect(() => codexApp.onRequest(setLocalRequests), []);
```

Correct:

```typescript
// One application bridge observes requests; card views select their subset.
<CodexRequestBridge />
const requests = useCodexRequestStore(
  (state) => state.requests.filter((request) => request.cardId === card.id),
);
```

Wrong:

```tsx
<aside className="flex flex-col">
  <p>{group.preview}</p>
</aside>
```

Correct:

```tsx
<aside className="flex min-w-0 max-w-full flex-col overflow-x-hidden">
  <p className="max-w-full whitespace-pre-wrap break-all overflow-hidden">
    {group.preview}
  </p>
</aside>
```

</spec-entry>

<spec-entry category="quality" keywords="notifications,tauri,pty,supervisor,codex,dedup,focus" date="2026-07-26" source="src/lib/osNotificationPolicy.ts:1">

### Scenario: Semantic OS Notification Boundary

#### 1. Scope / Trigger
- Trigger: Any change to automatic desktop OS notifications, terminal
  `attention-required` events, reply-completion notifications, Supervisor
  alerts, Codex structured requests, or worktree result notifications.
- Applies to `NotificationBridge`, `osNotificationPolicy`,
  `TerminalEventBridge`, `CodexRequestBridge`, Supervisor store/hook,
  `NotificationEntry`, and Rust PTY attention payloads.

#### 2. Signatures

```typescript
interface NotificationRouting {
  origin: 'pty' | 'reply' | 'codex_request' | 'supervisor' | 'auto_restart';
  family: 'interaction' | 'completion' | 'failure' | 'system';
  episodeKey?: string;
  fingerprint?: string;
}

interface NotificationEntry {
  // existing persisted fields...
  routing?: NotificationRouting;
}

interface AttentionRequiredEvent {
  ptyId: string;
  sessionId: string;
  type: 'waiting' | 'error';
  message: string;
  fingerprint?: string;
}

buildInteractionEpisodeKey(cardId: string, generation: number): string;
shouldDispatchOsNotification(
  notification: NotificationEntry,
  environment: {
    enabled: boolean;
    foreground: boolean;
    focusedCardId: string | null;
  },
): boolean;
```

Rust `AttentionRequiredPayload` adds camelCase `fingerprint`; the frontend
field is optional so an older backend or persisted notification remains valid.

#### 3. Contracts
- `terminalStore.pushNotification()` records in-app evidence only. Automatic OS
  dispatch belongs exclusively in `NotificationBridge`; do not add native
  notification calls to producers or Zustand actions.
- The settings-page manual test notification remains a direct Rust command and
  intentionally bypasses automatic routing policy.
- `routing` is optional and must be copied intact by the notifications slice.
  Adding routing metadata must not require a persist migration.
- `completed` sends an OS toast only while the main window is in the
  background. A foreground signal for `focusedCardId` is suppressed at the OS
  boundary while its in-app entry remains.
- `system:worktrees + completed` is in-app only.
  `system:worktrees + failed` is OS-visible only in the background.
- Interaction episode identity is
  `interaction:<cardId>:<messageCount>`. The 500 ms priority order is
  `codex_request > supervisor > pty`.
- PTY notification identity is generation + attention type + normalized Rust
  matching-line fingerprint. Exact redraws are suppressed; a new user submit
  or changed fingerprint rearms immediately.
- Supervisor in-app dedup identity is card + rule + generation + normalized
  sample. A 60-second cooldown is not permission to enqueue a sticky prompt
  again.
- Distinct Codex request fingerprints remain distinct even in one generation.
  Generic PTY/Supervisor signals must not create an additional toast for an
  already represented structured request.
- Delayed candidates must re-read the OS preference, document focus, and
  focused card at flush time. Coordinator maps are bounded and every timer is
  cancelled on Bridge unmount/HMR.
- Rust derives the fingerprint from the last line matched by the relevant
  `RegexSet`, collapses whitespace, and bounds it to 240 characters without
  changing the user-visible generic message.

#### 4. Validation & Error Matrix
- `routing` absent -> preserve in-app display and apply kind/card-based legacy
  OS visibility rules; never throw.
- fingerprint absent from an older PTY backend -> normalize type + message as a
  conservative fallback.
- OS notifications disabled at accept or flush -> no OS toast.
- app becomes focused on the target card during the 500 ms window -> cancel
  delivery while keeping the in-app entry.
- Rust OS command fails -> keep the existing Web Notification fallback.
- duplicate notification id, exact episode fingerprint, StrictMode replay, or
  HMR listener replay -> no second OS toast.
- changed fingerprint or increased `messageCount` -> allow a new interaction.
- Bridge unmount with a pending candidate -> clear timer; no ghost toast.

#### 5. Good/Base/Bad Cases
- Good: one Codex approval simultaneously matches PTY and Supervisor; all
  authoritative evidence remains, and the OS receives one Codex toast.
- Good: a TUI redraws `Continue? [y/n]` after 61 seconds; no new notification
  is created until the user submits again or the matched line changes.
- Base: an old persisted notification has no routing; it still renders and a
  background failure still follows the conservative legacy policy.
- Bad: increasing the PTY debounce from 5 to 30 seconds and calling that
  deduplication. A sticky prompt will still fire again after 30 seconds.
- Bad: deleting lower-priority in-app notifications to reduce OS noise; this
  removes Workbench evidence instead of coordinating the side effect.

#### 6. Tests Required
- Pure policy tests: disabled preference, foreground focused target,
  foreground/background completion, and worktree success/failure.
- Fake-timer coordinator tests: PTY/Supervisor/Codex priority, exact redraw
  dedup, changed fingerprint, new generation, distinct Codex requests, focus
  recheck, and dispose cleanup.
- `NotificationBridge` integration must prove three in-app interaction entries
  can yield one OS command and unmount cancels pending delivery.
- Producer tests must assert routing metadata for reply, PTY, Supervisor, and
  Codex entries.
- Rust tests must assert last matching line selection and whitespace-stable
  fingerprinting.
- Required gates: targeted ESLint with zero warnings, `npm run check`,
  `npm run build`, full `cargo test`, Rustfmt, and `git diff --check`.

#### 7. Wrong vs Correct

Wrong:

```typescript
if (Date.now() - lastNotificationAt > 60_000) {
  sendNotification(prompt);
}
```

Correct:

```typescript
pushNotification({
  ...prompt,
  routing: {
    origin: 'supervisor',
    family: 'interaction',
    episodeKey: buildInteractionEpisodeKey(cardId, messageCount),
    fingerprint: normalizeNotificationFingerprint(`${ruleId}:${sampleText}`),
  },
});
```

The correct version preserves evidence and lets one OS boundary combine
semantic identity, source priority, and current focus state.

</spec-entry>

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)

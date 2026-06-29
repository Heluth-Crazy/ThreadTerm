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

### Scenario: Workflow YAML Files via Tauri FS

#### 1. Scope / Trigger
- Trigger: Any frontend feature that reads or writes workflow files on disk.
- Applies to `src/lib/workflows/**`, workflow UI components, and Tauri capability changes.

#### 2. Signatures
- `loadAllWorkflows(focusedProjectCwd: string | null): Promise<DiscoveryResult>`
- `loadProjectPresetWorkflows(projectCwd: string): Promise<DiscoveryResult>`
- `discoverWorkflows(fs, { globalDir, projectDir }): Promise<{ workflows, errors }>`
- `ensureDir(path: string): Promise<void>`

#### 3. Contracts
- Global workflow dir: `~/.threadterm/workflows/`.
- Project workflow dir: `<projectCwd>/.threadterm/workflows/`.
- Tauri capability scope must include those two directory families.
- Allowed frontend fs calls for this contract: `readDir`, `readTextFile`, `stat`, `mkdir`.
- Do not add `exists()` unless `src-tauri/capabilities/default.json` also grants the matching fs permission.

#### 4. Validation & Error Matrix
- Missing workflow directory -> empty result, no notification.
- YAML parse failure in one file -> keep other files, emit `parse-failed`.
- Same-source duplicate workflow name -> keep first, emit `duplicate-name`.
- File size greater than 256KB -> skip file, emit `too-large`.
- Permission/read failure -> emit `read-failed`.

#### 5. Good/Base/Bad Cases
- Good: project workflow with same `name` overrides global workflow.
- Base: no global or project workflow directory returns no workflows.
- Bad: one invalid YAML file must not abort discovery for valid files.

#### 6. Tests Required
- Parser tests for required fields, unknown field dropping, multi-document YAML, malformed YAML.
- Discovery tests for missing dirs, per-file failures, duplicate names, project override, file size cap.
- Apply preset tests for `(resolved cwd, interpolated command)` dedup and missing-argument skips.
- UI tests for workflow argument modal and apply preset diff states.

#### 7. Wrong vs Correct

Wrong:
```typescript
import { exists } from '@tauri-apps/plugin-fs';

if (!(await exists(dir))) {
  await mkdir(dir, { recursive: true });
}
```

Correct:
```typescript
await mkdir(dir, { recursive: true });
```

The correct version stays inside the currently granted fs capability set and
avoids a runtime permission denial.

### Scenario: Workflow URL Import via Tauri HTTP

#### 1. Scope / Trigger
- Trigger: Any frontend feature that downloads workflow YAML from a remote URL.
- Applies to `src/lib/workflows/importWorkflow.ts`,
  `src/lib/workflows/tauriWorkflowImport.ts`, workflow import UI components,
  and Tauri capability / plugin changes.

#### 2. Signatures
- `fetchWorkflowImportText(rawUrl, fetcher): Promise<WorkflowImportResult<WorkflowImportFetchedText>>`
- `parseWorkflowImportText(sourceUrl, yamlText): WorkflowImportResult<ParsedWorkflowImport>`
- `previewProjectWorkflowUrlImport(rawUrl, projectCwd): Promise<WorkflowImportResult<WorkflowImportPlan>>`
- `saveProjectWorkflowImportPlan(plan): Promise<void>`

#### 3. Contracts
- Network must use `@tauri-apps/plugin-http` from the Tauri desktop app, not
  browser `window.fetch`.
- Rust backend must register `.plugin(tauri_plugin_http::init())`.
- `src-tauri/capabilities/default.json` must include `http:default` with HTTPS
  URL scope and fs write permission for workflow directories.
- Import target for Stage 7.2 is project-only:
  `<projectCwd>/.threadterm/workflows/<derived-file>.yaml`.
- Request options:
  - method: `GET`
  - `connectTimeout: 10_000`
  - `maxRedirections: 0`
- Preserve fetched YAML text on disk; do not regenerate YAML from parsed objects.

#### 4. Validation & Error Matrix
- Malformed URL -> `invalid-url`, no network call.
- Non-HTTPS URL -> `unsupported-scheme`, no network call.
- URL with username/password -> `credentials-not-allowed`, no network call.
- Network timeout / abort -> `timeout`.
- Other plugin/network failure -> `fetch-failed`.
- Non-2xx status -> `http-status`.
- Empty body -> `empty-body`.
- Body greater than 256KB -> `too-large`.
- YAML parse or required-field failure -> `parse-failed`.
- Existing target file cannot be read -> `read-existing-failed`.

#### 5. Good/Base/Bad Cases
- Good: `https://raw.githubusercontent.com/.../deploy.yaml` previews one target
  file and only writes after explicit user confirmation.
- Base: existing target file previews as `overwrite`; missing target previews as
  `create`.
- Bad: `http://example.com/a.yaml` must fail locally before calling the fetcher.

#### 6. Tests Required
- Pure import tests for URL validation, local http rejection, timeout
  normalization, non-2xx, body size cap, parse failure, filename derivation, and
  create/overwrite plan state.
- Component tests for preview success, save confirmation, and preview error
  states when import UI has non-trivial state.
- Full gates: `npm run typecheck`, `npx vitest run`, `npm run build`,
  `cargo check`, and `cargo test`.

#### 7. Wrong vs Correct

Wrong:
```typescript
const response = await window.fetch(url);
await writeTextFile(targetPath, await response.text());
```

Correct:
```typescript
const result = await previewProjectWorkflowUrlImport(url, projectCwd);
if (result.kind === 'success') {
  await saveProjectWorkflowImportPlan(result.value);
}
```

The correct version keeps remote access behind Tauri HTTP capabilities, blocks
non-HTTPS input before network I/O, enforces timeout / redirect / size limits,
and previews the exact file action before writing.

### Scenario: Local Directory Reveal via Tauri Command

#### 1. Scope / Trigger
- Trigger: Any frontend feature that opens a local filesystem directory from the
  desktop app.
- Applies to project/card reveal buttons, workflow-directory edit actions,
  bottom-bar file explorer chips, and any future local directory opener.

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
- Good: edit project preset ensures `<project>/.threadterm/workflows`, then
  opens that directory through `openLocalDirectory`.
- Base: card reveal opens the card project directory only in Tauri.
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
- Base: existing capability scopes for workflow fs and HTTPS import remain unchanged.
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

#### 4. Validation & Error Matrix
- Repo-relative path is empty, absolute, parent-traversing, or Windows drive-like -> reject before running Git.
- Binary diff -> return/show binary state instead of creating editable sections.
- Missing working-tree file with unstaged deletion -> editable draft may be saved by creating the file inside the workspace root.
- File changed on disk after diff load -> `workspace_write_file` returns `file_conflict`.
- Untracked file with no staged diff -> show no textual diff and offer normal file open behavior.
- Soft-wrapped side-by-side diff lines with unequal gutter/content width -> unchanged sections can appear vertically misaligned.

#### 5. Good/Base/Bad Cases
- Good: click a modified file in Changes, edit the right diff pane, see dirty tab marker, save to working tree with the section mtime.
- Good: `Revert line` changes only the draft; if single-line mapping is unsafe, revert the current hunk and show a status message.
- Good: long unchanged lines in side-by-side diff wrap at the same visual column on both panes.
- Base: staged-only changes are visible but read-only.
- Bad: calling Git or writing files from the frontend directly, applying a revert immediately to disk without the explicit Save action, or enabling soft wrap while only one pane has an action gutter.

#### 6. Tests Required
- Component tests for file edit save, CRLF preservation, diff load, diff draft save, and dirty tab wiring.
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

<spec-entry category="quality" keywords="mobile-bridge,react-bundle,pairing,websocket,xterm,theme" date="2026-05-12" source="src-tauri/src/bridge/protocol.rs:238">

### Scenario: Mobile Bridge React Client

#### 1. Scope / Trigger
- Trigger: Any change to the mobile bridge client, mobile bridge protocol, mobile static serving, pairing permission behavior, or post-pair session display.
- Applies to `mobile-app/`, `src/mobile/bridge/**`, `src-tauri/src/bridge/**`, and desktop theme broadcasting through `src/contexts/ThemeContext.jsx`.

#### 2. Signatures
- Mobile build: `npm run build:mobile` emits `mobile-app/dist/index.html`, `assets/index.css`, `assets/index.js`, `assets/vendor-react.js`, and `assets/vendor-xterm.js`.
- Static mobile shell: `GET /`, `GET /pair?otp=<code>&permission=<read_only|full>`, and extensionless SPA paths serve `index.html`.
- Static assets: `GET /assets/index.css`, `GET /assets/index.js`, `GET /assets/vendor-react.js`, and `GET /assets/vendor-xterm.js` serve fixed bundle files.
- Pairing request: `POST /pair` with `{ otp, deviceName, permission }`.
- Live updates: `GET /ws?token=<deviceToken>` remains supported for compatibility, but the preferred WebSocket path is `GET /ws` followed by first-frame `{ protocol_version: 1, kind: "auth", token }`.
- Snapshot fallback/API: `GET /snapshot` must authenticate with `Authorization: Bearer <deviceToken>`. `GET /snapshot?token=<deviceToken>` remains a compatibility path only.
- Bridge CORS must stay explicit: allow browser mobile bridge flows with only the required HTTP methods and headers instead of using a fully permissive layer.
- Pair QR host selection must keep bind host and publish host separate. Binding to `0.0.0.0` may listen on all interfaces, but QR generation must accept an explicit publish-host override for LAN DNS, Tailscale, or tunnel names.
- Snapshot cards: `CardMeta` must include `id`, `status`, `projectPath`, `projectName`, `lastReplyPreview`, `summaryLine`, `hiddenLineCount`, and `recentOutputBytes`.
- Preview events: `kind: "preview"` must include `card_id`, `last_reply_preview`, `summary_line`, and `hidden_line_count`.
- Theme events: `kind: "theme"` must include `app`, `terminal`, and `mode`.
- Full-control input: mobile sends `{ kind: "input", card_id, data }`; Enter appends `\r`, Esc sends `\x1b`, and Ctrl-C sends `\x03`.

#### 3. Contracts
- The mobile page is a React app built under `mobile-app/`, not a hand-maintained Rust HTML string template.
- Rust may embed only the fixed production bundle outputs listed above. If bundle filenames change, update both Vite output naming and `mobile_asset_bytes()`.
- `src-tauri/build.rs` must fail early when `mobile-app/dist/index.html` is missing; build `mobile-app/dist` before `cargo build` / Tauri packaging.
- Static asset responses must set content type from the served file path. SPA fallback requests without an extension must still return `text/html`, not `application/octet-stream`.
- Mobile bundle filenames are fixed (`assets/index.js`, `assets/index.css`,
  vendor chunks), so all embedded mobile responses must use `no-store`.
  `index.html` must also append a version query to fixed asset URLs so clients
  that previously cached immutable no-query assets fetch the current bundle.
  Do not use immutable asset caching unless the bundle switches to content-hashed
  filenames and Rust `mobile_asset_bytes()` is updated with the hashed names.
- Pairing-page requests must set an explicit permission. Use `read_only` by default; enable `full` only from a deliberate full-control selection in the desktop pairing UI.
- If a legacy or direct `POST /pair` request omits `permission`, backend pairing and persisted device rows must default to `read_only`, never `full`.
- The desktop `PairQrResponse.url` command contract must stay permission-neutral. Append `permission=read_only|full` client-side when displaying/copying the pairing URL so the command response shape remains stable.
- Mobile pairing storage keys are `threadterm.bridgeToken` and `threadterm.bridgePermission`. Temporary or experimental key names may be read only for migration and must be cleared after storing the canonical keys.
- A QR URL with `permission=read_only` must not inherit an existing stored `full` permission. Stored permission is used only for already-paired reconnects when no OTP is present.
- After successful pairing, store the device token and connect to `/ws`.
- Do not put device tokens into mobile WebSocket URLs by default. Browser WebSocket clients must authenticate with a first-frame `auth` message, then send `subscribe`.
- Do not silently share a phone QR that resolves to loopback when the bridge is bound for LAN access. Surface the loopback condition and let the user provide a publish host.
- Snapshot refetches after lag/backpressure should use the bearer header, not a query token.
- Query-token authentication is compatibility-only. Do not remove it without a migration window, but new mobile code should not add fresh query-token callsites.
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
- Pairing failure -> show retry button and error detail.
- Read-only QR with old full-control storage -> pair/read as `read_only`, not `full`.
- WebSocket protocol mismatch -> show an error detail and do not render the raw payload.
- WebSocket missing query token -> allow upgrade, require first-frame `auth`, then send initial `theme` and `snapshot`.
- WebSocket invalid/missing first-frame auth -> send a versioned `error` and close.
- Snapshot request with bearer token -> return the same versioned snapshot as the query-token compatibility path.
- Snapshot request with missing or invalid token -> return `401`; legacy query-token and bearer-token paths must both be covered while compatibility remains.
- CORS preflight for snapshot/mobile bridge endpoints -> expose only the expected methods and headers.
- Publish-host override entered in settings -> QR generation uses the override without changing the bridge bind address.
- WebSocket close/error -> keep the page visible, show retry/reconnect, and do not clear the stored token automatically.
- Deliberate cleanup/reconnect -> close the stale client without scheduling a duplicate reconnect loop.
- Lag/backpressure message -> fetch `/snapshot` and merge it without clearing current terminal snapshots prematurely.
- Missing production mobile bundle -> cargo build fails in `build.rs` before producing a broken app.
- Empty `cards` array -> show an empty session message, not a blank panel.
- Unknown static asset with an extension -> return `404`, not the app shell.

#### 5. Good/Base/Bad Cases
- Good: paired page connects live, applies the desktop app theme while keeping the terminal surface visibly dark, shows tappable project cards, opens xterm detail with project path, summary, preview lines, and full-control input only when paired as `full`.
- Base: no live terminal sessions shows "No live terminal sessions yet."
- Good: a long markdown or terminal line wraps inside the phone viewport and does not resize the page horizontally.
- Bad: `JSON.stringify(await snapshot.json(), null, 2)` displayed directly in the mobile page.
- Bad: one long terminal line forces the page wider than the phone viewport.
- Bad: a card title/summary displays the AI CLI composer placeholder (for example `› Summarize recent commits`) instead of the last assistant response.
- Bad: a read-only QR opens a full-control input bar because an old `full` permission was already in local storage.
- Bad: a touch Enter button preserves focus but sends nothing because the click was suppressed.

#### 6. Tests Required
- Rust bridge tests must assert static mobile assets are served, SPA fallback returns the built index with `text/html`, and unknown file assets return `404`.
- Rust protocol/server tests must assert `theme` serializes correctly and initial WebSocket messages send `theme` before `snapshot`.
- Mobile unit tests must cover pairing storage keys, read-only QR precedence over stored full permission, legacy key migration, theme application, message validation, ANSI classification, and touch input de-duplication.
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
- Desktop settings tests must assert the displayed/copied pairing URL appends the selected `permission` query parameter without changing the `bridge_pair_qr` invocation contract.
- Bridge preview tests must cover mobile summary noise such as Trellis hook lines, MCP startup noise, duplicate line cleanup, and AI CLI composer/input prompt lines.
- Rust bridge tests must cover first-frame WebSocket auth without query token, bearer token parsing, and the legacy query-token path until it is intentionally removed.
- Rust bridge tests must cover CORS preflight, missing token, invalid token, bearer snapshot auth, and legacy query-token snapshot auth.
- Settings tests must cover publish-host override and the loopback warning path for LAN QR generation.
- Mobile WS client tests must assert the token is sent in an `auth` frame before `subscribe`, and `buildBridgeWsUrl()` does not include a token query string.
- Mobile terminal tests must assert preview/detail scrollback sizes, stale snapshot suppression after newer output, coalesced viewport fitting, and unchanged-size resize suppression.

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

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)

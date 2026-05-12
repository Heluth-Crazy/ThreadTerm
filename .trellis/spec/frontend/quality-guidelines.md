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

<spec-entry category="quality" keywords="mobile-bridge,pairing,websocket,snapshot,raw-json" date="2026-05-08" source="src-tauri/src/bridge/server.rs:311">

### Scenario: Mobile Pairing Live Client

#### 1. Scope / Trigger
- Trigger: Any change to the mobile bridge pairing page or post-pair session display.
- Applies to the embedded HTML generated by `pair_page_html()` in `src-tauri/src/bridge/server.rs`.

#### 2. Signatures
- Pairing page: `GET /pair?otp=<code>&permission=<read_only|full>` renders the mobile pairing UI.
- Pairing request: `POST /pair` with `{ otp, deviceName, permission }`.
- Live updates: `GET /ws?token=<deviceToken>` upgrades to the versioned bridge WebSocket protocol.
- Snapshot fallback/API: `GET /snapshot?token=<deviceToken>` returns the versioned bridge protocol payload.
- Snapshot cards: `CardMeta` must include `id`, `status`, `projectPath`, `projectName`, `lastReplyPreview`, `summaryLine`, `hiddenLineCount`, and `recentOutputBytes`.
- Preview events: `kind: "preview"` must include `card_id`, `last_reply_preview`, `summary_line`, and `hidden_line_count`.

#### 3. Contracts
- The pairing page is a user-facing mobile UI, not a debug protocol viewer.
- Pairing-page requests must set an explicit permission. Use `read_only` by default; enable `full` only from a deliberate full-control selection in the desktop pairing UI.
- The desktop `PairQrResponse.url` command contract must stay permission-neutral. Append `permission=read_only|full` client-side when displaying/copying the pairing URL so the command response shape remains stable.
- After successful pairing, store the device token and connect to `/ws`.
- Render the initial `snapshot.cards` from the WebSocket snapshot message, then merge `preview`, `state`, `exit`, and card lifecycle messages into the page state.
- Session cards must be real tap targets that open a detail view; do not render a static list with no click behavior.
- Session cards and details must show project context from `projectName` / `projectPath`, not only opaque session ids.
- Mobile preview rendering must use backend-provided `summaryLine` for the one-line semantic summary and keep `lastReplyPreview` for the thumbnail/body text. Do not derive the summary from input composer placeholders in the mobile DOM.
- Mobile detail views must render the live PTY through xterm.js using backend `terminal_snapshot` data for the initial screen and `terminal_output` messages for incremental output. Do not replace the detail terminal with line-filtered preview text; the list may still use `summaryLine` / `lastReplyPreview` as a thumbnail.
- Full-control mobile pages should route keyboard data from the xterm instance to bridge `input`. The auxiliary controls are Enter, Ctrl-C, and Esc only. Do not add a separate textarea composer with a duplicate Send action unless the interaction is redesigned as an explicit command composer. Read-only pages must disable xterm stdin, hide input controls, and keep an explicit read-only notice. Destructive close/kill controls are not part of the mobile page UX.
- Mobile xterm resize events may send bridge `resize` only for full-control devices. Local snapshot replay or hidden-view fitting must not issue read-only resize commands.
- Mobile card and detail layouts must set `min-width: 0` / `max-width: 100%` and wrap preview text with `overflow-wrap` so narrow phones never show horizontal overflow.
- Use DOM text assignment (`textContent`) for bridge-derived strings.
- Do not show raw `protocol_version`, `kind`, `cards`, `notifications`, or full JSON on the page.

#### 4. Validation & Error Matrix
- Missing OTP with a stored token -> reconnect to `/ws`.
- Missing OTP without a stored token -> show missing-code guidance.
- Pairing failure -> show retry button and error detail.
- WebSocket protocol mismatch -> show an error detail and do not render the raw payload.
- WebSocket close/error -> keep the page visible, show retry, and do not clear the stored token automatically.
- Empty `cards` array -> show an empty session message, not a blank panel.

#### 5. Good/Base/Bad Cases
- Good: paired page connects live, shows tappable project cards, opens a detail view with project path, summary, preview lines, and full-control input only when paired as `full`.
- Base: no live terminal sessions shows "No live terminal sessions yet."
- Bad: `JSON.stringify(await snapshot.json(), null, 2)` displayed directly in the mobile page.
- Bad: one long terminal line forces the page wider than the phone viewport.
- Bad: a card title/summary displays the AI CLI composer placeholder (for example `› Summarize recent commits`) instead of the last assistant response.

#### 6. Tests Required
- Unit tests for `pair_page_html()` must assert it pairs with an explicit permission, opens a WebSocket, has a card click/detail path, includes overflow wrapping CSS, includes project/summary fields, includes full-control input wiring, and does not contain direct raw JSON display.
- Unit tests for `pair_page_html()` must assert the mobile detail page loads xterm assets, has a `terminal-shell` / `terminal-host`, handles `terminal_snapshot` and `terminal_output`, and no longer renders the detail view through `detail-preview` text.
- Desktop settings tests must assert the displayed/copied pairing URL appends the selected `permission` query parameter without changing the `bridge_pair_qr` invocation contract.
- Bridge preview tests must cover mobile summary noise such as Trellis hook lines, MCP startup noise, duplicate line cleanup, and AI CLI composer/input prompt lines.

#### 7. Wrong vs Correct

Wrong:
```javascript
snapshotEl.textContent = JSON.stringify(await snapshot.json(), null, 2);
```

Correct:
```javascript
socket.onmessage = (event) => {
  applyServerMessage(validateMessage(JSON.parse(event.data)));
};
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

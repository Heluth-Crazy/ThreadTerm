# Local Data Export

> Contracts for exporting user-controlled local data from the frontend.

---

## Scenario: Settings Bundle Export / Import

### 1. Scope / Trigger
- Trigger: Any frontend feature that exports or imports app settings.
- Applies to `src/lib/settings/**`, Settings data UI, theme preference state,
  terminal preference state, overlay hotkey settings, and workflow YAML bundles.

### 2. Signatures
- `buildSettingsBundle(input): SettingsBundle`
- `parseSettingsBundle(text: string): SettingsBundleParseResult`
- `diffSettingsBundle(current, incoming): SettingsBundleDiff`
- `applySettingsBundleSelection(selection): Promise<SettingsBundleApplyResult>`

### 3. Contracts
- The bundle must include an app marker, schema version, and export timestamp.
- Export only whitelisted sections. Do not serialize full Zustand stores,
  full `localStorage`, bridge state, paired device state, audit logs, provider
  keys, or provider session internals.
- Import must preview a diff and apply only user-selected sections.
- Workflow data must be exported as portable YAML file contents, not absolute
  local file paths.

### 4. Validation & Error Matrix
- Invalid JSON -> parse failure before state changes.
- Missing app marker or unsupported schema version -> reject before diffing.
- Unknown top-level section -> ignore or report as unsupported, never apply.
- Sensitive field present in imported JSON -> ignore and keep current local
  value.

### 5. Good/Base/Bad Cases
- Good: a user can move theme, custom themes, terminal focus preferences,
  overlay hotkeys, and workflow YAML to another machine.
- Base: an empty optional section produces no changes.
- Bad: bridge tokens, paired devices, provider keys, provider sessions, audit
  records, and raw stores must not appear in exported JSON.

### 6. Tests Required
- Pure bundle tests for schema marker, version, whitelist fields, and negative
  sensitive-field assertions.
- UI tests for export, import preview, selective apply, invalid file handling,
  and cancelled import/export flows.
- Full gates: `npm run typecheck`, `npx vitest run`, `npm run build`,
  `cargo check`, and `cargo test`.

### 7. Wrong vs Correct

Wrong:
```typescript
const bundle = JSON.stringify(localStorage);
```

Correct:
```typescript
const bundle = buildSettingsBundle({
  themePreference,
  customThemes,
  terminalFocusPreferences,
  overlayHotkeys,
  workflowFiles,
});
```

The correct version keeps the export boundary explicit so future fields cannot
leak sensitive or machine-specific state by accident.

---

## Scenario: AI Session Markdown Export

### 1. Scope / Trigger
- Trigger: Any frontend feature that saves AI conversations or AI CLI session
  metadata as Markdown.
- Applies to `src/lib/ai/**`, AI thread UI, terminal block inspector actions,
  provider-backed terminal card actions, and Tauri dialog/fs capability tests.

### 2. Signatures
- `renderAiSessionMarkdown(input: AiSessionMarkdownInput): string`
- `buildBlockAiSessionExport(args): AiSessionMarkdownInput`
- `buildCardAiSessionExport(args): AiSessionMarkdownInput`
- `saveAiSessionMarkdown(markdown: string, suggestedFilename: string): Promise<AiSessionSaveResult>`

### 3. Contracts
- Markdown must be rendered by a pure helper with no Tauri, browser download,
  network, or store side effects.
- Save IO must use the Tauri desktop save dialog plus `writeTextFile` for the
  selected path. Do not write AI exports into `localStorage`.
- Current Tauri capability contract for dialog-selected Markdown writes:
  `dialog:allow-save` and `fs:allow-write-text-file` must be present. The static
  `fs:scope` can remain narrow because the dialog-selected path is granted for
  the current desktop session by the dialog plugin.
- Export metadata must include source intent, provider, session id when known,
  start/end timestamps when known, and the source context needed to understand
  the Markdown later.
- Prompt/reply entries must remain ordered. Preserve fenced code blocks from AI
  responses; do not attempt to parse, execute, or reformat commands during
  export.
- Block Inspector export must read the live AI thread at export time. If no AI
  thread entries exist, export block context and captured block output when
  available instead of producing an empty Conversation section.
- AI CLI card export may contain only useful session metadata when no Q/A thread
  exists. Do not invent conversation content.
- No network request is allowed during export.

### 4. Validation & Error Matrix
- Save dialog cancelled -> return a cancelled result and do not call
  `writeTextFile`.
- `writeTextFile` failure -> return an error result and keep the export action
  available.
- Empty AI thread on a block with output -> export block command/cwd/exit code
  plus output content.
- Empty AI thread on an AI CLI card -> export metadata plus an empty-content
  note, not fabricated Q/A entries.
- Non-AI terminal card -> do not show AI Markdown export as an available card
  action.

### 5. Good/Base/Bad Cases
- Good: a failed command block with an AI explanation can be saved as Markdown
  with command, provider, timestamps, user prompt, and AI answer in order.
- Good: a block without an AI explanation but with captured output exports
  command/cwd/exit metadata plus output text, not an empty Conversation.
- Base: a Codex or Claude terminal card with a bound session id exports session
  metadata even before a saved Q/A thread exists.
- Bad: calling `window.fetch`, serializing provider keys, or changing the button
  label to transient success/error text during export.

### 6. Tests Required
- Pure renderer tests for metadata, ordered entries, empty entries, and fenced
  code preservation.
- IO helper tests proving `save()` runs before `writeTextFile()` and cancelled
  dialogs do not write.
- Capability contract tests for `dialog:allow-save`,
  `fs:allow-write-text-file`, and the intentionally narrow static fs scope.
- Component tests for block export action, AI card export action, hidden status
  feedback, and non-AI card omission.
- Regression tests for exporting immediately after Explain updates the thread,
  and for block-output fallback when no AI thread exists.

### 7. Wrong vs Correct

Wrong:
```typescript
const markdown = await fetch('/api/export-ai-session', {
  method: 'POST',
  body: JSON.stringify(thread),
}).then((response) => response.text());
```

Correct:
```typescript
const markdown = renderAiSessionMarkdown(session);
await saveAiSessionMarkdown(markdown, suggestedFilename);
```

The correct version keeps export local-only, testable as pure serialization, and
aligned with the desktop permission contract.

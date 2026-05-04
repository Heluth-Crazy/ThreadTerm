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

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)

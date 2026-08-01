# User-Controlled Data Directory

> ThreadTerm owns one user-selected data root. Startup resolution, state reads,
> migration, and recovery must never manufacture an empty replacement profile.

## 1. Scope / Trigger

Use this contract for changes to:

- `data_directory`, `startup_data_directory`, `data_migration`, `data_cache`,
  `managed_state`, database startup, window-state paths, or WebView data paths;
- the Settings data-location UI and its Tauri IPC wrappers;
- persisted terminal, Workbench, overlay, theme, language, preview, or window
  state;
- first-install, upgrade, reinstall, unavailable-disk, rollback, or cleanup
  behavior.

ThreadTerm-owned data is exactly:

1. the SQLite database;
2. persistent desktop/interface state and the Windows WebView2 user-data folder;
3. main/settings window state.

Projects, Git repositories, worktrees, exports, and native Codex, Claude,
Gemini, or OpenCode data are outside this boundary and must never be moved.

## 2. Signatures

Startup and layout:

```rust
pub fn resolve_startup_data_root() -> Result<ResolvedDataRoot, String>;
pub fn is_first_start(active: &ResolvedDataRoot) -> bool;
pub fn initialize_selected_root(
    requested_root: &Path,
    pointer_path: &Path,
) -> Result<PathBuf, String>;
```

Stable frontend IPC facade:

```typescript
dataDirectory.status(): Promise<DataDirectoryStatus>
dataDirectory.migrationStatus(): Promise<DataMigrationStatus | null>
dataDirectory.preflight(targetRoot): Promise<DataMigrationPreflight>
dataDirectory.schedule(targetRoot, retainSource): Promise<DataMigrationStatus>
dataDirectory.cancel(): Promise<void>
dataDirectory.confirm(): Promise<DataMigrationStatus>
dataDirectory.cleanupSource(transactionId): Promise<DataMigrationStatus>
dataDirectory.requestRollback(transactionId): Promise<DataMigrationStatus>
dataDirectory.restart(): Promise<void>
dataDirectory.cacheCleanupStatus(): Promise<DataCacheCleanupStatus>
dataDirectory.scheduleCacheCleanup(): Promise<DataCacheCleanupStatus>
dataDirectory.cancelCacheCleanup(): Promise<DataCacheCleanupStatus>
```

Managed-state IPC:

```text
managed_state_get(key) -> { initialized, value, recoveredBackup }
managed_state_import_legacy(key, value, sourceId) -> { imported }
managed_state_set(key, value, sourceId) -> ()
managed_state_remove(key, sourceId) -> ()
event: managed-state://changed { key, sourceId }
```

## 3. Contracts

### Directory and startup contract

A managed root is versioned and self-contained:

```text
<root>/
  manifest.json
  database/threadterm.db
  state/window-state.json
  state/<managed UI documents>
  webview/                 # Windows; system-managed on macOS
  migration/
```

- The only long-lived exception is
  `<system config>/com.Heluth-Crazy.threadterm/data-location.json`, which stores
  location metadata only. It must not contain business state or credentials.
- A genuinely fresh install runs the native first-start assistant before the
  database or business WebView state is created. The user may accept
  `Documents/ThreadTerm Data`, choose another empty folder, or exit.
- No pointer plus existing legacy data means `legacy_split`, not a fresh
  install. Existing users remain on their exact old paths until they explicitly
  schedule migration.
- A pointer to an unavailable or invalid managed root is a startup error. Show
  recovery choices; never fall back to legacy paths or create a blank profile.
- The application install directory and data root remain separate.

### Managed-state contract

- The Rust store is authoritative on desktop. Legacy `localStorage` is read
  only for the once-only import.
- `initialized: true, value: null` is a persistent tombstone. Removal must not
  make the key eligible for legacy re-import.
- Primary-file corruption or an interrupted switch reads the last valid backup;
  it must not return an empty state as success.
- `ManagedStateBootstrap` finishes preload and store hydration before rendering
  the application, then confirms a `pointer_switched` migration.
- Desktop E2E fakes must implement all four `managed_state_*` commands. Returning
  `null` for them invalidates the startup contract and correctly triggers the
  protected data-error screen.

### Migration contract

- Running-process scheduling performs validation and records intent only. The
  copy occurs after restart while the old process lock is no longer held.
- The order is: checkpoint source SQLite, copy into target staging, verify
  files and SQLite integrity, atomically switch the pointer, boot and hydrate
  the target, confirm first launch, then permit explicit source cleanup.
- Source data remains available through confirmation. Cleanup requires the
  matching transaction id and user action.
- Failure or interruption restores the source pointer. A missing target,
  corrupt database, or partial staging tree must never activate an empty root.
- Windows moves the WebView2 user-data folder into the selected root. macOS
  keeps engine-owned WebKit data in the system location but all ThreadTerm
  business state remains in the managed root.

### Display-path contract

- Backend paths remain canonical/raw, including the Windows `\\?\` verbatim
  prefix when returned by the filesystem.
- UI text hides `\\?\` and maps `\\?\UNC\server\share` to
  `\\server\share` for readability.
- Folder opening, preflight, migration, and cleanup keep using the raw path.
  Display formatting must never mutate an operational path.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Empty or relative target | `empty_path` / `relative_path` |
| Target is source or its child | `source_or_child` |
| Target is app directory or macOS app bundle | `application_directory` / `mac_application_bundle` |
| Target is a file, symlink, or non-empty foreign folder | `file_target`, `symbolic_link`, or `non_empty_target` |
| Target is not writable or lacks space | `not_writable` / `insufficient_space` |
| Windows WebView root is a network location | `network_location` |
| Source is missing or a symlink | `source_unavailable` / `source_symbolic_link` |
| Managed pointer root is unavailable at startup | Recovery assistant; no fallback |
| Source database fails integrity verification | Roll back; do not switch pointer |
| Copy is interrupted | Discard/rebuild staging; retain source |
| Another process still owns the source | Defer migration/cleanup |
| Unknown managed-state key | Reject; do not write arbitrary files |

## 5. Good / Base / Bad Cases

- Good: a new Windows user chooses `D:\ThreadTermData`; database, UI state,
  window state, and WebView2 data are created under that root, while the system
  config contains only the pointer.
- Good: an upgraded user sees `legacy_split`, keeps all existing terminals, and
  explicitly schedules a restart migration.
- Good: an external drive disappears; startup offers retry, repoint, previous
  root, or exit and never displays an empty Workbench.
- Base: macOS keeps WebKit cache in its system-managed location while managed
  business state follows the selected root.
- Bad: catch root-resolution failure and call `ResolvedDataRoot::legacy(...)`.
- Bad: delete source immediately after pointer switch or before managed-state
  hydration confirms the new launch.
- Bad: pass a display-stripped path back into a directory or migration command.

## 6. Tests Required

- Layout/pointer: self-contained paths, versioned manifest, location-only
  pointer, fresh-install detection, reconnect existing root, exact legacy paths.
- Recovery: missing selected root, interrupted pointer replacement, previous
  root restoration, and no blank fallback.
- Migration fault tests: non-empty/source-child target, active process lock,
  disconnected target, corrupt SQLite, interrupted copy, staging rebuild,
  first-launch confirmation, rollback, and cleanup-after-confirmation only.
- Managed state: key allowlist, once-only import, initialized tombstone,
  primary corruption backup, interrupted switch backup, and cross-window event.
- Frontend: data Settings IPC wiring, display-only Windows prefix formatting,
  raw path retained for folder opening, bootstrap protected-error screen, and
  locale parity.
- E2E: desktop fake Tauri imports legacy state into managed storage; desktop
  terminal/Workbench journeys; mobile Chromium/WebKit; real Rust bridge fixture.
- Final gates: `npm run check`, full `cargo test --all-targets`, Rustfmt,
  desktop/mobile builds, desktop/mobile E2E, `git diff --check`, circular
  dependency check, GitNexus change detection, and the platform release build.

## 7. Wrong vs Correct

Wrong:

```rust
let root = resolve_startup_data_root()
    .unwrap_or_else(|_| ResolvedDataRoot::legacy(old_db, old_local, old_config));
```

Correct:

```rust
let root = match resolve_startup_data_root() {
    Ok(root) => root,
    Err(error) => return run_recovery_assistant(error),
};
```

Wrong:

```typescript
const path = formatDataPathForDisplay(status.root);
await openLocalDirectory(path);
```

Correct:

```typescript
const label = formatDataPathForDisplay(status.root);
await openLocalDirectory(status.root); // retain the raw canonical path
```

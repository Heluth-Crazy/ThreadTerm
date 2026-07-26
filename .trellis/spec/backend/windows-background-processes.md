# Windows Background Process Contracts

> Keep service-style child processes invisible without changing interactive
> ConPTY behavior.

---

## Scenario: Background Stdio Services Stay Hidden and Cannot Outlive ThreadTerm

### 1. Scope / Trigger

- Trigger: adding or changing a long-running Windows child process that
  communicates only through piped stdin/stdout, including the Codex app-server
  transport.
- Applies to `src-tauri/src/codex_app.rs` and future service-style subprocesses.
- Does not apply to terminal cards. Interactive shells and CLI cards must keep
  using the PTY subsystem so ConPTY, resize, signal, and process-tree semantics
  remain intact.
- Does not apply to applications deliberately opened for the user, such as
  Explorer or an external editor.

### 2. Signatures

- `CodexAppManager::ensure_process(&self, app: &AppHandle) -> Result<bool, String>`
- `spawn_managed_codex_child(Command) -> std::io::Result<ManagedCodexChild>`
- `WindowsJob::new() -> std::io::Result<WindowsJob>`
- `WindowsJob::assign(&self, child: &tokio::process::Child) -> std::io::Result<()>`
- `WindowsJob::terminate(&self) -> std::io::Result<()>`
- Windows flags: `CREATE_NO_WINDOW | CREATE_SUSPENDED`.
- Transport remains `stdin(Stdio::piped())`, `stdout(Stdio::piped())`, and
  `stderr(Stdio::piped())`.

### 3. Contracts

- Create a dedicated Job Object for each managed service tree and set
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
- Spawn the top-level process suspended, assign it to the Job Object, and only
  then resume its threads. This closes the race in which a wrapper can create a
  descendant before ThreadTerm starts tracking it.
- `ManagedCodexChild::drop` must actively terminate the Job Object during normal
  disconnect/teardown. Kill-on-close is the crash fallback when Rust destructors
  cannot run.
- If Job creation, assignment, or thread resume fails, terminate the suspended
  child/tree and return an error. Never resume an untracked process.
- Keep each Job scoped to one service tree. Do not assign the ThreadTerm process
  itself to a global Job because user-launched Explorer/editor processes must
  remain independent.
- The Windows-only code is gated with `#[cfg(windows)]`; non-Windows builds keep
  immediate-child `kill_on_drop(true)` behavior.
- Hiding a background service must not redirect, merge, or remove its JSON-RPC
  stdio transport.
- Never apply this rule inside `pty_spawn`: PTY cards intentionally own a real
  ConPTY session and a headless `conhost.exe` while the card is live.

### 4. Validation & Error Matrix

- Job creation fails -> do not spawn; return the existing app-server start
  failure shape.
- Executable is missing -> return the existing spawn error; no Job member
  remains.
- Job assignment or thread resume fails -> terminate the still-suspended
  process, close the Job, and return an error.
- Windows service executable is a console-subsystem binary -> no visible
  console window; piped JSON-RPC still initializes after assignment.
- Child exits or closes stdout -> existing app-server disconnect handling runs
  and dropping the managed child terminates any remaining descendants.
- ThreadTerm is terminated without running destructors -> Windows closes the
  final Job handle and terminates the wrapper plus all inherited descendants.
- Interactive terminal card is created -> ConPTY still launches and resizes;
  do not use `CREATE_NO_WINDOW` as a substitute for the PTY host.

### 5. Good/Base/Bad Cases

- Good: opening a Codex Chat starts `codex.exe app-server` without an extra
  console window, requests continue over stdio, and a `cmd.exe`/npm wrapper
  cannot survive ThreadTerm.
- Base: non-Windows builds compile without importing Windows-only APIs.
- Bad: rely on `tokio::process::Child::kill_on_drop(true)` alone; it only owns
  the immediate wrapper and does not establish a process-tree boundary.
- Bad: assign ThreadTerm itself to one application-wide Job, because unrelated
  user-launched applications could become part of the cleanup boundary.

### 6. Tests Required

- `managed_windows_process_allows_normal_exit` asserts ordinary completion.
- `dropping_managed_windows_process_ends_descendant_tree` starts a real
  `cmd.exe -> ping.exe` tree and asserts both process IDs disappear on Drop.
- `managed_windows_process_tree_ends_after_owner_crash` runs the Job owner in a
  separate test process, aborts it without Drop, and asserts kill-on-close
  removes both process levels.
- `managed_windows_process_reports_spawn_failure` asserts a missing executable
  leaves no managed process.
- Rust unit tests keep verifying the Codex app-server command uses stdio.
- `cargo test --all-features`, `cargo clippy --all-targets --all-features --
  -D warnings`, Rustfmt, and a Windows release build must pass.
- Windows smoke: open Codex Chat, verify no extra console window appears, send
  one request, exit ThreadTerm, and verify no app-server/wrapper descendant
  remains.
- Process evidence should distinguish service `codex.exe app-server` from CLI
  `codex.exe ... --no-alt-screen` terminal-card descendants.

### 7. Wrong vs Correct

Wrong:

```rust
let mut command = tokio::process::Command::new(executable);
command
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .kill_on_drop(true);
let child = command.spawn()?; // only the immediate wrapper is owned
```

Correct:

```rust
let mut command = tokio::process::Command::new(executable);
command.stdin(Stdio::piped()).stdout(Stdio::piped());
#[cfg(windows)]
command.creation_flags((CREATE_NO_WINDOW | CREATE_SUSPENDED).0);
let child = command.spawn()?;
job.assign(&child)?;
resume_windows_process_threads(child.id().unwrap())?;
```

The concrete implementation also terminates the Job during Drop and sets
kill-on-close before spawning, so normal teardown and owner crashes are both
covered.

---

## Scenario: Synchronous Background Discovery Commands Stay Invisible

### 1. Scope / Trigger

- Trigger: adding or changing a synchronous `std::process::Command` used only
  to discover repository or executable metadata in the desktop backend.
- Applies to the Git readers in `src-tauri/src/git.rs` and the Windows shell
  probe in `src-tauri/src/pty/shell.rs`.
- Does not apply to interactive terminal cards or commands intentionally opened
  for the user.

### 2. Signatures

- `git_command() -> std::process::Command`
- `which_exists(name: &str) -> bool`
- Windows process flag: `CREATE_NO_WINDOW = 0x0800_0000`.

### 3. Contracts

- All production Git reads and worktree commands in `git.rs` must construct the
  child through `git_command()`; do not add a new raw
  `Command::new("git")` call in production code.
- `git_command()` changes only the Windows creation flag. Program lookup,
  arguments, working directory, captured output, exit-status handling, and
  error mapping stay at each caller.
- `which_exists()` must run `where <name>` with `CREATE_NO_WINDOW` and preserve
  its current boolean failure fallback.
- Platform-only imports and constants remain guarded with `#[cfg(windows)]` or
  `#[cfg(target_os = "windows")]`.
- Test fixtures may use raw Git commands when they are setting up repositories
  rather than exercising production command construction.

### 4. Validation & Error Matrix

- Windows Git is present -> the existing Git result is returned without a
  visible console window.
- Git is missing -> each caller keeps its existing empty-list or error result;
  the command builder must not reclassify failures.
- `where` finds the requested executable -> return `true`.
- `where` exits non-zero or cannot spawn -> return `false`.
- Non-Windows build -> compile without importing Windows process extensions and
  construct the same command as before.

### 5. Good/Base/Bad Cases

- Good: repeated Workbench Git-status polling remains invisible on Windows.
- Good: the one-time `pwsh` / `powershell` probe does not flash a console.
- Base: macOS and Linux continue to resolve `git` through `PATH`.
- Bad: apply `CREATE_NO_WINDOW` to the PTY shell process or change Git stderr
  handling while fixing a window-flash issue.

### 6. Tests Required

- A Git integration test must exercise a production reader against a temporary
  repository and assert the returned data remains correct.
- On Windows, `which_exists("cmd.exe")` must return `true`.
- Run the Git and shell test modules, full Cargo test, Clippy with warnings
  denied, Rustfmt check, and `git diff --check`.
- The lack of a visible console is a Windows smoke-test assertion because
  `std::process::Command` does not expose configured creation flags for unit
  inspection.

### 7. Wrong vs Correct

Wrong:

```rust
let output = Command::new("git")
    .args(["status", "--porcelain=v1"])
    .output()?;
```

Correct:

```rust
let output = git_command()
    .args(["status", "--porcelain=v1"])
    .output()?;
```

The correct version centralizes the Windows-only process attribute while
leaving each Git operation's functional contract at its existing caller.

---

## Scenario: Background Discovery CLIs Resolve Windows Package Shims Safely

### 1. Scope / Trigger

- Trigger: adding or changing a non-interactive Provider discovery/export
  subprocess, such as OpenCode or Gemini Session Catalog integration.
- Applies to `src-tauri/src/agent_sessions/process.rs` and adapters that consume
  its command builder.
- This is a background stdio contract only. Restoring a selected session still
  launches through the terminal-card PTY path.

### 2. Signatures

- `background_cli_command(name: &str) -> tokio::process::Command`
- `is_safe_session_id(value: &str) -> bool`
- Windows executable suffix priority: `.exe`, `.com`, `.cmd`, `.bat`, then an
  extensionless file.
- Windows search roots: `%APPDATA%\\npm` followed by entries from `PATH` for
  each suffix priority.

### 3. Contracts

- Resolve an actual program path before constructing the command. Do not rely
  on `Command::new("opencode")` or `Command::new("gemini")` to discover npm
  `.cmd` shims on Windows.
- Prefer a native `.exe`/`.com` over a package-manager `.cmd`/`.bat` shim when
  both exist. For candidates with the same suffix, `%APPDATA%\\npm` wins before
  `PATH`.
- Apply `CREATE_NO_WINDOW` to the resolved background process. Keep output
  captured/piped and never route catalog discovery through a visible terminal.
- Do not build a shell command string. Pass static arguments separately.
- A session id passed to a batch-backed export/resume command is untrusted.
  Accept only non-empty ASCII alphanumeric ids plus `-`, `_`, `.`, and `:`,
  with a maximum length of 256 bytes. Reject it before spawning.
- On non-Windows platforms, retain normal executable lookup with the bare CLI
  name; the Windows resolver is platform-gated.

### 4. Validation & Error Matrix

- Native executable and npm shim both exist -> select the native executable.
- Only `.cmd` shim exists -> execute the resolved shim hidden and capture its
  output.
- No candidate exists -> keep the bare name so the Provider adapter classifies
  the normal spawn error as missing/unavailable CLI.
- Session id contains whitespace, `%`, `&`, `|`, `<`, `>`, quotes, or shell
  expansion syntax -> reject before spawning the batch-backed command.
- Static list/version command fails -> return the adapter's existing command
  failure state; do not fall back to an interactive PTY.

### 5. Good/Base/Bad Cases

- Good: `opencode.cmd session list --format json --pure` runs without a console
  flash and returns captured JSON on a standard Windows npm install.
- Base: a native `gemini.exe` on `PATH` runs through the same builder.
- Bad: interpolate an arbitrary session id into `cmd /C "opencode export ..."`
  or treat a catalog subprocess as a terminal card.

### 6. Tests Required

- Unit-test safe and rejected session ids, including shell metacharacters.
- On Windows, create `.exe` and `.cmd` candidates and assert native suffix
  preference.
- On Windows, execute a temporary `.cmd` shim through the real command builder
  and assert successful captured output.
- Provider adapter tests must cover missing CLI, non-zero exit, malformed JSON,
  and invalid export id without spawning.
- Run Cargo tests, Clippy with warnings denied, a Windows smoke using an
  installed npm CLI, and `git diff --check`.

### 7. Wrong vs Correct

Wrong:

```rust
let output = Command::new("opencode")
    .args(["export", untrusted_session_id])
    .output()
    .await?;
```

Correct:

```rust
if !is_safe_session_id(session_id) {
    return Err("Invalid OpenCode session id".into());
}
let output = background_cli_command("opencode")
    .args(["export", session_id, "--pure"])
    .output()
    .await?;
```

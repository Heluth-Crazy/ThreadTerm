# Windows Background Process Contracts

> Keep service-style child processes invisible without changing interactive
> ConPTY behavior.

---

## Scenario: Background Stdio Services Must Not Create Console Windows

### 1. Scope / Trigger

- Trigger: adding or changing a Windows child process that communicates only
  through piped stdin/stdout, including the Codex app-server transport.
- Applies to `src-tauri/src/codex_app.rs` and future service-style subprocesses.
- Does not apply to terminal cards. Interactive shells and CLI cards must keep
  using the PTY subsystem so ConPTY, resize, signal, and process-tree semantics
  remain intact.

### 2. Signatures

- `CodexAppManager::ensure_process() -> Result<Arc<CodexAppProcess>, String>`
- Windows process flag: `CREATE_NO_WINDOW = 0x0800_0000`.
- Transport remains `stdin(Stdio::piped())`, `stdout(Stdio::piped())`, and
  `stderr(Stdio::null())` with `kill_on_drop(true)`.

### 3. Contracts

- On Windows, a service-style process must call
  `std::os::windows::process::CommandExt::creation_flags(CREATE_NO_WINDOW)`
  before `spawn()`.
- The flag is platform-gated with `#[cfg(windows)]`; macOS and Linux command
  construction remains unchanged.
- Hiding a background service must not redirect, merge, or remove its JSON-RPC
  stdio transport.
- Never apply this rule inside `pty_spawn`: PTY cards intentionally own a real
  ConPTY session and a headless `conhost.exe` while the card is live.

### 4. Validation & Error Matrix

- Windows service executable is a console-subsystem binary -> no visible
  console window; piped JSON-RPC still initializes.
- Executable is missing -> existing spawn error is returned unchanged.
- Child exits or closes stdout -> existing app-server disconnect handling runs.
- Interactive terminal card is created -> ConPTY still launches and resizes;
  do not use `CREATE_NO_WINDOW` as a substitute for the PTY host.

### 5. Good/Base/Bad Cases

- Good: opening a Codex Chat starts `codex.exe app-server` without an extra
  console window and requests continue over stdio.
- Base: non-Windows builds compile without importing Windows-only APIs.
- Bad: globally hiding every `codex.exe`, including CLI terminal cards, because
  that would bypass or damage the user-visible PTY feature.

### 6. Tests Required

- Rust unit tests keep verifying the Codex app-server command uses stdio.
- `cargo test`, `cargo clippy -- -D warnings`, and a Windows release build must
  pass.
- Windows smoke: open Codex Chat, verify no extra console window appears, send
  one request, and verify closing an unrelated console cannot disconnect Chat.
- Process evidence should distinguish service `codex.exe app-server` from CLI
  `codex.exe ... --no-alt-screen` terminal-card descendants.

### 7. Wrong vs Correct

Wrong:

```rust
let mut command = tokio::process::Command::new(executable);
command.stdin(Stdio::piped()).stdout(Stdio::piped());
let child = command.spawn()?;
```

Correct:

```rust
let mut command = tokio::process::Command::new(executable);
command.stdin(Stdio::piped()).stdout(Stdio::piped());
#[cfg(windows)]
command.creation_flags(CREATE_NO_WINDOW);
let child = command.spawn()?;
```

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

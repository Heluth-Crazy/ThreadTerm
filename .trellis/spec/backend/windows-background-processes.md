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

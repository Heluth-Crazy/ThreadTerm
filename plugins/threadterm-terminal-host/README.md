# ThreadTerm Terminal Host

This is a separately installed, connect-only Codex plugin. It never starts, repairs, upgrades, or otherwise launches ThreadTerm or its terminal daemon.

Start ThreadTerm first, then use `terminal_host_status`. `terminal_create` launches a direct executable and argument array (not a shell command), with a 24×80 terminal. To run a script, explicitly invoke its shell, for example `powershell.exe -File script.ps1`.

Creates require a durable, profile-scoped `request_id`. After an interrupted create, retry the **same** request ID or call `terminal_get` with that request ID. Defaults are `presentation: focused` and `exit_behavior: keep`.

`launch.cwd` must be an existing absolute directory. For workspace placement, `workspace_path` is optional and defaults at the daemon to the launch directory; if supplied, it must canonicalize to that same directory. Window placement rejects `workspace_path`.

Set `THREADTERM_PROFILE_DIR` to an existing absolute ThreadTerm profile state directory when needed. Without it, the bridge reads `%APPDATA%\com.Heluth-Crazy.threadterm\data-location.json`, then `data-location.previous.json`, validates the managed-root manifest, and uses `<managed-root>\state`; it then falls back to `%USERPROFILE%\.threadterm\state`.

Build and stage the Windows executable with `scripts/build.ps1`; run `scripts/validate.ps1` for manifest/schema and Cargo checks.

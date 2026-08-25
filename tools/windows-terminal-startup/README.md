# Windows terminal-startup WebDriver gate

`npm run test:e2e:terminal-startup:windows` runs the resumable, deterministic
matrix orchestrator. It invokes the existing WebdriverIO runner through an
external `tauri-driver` process and never adds a WebDriver plugin to the
application. Partial state stays under the ignored task-scoped cache; final
JSON/Markdown evidence is written only after every mandatory case completes.

The current matrix is versioned in `matrix.mjs`: production smoke, float,
isolation, provider cold repetitions, timing/warm repetitions, DA1, encoding,
all warmup cases, same-id repetitions, and 1/5/20 concurrency rounds. Each
case has a five-minute deadline and runner failures are recorded only as fixed
failure enums. Reports deliberately exclude paths, commands, output, provider
identifiers, environment values, PIDs, and exception text.

Build the release binary first:

```powershell
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --release
npm run test:e2e:terminal-startup:windows
```

Because the shipping main window is created during setup, build the WebDriver
variant with `src-tauri/tauri.webdriver.conf.json` when using legacy external
`tauri-driver`; it creates the initial WebView before setup and is never used
for a shipping artifact.

Set `THREADTERM_WDIO_APP` to test a separately built binary. The production
smoke uses public UI and proves that `terminal_startup_harness_status` is not
registered. A non-shipping build uses:

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --release --features terminal-startup-harness
```

The feature currently exposes only a privacy-safe capability probe. The runner
must record unsupported shell/timing/fault cases as failed or unavailable; it
must not count them as passed. Final evidence belongs only in the task's two
matrix result artifacts and must not include commands, cwd, PTY output,
environment values, or provider identifiers.

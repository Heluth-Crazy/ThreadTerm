# macOS Overlay / NSPanel Conventions

> Scope: `src-tauri/src/overlay/platform.rs` (macOS branch). The selector, float,
> and pet overlays are `tauri-nspanel` NSPanels, configured via `objc2` /
> `objc2-app-kit` after creation. These run inside Objective-C callbacks
> (app launch, global-hotkey handler), where a Rust panic **cannot unwind**.

---

## Don't: KVC `setValue:forKey:` with a private-API key on overlay NSPanels

**Problem** (removed in fix `83984fc`; introduced in `d46a5b8`):

```rust
// WRONG — crashes the whole app
fn disable_window_occlusion_detection(ns_window: &objc2_app_kit::NSWindow) {
    use objc2_foundation::{ns_string, NSNumber, NSObjectNSKeyValueCoding};
    let no = NSNumber::numberWithBool(false);
    unsafe {
        ns_window.setValue_forKey(Some(&no), ns_string!("windowOcclusionDetectionEnabled"));
    }
}
// ...called from configure_selector_window_for_current_space / _float_...
```

**Why it's bad**: `setValue:forKey:` with a key the receiver does not expose in a
KVC-compliant way raises an Objective-C `NSException`. The exception crosses the
`objc2` message-send boundary, which is `extern "C"` (non-unwinding), so Rust
converts it to `core::panicking::panic_cannot_unwind` → **`abort()`**. There is no
recoverable error and usually **no useful Rust panic message** — only
`panic in a function that cannot unwind`.

**Symptom**: the entire app vanishes (SIGABRT) the moment a code path runs
`configure_*_window_for_current_space` on the panel — most visibly when the
global hotkey (`Cmd+Shift+Space`) shows the selector, and also during
`prewarm_windows` at startup. macOS writes a crash report to
`~/Library/Logs/DiagnosticReports/threadterm-*.ips` whose crashing frame is
`global_hotkey::...::hotkey_handler` → `panic_cannot_unwind` (or
`tao::...::did_finish_launching` for the startup path).

**Instead**: only use the **typed, public** `objc2-app-kit` setters that are
already proven on these panels:

```rust
// CORRECT — typed public AppKit API only
ns_window.setCollectionBehavior(behavior);   // CanJoinAllSpaces | FullScreenAuxiliary | ...
ns_window.setHidesOnDeactivate(false);
ns_window.setLevel(NSScreenSaverWindowLevel);
ns_window.setStyleMask(style);               // UtilityWindow | NonactivatingPanel
```

If a **private** API is genuinely required, wrap the call in
`objc2::exception::catch(...)` and handle the `Err` (log + continue), or do not
use it at all. Never let a raw `setValue:forKey:`/private selector run unguarded
on an overlay panel.

**Status of the "#51 hidden-window anti-throttle" idea**: dropped. The
`windowOcclusionDetectionEnabled` KVC technique (from the native-feel skill) is
the exact pattern that crashed here. If first-frame hitch on the prewarmed
overlay is revisited, do **not** reintroduce KVC on that key — investigate a
supported route or an exception-guarded approach first.

---

## Gotcha: panics in objc callbacks abort the process (and hide their cause)

> Overlay code runs inside Objective-C callbacks (`applicationDidFinishLaunching`,
> the Carbon global-hotkey handler). A panic there is **non-unwinding** → instant
> `abort()`, and the *original* panic/exception reason is often swallowed.

When debugging an overlay crash:

- Read the macOS crash report (`.ips`) — the crashing-thread frames point at the
  callback boundary (`global_hotkey::hotkey_handler` / `tao::did_finish_launching`)
  and confirm it is an objc-boundary nounwind abort.
- A temporary `std::panic::set_hook(...)` in `run()` may only capture
  "panic in a function that cannot unwind" — that itself signals an **ObjC
  exception** rather than a normal Rust panic.
- `THREADTERM_SKIP_OVERLAY_PREWARM=1` (see `overlay::prewarm_windows`) skips panel
  prewarming, useful to isolate prewarm-path crashes from the hotkey-path.

**Note for local debugging**: a GUI Tauri build launched from a non-Aqua/sandbox
shell can crash at startup in the NSPanel path purely because it lacks a proper
WindowServer session. Such a startup crash is a launch artifact, **not** the bug —
reproduce overlay crashes by running the app from a real login GUI session.

---

## Source

- Root cause: commit `d46a5b8` (`platform.rs` `disable_window_occlusion_detection`).
- Fix: commit `83984fc` (removed the function + both call sites).
- Session journal: workspace session 13 (Shift+Cmd+Space crash investigation).

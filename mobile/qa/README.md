# Mobile Web QA

`web-empty-states.mjs` exports and serves the real Expo Web application only on an ephemeral `127.0.0.1` port, then captures 390×844 English/Chinese light/dark screenshots of the real empty/offline shell.

It is supplemental browser QA. It does **not** validate iOS, camera, native pairing, or NativePort networking.

`app/` is an isolated Expo/Metro project for injected-state QA. Its `App.tsx` wraps the real exported `CompanionApp` with `SafeAreaProvider` and an injected `CompanionProvider` store. The fixture deliberately has two machines with the same local project/session IDs: `alpha` has control plus a pending question, terminal output, scoped file and Git responses; `beta` is read-only. `injected-metro.mjs` exports that project, serves it only on an ephemeral `127.0.0.1` port, and uses Playwright at 390×844 to exercise the real UI's computer → project → file/Git → session/terminal routes and its read-only guard.

Run both browser checks from the repository root:

```sh
node mobile/qa/web-empty-states.mjs
node mobile/qa/injected-metro.mjs
node mobile/node_modules/typescript/bin/tsc --noEmit -p mobile/qa/app/tsconfig.json
```

The injected QA project uses the same Expo `registerRootComponent` bootstrap as
production. Its Metro configuration disables hierarchical dependency lookup and
searches the mobile workspace first. This is essential because the desktop and
mobile workspaces intentionally install different React versions; a hoisted
React Native Web dependency otherwise loads desktop React while the app loads
mobile React, producing an invalid hook dispatcher and a blank root. No native
safe-area/camera stubs or production configuration changes are needed.

The fixture uses typed, schema-valid snapshots and real production components.
The browser test checks navigation/back routes, overflow, question choice and
submission payload (including computer/turn/approval identity), terminal output,
read-only action refusal and dark appearance. It captures the computer hierarchy,
attention, file, Git, question, terminal and read-only surfaces. The injected
transport is synthetic; this check does not assert that an Agent or iOS device
performed those operations.

`native-host-smoke.mjs` separately starts a real runtime under a disposable root
and drives `native-client/examples/host_smoke.rs` through pinned TLS pairing,
snapshot, exact readonly denial, Control lease and resize, LF refusal followed
by an executed CR/echo round-trip, live revocation and clean shutdown. It uses
local authenticated IPC for host administration and never prints/persists the
issued mobile credential. Build the runtime and native example first, then run:

```sh
node mobile/qa/native-host-smoke.mjs
```

`round3-navigation.mjs` verifies Git tab replacement, Back from a diff, keyboard
background dismissal, list actions while focused, and measured terminal resize
and CR input payloads. Run it from the root. The other injected browser scripts
accept `TT_QA_SKIP_EXPORT=1` to reuse its export and `TT_QA_NO_SHOTS=1` to run
without changing screenshots.

All generated web exports and screenshots live in ignored `.qa-*` directories.
The Apple build, camera/picker/biometrics and native preview/device matrix remain
the separate gate in `scripts/NATIVE-IOS-VALIDATION.md`.

`chat-options.mjs` uses the same injected Expo project for the host-driven model,
reasoning and session-option composer sheet. Run from the repository root:

```sh
node mobile/qa/chat-options.mjs
```

It checks Control writes (including machine/session/lease identity), local lock,
View-only refusal, English/Chinese, dark mode and narrow/landscape overflow. Its
four screenshots live in `.trellis/tasks/11-06-mobile-companion/qa-chat-options/`.
Inspect the captures after rendering; browser injection does not exercise Swift
permission gates, biometrics or a real provider. A Swift allowlist change requires
a rebuilt signed iPhone app even when the JavaScript is served by Metro.

`device-fixes.mjs` checks the real UI with injected live permission changes,
English/Chinese permission messages, Control/View action gates, chat/terminal
inputs in reduced and landscape viewports, session/pairing sheets, removal of the
final computer, and direct Add computer guidance. It captures raw-text console
errors as well as page errors. Run `node mobile/qa/device-fixes.mjs` from the root.
Its two web screenshots live in the task's `qa-device-fixes/` beside the native
Simulator keyboard before/after captures. Browser viewport reduction supplements
native keyboard validation; it does not synthesize an iOS keyboard or Face ID.

## Offline terminal WebView (round 4)

From the repository root, run `node mobile/qa/terminal-webview.mjs`. It executes
our bundled xterm document in Chromium and checks byte-sequence dedupe, ten
keyboard-sized viewport changes, rotation without changing host geometry, ANSI
colors/Chinese, CR Return, sticky Ctrl, View-only denial, stale input tokens,
horizontal panning, host ConPTY option propagation and a bottom-row prompt in a
short viewport. It does not replace native keyboard acceptance.

`mobile/qa/tui-host-fixture.mjs --log <absolute-jsonl>` runs under a PTY, renders a
colored Codex-like banner/prompt, redraws on SIGWINCH and records exact stdin
bytes. The private Simulator harness and assertions are retained under task
`11-06-mobile-companion/qa-round4/`; its final receipt demonstrates ten actual
native keyboard show/hide cycles with no resize or banner replay.

The native-host smoke now also sends to a private offline Codex provider and
asserts the actual `turn/start` message. To use existing binaries, set
`THREADTERM_MOBILE_HOST_SMOKE_CLIENT_EXE` to the built host_smoke executable and
`THREADTERM_QA_RUNTIME_EXE` to a fresh runtime binary. The default client build
invokes Cargo, so the machine-wide lock and memory rules in AGENTS apply.

If a live test executable holds the default Rust output directory, preserve the
process and select a separate output cache for the full gate:

```powershell
npm run check -- --working-tree --test-threads=1 --rust-target-dir=runtime/target
```

This runs the same locked Cargo suite and leaves the default path and existing
processes untouched; hold the machine-wide lock while it runs.

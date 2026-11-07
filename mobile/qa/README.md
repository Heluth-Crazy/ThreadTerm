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
snapshot, exact readonly denial, live revocation and clean shutdown. It uses
local authenticated IPC for host administration and never prints/persists the
issued mobile credential. Build the runtime and native example first, then run:

```sh
node mobile/qa/native-host-smoke.mjs
```

All generated web exports and screenshots live in ignored `.qa-*` directories.
The Apple build, camera/picker/biometrics and native preview/device matrix remain
the separate gate in `scripts/NATIVE-IOS-VALIDATION.md`.

# Mobile companion implementation and concentrated acceptance

Source branch: `codex/mobile-companion`, isolated from the original checkout and
the separate `feat/mobile-development` worktree. Base revision: `48c0559`.

The user's sequencing is code and Windows verification first, followed by one
concentrated Mac/iPhone window. The code includes the app, Rust/Swift connection
module, host profile/schema/permission integration, desktop pairing/hosting
settings, and independent build/QA scripts. It is not yet an iOS release.

## Verification boundaries

| Available now | Requires the Mac/iPhone window |
| --- | --- |
| TypeScript and coordinator regression tests | Xcode and Apple-target compilation |
| Native Rust unit tests and generated Swift API comparison | Keychain persistence and Face ID behavior |
| Host migration/permissions/scoped data/revocation tests | Camera, picker, keyboard and VoiceOver |
| Real Windows runtime/native-client protocol smoke | iPhone Wi-Fi/cellular/network changes |
| Expo Web layout/navigation fixtures | iOS WebKit cookie isolation and proxy/WebSocket behavior |
| Desktop/renderer/protocol regression gates | Device signing/install and physical small/large screens |

Per-command results and diagnostic logs are recorded in the active Trellis task.
Tests use disposable roots, ports, credentials and processes; no existing user
daemon or another worktree's build output is reused.

## Windows verification recorded on 2026-11-06

- Full working-tree gate: 16/16 steps passed. Runtime: 2120 passed, zero failed,
  20 existing ignored cases, 31 selected-commit cases filtered because this PC's
  Git lacks `git hook run`. Final fast gate: 15/15 steps passed.
- Mobile coordinator/projection/path tests: 23 passed. Native Rust tests: 13
  passed; locked build and all-target clippy passed. Real DLL-backed UniFFI
  Swift/header/module-map generation and signature verification passed.
- Real native-client/runtime smoke: passed pairing, snapshot, readonly denial,
  revoke propagation and clean shutdown. Host pinned TLS-over-iroh tests passed.
- Production desktop/renderer build and two-computer browser navigation passed.
  Additional affected suites: 97 passed, one IPv6 loopback case skipped because
  this PC rejects that bind. Browser checks do not replace iOS acceptance.
- The final Swift API/actor-isolation corrections and Podspec/build preflight
  received source review, native-contract and Bash syntax checks. Apple
  compilation, signing and device behavior remain unverified until the window.

The desktop certificate fixture required the already-installed Git OpenSSL in
the check process's PATH; no system configuration or product workaround was
changed. One unchanged editor-navigation EOF timing test failed in an earlier
filtered run and passed both full runtime runs. Its cause remains unpinpointed;
no timeout increase or speculative cleanup fix was made.

## Preparation before the booked window

1. Copy or check out the exact reviewed revision on the Mac. Prepare full Xcode 16.1+,
   complete first-launch/license setup, and select its developer directory.
   Verify both iPhoneOS/simulator SDKs and CocoaPods before the window. Use
   Node 22.x >=22.13, Node 24.x >=24.3, or Node 26+; then install the npm lockfile.
   Prepare Rust/rustup; the native build script installs the Apple targets.
2. Prepare signing and Developer Mode so the session is not spent on account
   setup. Do not put signing certificates or credentials in the repository.
3. On each Windows host, run the matching runtime and register a disposable Git
   project with text/image/binary files and a development service with WebSocket.
4. Prepare one authenticated Agent and one ordinary terminal session on each
   host. Use the same project/session display names to exercise provenance.
5. Keep one View-only pairing and one Control pairing available. Make five-minute
   invitations during the session, not in advance.

## Acceptance order

1. **Build/install:** run the native build script, Expo prebuild and device
   install. Record Xcode, Rust, iOS, device and source versions. Resolve compiler
   or binding failures before testing behavior.
2. **Pairing:** direct TLS and iroh; compare codes; reject a changed certificate;
   cancel/back/reopen; expired and consumed invitations. Wrong pins must fail
   before credentials are sent.
3. **Two computers:** computer/project/worktree/session navigation and filters;
   identical names and session IDs; correct source on attention, chat, file, Git,
   attachments, draft, preview and back navigation.
4. **Control:** View cannot send/create/approve/type; Control requires biometric
   unlock and a session lease. Desktop/phone contention requires explicit
   takeover. Complete a real permission, question/form and plan round trip.
5. **Lifecycle:** create/connect/send/cancel/stop/resume a real Agent; type into a
   terminal; read split UTF-8 output and a truncated/gapped tail. Confirm no input
   is sent twice after interrupted replies.
6. **Attachments/files/Git:** choose zero-byte, image and text files; upload/send;
   preserve drafts after failures. Read registered files, image content and Git
   staged/unstaged/commit changes. Reject path escapes and unsupported binaries.
7. **Preview:** open registered host-loopback service with assets and WebSocket;
   check identical localhost addresses on both hosts and distinct cookies;
   public resources use phone networking. Failed tunnels cannot reach phone
   localhost as a fallback.
8. **Recovery:** Wi-Fi/cellular switch, lock/background/foreground, host restart,
   revoke, disable access and reset identity. Writes stay blocked until current
   snapshots finish; stale prompts cannot be acted on; uncertain mutations are
   never replayed automatically.
9. **Presentation:** light/dark/system, English/Chinese, keyboard avoidance,
   portrait/landscape, large text and VoiceOver. Verify every control remains
   reachable on the smallest supported phone.
10. **Desktop regression:** legacy phone credentials and desktop peers still
    work; mobile-only hosting offers keep-running quit; revoke affects only the
    intended phone and does not terminate host tasks.

Any failure records the exact trigger, relevant logs without secrets, a focused
reproduction, and its fix/retest. An intermittent failure remains unresolved;
increase investigation scope according to `AGENTS.md`.

## Delivery constraints

No automatic merge, push, packaging or deployment is part of this working
session. Keep the task open until Apple compilation and the hardware acceptance
matrix are recorded. Do not interpret a browser screenshot or a generated Swift
signature check as device acceptance. Push notifications and background live
connections are not promised; returning to the app resynchronizes it.

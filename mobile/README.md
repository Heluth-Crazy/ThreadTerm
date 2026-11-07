# ThreadTerm iPhone companion

An iOS 17+ companion for work running on paired ThreadTerm computers. The
application keeps the supplied warm neutral/indigo design and four tabs:
Needs You, Projects, Chat, and Settings. Projects start at the computer level;
attention items and conversations retain their computer and project identity.

## Implemented surfaces

- QR/pasted-text pairing, certificate comparison, iroh or direct pinned TLS,
  independent reconnects, device removal, and host-side revocation.
- Computer → project → registered worktree → session navigation, with direct
  folder projects, cached disconnected views, and computer/project filters.
- Chat transcripts, paging, provider connection state, permission choices,
  structured questions/forms, plans, attachments, new sessions, and stop/resume.
- Terminal output with bounded cursors/gap indicators, input, and explicit
  control takeover. The terminal surface is a text mirror, not a full VT emulator.
- Read-only project files and Git status/diffs/history/branches, plus native
  per-computer WebKit preview through authenticated host-loopback tunnels.
- English/Chinese, light/dark/system appearance, accessible controls, biometric
  unlock, and background locking. Host permissions remain authoritative.

Push notifications, file/Git writes, temporary privilege elevation, bulk
approvals, undo of sent approvals, and group administration are outside v1.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/core` | Platform-independent state, identity, reconnect and write fencing |
| `src/ui`, `App.tsx` | React Native screens and per-tab navigation |
| `modules/threadterm-mobile` | Expo/Swift bridge, Keychain, biometrics, picker, WebKit |
| `native-client` | Rust iroh/TLS client, framing, RPC, native preview proxy |
| `scripts` | Apple build and native/binding contract checks |
| `qa` | Isolated browser fixtures and real host/client smoke tests |
| `../protocol/mobile.ts` | Shared mobile payloads and boundary validation |
| `../runtime/src/mobile.rs` | Host authority, projection and registered-root policy |

Credentials and the iroh secret stay in native memory/Keychain. JavaScript
receives public machine records, pairing comparison data, and validated RPC
results. Local draft and attachment references are keyed by computer/session.

## Install and check

Run from the repository root with the checked-in lockfile:

```sh
npm ci
npm run mobile:typecheck
npm run mobile:test
node mobile/scripts/verify-native-contract.mjs
npm --workspace @threadterm/mobile run export:web
```

The Web build is useful for layout checks. It has no native transport, Keychain,
Face ID, or host preview implementation. Expo Go cannot load the custom module;
use an iOS development build for connections.

## Concentrated Mac/iPhone build window

Prepare full Xcode 16.1 or newer (open it once to accept its license and install components),
a signing team, a connected iPhone with Developer Mode enabled, Rust/rustup,
CocoaPods, Node/npm, and the same source revision on the Mac. Use Node 22.x at
22.13 or newer, Node 24.x at 24.3 or newer, or Node 26+; Node 20 is unsupported
by the pinned Expo/React Native versions. Verify these before `npm ci`:

```sh
node --version
pod --version
xcodebuild -version
xcrun --sdk iphoneos --show-sdk-path
xcrun --sdk iphonesimulator --show-sdk-path
```

The active developer directory must point to full Xcode, rather than the
standalone Command Line Tools installation. Keep a Windows
host running the matching desktop/runtime revision and a disposable registered
project available. For multi-computer acceptance, prepare a second host too.

```sh
npm ci
cd mobile
bash scripts/build-native-ios.sh
npx expo prebuild --platform ios
npx expo run:ios --device
```

The build script installs all three Apple Rust targets, generates pinned UniFFI
Swift bindings, and creates the device/simulator XCFramework. Generated Apple
projects, bindings, frameworks, and caches are ignored. Check the resulting
Xcode signing team and bundle identifier before installing on the iPhone.
For an existing generated iOS project, run `(cd ios && pod install)` from
`mobile/` after rebuilding the native framework.

For subsequent UI edits, start Metro with `npm run mobile:start` from the root.
Rebuild the native library and development app after Rust or Swift changes.

Follow [the native acceptance checklist](scripts/NATIVE-IOS-VALIDATION.md) and
[the integrated acceptance plan](../docs/mobile-implementation.md). Windows
checks do not establish that the Apple build or hardware flows pass.

## Host setup

In the desktop application's phone settings, enable mobile access and grant
View or Control before creating the five-minute invitation. For iroh, enable
the shared cross-network option; the host's Tailscale-only restriction still
applies. Scan or paste the complete invitation on the phone, compare the check
code shown on both devices, then confirm. The short code alone is insufficient.

Mobile credentials expire after 30 idle days. Legacy phone credentials retain
their terminal-only profile and original lifetime. Revoking a phone or disabling
remote access closes its live connections and control leases while the computer's
tasks remain running. Choosing the desktop's keep-running quit option preserves
mobile access when a mobile device is paired.

See [the wire/native contract](../docs/mobile-contract.md) before changing the
transport or any authority boundary.

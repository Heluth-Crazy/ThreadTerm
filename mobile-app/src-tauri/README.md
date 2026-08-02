# ThreadTerm iOS shell (`mobile-app/src-tauri`)

Minimal **Tauri 2 iOS-only** crate that hosts the shared React UI in
`mobile-app/src`. It does **not** compile the desktop backend (PTY, Git,
Agent, bridge server, SQLite project DB).

## What lives here

| Layer | Responsibility |
|-------|----------------|
| React UI (`../src`) | Workbench, Workspaces, Settings, terminal mirror, file/diff UI |
| `BridgeClient` TS | `LegacyWebBridgeClient` (web) / `NativeSecureBridgeClient` (iOS plugin) |
| This crate | WebView host + plugin registration only |
| Swift plugin (post-init) | QR/camera, Keychain token, URLSession WebSocket + cert fingerprint pin |

## Windows note

This repository path can be edited on Windows, but **you cannot**:

- Run `cargo tauri ios init` / simulator / archive
- Link the real Keychain or `URLSessionWebSocketTask` pin path
- Produce a TestFlight build

Complete Batch 2–6 of `.trellis/tasks/08-01-ios-workspace-client/implement.md`
on a Mac with Xcode, Apple Developer signing, and a physical iPhone.

## macOS bootstrap (authoritative)

```bash
# From repo root, on macOS with Xcode + Rust iOS targets:
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim
npm install
npm run build:mobile

cd mobile-app
# First time only — generates gen/apple Xcode project:
npx tauri ios init

# Dev (simulator)
npm run ios:dev

# Release archive (signing via Xcode / env — never commit secrets)
npm run ios:build
```

### Privacy strings (set in Xcode Info)

- `NSCameraUsageDescription` — scan desktop secure pairing QR
- `NSLocalNetworkUsageDescription` — reach ThreadTerm desktop on LAN
- Bonjour services as required by local network WebSocket discovery

### Bundle id

Desktop: `com.Heluth-Crazy.threadterm`  
iOS: `com.Heluth-Crazy.threadterm.ios` (see `tauri.conf.json`)

## Secure plugin contract (Swift)

Commands (names are stable for the TypeScript client):

- `secure_validate_qr` — parse QR; reject bad fingerprint format before network
- `secure_pair` — pin leaf cert SHA-256 to QR fingerprint, then send OTP
- `secure_connect` / `secure_send` / `secure_disconnect`
- `secure_forget` — delete Keychain token; non-secret computer meta may remain until cleared

Events:

- `secure://status` — connecting | open | revoked | fingerprint_mismatch | …
- `secure://message` — raw versioned v2 JSON (terminal bytes untouched)

**Never** return the raw device token to JavaScript after storage.

## Related packages

- Root `npm run build:mobile` — legacy embedded web bundle (unchanged)
- Root desktop `src-tauri` — full ThreadTerm; do not link it into this crate

## Acceptance blocked without Apple hardware

See `.trellis/tasks/08-01-ios-workspace-client/blockers.md`.

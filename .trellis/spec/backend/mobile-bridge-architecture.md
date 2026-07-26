# Mobile Bridge Architecture

> Keep the mobile bridge wire contract stable while splitting transport,
> lifecycle, projection, and pure preview responsibilities.

## Module Ownership

- `bridge/protocol.rs` owns serialized client/server message shapes and protocol
  versioning.
- `bridge/pairing.rs` owns pairing codes, device tokens, permissions, expiry,
  revocation, and audit persistence.
- `bridge/server.rs` owns HTTP/WebSocket transport, authentication at the
  transport boundary, connection tracking, and request dispatch.
- `bridge/network.rs` owns loopback bind defaults and pairing-target
  normalization for local access and secure tunnels.
- `bridge/preview.rs` owns pure terminal-text-to-card-preview projection.
- `bridge/projection.rs` owns the desktop/mobile state mirror, card/PTY identity
  lookup, live-state enrichment, terminal snapshot message construction, and
  pure PTY-snapshot/tombstone-to-`CardMeta` projection.
- `bridge/mod.rs` is the compatibility facade and currently coordinates the
  managed server runtime and outward bridge broadcasts.

## Preview Contract

- `preview_from_output` is a pure projection. It must not acquire runtime/PTy
  locks, broadcast messages, read settings, or perform network/database I/O.
- Preserve the existing eight-line limit, 240-character per-line cap, ANSI and
  control stripping, composer removal, noise fallback, adjacent-line
  deduplication, summary selection, and hidden-line count.
- Moving preview code must not change `CardMeta`, `ServerMessage::Preview`, or
  snapshot serialization.
- Preview tests live beside `preview.rs`; runtime tests remain in `mod.rs`.

## Dependency Direction

```text
network <- runtime facade
preview <- projection -> protocol
protocol <- pairing <- server
protocol <- runtime facade -> server
runtime facade -> preview
runtime facade -> projection
```

Projection methods may read `BridgeRuntime` state but must not own server
start/stop. They clone mirrored state under the mirror lock and enrich it with
PTY state only after releasing that lock, preserving the existing lock-order
contract.

## Refactoring Rules

- Extract one responsibility per commit and keep the public bridge facade
  function names unchanged.
- Use `pub(super)` only for data needed by the parent facade; keep helper
  functions private to their module.
- Move existing tests with pure code instead of duplicating them.
- Run the extracted module tests, all bridge integration tests, full Cargo
  tests, Clippy with warnings denied, and GitNexus change detection before each
  independently reversible commit.

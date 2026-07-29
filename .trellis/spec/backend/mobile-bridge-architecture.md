# Mobile Bridge Architecture

> Keep the mobile bridge wire contract stable while splitting transport,
> lifecycle, projection, and pure preview responsibilities.

## Module Ownership

- `bridge/protocol.rs` owns protocol versioning, compatibility re-exports, and
  wire-contract tests. Serialized shapes live under `bridge/protocol/`:
  `terminal.rs`, `workbench.rs`, `theme.rs`, `access.rs`, and `messages.rs`.
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
- `bridge/runtime.rs` owns managed-server start/stop, startup restoration,
  lifecycle serialization, and persistence of bridge identity and running
  state.
- `bridge/commands.rs` owns the command-handler behavior for bridge controls,
  state synchronization, mobile action results, pairing, device management,
  and theme publication.
- `bridge/mod.rs` is the compatibility facade and currently coordinates the
  outward bridge broadcasts. It retains the exact Tauri command function names
  and signatures as thin registration wrappers.

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
network <- runtime
preview <- projection -> protocol
protocol <- pairing <- server
protocol <- runtime -> server
protocol <- commands -> runtime
commands -> network
compatibility facade -> commands
compatibility facade -> preview
compatibility facade -> projection
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

## Scenario: Protocol Submodule Compatibility Facade

### 1. Scope / Trigger

- Trigger: adding, moving, or changing any serialized mobile bridge DTO,
  `ClientMessage`, `ServerMessage`, protocol parse error, or default theme
  token.

### 2. Signatures

- Stable public path: `crate::bridge::protocol::<ExistingItem>`.
- Version entry: `pub const PROTOCOL_VERSION: u16`.
- Parse entry:
  `parse_client_message(&str) -> Result<ClientMessage, ProtocolParseError>`.
- Serialize entry:
  `versioned_server_message(ServerMessage) -> VersionedServerMessage`.

### 3. Contracts

- `protocol.rs` is a facade. Existing public items must be re-exported from it
  even when the item currently has no in-crate consumer.
- Module ownership is fixed by payload purpose:
  `terminal` (card/terminal state), `workbench` (notifications and Workbench
  projection), `theme` (theme payload/default), `access` (pairing/device/action
  requests), and `messages` (wire envelopes, enums, version validation).
- Moving an item must preserve its type name, enum variants, field order/type,
  every Serde attribute, conversion implementation, and serialized default.
- A structural split never increments `PROTOCOL_VERSION`.

### 4. Validation & Error Matrix

- Missing or wrong `protocol_version` -> `ProtocolVersionMismatch` with
  `protocol_version_mismatch`.
- Invalid JSON -> `InvalidJson` with `invalid_message`.
- JSON with an invalid message shape -> `InvalidMessage` with
  `invalid_message`.
- Missing compatibility re-export -> compile failure in bridge consumers; do
  not migrate consumers to a private child-module path.

### 5. Good/Base/Bad Cases

- Good: move `BridgeTheme` to `theme.rs`, keep
  `pub use theme::BridgeTheme`, and retain identical serialized JSON.
- Base: a new DTO is defined in its owning child module and exported through
  `protocol.rs`.
- Bad: import `protocol::theme::BridgeTheme` from `server.rs`, make a child
  module public, or remove an unused public re-export to silence a warning.
- Bad: combine a file move with field renames, payload compaction, or a
  protocol-version bump.

### 6. Tests Required

- Protocol tests assert stable `kind`, camel/snake-case field names, version,
  defaults, terminal snapshot identity, mobile action results, and parse error
  codes.
- Run all bridge tests and full `cargo test`.
- Run Rustfmt and Clippy with warnings denied.

### 7. Wrong vs Correct

Wrong:

```rust
pub mod theme;
// Callers migrate to protocol::theme::BridgeTheme.
```

Correct:

```rust
mod theme;
pub use theme::BridgeTheme;
// Callers keep using protocol::BridgeTheme.
```

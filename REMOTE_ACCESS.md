# Remote terminal access

ThreadTerm's Rust runtime owns a disabled-by-default HTTPS listener for paired devices on the local network. The local named-pipe API is the only administration surface:

- `device.status`, `device.enable`, and `device.disable` control and inspect the listener.
- `device.pairing.create` creates a one-time five-minute pairing offer for either `readonly` or `fullcontrol` access.
- `device.list` and `device.revoke` expose device metadata and immediately revoke a bearer token.

The runtime persists the assigned TCP port so paired clients can reconnect after restart. A port collision disables only remote access and appears in `device.status.error`; it does not prevent the local runtime from starting. The listener uses a persistent self-signed certificate at `remote-access-cert.pem` and private key at `remote-access-key.pem` under the V3 data root. Data relocation copies both files with the SQLite database and reapplies a current-user-only ACL to the private key. Pairing payloads include the certificate's SHA-256 fingerprint so the client can pin the identity.

## Credential rules

Pairing offers use a random 128-bit hexadecimal secret. Only its SHA-256 digest is stored. An offer expires after five minutes, is consumed atomically once, and becomes invalid after five unsuccessful attempts. A successful pair issues a random 256-bit URL-safe bearer token with a fixed 24-hour lifetime. Only the token digest is stored. Authentication checks expiry and revocation and updates `lastSeenAt` for every request. Revoke drains actions already authorized by that token and atomically expires its control leases before returning. Pairing secrets and bearer tokens are never written to settings exports, snapshots, outbox events, or URLs.

## HTTPS API

`POST /v1/pair` is the only unauthenticated operation. It accepts strict JSON:

```json
{"pairingId":"…","code":"…","deviceName":"Phone"}
```

`POST /v1/rpc` requires `Authorization: Bearer <token>` and accepts `{ "method": "…", "params": {…} }`. Requests are limited to 128 KiB. The listener limits concurrent TLS connections, times out TLS handshakes and request bodies, and caps connection lifetime. Disabling the listener cancels and drains accepted connections before returning.

The remote dispatcher is a closed method match and never passes a caller-supplied method through to the local dispatcher. Read-only devices may call:

- `remote.sessions`, which returns terminal-only session metadata without filesystem paths, settings, credentials, or provider history.
- `terminal.read`, with output bounded to 256 KiB per request.

Full-control devices may additionally call:

- `session.create`, with a registered project ID and a fixed set of terminal providers. The runtime derives the working directory from the project and rejects executable, arguments, custom-command, and arbitrary-path fields.
- `session.stop`, `session.claim`, `session.renew`, and `session.release`.
- `terminal.input` and `terminal.resize` after lease validation. The runtime derives the lease principal as `device:<paired-device-id>`.

Both permissions deny runtime shutdown, device administration, settings, data operations, workspace and preset changes, files and drafts, Git and worktrees, provider Chat and history, backups, relocation, and MCP operations.

Remote request execution takes the runtime relocation gate before the remote activity gate. This fixed lock order lets `device.disable` and `device.revoke` drain credential and terminal requests without deadlocking a queued relocation. Each accepted request is fenced by the listener generation that accepted it, so work queued before disable cannot resume after a later re-enable. Relocation requires remote access to be disabled.

## Validation

Runtime unit tests cover expiry boundaries, five-attempt invalidation, atomic one-time use, digest-only storage, fixed token lifetime, revoke behavior, metadata redaction, and the allowlist matrix. The HTTPS integration test trusts only the generated test certificate, pairs read-only and full-control devices through the listener, proves read-only control denial, creates a real shell PTY, claims and renews its lease, sends input, reads captured output, releases the lease, revokes the device, and verifies the same token receives `401 Unauthorized`.

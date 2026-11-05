# Remote terminal access

ThreadTerm's Rust runtime owns a disabled-by-default HTTPS listener for paired devices on the local network. The local named-pipe API is the only administration surface:

- `device.status`, `device.enable`, and `device.disable` control and inspect the listener.
- `device.identity.reset` replaces the TLS identity after an explicit user confirmation and revokes every paired device.
- `device.pairing.create` creates a one-time five-minute pairing offer for either `readonly` or `fullcontrol` access.
- `device.list` and `device.revoke` expose device metadata and immediately revoke a bearer token.

The runtime persists the assigned TCP port so paired clients can reconnect after restart. A port collision disables only remote access and appears in `device.status.error`; it does not prevent the local runtime from starting. The listener uses a persistent self-signed certificate at `remote-access-cert.pem` and private key at `remote-access-key.pem` under the V3 data root. Data relocation copies both files with the SQLite database and reapplies a current-user-only ACL to the private key. Pairing payloads include the certificate's SHA-256 fingerprint so the client can pin the identity.

Remote access is optional, so the runtime reads the enabled preference before it touches the identity and creates the pair only when remote access starts. A missing half pair, a corrupt PEM file or an unreadable key becomes a recoverable `device.status.error` (with the exact cause in `device.status.identityError`) instead of a startup failure: local transport, terminals, Chat and Settings keep working. Settings → Devices shows that error with **Reset remote identity**, which requires a second confirmation, revokes every paired device, expires their leases, discards open pairing offers and generates a new pair; already paired devices must pair again because their pinned certificate no longer matches. A new pair is written and restricted under temporary sibling names before either file is renamed into place, so an interrupted reset leaves the previous pair or an explicit identity error rather than a silently generated replacement.

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

Both permissions deny runtime shutdown, device administration, settings, data operations, workspace changes, files and drafts, Git and worktrees, provider Chat and history, backups, relocation, and MCP operations.

Remote request execution takes the runtime relocation gate before the remote activity gate. This fixed lock order lets `device.disable` and `device.revoke` drain credential and terminal requests without deadlocking a queued relocation. Each accepted request is fenced by the listener generation that accepted it, so work queued before disable cannot resume after a later re-enable. Relocation requires remote access to be disabled.

## Validation

Runtime unit tests cover expiry boundaries, five-attempt invalidation, atomic one-time use, digest-only storage, fixed token lifetime, revoke behavior, metadata redaction, and the allowlist matrix. Identity recovery tests plant a missing half pair, a corrupt PEM pair and an unreadable key, then prove that startup, health and a terminal session still work and that enabling reports the actionable error; the reset test proves that only an explicit reset replaces the identity, invalidates tokens and open offers, and lets a new device pair. The HTTPS integration test trusts only the generated test certificate, pairs read-only and full-control devices through the listener, proves read-only control denial, creates a real shell PTY, claims and renews its lease, sends input, reads captured output, releases the lease, revokes the device, and verifies the same token receives `401 Unauthorized`.

## Desktop computers (Computers preview)

Desktop computers use the full ThreadTerm protocol over pinned TLS, on the same listener and port as phones. The phone HTTPS permissions and lifetime above are unchanged. Computers remains a preview behind Settings → Computers → **Enable Computers preview**, off by default. Use it on Windows PCs on your LAN or Tailscale network; there is no discovery, relay, or start-at-login feature.

To pair, enable the preview on both PCs. On the PC that will run the work, choose **Create pairing offer** in Settings → Computers. On the other PC, paste its pairing text into **Add a computer**, check that both PCs show the same check code, then choose a name and color. Offers expire after five minutes and work once. The client checks the pinned certificate before sending credentials. The saved credential is encrypted with operating-system secure storage; pairing is unavailable if that storage is unavailable. Desktop credentials expire after 30 days without use. A newly issued credential that never connects is removed after ten minutes.

The offer carries the address the other PC dials, read when the offer is made. With Tailscale-only on, that is this PC's Tailscale address, and **Create pairing offer** says Tailscale is not connected when there is none. Otherwise it is the address of the Ethernet or Wi-Fi adapter that has a default gateway, so proxy and VPN tunnels (sing-box or Clash in TUN mode, WireGuard) and host-only adapters (VMware, Hyper-V) are never offered; without such an adapter, a Tailscale address comes first. PCs on different networks, such as home and office, need Tailscale on both. When the other PC cannot reach the address, **Check computer** names it.

A paired computer is trusted to act as you: Chat, terminals, Run, files, Search, Git/worktrees, Browser, usage, and the host's ordinary settings all run against that PC. It cannot administer paired devices or remote access, change the Tailscale-only option, shut down the runtime, back up/relocate data, or invoke internal QA administration. Pair only computers you trust. Host administration pages are hidden in remote views. Files attached from the client are uploaded to the host; exports are saved on the client. In the machine's panel browser, localhost reaches that host. Public sites use the client's network.

Each computer has its own sidebar group. Select its session to work there, or open it in another window. Settings → Computers on the host lists allowed desktop computers; **Remove** revokes that credential, closes its connections and ends its terminal control within two seconds. Programs already running on the host continue. Removing an entry on the client only removes that client's saved connection.

### Tailscale-only access

**Only accept devices on my Tailscale network** is one shared host switch on This PC's Settings → Computers and Settings → Phones. It applies to computers and phones alike. When enabled, the listener accepts only Tailscale source addresses (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`, including IPv4-mapped IPv6 forms); loopback is refused. Changing the option restarts the listener and closes existing connections, including phones, within two seconds. Allowed clients reconnect. The preference survives runtime restarts. Only the host's local administration surface can change it (`device.tailscaleOnly.set {enabled, operationId}`); `device.status` reports `tailscaleOnly`.

### Quitting a host and returning later

With Computers enabled, a running runtime and at least one unrevoked paired desktop computer, both tray Quit and the window's Quit action always ask, even with no active sessions. The heading names computers with live connections, or says **Other computers can use this PC**. Choose:

- **Quit, keep running** (default): Electron exits, while the detached runtime and sessions continue. Other computers can keep working. The next desktop launch attaches to the same runtime and session list.
- **Stop everything**: perform the usual runtime shutdown and stop its jobs, then exit Electron.
- **Cancel** (Escape): stay open.

With no paired desktop, with Computers off, or with no runtime running, the existing quit dialog and shutdown rules apply. Closing a window still follows the existing tray behavior. Runtime exit, Windows logout and reboot end running sessions; this feature does not start ThreadTerm at login.

### Connection and identity failures

A dropped connection shows reconnecting/disconnected state. Existing work keeps running on the host, and requests with uncertain outcomes are never sent again automatically. A host runtime crash reconnects after that runtime restarts on the same data and port. The Chat turn that was in progress is marked **Turn interrupted**, as on any runtime restart; a new Chat turn is an explicit new action.

A version mismatch shows both versions/contracts and asks you to update one so they match. That connection stops retrying; after updating/restarting, select the computer again in the sidebar to retry. Other computers and This PC remain usable.

If the certificate changes, the view says the computer's identity changed and requires pairing again. An explicit **Reset remote identity** on the host replaces its certificate and revokes every paired device. Pair that address again to replace the stale changed-identity entry while retaining its machine id, local name and color. A matching address without a changed-identity state retains the ordinary add-computer behavior.

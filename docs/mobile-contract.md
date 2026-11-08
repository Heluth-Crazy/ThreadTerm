# Mobile contract 1

This is the coordination contract for the iPhone companion. The host remains authoritative. The old `phone` profile is unchanged; the new `mobile` profile uses readonly/fullcontrol permissions and 30-day idle credentials. Native protocol and mobile feature contract are 1. Outer iroh ALPN `threadterm-iroh/1`; inner TLS `threadterm-mobile/1`. Pair via `http/1.1`, retained pinned stream, POST /v1/pair. Mobile offers use the existing `threadterm://pair?data=...` descriptor plus `profile:"mobile"`; v2 includes iroh, v1 TCP. Pin SHA-256 of DER certificate before any HTTP/auth bytes.

## Handshake and framing

Reuse peer framing and challenge: server `{kind:"challenge",protocol:1,contract:1,nonce,version}`; client `{kind:"auth",protocol:1,contract:1,nonce,channel,clientId,credential,epoch}`. Control epoch null; dependents use authenticated control epoch. Channels control/output/tunnel (no browser automation). Server authenticated includes epoch/principal/permission; incompatible and tunnel_failed retain peer shapes. An unknown iroh key can only pair against a live mobile offer. Device profile and connection-proved key must match on authentication.

Requests `{v:1,id,method,params}`, responses `{v:1,id,result}` or error, events `{v:1,event,epoch,seq,data}`. u32 little-endian frame length, max 8MiB; bounded response max6MiB. Never automatically retry uncertain mutations.

Invalid/revoked credentials fail authentication with `{kind:"authentication_failed",code:"mobile_revoked",message:"Mobile credential is no longer valid"}`. A live control connection whose credential is revoked or expires receives `{v:1,event:"mobile.revoked",epoch,seq:0,data:{reason:"revoked"|"credential_expired"}}` before closing. Native consumes this terminal event before ordinary sequence handling and emits connection state `revoked`. Ordinary EOF and disabled hosting are disconnections, not proof of revocation.

## Mobile-only methods

- `mobile.snapshot {}` -> `{epoch,revision,permission,capabilities:{contract:1,methods:string[]},projects:ProjectCatalogItem[],worktrees:Worktree[],sessions:Session[],inbox:InboxItem[],providers:MobileProvider[]}`. Provider fields id/name/installed/terminal/chat/auth?/reason?/version? only. No settings/credentials. Catalog/worktrees only registered scopes. Exclude removed/archived internal review sessions as appropriate. Per-project worktree read failures must not disconnect the computer; report optional `warnings:[{projectId,message}]`.
- `mobile.session.create {projectId,worktreeId?,provider,mode,title?,operationId}` -> Session. Runtime resolves cwd; no executable/args/custom commands/nativeId from mobile. Provider must be installed and support mode; selected worktree must belong to project.
- `mobile.events.subscribe {sessionIds:string[]}` -> `{sessionIds:string[],revision:number}`. Bound to current control connection. Empty list summary-only; max 4 detailed sessions. Safe `mobile.changed` invalidates summary (payload empty); active session `chat.*` events are safe typed projections. No raw settings/device/config events. Existing `runtime.degraded`/cursor semantics allowed; events always machine-qualified by client adapter.

## Existing methods (closed subset)

View: runtime.health, project.catalog.list, worktree.list/worktree.branches, session.lookup, chat.snapshot/read/subagent.read/options/connection, terminal.read, filesystem.list/read/files/search/image, git.status/diff/log/commit.show/commit.diff/branches, inbox.read, session.attention.acknowledge. Scope filesystem/Git to registered projects/worktrees. No arbitrary browse/external-files/host settings/history/plugin APIs. Use bounded existing result types.

Control: mobile.session.create, session.stop/resume, session.claim/renew/release, chat.connect/option.set/send/cancel/approve/answer, terminal.input/resize, attachment.upload/read, chat.image.read. `chat.option.set` receives only the host-provided option id/value and requires the same registered session and leaseEpoch as desktop. `chat.approve` uses choiceId, never invent approve/deny booleans. Optional other read methods only when needed and explicitly coordinated. Claims derive principal from authenticated device/client; subsequent operations use leaseEpoch. No silent takeover. Lease enforcement remains identical to desktop. `chat.image.read` and authorized session attachment reads are viewing operations; uploads require control. Do not expose `session.create` directly.

Tunnel target is literal host loopback and a port belonging to a registered current preview session. Native proxy handles public resources locally; never tunnel arbitrary host network addresses or fallback to phone loopback. Opening viewer can have web app effects; it is not a promise that the viewed web app is read-only.

## Native Expo module `ThreadTermMobile`

All async methods throw structured errors with a stable code. Native Rust owns sockets and framing; Swift owns secure storage, connection registry and biometrics. JS sees metadata only:

`MachineRecord = {id,name,color,transport:'iroh'|'tls',endpoint,tlsFingerprint,permission:'readonly'|'fullcontrol',expiresAt}`.

- `listMachines(): Promise<MachineRecord[]>`
- `preparePairing(text:string): Promise<{pendingId:string,checkCode:string,endpoint:string,transport:'iroh'|'tls'}>` validates descriptor and pins live host before success.
- `confirmPairing(pendingId:string,deviceName:string,name:string,color:string): Promise<MachineRecord>` consumes same checked connection. `cancelPairing(pendingId): Promise<void>`.
- `removeMachine(machineId): Promise<void>` removes local credentials/connection/browser store only. `renameMachine(machineId,name,color): Promise<void>`.
- `connect(machineId): Promise<{epoch:string,permission:'readonly'|'fullcontrol'}>`; `disconnect(machineId): Promise<void>`.
- `request(machineId,method,paramsJson): Promise<string>` result JSON only; mobile control requests require native unlocked state. Never return credentials. RPC error message retains code.
- `unlockControl(): Promise<boolean>` native LocalAuthentication; `lockControl(): Promise<void>`. Background locks and disconnects.
- `openPreview(machineId,url): Promise<void>` presents the native WKWebView with per-machine store/proxy. `chooseAttachment(): Promise<{name:string,size:number,uri:string}|null>`; `readAttachment(uri,offset,length): Promise<string>` returns <=1MiB base64 for picked private file only.
- Events `onRuntimeEvent {machineId,eventJson}` and `onConnectionState {machineId,state:'connecting'|'connected'|'disconnected'|'incompatible'|'pin-mismatch'|'revoked',message?:string}`. Native fences old connections before emitting. `onControlLock {locked:boolean}`.

The JS coordinator handles network-backoff, summary synchronization, per-machine state and lease renewal; native connect is single-flight and request never reconnects implicitly. Terminal v1 may use bounded `terminal.read` with durable cursor only while visible; this keeps byte/cursor integrity and does not claim unsupported screen-checkpoint fidelity. Native core should support output streams as an extension, but don't block usable terminal reading on it.

## App coordinator facade

UI imports `useCompanion` from `../core/react` and types from `../core/types`. The coordinator will supply machines with connection/snapshot state, tabs' routes, per-machine draft/history/attention and action methods; coordinate exact UI facade with root before implementation. UI must not call native module directly except camera/document inputs via coordinator. No production demo machines.

### Chat options flow

`chat.options {sessionId}` returns the host's complete `ChatUiState` (options,
choices, selected values, load state and provider error). Subscribed `chat.ui`
events replace that state. The companion uses the desktop's pure presentation
helpers for category, group, labels and current model/effort; it has no model
catalog of its own.

`chat.option.set {sessionId,optionId,value,leaseEpoch,operationId}` returns the
host-confirmed `ChatUiState`. It is session-scoped and has no turn identity. A
Control phone must hold the same lease the desktop handler requires; View gets
`mobile_readonly` before provider work. Native Swift and JavaScript both guard
this Control method as well. The phone serializes changes, rechecks lock and
connection generations after acquiring a lease, and never automatically replays
a change. Reconnection must finish the current session snapshot before another
write. Late replies cannot overwrite a new connection's options. Read failures
retain the readable previous values; a later live UI snapshot wins over an older
read. A pending or failed update remains visible even after dismissing the sheet.
Like desktop, `chat_permission_restore_failed` offers only the host's permission
(`category: mode`) choices even while the provider is failed. This exception
retains every Control, unlock, synchronization and lease check; other option load
errors and disconnected providers remain display-only.

## Changing a paired device's access

Local desktop administration may call `device.permission.set` with
`{deviceId,permission,operationId}` and receives the persisted `PairedDevice`.
View/Control changes apply to already connected mobile groups. A downgrade expires
that device's control leases and the next control request returns `mobile_readonly`;
an upgrade needs a fresh lease. The device change event resynchronizes desktop and
phone. This method is never part of the mobile or remote desktop allowlists.
The native bridge refreshes its permission cache from authenticated mobile
snapshots before handing them to JavaScript. A Face ID unlock only removes the
local lock on Control already granted by the computer.

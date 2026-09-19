# V3 architecture and initial wire contract

## Ownership and layout
- v3/runtime/: standalone Cargo Rust daemon, sole SQLite writer and canonical state authority. Modular monolith.
- v3/desktop/: Electron main/preload, build/package configuration. OS integration, start/discover/reconnect runtime, validated IPC proxy only.
- v3/renderer/: React feature UI, no Node APIs, narrow window.threadterm facade.
- v3/protocol/: shared TypeScript contracts/runtime validators and protocol schema. Main coordinator owns this directory.
- v3/providers/: supervised minimal Node Claude SDK sidecar; native provider process protocols handled by runtime adapters.
- v3/reference/prototype/: immutable latest prototype reference.

Electron sandbox/contextIsolation true, nodeIntegration false. No raw ipcRenderer or channels exposed. Runtime is on-demand per-user singleton; Windows named pipe per-user ACL and credential handshake; UDS later. Separate control and binary output connections; length-prefixed frames (u32 little endian length, then payload), max 8 MiB. Pipe base configurable via THREADTERM_V3_PIPE, default \\.\pipe\threadterm-v3-<user hash>. Bootstrap credential stored in restricted V3 data directory, never renderer/argv. Handshake before any commands. IPC protocol version 1. Never use unauthenticated TCP as fallback.

Control request: {v:1,id:string,method:string,params:object}; response {v:1,id,result:unknown} OR {v:1,id,error:{code:string,message:string,details?:unknown}}. Events {v:1,event:string,epoch:string,seq:number,data:unknown}. auth request {token,clientId,protocol:1}. Runtime health reports epoch/version. snapshot returns {epoch,revision,projects,sessions,settings,workspaces,presets,inbox,providers}. Domain commands carry operationId for idempotency and expectedRevision for mutable revisioned records. Changes persisted with outbox, state.changed event causes snapshot refresh initially; gap/epoch change always resnapshot. High-rate output excluded from React state and control event log.

Output connection authenticates with same JSON framing first. Binary frames payload: u8 kind (1 output,2 credit,3 subscribe,4 gap), u32 header length, UTF8 JSON header, bytes. Header {sessionId,cursor?,credit?}. Cursor is absolute byte offset; bounded replay reports gaps explicitly. Hidden views cannot block PTY drain. Runtime stores batched output chunks; use credits per subscription. Define exact implementation additions in protocol before consumers diverge.

Canonical entities use camelCase JSON: Project {id,name,path,createdAt}; Session {id,projectId?,worktreePath?,title,provider,mode,status,createdAt,updatedAt,nativeId?,exitCode?,followed?}; provider is codex|claude|kimi|gemini|opencode|shell|grok|custom. mode terminal|chat; status starting|running|idle|waiting|exited|interrupted|error. IDs UUID, timestamps UTC ISO strings. Session id distinct from native session identity. Settings JSON revisioned in DB.

Initial methods (params -> result):
- runtime.health {} -> {version,epoch}; runtime.snapshot {} -> snapshot
- project.add {path,name?,operationId} -> Project; project.remove {id,operationId} -> null
- session.create {projectId?,cwd,title?,provider,mode,executable?,args?,nativeId?,operationId} -> Session
- session.stop {sessionId,operationId} -> null; session.update {sessionId,title?,followed?,operationId} -> Session
- terminal.input {sessionId,data,leaseEpoch} -> null; terminal.resize {sessionId,cols,rows,leaseEpoch} -> null
- session.claim {sessionId,clientId} -> {leaseEpoch}; session.release {sessionId,leaseEpoch} -> null
- settings.update {patch,expectedRevision,operationId} -> settings
- provider.list {} -> capabilities; history.list {provider,cursor?,limit?,cwd?} -> {items,nextCursor?}; history.read {provider,nativeId} -> transcript
- chat.send {sessionId,text,operationId,leaseEpoch} -> {turnId}; chat.cancel {sessionId,turnId,leaseEpoch} -> null; chat.approve {sessionId,turnId,approvalId,decision,leaseEpoch,operationId} -> null
- filesystem.list/read/write and git.status/diff/actions validate project scope and fingerprints; exact types added before UI integration.
- workspace/preset/inbox/data/MCP commands are typed contracts. Device administration and the separate, terminal-only HTTPS allowlist are specified in [REMOTE_ACCESS.md](REMOTE_ACCESS.md).

Facade window.threadterm: request(method,params):Promise<unknown> (method allowlist + validators in preload), onEvent(listener):unsubscribe, subscribeOutput(sessionId,cursor,onChunk):Promise<unsubscribe>, chooseDirectory():Promise<string|null>, windowAction(action), openWindow({sessionId?,workspaceId?}), platform:string. Protocol exports typed helper interfaces and RequestMap; UI must cast only validated boundary results through shared wrapper, no scattered any.

Provider native-first adapters: Codex app-server stdio JSONL; Claude official Agent SDK standalone Node worker with supported authentication; Kimi ACP; Gemini --acp; OpenCode authenticated localhost HTTP/SSE server. No ANSI-to-Chat imitation. Probe installed versions/capabilities/auth, missing setup explicit. Runtime owns worker lifespan and serializes turns. One native account/provider/session owner with fenced lease, many viewers. Pending approval bound to turn/id/epoch, accepted once. Persist intent, unknown provider outcomes never blindly retry.

SQLite WAL, current-state tables and transactional outbox, one writer. Files and Git authoritative; native history provider-owned. No V2 data reads. Data relocation needs quiesce + SQLite backup + atomic switch. Daemon shutdown terminates supervised jobs; UI exit alone does not. Windows helpers hidden, PTY only visible in app. Package npm workspaces under v3, Vite/esbuild/electron-builder with pinned dependencies, no Tauri dependencies.

## Clarifications from integration review
- Deliberate application Quit: if live jobs exist, confirm ending them. Confirmed Quit invokes runtime.shutdown {operationId}, waits for graceful child cleanup, then exits Electron. Cancel keeps running. Closing the main window goes to tray; renderer/main crashes detach without shutting runtime down.
- Mutual challenge/HMAC authentication supersedes raw-token auth in the initial bootstrap paragraph. Both connections prove credential knowledge; credential bytes never cross the pipe. Exact implementation handshake is documented alongside desktop/runtime transport after joint validation.
- Runtime uses Windows token SID (not USERNAME alone) for per-user identity, explicit private pipe and credential ACLs, and refuses remote pipe clients.
- Shared protocol/index.ts is authoritative for typed entities and scoped file/draft/Git/worktree/workspace methods. Relative paths resolve only inside registered roots; expectedFingerprint and expectedRevision reject conflicting writes.

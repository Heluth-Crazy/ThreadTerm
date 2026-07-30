# State Management

> How state is managed in this project.

---

## Overview

<!--
Document your project's state management conventions here.

Questions to answer:
- What state management solution do you use?
- How is local vs global state decided?
- How do you handle server state?
- What are the patterns for derived state?
-->

(To be filled by the team)

---

## State Categories

<!-- Local state, global state, server state, URL state -->

(To be filled by the team)

---

## When to Use Global State

<!-- Criteria for promoting state to global -->

(To be filled by the team)

---

## Server State

<!-- How server data is cached and synchronized -->

(To be filled by the team)

---

## Common Mistakes

### Persisting Timer-Dependent State

When a persisted Zustand store records metadata for an in-memory timer, persist
only serializable metadata and convert any active/pending timer state to an
interrupted state before writing storage.

Example: card auto restart keeps retry `setTimeout` handles in
`TerminalEventBridge`, not in `terminalStore`. Persisted card state may retain
retry history for user context, but a pending retry must be written as cancelled
because the timeout will not survive reload.

---

## Conventions

### Convention: Split a Feature's State by Persistence Concern

**What**: When a feature has both a user-visible toggle and runtime data
(alerts, counters, queues, ephemeral observations), put the toggle in the
existing persisted store and put the runtime data in a separate non-persist
store. Do not mix the two by carving the feature into one store and choosing
fields to omit from `partialize`.

**Why**: Persisted vs in-memory have different invariants. Migrations,
default-on-upgrade behavior, and storage-quota concerns belong only with the
toggle. Caps (FIFO limits), reset semantics, and "restart clears everything"
belong only with the runtime slice. Splitting by store keeps each invariant
local and prevents accidental persistence of high-volume runtime data.

**Example** (AI Supervisor):
- `terminalStore.supervisorEnabled` — boolean master switch, persisted,
  schema bumped `v8 -> v9` with the migration defaulting the new field to
  `false`.
- `supervisorStore` (separate slice) — alerts queue, telemetry counters,
  dedup window state. Non-persist; `create(...)` with no `persist` middleware.
  No React imports either; it is pure data + actions.

**Migration default rule**: when a persisted store gains a new field that
gates a behavior with side effects (network, OS notifications, regex on a
hot path), the migration must default it to OFF for upgraded users, even if
the new install default is ON. Surprising existing users with new background
work on first reload after an update is worse than asking them to opt in.

**Related**: persistence patterns in `directory-structure.md`; the supervisor
cross-layer contract in `supervisor.md`.

---

<spec-entry category="arch" keywords="terminal-output,data-flow,output-buffer,headless-preview,terminal-feed,throttle,coalesce" date="2026-06-13" source="src/components/terminal/outputBuffer.ts:1">

### Scenario: Terminal Output Has Five Representations — Know Which One You Are Touching

#### 1. Scope / Trigger

The same PTY byte stream is materialized **five times**, each for a different
consumer. Editing the wrong one to "fix a preview" or "speed up output" silently
breaks another. Read this before changing any terminal output / preview path.

#### 2. The five representations

1. **Rust PTY emulator buffer** (`src-tauri/src/pty/emulator.rs`) — the
   authoritative session state and scrollback. Source of `attachSnapshot`
   (history + screen) on (re)connect.
2. **Real xterm buffer** (desktop `Shell.jsx`, mobile `MainTerminal.tsx`) — what
   the user actually sees. Fed every chunk immediately; never throttled.
3. **Headless xterm buffer** (`headlessPreview.ts`) — an offscreen emulator per
   card used ONLY to extract a clean, wrap-aware card preview (full-screen TUIs
   can't be previewed by ANSI-stripping the raw stream). Fed every chunk.
4. **`lastOutput`** (`terminalStore`, ANSI-stripped tail ≤2KB) — fallback text
   for the notification snippet / missing-CLI detection. Not for display.
5. **`lastReplyPreview`** (`terminalStore`) — the clean card preview string
   produced from the headless buffer.

#### 3. Flow + throttle boundaries (audit P0-2 / P1-3)

`TerminalEventBridge.onOutput` fans each chunk to: (a) the real xterm
(immediate), (b) the headless emulator (immediate), and (c) the store via
`outputBuffer` — a **per-card coalescing buffer** (`OUTPUT_FLUSH_MS=100`) so
`updateCardOutput`/`updateCardReplyPreview` no longer rebuild the `cards` array
per chunk. `outputBuffer.flushCard(id)` MUST be called before status / exit /
attention handling so the notification snippet sees the freshest tail.
`throttledStorage` adds a second, independent 500ms trailing debounce with a
2,000ms `maxWait`. It implements Zustand's object `PersistStorage`, retaining
the latest immutable `StorageValue` and performing `JSON.stringify` only at
the flush boundary; wrapping an already-stringified `StateStorage` is not
sufficient. Hide/unload flush synchronously, and the storage key, version,
partialize/migrate behavior, and external JSON shape stay unchanged. Mobile
does NOT reuse the desktop store: `terminalFeed.ts` keeps a
per-card bucket (snapshot + bounded output ring) and notifies subscribed
`MainTerminal` instances directly — terminal transport never flows through React
state on mobile.

#### 4. Rule

Display fix → real xterm. Preview fix → headless emulator + `lastReplyPreview`.
Notification text → `lastOutput`. Throughput fix → `outputBuffer` cadence, never
by removing a representation. Never make the real xterm wait on a throttle.

</spec-entry>

<spec-entry category="contract" keywords="terminal-edit,pending-configuration,provider-session,pty-rotation,resume,workspace" date="2026-07-30" source="src/lib/terminalConfiguration.ts:1">

### Scenario: Existing Terminal Configuration Changes Are Validate-Then-Swap

#### 1. Scope / Trigger
- Trigger: Any change to editing a terminal card's type, startup command,
  Provider history binding, working directory, pending configuration, or PTY
  replacement.
- Applies to `terminalConfiguration.ts`, `terminalStore`,
  `EditTerminalDialog`, `useTerminalConfigurationEditor`,
  `TerminalView`, workspace-tab reset handling, and desktop fake-Tauri/E2E.

#### 2. Signatures

```typescript
type TerminalLaunchConfiguration =
  | { terminalType: TerminalType; launchMode: 'default' }
  | { terminalType: TerminalType; launchMode: 'custom'; command: string }
  | {
      terminalType: AgentSessionProvider;
      launchMode: 'resume';
      providerSessionId: string;
      workspaceMode: 'current' | 'session';
      sessionProjectPath?: string;
    };

terminalStore.pendingTerminalConfigurations:
  Record<string, TerminalLaunchConfiguration>;

terminalStore.commitTerminalConfiguration(
  cardId,
  { expectedPtyId, configuration },
): string | null;
```

Provider discovery and validation reuse the existing commands:

```typescript
providerSessions.listAgentSessions(request): Promise<AgentSessionPage>;
providerSessions.resolveResume(
  provider: 'claude' | 'codex',
  sessionId: string,
): Promise<ProviderSessionInfo | null>;
```

#### 3. Contracts
- Pending configuration is a separate persisted map keyed by card id. Do not
  add pending fields to `TerminalCard`; active cards, mobile projections,
  selector cards, and float terminals continue to describe only the applied
  configuration.
- The three launch modes are mutually exclusive after normalization. Default
  retains no command/session, custom retains only a trimmed command, and
  resume is restricted to Claude/Codex/OpenCode/Gemini with a backend-safe
  Provider session id.
- Save-only canonicalizes and checks duplicates, writes the pending map, and
  flushes persistence. It must not stop a PTY/Chat runtime or mutate active
  type, command, screen, status, or PTY identity.
- Apply validates before teardown. Claude/Codex ids resolve to their exact
  resumable session (Codex children to the interactive root) before the old
  PTY is touched. Missing/error resolution never falls back to a new session.
- A Provider/session pair may be bound by at most one active or archived card.
  Conflict UI navigates to the active original or restores the archived
  original; it does not create a second binding.
- A history path outside the card's project/effective worktree requires an
  explicit `current` versus `session` directory choice. `sessionProjectPath`
  affects equality only when `workspaceMode === 'session'`; under `current`
  it is informational catalog metadata and must not cause a no-op restart.
- Apply captures `expectedPtyId`, stops the old runtime, then commits only if
  the card still owns that PTY. Commit rotates the PTY id, clears live
  output/preview/attention and retry streak, acknowledges notifications, and
  preserves card identity, events, message count, Workbench follow, pinning,
  and auto-restart preference.
- Claude Terminal and Chat are reset together when entering/leaving Claude.
  Codex App/Chat binding remains only when both old and new terminal types are
  Codex; changing away clears provider-specific App fields.
- A mounted `Shell` handles the new `paneId` through its established detach /
  register / snapshot lifecycle. Do not add `key={paneId}` to force an xterm
  remount.
- The editor initialization effect depends only on configuration identity
  fields, not the whole `card` object. Output flushes replace card objects at
  high frequency and must not reset the user's in-progress form.
- Session catalog/query state is window-local and non-persisted. Paginated
  results merge by `provider + id`, and stale query/provider responses are
  discarded before they can replace current rows.

#### 4. Validation & Error Matrix
- Empty custom command -> validation error; no pending write or runtime stop.
- Resume on a non-Agent terminal type or unsafe/empty id -> validation error.
- Claude/Codex resolver returns null/errors -> keep active and pending state;
  do not prompt restart or kill the old PTY.
- Duplicate active/archived binding -> block save/apply and expose the original.
- Cross-project history without a directory choice -> request the choice and
  leave state untouched.
- Restart or dirty-draft confirmation declined -> keep the current runtime and
  configuration.
- PTY state/kill or Claude Chat stop returns a real error -> report it; never
  silently continue as a new session. A missing already-exited runtime is safe
  to replace.
- Card missing or PTY identity changed before compare-and-set -> commit returns
  `null`; do not overwrite the replacement card.
- Persisted pending entry is malformed or references no active/archived card ->
  drop it during migration/partialization.

#### 5. Good/Base/Bad Cases
- Good: save Shell -> custom Codex, keep using the Shell, then apply later;
  exactly one old PTY kill and one new PTY launch occur.
- Good: select a Codex child history, resolve its root, rotate the PTY, and send
  `codex resume <root> --no-alt-screen`.
- Good: a running terminal emits continuously while its editor is open; typed
  command, search, scope, and selection remain unchanged.
- Base: editing a configuration back to the active equivalent discards a
  redundant pending entry without restarting.
- Bad: writing the draft directly into `TerminalCard`, killing before Provider
  validation, treating two seconds of silence as session existence, or
  silently launching a fresh Agent session after resume validation fails.

#### 6. Tests Required
- Pure tests: normalization, safe ids, active configuration derivation,
  equality, persisted parsing, and active/archived duplicate detection.
- Store tests: save-only immutability, expected-PTY compare-and-set, PTY
  rotation/reset/preservation, workspace metadata, Codex field cleanup,
  archive/restore/remove behavior, v19 migration, and persistence round-trip.
- Component/hook tests: pending indicator/edit/discard, project/all catalog
  filtering and pagination, cross-project choice, dirty draft confirmation,
  high-frequency card refresh form stability, resolver failure, and exactly
  one runtime replacement.
- Desktop E2E: save-only survives storage, apply launches once, canonical
  Codex resume is sent, and missing history leaves the old terminal alive.
- Required gates: locale parity, targeted ESLint, `npm run check`, full desktop
  E2E, Rust tests/Clippy, `git diff --check`, and GitNexus change detection.

#### 7. Wrong vs Correct

Wrong:

```typescript
updateCard(cardId, draft);
await pty.kill(card.ptyId);
await pty.create(card.ptyId, draft.projectPath);
```

Correct:

```typescript
const configuration = await validateAndResolve(draft);
await pty.kill(expectedPtyId);
const nextPtyId = commitTerminalConfiguration(cardId, {
  expectedPtyId,
  configuration,
});
```

</spec-entry>

<spec-entry category="arch" keywords="pty,flow-control,ack,sequence,multi-webview,snapshot" date="2026-07-11" source="src-tauri/src/pty/session.rs:68">

### Scenario: PTY Output Credits Are Owned by Explicit Consumers

#### 1. Scope / Trigger
- Trigger: Any change to PTY output emission, desktop `pty-output` listeners,
  xterm attach/snapshot behavior, mounted-terminal LRU policy, or main/float
  window mirroring.
- Applies to `src-tauri/src/pty/{session,events,mod}.rs`,
  `src/lib/tauri-bridge.ts`, `TerminalEventBridge.tsx`, `Shell.jsx`, and desktop
  Tauri fakes/E2E.

#### 2. Signatures
- Output event: `{ id: string, data: string, seq: u64 }`; `seq` is monotonic
  for the process, not reset per PTY id.
- Renderer lifecycle commands:
  `pty_register_output_consumer(id, consumer_id)` and
  `pty_unregister_output_consumer(id, consumer_id)`.
  Desktop ids are scoped as `renderer:main:<instance>` or
  `renderer:float:<instance>` so native float teardown can detach only float
  leases without touching main-window flow control.
- ACK command:
  `pty_ack(id, through_seq, consumer_kind, consumer_id?)`; consumer kind is
  `background` or `renderer`, and a renderer ACK requires its registered id.
- Catch-up command: `pty_attach_snapshot(pty_id) -> Option<PtyAttachSnapshot>`.

#### 3. Contracts
- Rust commits sequence assignment, emulator advancement, replay-buffer write,
  and output credit under one `output_commit` lock. Attach snapshots take the
  same lock, so snapshot content and `snapshot.seq` are one atomic barrier.
- Rust owns one byte credit per emitted sequence. `emit_to(...).is_ok()` means
  only that dispatch was accepted; it must never be treated as proof that a JS
  listener processed the payload.
- ACKs are cumulative and idempotent, but settlement is consumer-aware. While
  renderers are registered, only the minimum acknowledged sequence across all
  renderer ids may settle credits. Background ACKs are retained for fallback
  and settle credits only when no renderer is registered.
- Sequence numbers are process-global so a delayed ACK from an old session
  cannot release credits after the same PTY id is recreated.
- `TerminalEventBridge` ACKs as `background` only after the durable store tail
  and headless xterm have processed an accepted chunk. A missing card may ACK
  immediately because there is no background representation to update.
- Every visible `Shell` registers a unique consumer id before subscribing and
  attaching. It ACKs as `renderer` only after xterm's write callback, and it
  unregisters/disposes retries on detach, pane switch, or unmount. A periodic
  heartbeat refreshes the backend renderer lease; stale leases expire so a
  crashed WebView or failed unregister cannot pin the minimum watermark.
- A hidden but still-registered Shell must continue `term.write` and ACK only
  after its drain callback. It may skip DOM viewport reads, focus, scroll,
  refresh, and React display indicators. Stopping writes requires the full
  unregister -> dispose -> atomic attach -> drain -> ACK resume protocol.
- Windows float idle close first suspends registration for the
  `renderer:float:` scope, removes that scope from all live PTYs, then closes
  the WebView under the same visibility transition epoch. Show invalidates old
  hide timers, resumes registration, and a still-mounted Shell immediately
  re-registers its original id; registration is idempotent and never ACKs.
- Attach snapshots do not auto-ACK in Rust. The renderer ACKs `snapshot.seq`
  only after the complete snapshot has drained into xterm; live writes remain
  queued behind large chunked snapshot restoration. Attach IPC failure tears
  down the renderer lease and enters reconnect; it must not heartbeat at ACK 0.
- Frontend ACK transport coalesces newer cumulative sequences and retries an
  IPC failure on a timer even if no later output event arrives.
- With no background or renderer consumer, credits intentionally reach the
  high watermark and bound the stream. A later renderer registration plus
  atomic attach snapshot can catch up and release the backlog.
- On `TerminalEventBridge` mount/HMR, install the listener first, queue live
  events, attach atomic snapshots for all live sessions, process/ACK each
  background barrier, then flush only queued events newer than that barrier.
  This must recover a session already stopped at the high watermark.
- Background state/snapshot reconciliation retries with bounded backoff until
  it succeeds or the effect is disposed. Effect replay clears stale local
  watermarks, and callbacks from a cancelled generation cannot mutate the new
  generation's seen/processed state.
- Frontend runtime-owned maps use a per-PTY generation. Card remove/archive,
  natural exit, bridge unmount, and PTY replacement dispose headless preview,
  output buffer, ACK retry, seen/processed seq, timers, and queued output
  exactly once. A late headless callback or in-flight ACK completion must
  compare its captured identity/generation before touching the replacement.
- Once the high watermark is reached, flow control waits until the low
  watermark and is woken by ACK or kill; do not spin-decrement a shared byte
  counter per consumer.

#### 4. Validation & Error Matrix
- Main ACKs `N`, float ACKs `N-1` -> settle only through `N-1`.
- Float unregisters -> the remaining main watermark may settle through `N`.
- Background ACKs `N` while a renderer is registered at `N-1` -> settle only
  through `N-1`; background can take over after the renderer unregisters.
- ACK `N`, then emit `N+1` -> `N+1` stays pending.
- Shell unmounted by the six-view LRU -> unregister renderer; background
  consumer may continue processing and ACKing.
- WebView crashes before unregister -> renderer heartbeat expires within the
  backend TTL and retained background watermark resumes flow.
- Card deleted before tail output arrives -> background ACK occurs without
  store/headless work.
- One ACK IPC call rejects and no new event arrives -> timer retry still sends
  the latest cumulative sequence.
- WebView misses events then attaches -> snapshot content/seq are consistent;
  renderer ACK follows complete xterm restoration.
- Renderer attach IPC rejects -> stop heartbeat, unregister/expire the lease,
  report connection failure, and retry; never mark connected with ACK 0.
- Background bridge reloads while output reaches high watermark -> mount-time
  snapshot reconciliation ACKs the backlog before waiting for a future event.
- First background attach attempt rejects -> retain listener queue and retry;
  a later successful snapshot replays/ACKs the barrier exactly once.
- PTY id reused -> delayed old-session ACK cannot affect the new global seq.
- PTY killed while flow-controlled -> kill notification wakes the waiter.
- Float hidden for 30s, shown, then hidden for 20s -> the first hide timer is
  stale and cannot close the second hide generation.
- Native float close fails, then float is shown -> original float consumer is
  registered immediately; no attach or ACK is emitted by re-registration.
- Card PTY id changes while old headless write drains -> old preview/ACK state
  is discarded and cannot mutate the new runtime generation.

#### 5. Good/Base/Bad Cases
- Good: main and float render the same 1 MiB stream; Rust waits for the slower
  renderer and reaches the final marker without double-settling credits.
- Base: one mounted Shell renders and ACKs normally; background processing is
  retained but cannot bypass visible renderer backpressure.
- Good: a background LRU card emits more than 200 KB, continues flowing, and
  restores from a snapshot when focused again.
- Good: hidden float keeps parser state current while suppressing display-only
  effects; after the 60s native close only float-scoped leases are removed.
- Bad: `pty_ack(id, byteLength)` subtracts bytes once per WebView, or ACK lives
  only inside mounted `Shell`.
- Bad: use `active === false` to skip `term.write` while leaving the renderer
  registered, or direct-ACK hidden chunks that were never parsed.

#### 6. Tests Required
- Rust ledger unit tests: cumulative ACK, old ACK vs future output, monotonic
  global seq, background-vs-renderer gating, slowest renderer, unregister, and
  stale renderer id/lease expiry without losing the last ACK watermark.
- `TerminalEventBridge` tests: ACK after headless processing, missing-card ACK,
  stale/duplicate coalescing, retry after rejected IPC, remove/archive/exit
  resource cleanup, and stale callback rejection after PTY replacement.
- `Shell` tests: register/unregister lifecycle, xterm-drain ACK, snapshot ACK,
  generation-scoped stale setup cleanup, heartbeat, pane-switch cancellation,
  hidden write+drain ACK, float-scoped id, and active re-registration without
  attach/ACK.
- `outputAcknowledger` tests: in-flight coalescing, independent timed retry,
  and retry cancellation on dispose.
- `outputSequencer` tests: atomic snapshot gate, empty snapshot ACK, stale live
  suppression, and no live write before a large snapshot writer drains.
- Desktop browser/fake-Tauri E2E must accept `{ id, throughSeq }` and stream
  more than 200 KB after LRU eviction. The release gate should additionally
  cover real-Tauri LRU and main+float sustained-output cases.
- Run full Vitest, Cargo tests, Clippy, desktop E2E, production build, and
  `git diff --check` for protocol changes.

#### 7. Wrong vs Correct

Wrong:
```typescript
pty.ack(ptyId, new TextEncoder().encode(data).length);
```

Correct:
```typescript
rendererAcks.ack({
  id: ptyId,
  throughSeq: seq,
  consumerKind: 'renderer',
  consumerId,
});
```

Wrong:
```typescript
void pty.ack(id, seq, 'background').catch(() => {});
feedHeadless(id, data, updatePreview);
```

Correct:
```typescript
const card = getCardForPtyId(id);
if (!card) {
  backgroundAcks.ack({ id, throughSeq: seq, consumerKind: 'background' });
  return;
}
feedHeadless(id, data, (preview) => {
  updatePreview(preview);
  backgroundAcks.ack({ id, throughSeq: seq, consumerKind: 'background' });
});
```

</spec-entry>

<spec-entry category="arch" keywords="terminal-card-archive,archivedCards,active-cards,provider-session,project-card-order" date="2026-06-16" source="src/stores/terminalStore.ts:185">

### Scenario: Terminal Card Archive Uses a Separate Inactive Collection

#### 1. Scope / Trigger
- Trigger: Any change to terminal card archive/restore behavior, provider-session import deduplication, project card ordering, or card list consumers.
- Applies to `terminalStore.cards`, `terminalStore.archivedCards`, `archiveCard`, `restoreArchivedCard`, `importProviderSessionCards`, desktop `CardGrid`, and top-level archive UI.

#### 2. Signatures
- `ArchivedTerminalCard extends TerminalCard { archivedAt: number }`
- `terminalStore.archivedCards: ArchivedTerminalCard[]`
- `terminalStore.archiveCard(id: string): void`
- `terminalStore.restoreArchivedCard(id: string): void`
- `terminalStore.getArchivedCardsForProject(path: string): ArchivedTerminalCard[]`

#### 3. Contracts
- Active cards live only in `terminalStore.cards`; archived cards live only in `terminalStore.archivedCards`.
- Do not implement archive by adding `archived: true` to active cards. Active list consumers such as project groups, command palette, search, mobile bridge sync, selector windows, and mounted terminal views must keep reading `cards` without project-wide archive filters.
- Archiving a card stops its live PTY when running in Tauri, removes focus/pin/notification state, removes the id from `projectCardOrder`, and keeps blocks, bookmarks, provider session id, events, and preview metadata.
- Restoring a card moves it back to `cards`, prepends it to that project's manual order, keeps it unfocused, and leaves PTY launch until the user opens the card.
- Provider-session import must dedupe against both active and archived cards so a Claude/Codex history scan does not recreate an archived session as a new active card.
- `projectPath` keys remain raw strings. Do not normalize separators or case-fold Windows/macOS paths.

#### 4. Validation & Error Matrix
- Unknown archive/restore id -> no state change.
- Archive active focused card -> focus and last-active refs clear; selected project remains so the user can restore from that project.
- Archive pinned card -> pinned id removed.
- Archive card with notifications -> notifications for that card removed and unread cleared in the archive snapshot.
- Restore archived card -> archived list loses id, active list gains id, project order starts with restored id.
- Import provider session matching archived card -> import count remains 0.

#### 5. Good/Base/Bad Cases
- Good: archive moves a card from `cards` to `archivedCards`, then restore prepends it to `projectCardOrder[projectPath]`.
- Base: projects with no archived cards render no archive toolbar button.
- Bad: leaving archived cards in `cards` and teaching every consumer to filter them out.

#### 6. Tests Required
- Store tests for archive, restore, provider-session dedupe against archived cards, migration default, and preservation of blocks/bookmarks/provider session metadata.
- UI tests for grid archive action, project archive toolbar panel, restore action, and i18n key parity across terminal locales.
- Full gates: `npm exec vitest run`, `npm run typecheck`, `npm run build`, and `npm run build:mobile`.

#### 7. Wrong vs Correct

Wrong:
```typescript
const visibleCards = state.cards.filter((card) => !card.archived);
```

Correct:
```typescript
const visibleCards = state.cards;
const archivedCards = state.archivedCards;
```

</spec-entry>

<spec-entry category="arch" keywords="ptyLive,card-mirror,bridge-snapshot,front-back-contract,session-state,mobile-bridge" date="2026-06-13" source="src/components/terminal/TerminalManager.tsx:105">

### Scenario: `ptyLive` Is a Front-Emits-Placeholder / Back-Overwrites Contract

#### 1. Scope / Trigger

Editing `cardToMobileMeta`, the Rust bridge card mirror, or any
`pty_get_session_state(s)` path. The truth of "is this PTY alive" lives on the
Rust side, but the card shape is authored on the front end — the contract only
exists as a convention across two files.

#### 2. Contract

- The front end emits `cardToMobileMeta` with `ptyLive: false` as a **deliberate
  placeholder** (`TerminalManager.tsx`). It is NOT a claim that the PTY is dead.
- The Rust bridge overwrites `ptyLive` from its live registry
  (`list_live_sessions`) when serving `/snapshot` and card-mirror updates
  (`src-tauri/src/bridge/mod.rs`). The map returned by
  `pty_get_all_session_states` (audit P2-5) is the batch form: an id absent from
  the map means the PTY is no longer registered.

#### 3. Rule

Changing the placeholder default on the front end, or the overwrite/liveness
derivation on the Rust side, requires updating the other side in the same
change. Mobile UI must treat `ptyLive` as authoritative only after the bridge
snapshot/mirror has applied — never trust the raw front-end placeholder.

</spec-entry>

<spec-entry category="contract" keywords="agent-session-catalog,provider-session,non-persist,recovery-panel,selection,timestamp" date="2026-07-14" source="src/stores/agentSessionCatalogStore.ts:1">

### Scenario: Provider Session Catalog Is Non-Persisted And Explicitly Materialized

#### 1. Scope / Trigger
- Trigger: browsing or restoring local Claude/Codex/OpenCode/Gemini history.
- Applies to `agentSessionCatalogStore`, `SessionRecoveryPanel`,
  `provider_list_agent_sessions`, and `importProviderSessionCards`.

#### 2. Signatures
- Tauri command:
  `provider_list_agent_sessions(request: ListAgentSessionsRequest) -> AgentSessionPage`.
- Request fields: `provider`, optional `cursor`, optional `limit`, optional
  `query`.
- Page fields: `provider`, `availability`, `items`, optional `nextCursor`,
  `scannedAt`, and optional `warning`.
- Store selection state:
  `selectedKeys: Set<string>` plus
  `selectedSummaries: Map<string, AgentSessionSummary>`.

#### 3. Contracts
- Catalog pages/selection live only in a non-persisted store for the window lifetime.
- Startup must not call Provider history list APIs or auto-import cards.
- Browsing/search/select must not write `terminalStore.cards`; only Restore
  selected materializes `idle + bound` cards.
- Dedupe uses `provider + NUL + sessionId` across active and archived cards.
- Provider `createdAt`, `updatedAt`, and page `scannedAt` are Unix epoch
  **milliseconds**. Backend adapters normalize epoch seconds, epoch
  milliseconds, numeric strings, and supported ISO-8601 strings before IPC.
- `setQuery` replaces Provider result pages but preserves both selected keys and
  the corresponding selected summary snapshots. A key without its summary is
  insufficient because the selected row may no longer exist in current items.
- `toggleSelected` may add a key only when the full summary exists in the
  Provider's current page. Deselect, `clearSelection`, and `reset` remove the
  key and summary together.
- `getSelectedSummaries()` reads the selection map, not the currently visible
  Provider rows. Restore may therefore include selections across Provider tabs
  and query changes, then clears selection after import.
- OpenCode usage SQLite ingestion remains independent from Session Catalog.

#### 4. Validation & Error Matrix
- App startup or `TerminalManager` mount -> zero catalog list calls and zero
  legacy recent-session list calls.
- Open recovery panel -> load only the active Provider tab.
- Query changes while a request is in flight -> stale generation result is
  discarded; selection remains intact.
- Selected row disappears from filtered results -> restore still receives its
  stored summary.
- Toggle an id absent from current Provider items -> no selection state change.
- Provider timestamp is seconds or ISO text -> IPC summary exposes milliseconds.
- Active or archived card already has `provider + sessionId` -> import skips it.

#### 5. Good/Base/Bad Cases
- Good: select a Claude row, search for another row, select it, switch to Codex,
  and restore all selections into idle bound cards with no PTY spawn.
- Base: open the panel with no Provider history; the terminal card store remains
  unchanged.
- Bad: derive selected summaries by filtering only current query rows, or
  persist catalog previews in local storage.

#### 6. Tests Required
- Store test: selection survives query-driven page replacement and returns the
  original summary snapshot.
- Store tests: deselect, clear, and reset keep `selectedKeys` and
  `selectedSummaries` synchronized.
- Rust adapter tests: seconds, milliseconds, numeric-string, and ISO timestamps
  normalize to milliseconds.
- Desktop E2E: cold startup makes zero history calls; opening/switching tabs is
  lazy; cross-tab multi-select restore creates cards and zero PTYs.
- Full gates: Vitest, Cargo tests, Clippy, typecheck, desktop build, desktop E2E,
  locale-key parity, and `git diff --check`.

#### 7. Wrong vs Correct

Wrong:

```typescript
getSelectedSummaries: () =>
  allVisibleRows().filter((row) => selectedKeys.has(selectionKey(row)))
```

Correct:

```typescript
toggleSelected: (summary) => {
  selectedKeys.add(selectionKey(summary));
  selectedSummaries.set(selectionKey(summary), summary);
};

getSelectedSummaries: () => Array.from(selectedSummaries.values());
```

Do not reintroduce mount-time `listRecent -> importProviderSessionCards`
alongside the recovery panel.

</spec-entry>

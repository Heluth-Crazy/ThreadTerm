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
`throttledStorage` adds a second, independent 500ms debounce on the persist
write. Mobile does NOT reuse the desktop store: `terminalFeed.ts` keeps a
per-card bucket (snapshot + bounded output ring) and notifies subscribed
`MainTerminal` instances directly — terminal transport never flows through React
state on mobile.

#### 4. Rule

Display fix → real xterm. Preview fix → headless emulator + `lastReplyPreview`.
Notification text → `lastOutput`. Throughput fix → `outputBuffer` cadence, never
by removing a representation. Never make the real xterm wait on a throttle.

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

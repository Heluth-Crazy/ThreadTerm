# AI Supervisor

> Contracts for the AI Supervisor v0.1 attention notifier (rules-based, pinned-card scope).

---

## Scenario: Rules-Based Block Output Supervisor

### 1. Scope / Trigger

- Trigger: Any frontend or backend feature that fires, listens to, or
  configures supervisor alerts.
- Applies to `src-tauri/src/supervisor.rs`, `src/lib/supervisor/**`,
  `src/components/settings/SupervisorSettings.tsx`, the supervisor master
  switch in `terminalStore`, and the Tauri bridge wrappers in
  `src/lib/tauri-bridge.ts`.
- This is a cross-layer feature: the Rust singleton is the authoritative
  regex matcher and event source; the renderer is a passive consumer that
  presents alerts and tracks click/action telemetry.

### 2. Signatures

- Tauri command:
  `supervisor_enable(enabled: boolean, watchedCardIds: string[]): Promise<void>`
- Tauri event:
  `supervisor://alert` with payload
  `{ cardId: string; ruleId: SupervisorRuleId; sampleText: string; ts: number }`
  (camelCase, ts is Unix epoch ms).
- Rust enum: `RuleId` with `as_str()` returning the stable wire string.
- Frontend type: `SupervisorRuleId` union of the same 8 strings.
- Hook: `useSupervisor(): void` — mount once near `NotificationBridge`.
- Store actions:
  - `ingestAlert(payload): SupervisorAlert | null` (returns null on dedup hit)
  - `attachNotification(alertId, notificationId)`
  - `recordClickByCardId(cardId): boolean`
  - `recordAction(cardId)`
  - `resetTelemetry()` / `clearAlerts()`

### 3. Contracts

- **Rule-id byte equality**: the 8 strings produced by Rust `RuleId::as_str()`
  must be byte-equal to the TS `SupervisorRuleId` union. Rule ids appear in
  three places — the alert payload, i18n key suffixes
  (`supervisor.alertTitle.<id>` / `supervisor.alertBody.<id>`), and the
  per-(card, rule) cooldown key. Any divergence means a coordinated
  frontend + backend release with all four locale files updated together.
- **Master switch coupling**: the persisted `terminalStore.supervisorEnabled`
  flag drives `supervisor_enable(true | false, pinnedCardIds)`. When the
  switch flips OFF the backend tears down its `pty://block-finished`
  subscription so disabled users pay zero CPU cost.
- **Watch-set scope**: `watchedCardIds` is exactly `terminalStore.pinnedCardIds`.
  Pinning or unpinning a card must re-emit `supervisor_enable` so the backend
  watcher set stays in sync. Cards outside the pinned set are ignored even if
  block-finished fires for them.
- **Default-OFF migration**: persisted store schema bumped to `v9`; the
  migration must default `supervisorEnabled` to `false` for users upgrading
  from `v8`. New installs follow the same default.
- **Frontend never re-matches regex**: `src/lib/supervisor/rules.ts` carries
  metadata only (id + i18n keys). All matching happens in Rust (PRD D12).
  Adding a new rule means: extend the Rust `RuleId` enum + matcher, append to
  the TS union and `SUPERVISOR_RULE_IDS` tuple, and add 8 i18n entries
  (4 locales × title + body).
- **Dedup window (60s, both layers)**: backend has `COOLDOWN = 60s` per
  `(cardId, ruleId)`; frontend `supervisorStore.ingestAlert` enforces an
  identical 60s window via `SUPERVISOR_DEDUP_WINDOW_MS` so a backend bug or
  rapid restart can't double-emit. Belt-and-braces is intentional.
- **Alerts cap**: `SUPERVISOR_ALERTS_MAX = 50` FIFO cap; oldest entries drop
  when exceeded. Long-running sessions must not leak unbounded.
- **Click → Action window**: the first `pty.write` to a card that received a
  clicked alert within the last `SUPERVISOR_ACTION_WINDOW_MS = 60s` increments
  `telemetry.acted` and marks that alert as acted (`acted=true`,
  `actedAt=now`). Outside the window the write is ignored. A clicked alert can
  credit `acted` at most once, even if the user types multiple times in the
  60s window; otherwise `acted/clicked` ratios become inflated and stop
  representing "returned and acted".
- **Click telemetry single funnel**: `recordClickByCardId(cardId)` lives in
  one funnel — `src/components/terminal/notificationTarget.ts` — which is
  called from both the Notification Centre item click and the OS notification
  `onAction` handler. Do not call `recordClick` from individual UI sites; the
  funnel is the contract.
- **In-memory only (D7)**: `supervisorStore` is a non-persist Zustand slice.
  Restart clears alerts and counters. SQLite persistence is a v0.2 concern.
  The store has no React imports.
- **Settings tab**: a single new `'supervisor'` tab is appended to the
  `Settings` `TABS` array (between `'shortcuts'` and `'data'`). The panel is
  presentational — props in, store actions out — and renders three counters
  (triggered / clicked / acted) plus a Reset button.

### 4. Validation & Error Matrix

- `supervisorEnabled === false` -> `supervisor_enable(false, [])`; backend
  drops the listener and clears its watcher map.
- `pinnedCardIds` change while enabled -> re-emit `supervisor_enable(true, ids)`;
  backend reconciles the watcher set without re-subscribing.
- Backend emits an unknown `ruleId` -> frontend `isSupervisorRuleId` guard
  rejects, hook logs and drops the event (no crash, no notification).
- Same `(cardId, ruleId)` fires twice within 60s -> `ingestAlert` returns
  `null`, no notification pushed, no telemetry increment.
- Alert click via Notification Centre or OS path -> `openNotificationTarget`
  invokes `recordClickByCardId`; the newest unclicked alert for that card is
  credited; second click on the same alert is a no-op (`alert.clicked` already
  true).
- First `pty.write` within 60s after a credited alert click -> newest eligible
  clicked/unacted alert for that card gets `acted=true`; second write for the
  same alert is a no-op for telemetry.
- Persisted store version `< 9` on load -> migration runs and sets
  `supervisorEnabled = false` regardless of any pre-existing field.
- App restart -> alerts and telemetry counters reset to zero by design.

### 5. Good/Base/Bad Cases

- Good: a pinned shell card emits `pty://block-finished` whose tail matches
  `[Y/n]`; backend fires `supervisor://alert` with `ruleId: 'yes-no-bracket'`;
  the renderer pushes a Notification Centre entry and an OS toast; the user
  clicks, focuses the card, types `y`, and all three counters increment in
  order (triggered → clicked → acted).
- Base: master switch is OFF; pinning or unpinning cards has no effect on
  CPU; no events fire; counters stay at zero.
- Bad: emitting alerts for a non-pinned card; calling `recordClick` from a
  callsite other than the notification funnel; persisting alerts or
  telemetry counters across restart; adding a rule id that's not byte-equal
  between Rust and TS.

### 6. Tests Required

- Pure rule registry tests confirming the 8 ids and i18n key naming.
- Store tests for `ingestAlert` dedup, alerts cap, `recordClickByCardId`
  newest-first credit + no-double-credit, `recordAction` 60s window +
  no-double-credit per clicked alert, `resetTelemetry`.
- Hook tests proving idempotent listener mount, re-emit of
  `supervisor_enable` when pinned set changes, teardown on unmount.
- `notificationTarget` integration tests showing supervisor click credit
  flows through the Notification Centre and OS notification paths.
- `terminalStore` migration tests for `v8 -> v9` defaulting
  `supervisorEnabled` to `false` regardless of prior state.
- Rust unit tests for each rule's positive matches, the powerlevel10k
  arrow-select negative case, dedup cooldown, and watcher reconciliation
  through `supervisor_enable`.
- i18n parity check (programmatic JSON key diff across en / zh-CN / ja / ko)
  for `supervisor.json` so all 64 alert keys plus UI keys stay in lockstep.
- Full gates: `npm run typecheck`, `npx vitest run`, `npm run build`,
  `cargo check`, `cargo test`.

### 7. Wrong vs Correct

Wrong:
```typescript
// Notification Centre item handler
function handleNotificationClick(entry: NotificationEntry) {
  useSupervisorStore.getState().recordClick(entry.alertId);
  focusCard(entry.cardId);
}
```

Correct:
```typescript
// notificationTarget.ts — the single funnel
export function openNotificationTarget(cardId: string): void {
  useSupervisorStore.getState().recordClickByCardId(cardId);
  focusCard(cardId);
}

// Notification Centre item handler
function handleNotificationClick(entry: NotificationEntry) {
  openNotificationTarget(entry.cardId);
}
```

The correct version routes both Notification Centre clicks and OS
notification `onAction` clicks through one telemetry-bearing funnel.
Instrumenting individual callsites silently drops counters whenever a new
caller forgets the wire-up — the bug that `recordClickByCardId` was
introduced to prevent.

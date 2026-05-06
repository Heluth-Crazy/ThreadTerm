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

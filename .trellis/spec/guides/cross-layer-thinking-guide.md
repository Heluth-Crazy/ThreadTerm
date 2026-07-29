# Cross-Layer Thinking Guide

> **Purpose**: Think through data flow across layers before implementing.

---

## The Problem

**Most bugs happen at layer boundaries**, not within layers.

Common cross-layer bugs:
- API returns format A, frontend expects format B
- Database stores X, service transforms to Y, but loses data
- Multiple layers implement the same logic differently

---

## Before Implementing Cross-Layer Features

### Step 1: Map the Data Flow

Draw out how data moves:

```
Source → Transform → Store → Retrieve → Transform → Display
```

For each arrow, ask:
- What format is the data in?
- What could go wrong?
- Who is responsible for validation?

### Step 2: Identify Boundaries

| Boundary | Common Issues |
|----------|---------------|
| API ↔ Service | Type mismatches, missing fields |
| Service ↔ Database | Format conversions, null handling |
| Backend ↔ Frontend | Serialization, date formats |
| Component ↔ Component | Props shape changes |

### Step 3: Define Contracts

For each boundary:
- What is the exact input format?
- What is the exact output format?
- What errors can occur?

---

## Common Cross-Layer Mistakes

### Mistake 1: Implicit Format Assumptions

**Bad**: Assuming date format without checking

**Good**: Explicit format conversion at boundaries

### Mistake 2: Scattered Validation

**Bad**: Validating the same thing in multiple layers

**Good**: Validate once at the entry point

### Mistake 3: Leaky Abstractions

**Bad**: Component knows about database schema

**Good**: Each layer only knows its neighbors

---

## Checklist for Cross-Layer Features

Before implementation:
- [ ] Mapped the complete data flow
- [ ] Identified all layer boundaries
- [ ] Defined format at each boundary
- [ ] Decided where validation happens

After implementation:
- [ ] Tested with edge cases (null, empty, invalid)
- [ ] Verified error handling at each boundary
- [ ] Checked data survives round-trip

---

## When to Create Flow Documentation

Create detailed flow docs when:
- Feature spans 3+ layers
- Multiple teams are involved
- Data format is complex
- Feature has caused bugs before

---

## Gotcha: Byte-Equal Wire Strings Across Rust ↔ TS

**Problem**: When a feature uses the same string literal on both sides of the
Tauri boundary — rule ids, event channel names, payload field names that double
as i18n key suffixes — the strings are a load-bearing contract. A typo or
silent rename on one side breaks the runtime wire without any compiler help.

**Symptom**: Backend emits, frontend ignores; or i18n keys resolve to
`supervisor.alertTitle.<id>` on one side and a missing translation fallback
on the other. Hard to spot in code review because the two sides live in
different files.

**Prevention checklist**:
- [ ] Define the canonical strings in one place and reference them from both
      sides (Rust enum `as_str()` + TS string-literal union of the same set).
- [ ] Add a test that lists every Rust enum variant and asserts it appears in
      the TS union exhaustively.
- [ ] When renaming, treat it as a coordinated frontend + backend release;
      don't change one side and "fix the other later".
- [ ] Include the strings in the i18n parity check below if they are key
      suffixes.

Example: the AI Supervisor's 8 rule ids appear in `RuleId::as_str()`
(`src-tauri/src/supervisor.rs`), the TS `SupervisorRuleId` union
(`src/lib/supervisor/rules.ts`), the `supervisor.alertTitle.<id>` /
`supervisor.alertBody.<id>` keys (`src/i18n/locales/*/supervisor.json`),
and per-(card, rule) cooldown keys.

---

## Gotcha: Per-Locale i18n Key Drift

**Problem**: When a feature ships strings across multiple locale files
(`en` / `zh-CN` / `ja` / `ko` here), the four files start identical and
silently diverge over time. A new key added to `en` and forgotten in `ja`
shows up at runtime as the raw key name, or worse, an English fallback in a
non-English UI.

**Prevention checklist**:
- [ ] Treat the locale set as a frozen contract: all four files must have the
      same key tree.
- [ ] When adding a new key, edit every locale file in the same commit. Do not
      land an `en`-only PR with "translate later" TODOs.
- [ ] After editing, run a programmatic key-set diff (e.g. a small Python
      `json.load` + recursive `set` comparison) across the locales for the
      affected namespace, not just eyeballing the diff.
- [ ] When a feature has many keys (the AI Supervisor has 64 alert keys —
      8 rules × title+body × 4 locales — plus UI keys), automate the parity
      check in the test suite if practical.

**Don't duplicate keys across namespaces**: when a feature has its own
namespace file (`supervisor.json`), do not also stash copies of the same keys
under `settings.json` "for fallback". Dead duplicate keys rot — they get
edited in one place and not the other, then someone wires up the wrong one.

---

## Gotcha: Identity Repair Must Not Become Data Replacement

**Problem**: A persisted external id can point to a non-interactive child,
alias, or stale record. Treating validation failure as permission to clear the
id and create a new entity destroys the user's intent while making the UI look
successful.

**Prevention checklist**:
- [ ] Decide whether the id is invalid, or whether it can be canonicalized to
      an ancestor/root id.
- [ ] Return the canonical identity across the backend/frontend boundary; do
      not reduce resolution to a boolean when the caller needs the replacement
      id.
- [ ] On missing/error results, preserve the original identity, block the
      destructive fallback, surface the state, and offer retry.
- [ ] Test the full restore-to-open path, including the exact command or API
      invoked—not only parser and command-builder units.
- [ ] If two UI modes own different persistence domains, make restored state
      select the mode that owns that history.

Concrete Codex rules and test points live in
[`../backend/provider-session-resume.md`](../backend/provider-session-resume.md).

---

## Gotcha: Alternative Evidence Must Stay Alternative

**Problem**: A producer can represent the same semantic transition through
different fields. For example, terminal completion is either a physical
`completed` card state or an unread `completed` notification after the common
`running -> idle` reply transition. A consumer that accidentally requires both
signals drops valid items between layers.

**Prevention checklist**:
- [ ] Write multi-source contracts explicitly as AND/OR truth tables before
      implementing the projection.
- [ ] Trace at least one real transition for every producer shape, including
      the final status after transient states settle.
- [ ] Add a composed regression that feeds producer output into the consumer;
      isolated producer and consumer unit tests are not sufficient.
- [ ] Test acknowledgement/recovery separately so broadening admission does
      not make stale items permanent.

Concrete Workbench completion rules and transition assertions live in
[`../frontend/quality-guidelines.md`](../frontend/quality-guidelines.md).

---

## Gotcha: Transport Frequency Is Not Semantic Event Identity

**Problem**: Multiple producers can describe one user-facing event, and a
terminal TUI can redraw the same prompt indefinitely. Per-source cooldowns
reduce frequency but do not identify whether the user has a new interaction.
Once the cooldown expires, the same prompt becomes a duplicate side effect.

**Prevention checklist**:
- [ ] Inventory every producer and every side-effect sink before changing
      notification, sound, badge, or auto-open behavior.
- [ ] Give events a semantic episode key (for example card + user-submit
      generation) and a stable producer fingerprint; do not use elapsed time or
      random transport ids as identity.
- [ ] Keep source evidence in its authoritative stores, then coordinate the
      external side effect once at a single boundary.
- [ ] Define precedence for structured and heuristic sources, and test them
      arriving together—not only in isolated unit tests.
- [ ] When Rust adds event metadata, use additive camelCase payload fields and
      keep the TypeScript field optional for mixed-version/persisted consumers.
- [ ] Recheck mutable delivery conditions such as focus and preferences when a
      delayed candidate actually flushes, and dispose every pending timer.

Concrete OS notification routing, visibility, and regression-test contracts
live in
[`../frontend/quality-guidelines.md`](../frontend/quality-guidelines.md).

---

## Gotcha: Preserved Transport Bytes Can Still Produce a Broken Frame

**Problem**: A terminal producer can wrap several ANSI writes in one atomic
visual transaction (DEC 2026). Passing every PTY byte through unchanged is
necessary, but it is not sufficient if a later UI layer forces a renderer
refresh before the transaction closes. The wire contract remains correct while
the user briefly sees intermediate layouts.

**Prevention checklist**:
- [ ] Map both the data path and every display side effect. Include explicit
      refresh, fit, scroll, focus, and recovery calls—not only byte transforms.
- [ ] Keep the transport opaque. If display scheduling must observe protocol
      markers, the observer may gate side effects but must not rewrite, delay,
      merge, or re-chunk producer bytes.
- [ ] Carry marker detection across transport chunks and reset that display
      state at the same generation/epoch boundary as the transport sequencer.
- [ ] Use a composed fixture that contains the real visible symptom (for
      example an optional status bullet plus a width-sensitive wrapped line),
      and assert bytes, ACK timing, and refresh count together.
- [ ] Re-test ordinary output outside the atomic transaction so coalescing a
      TUI redraw does not disable shell progress rendering.

Concrete xterm write, synchronized-frame, and refresh rules live in
[`../frontend/terminal-output-rendering.md`](../frontend/terminal-output-rendering.md).

---

## Gotcha: A Quiet Streaming Producer Is Not Necessarily Complete

**Problem**: A multi-stage producer can emit startup output, pause while it
loads state, and then emit the real payload. A UI that treats the first debounce
window as semantic completion reveals an unfinished stream. Display-side
recovery work can then trigger another producer redraw after the loading
curtain disappears.

**Prevention checklist**:
- [ ] Distinguish transport quiet from semantic completion; if no explicit
      producer-owned completion signal exists, do not start an idle completion
      window until there is independent evidence that the substantive payload
      has begun.
- [ ] Trace every producer payload kind through the sink. Live increments,
      attach snapshots, renderer-recovery snapshots, and empty/reset writes
      must not take different completion paths accidentally.
- [ ] Separate bootstrap/chrome output from the substantive payload using
      stable transport or renderer evidence backed by real producer probes.
      Do not match provider names, localized prompts, or transient status text.
- [ ] If determinate percentage is a product contract, keep it determinate and
      monotonic. Do not substitute indeterminate motion, roll 100% backwards,
      or repeatedly hide and re-open the completed surface.
- [ ] Make 100% the single commit boundary: cancel pending completion before
      100 when new sink writes arrive, then reveal once and dispose the guard.
- [ ] Do not add a timer-based fail-open that exposes the exact unfinished
      stream the curtain is meant to hide. Error, process exit, and component
      disposal remain explicit abort paths.
- [ ] Test a pause that crosses the current debounce/idle threshold, not merely
      the threshold that a previous implementation used. Fixtures should use
      timings and payload sizes measured from the real producer.
- [ ] A monotonic `seq` is only transport ordering unless the producer also
      supplies an authoritative final `seq`; do not call a current snapshot
      watermark “complete.”
- [ ] Audit the final display path for fit, resize, scroll, focus, and refresh
      side effects. A presentation-only curtain must not trigger a new producer
      redraw when it opens.
- [ ] Preserve transport bytes, write ordering, and ACK timing while fixing the
      visual lifecycle.

Concrete Agent resume progress and xterm reveal rules live in
[`../frontend/terminal-output-rendering.md`](../frontend/terminal-output-rendering.md).

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

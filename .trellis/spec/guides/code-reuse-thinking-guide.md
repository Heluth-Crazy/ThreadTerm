# Code Reuse Thinking Guide

> **Purpose**: Stop and think before creating new code - does it already exist?

---

## The Problem

**Duplicated code is the #1 source of inconsistency bugs.**

When you copy-paste or rewrite existing logic:
- Bug fixes don't propagate
- Behavior diverges over time
- Codebase becomes harder to understand

---

## Before Writing New Code

### Step 1: Search First

```bash
# Search for similar function names
grep -r "functionName" .

# Search for similar logic
grep -r "keyword" .
```

### Step 2: Ask These Questions

| Question | If Yes... |
|----------|-----------|
| Does a similar function exist? | Use or extend it |
| Is this pattern used elsewhere? | Follow the existing pattern |
| Could this be a shared utility? | Create it in the right place |
| Am I copying code from another file? | **STOP** - extract to shared |

---

## Common Duplication Patterns

### Pattern 1: Copy-Paste Functions

**Bad**: Copying a validation function to another file

**Good**: Extract to shared utilities, import where needed

### Pattern 2: Similar Components

**Bad**: Creating a new component that's 80% similar to existing

**Good**: Extend existing component with props/variants

### Pattern 3: Repeated Constants

**Bad**: Defining the same constant in multiple files

**Good**: Single source of truth, import everywhere

---

## When to Abstract

**Abstract when**:
- Same code appears 3+ times
- Logic is complex enough to have bugs
- Multiple people might need this

**Don't abstract when**:
- Only used once
- Trivial one-liner
- Abstraction would be more complex than duplication

---

## After Batch Modifications

When you've made similar changes to multiple files:

1. **Review**: Did you catch all instances?
2. **Search**: Run grep to find any missed
3. **Consider**: Should this be abstracted?

---

## Gotcha: Asymmetric Mechanisms Producing Same Output

**Problem**: When two different mechanisms must produce the same file set (e.g., recursive directory copy for init vs. manual `files.set()` for update), structural changes (renaming, moving, adding subdirectories) only propagate through the automatic mechanism. The manual one silently drifts.

**Symptom**: Init works perfectly, but update creates files at wrong paths or misses files entirely.

**Prevention checklist**:
- [ ] When migrating directory structures, search for ALL code paths that reference the old structure
- [ ] If one path is auto-derived (glob/copy) and another is manually listed, the manual one needs updating
- [ ] Add a regression test that compares outputs from both mechanisms

---

## Pattern: Single-Funnel Side Effect

**Problem**: When a feature adds a side effect to an action that already has
multiple call sites — a click that goes through both an in-app handler and an
OS notification handler, a write that happens via several entry points — the
naive fix is to instrument each callsite. New callers later forget the wire
and the side effect silently drops.

**Symptom**: A telemetry counter that "should" increment on every click
stays at zero (or is way too low) because one of the click paths bypasses
the instrumentation. The bug surfaces as "the feature works but the metric
is broken" — which is harder to notice than a hard crash.

**Solution**: Find or create a single funnel that every caller already passes
through and put the side effect there. Callsites stay dumb; the funnel owns
the contract.

**Example** (AI Supervisor click telemetry):

Wrong:
```typescript
// Notification Centre item click
useSupervisorStore.getState().recordClick(alert.id);
focusCard(alert.cardId);

// OS notification onAction handler — separate file, same logic
useSupervisorStore.getState().recordClick(alert.id);
focusCard(alert.cardId);
```

Both paths route to the same place anyway; one was wired and the other was
not, so OS clicks never credited.

Correct:
```typescript
// notificationTarget.ts — the single funnel both paths already use
export function openNotificationTarget(cardId: string): void {
  useSupervisorStore.getState().recordClickByCardId(cardId);
  focusCard(cardId);
}
```

**When to apply**: Any cross-cutting concern — telemetry, audit logs,
permission checks, cache invalidation — added to an action that already has
2+ call sites. If the funnel doesn't exist, creating it is usually a smaller
change than instrumenting every callsite.

---

## Checklist Before Commit

- [ ] Searched for existing similar code
- [ ] No copy-pasted logic that should be shared
- [ ] Constants defined in one place
- [ ] Similar patterns follow same structure
- [ ] Side effects (telemetry, audit) live in a single funnel, not per-callsite

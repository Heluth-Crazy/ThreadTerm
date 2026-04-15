# Windows Session Provider Alignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix Windows desktop session startup and Codex session visibility by aligning shell startup with provider-native PTY launches and splitting mixed provider session data before it reaches the UI.

**Architecture:** Keep plain shell creation unchanged, but route AI terminal sessions through the existing `ai.startSession` bridge so Claude/Codex launch directly instead of being typed into PowerShell. Normalize backend project payloads in the frontend so mixed provider session arrays become stable `sessions` and `codexSessions` buckets for all views.

**Tech Stack:** React, TypeScript, Tauri bridge, xterm.js

---

### Task 1: Route AI shell sessions through provider-native startup

**Files:**
- Modify: `src/components/Shell.jsx`

**Step 1: Remove manual AI CLI injection**

Replace the `pty.create(...)` plus `pty.input("claude ...")` startup path for AI sessions with `ai.startSession(...)`, passing the pane PTY id and the provider resume id separately.

**Step 2: Preserve plain shell behavior**

Keep the existing `pty.create(...)` path for plain shell panes and keep `initialCommand` injection only for plain shell sessions.

**Step 3: Register PTY-to-session mapping**

When an AI shell session starts, register the created PTY id back into the Tauri event context so chat/shell surfaces do not spawn duplicate PTYs for the same session.

### Task 2: Normalize mixed provider sessions into frontend buckets

**Files:**
- Modify: `src/hooks/useProjectsState.ts`

**Step 1: Add backend project normalization helpers**

Map backend sessions into frontend session objects, infer provider from `provider`/`__provider`, and split them into Claude and Codex arrays with deduplication.

**Step 2: Use normalized projects everywhere**

Run fetch, refresh, and live project-update payloads through the same normalization path before launch metadata is applied.

**Step 3: Fix equality and counters**

Include `codexSessions` in shallow project equality and keep `sessionMeta.total` aligned with the combined session count so Codex-only changes refresh correctly.

### Task 3: Verify the frontend build still passes

**Files:**
- Modify: `src/components/Shell.jsx`
- Modify: `src/hooks/useProjectsState.ts`

**Step 1: Run static verification**

Run: `npm run typecheck`

Expected: TypeScript completes without new errors from the session startup or project normalization changes.

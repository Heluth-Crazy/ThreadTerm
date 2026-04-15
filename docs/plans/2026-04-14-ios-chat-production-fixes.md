# iOS Chat Production Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring iOS chat behavior up to production quality without regressing PC behavior, and fix the separate Codex desktop chat Enter-submit defect.

**Architecture:** Keep PC behavior unchanged in phase 1. Refactor iOS chat to consume structured message events rather than raw PTY text, while terminal continues to consume raw PTY output. Treat the Codex desktop Enter defect as a separate, bounded fix on the existing PC chat send path.

**Tech Stack:** SwiftUI, Swift Observation, iOS URLSession WebSocket, React, TypeScript, Tauri invoke bridge, Rust PTY session backend.

---

### Task 1: Freeze Current Behavior With Tests

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobileTests/SessionViewModelTests.swift`
- Modify: `src/components/chat/utils/chatUtils.test.ts`
- Modify: `src/hooks/useSessionStatusTracker.test.ts`

**Step 1: Add failing iOS tests for chat-vs-terminal separation**

Add tests that assert:
- Raw PTY terminal table/box output is not emitted as assistant chat text.
- Assistant streaming messages are finalized cleanly.
- User messages remain visible after send failures.

**Step 2: Add failing desktop test for Codex Enter submit**

Add a test around the chat send path that asserts:
- `Enter` without `Shift` invokes the same send flow for `codex` and `claude`.
- The provider-specific message type for Codex still resolves to `codex-command`.

**Step 3: Run targeted tests and record failures**

Run:

```bash
xcodebuild test -project OpenWorkMobile/OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:OpenWorkMobileTests/SessionViewModelTests GENERATE_INFOPLIST_FILE=YES
npm test -- --runInBand src/components/chat/utils/chatUtils.test.ts src/hooks/useSessionStatusTracker.test.ts
```

Expected:
- iOS tests fail because PTY output is still treated as assistant chat content.
- Desktop tests fail or reveal missing Codex submit parity coverage.

### Task 2: Split iOS Chat Rendering From Raw PTY Output

**Files:**
- Create: `OpenWorkMobile/OpenWorkMobile/Models/SessionEvent.swift`
- Create: `OpenWorkMobile/OpenWorkMobile/Utilities/SessionEventInterpreter.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/SessionViewModel.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Networking/PTYWebSocketClient.swift`

**Step 1: Introduce structured iOS session event types**

Define event/message primitives for:
- `user`
- `assistant`
- `tool`
- `thinking`
- `status`
- `error`

Add metadata:
- `streaming`
- `source`
- stable merge key for in-flight assistant updates

**Step 2: Add an interpreter that classifies live PTY output**

Implement a small interpreter that:
- accepts raw PTY history/output strings
- strips ANSI and obvious terminal frame noise
- rejects undecidable terminal layout text from chat
- returns structured chat events only when content is confidently chat-relevant

**Step 3: Keep terminal output untouched**

Ensure `PTYWebSocketClient` still exposes raw output for terminal consumers, while `SessionViewModel` stops directly appending raw PTY output into assistant messages.

**Step 4: Run focused iOS tests**

Run:

```bash
xcodebuild test -project OpenWorkMobile/OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:OpenWorkMobileTests/SessionViewModelTests GENERATE_INFOPLIST_FILE=YES
```

Expected:
- New interpreter tests pass.
- No raw terminal layout appears in chat-derived message assertions.

### Task 3: Add Production-Grade iOS Send/Phase State

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/SessionViewModel.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionView.swift`

**Step 1: Replace implicit streaming behavior with explicit phases**

Add phase transitions:
- `idle`
- `sending`
- `thinking`
- `tool`
- `writing`
- `done`
- `failed`

**Step 2: Preserve local user echo on send**

Update send behavior so that:
- local user bubble appears immediately
- failure appends status/error instead of deleting the user bubble
- input disabled/loading state tracks actual in-flight state

**Step 3: Render tool/status/thinking separately from assistant正文**

Update SwiftUI chat message rendering so:
- assistant text uses chat-style bubble
- tool/status messages use lighter system rows
- thinking is non-invasive and never mixed into assistant text

**Step 4: Run manual simulator validation**

Validate manually:
- send one message
- send two consecutive messages
- abort mid-stream
- provoke failure and confirm message is retained

### Task 4: Align iOS History Messages With Live Message Model

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/HistoryViewModel.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/SessionViewModel.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Models/SessionMessage.swift`

**Step 1: Normalize history into the same message model used by live chat**

Ensure historical content is converted into the same structured message format as live events.

**Step 2: Filter non-chat blocks**

Mirror PC chat expectations:
- skip thinking / internal traces
- map tool events into tool rows
- extract assistant/user text only from known content blocks

**Step 3: Run real history verification**

Use a project/session with existing history and verify:
- history layout matches live chat semantics
- history does not contain terminal noise

### Task 5: Fix Desktop Codex Chat Enter Submit Defect

**Files:**
- Modify: `src/contexts/TauriEventContext.tsx`
- Modify: `src/components/chat/hooks/useChatPanel.ts`
- Modify: `src/lib/tauri-bridge.ts`
- Modify: `src-tauri/src/ai.rs` if the bug is confirmed inside Tauri send semantics

**Step 1: Reproduce and instrument the Codex send path**

Confirm whether:
- `Enter` triggers `sendChatMessage`
- `codex-command` reaches `TauriEventContext.sendMessage`
- `ai.sendMessage` receives the final prompt
- Rust `ai_send_message` writes an actual submit-equivalent control sequence to Codex PTY

**Step 2: Fix only the Codex-specific broken step**

Possible bounded fixes:
- provider resolution is wrong when sending
- active session lookup is stale for Codex sessions
- Codex requires a different submit sequence than current `\r`
- chat path is writing text into the shell without the final submission action

Do not change Claude send behavior.

**Step 3: Add regression coverage**

Add tests asserting:
- Claude send path unchanged
- Codex send path submits once on `Enter`
- `Shift+Enter` still inserts newline where intended

**Step 4: Run targeted desktop verification**

Validate manually with a real Codex session:
- press `Enter` in chat
- confirm terminal no longer shows unsent multiline prompt residue
- confirm assistant response begins

### Task 6: End-to-End Regression Validation

**Files:**
- Modify if needed: `OpenWorkMobile/OpenWorkMobileTests/SessionIntegrationTests.swift`
- Optional docs note: `docs/current-version-defects-2026-04-12.md`

**Step 1: Expand or repair integration coverage**

Make iOS integration tests usable in current simulator environment so they exercise:
- connection
- session attach/create
- two consecutive sends
- no ANSI leakage

**Step 2: Run full targeted validation**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
xcodebuild -project OpenWorkMobile/OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
xcodebuild test -project OpenWorkMobile/OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'platform=iOS Simulator,name=iPhone 17 Pro' GENERATE_INFOPLIST_FILE=YES
npm test -- --runInBand src/components/chat/utils/chatUtils.test.ts src/hooks/useSessionStatusTracker.test.ts
```

**Step 3: Real-device-style manual checks**

Verify manually:
- iOS chat no longer mirrors terminal junk
- iOS terminal still shows full PTY output
- iOS send has visible feedback and completion
- desktop Codex chat Enter now behaves like Claude chat
- desktop Claude behavior unchanged

**Step 4: Commit in small batches**

Suggested commit split:

```bash
git add OpenWorkMobile/OpenWorkMobile/Models/SessionEvent.swift OpenWorkMobile/OpenWorkMobile/Utilities/SessionEventInterpreter.swift OpenWorkMobile/OpenWorkMobile/ViewModels/SessionViewModel.swift OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionView.swift OpenWorkMobile/OpenWorkMobileTests/SessionViewModelTests.swift
git commit -m "fix(ios): separate chat messages from raw pty output"

git add src/components/chat/hooks/useChatPanel.ts src/contexts/TauriEventContext.tsx src/lib/tauri-bridge.ts src-tauri/src/ai.rs
git commit -m "fix(chat): restore codex enter-to-send behavior"

git add OpenWorkMobile/OpenWorkMobileTests/SessionIntegrationTests.swift docs/current-version-defects-2026-04-12.md
git commit -m "test(ios): harden chat integration coverage"
```

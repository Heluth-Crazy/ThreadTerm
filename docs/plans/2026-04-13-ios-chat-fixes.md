# iOS Chat Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the current iOS chat experience so assistant output is readable and the user can send follow-up messages after a response completes.

**Architecture:** Keep the current PTY-based chat transport, but repair the client-side state machine. The chat view model will debounce PTY output to infer stream completion, and assistant text will be normalized through a small ANSI/control-sequence cleanup utility before it is rendered in the chat tab.

**Tech Stack:** SwiftUI, Observation, URLSessionWebSocketTask, XCTest

---

### Task 1: Add tests for text cleanup and stream completion

**Files:**
- Create: `OpenWorkMobile/OpenWorkMobileTests/SessionViewModelTests.swift`

**Step 1: Write the failing tests**

Add tests covering:
- ANSI/control sequences are stripped from assistant output
- trailing whitespace-only chunks do not create unreadable bubbles
- streaming state resets after PTY output goes idle

**Step 2: Run tests to verify failure**

Run: `xcodebuild -project OpenWorkMobile/OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'platform=iOS Simulator,id=8CA7E0AA-9C41-4F9E-A1EF-FC29B7086D74' test CODE_SIGNING_ALLOWED=NO`

Expected: the new tests fail because the current implementation never ends streaming and does not clean PTY output.

### Task 2: Repair the chat output pipeline

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/SessionViewModel.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Utilities/ANSIParser.swift`

**Step 1: Implement minimal cleanup utility**

Add a helper that removes ANSI CSI/OSC escape sequences and other control characters that should not render in the chat tab.

**Step 2: Implement stream completion inference**

Add a debounce-based completion mechanism in `SessionViewModel` so that:
- new PTY output keeps the assistant bubble open
- inactivity marks the current assistant bubble as complete
- the send button becomes available again for follow-up messages

**Step 3: Keep the terminal tab untouched**

Apply cleanup only to chat messages. Do not change terminal rendering code.

### Task 3: Verify the fix end-to-end

**Files:**
- No code changes expected

**Step 1: Run tests**

Run the iOS test command again and expect PASS.

**Step 2: Run a simulator smoke test**

Open the app, connect to the local server, open a session, send a message, and verify:
- the assistant message renders readable text
- the stream settles back to the send button after output stops
- a follow-up message can be sent

# Performance Assessment (2026-04-11)

This document records a focused assessment of possible memory leaks and performance bottlenecks observed while running OpenWork on Windows.

## Scope

- Environment: Windows development run
- Frontend dev server: `http://127.0.0.1:5273`
- Backend server: `http://127.0.0.1:3101`
- Method: one main pass plus one independent sub-agent code audit, then merged findings

## Summary

There is currently no proof of a deterministic memory leak. However, the codebase contains several strong suspects that can plausibly explain high CPU usage and elevated background memory after the app has been running for a while.

The two review passes aligned on the same top three risks:

1. project file watching triggers expensive full project rescans
2. PTY sessions stay alive too long and retain buffers
3. WebSocket streaming causes broad frontend rerender churn

## Runtime Sample

The following point-in-time sample was taken during local development:

- Backend `node` process: working set about `200 MB`, private memory about `341 MB`, handles about `4554`
- Frontend/Vite-related `node` process: working set about `25 MB`, private memory about `268 MB`, handles about `7723`

This sample supports the report that resource usage is high, but it does not by itself prove a leak.

## Findings

### 1. Critical: global file watcher invalidates cache and triggers full project rescans

Files:

- `server/handlers/fileWatcher.js`
- `server/projects.js`

Relevant locations:

- `server/handlers/fileWatcher.js:76`
- `server/handlers/fileWatcher.js:79`
- `server/projects.js:281`

Why it matters:

- file changes call `clearProjectDirectoryCache()`
- the watcher then calls `getProjects(...)`
- `getProjects()` is expensive because it rescans project metadata and session history
- on Windows, frequent file system events can make this path especially costly

Why this is likely user-visible:

- this is the strongest candidate for sustained backend CPU and disk activity while chats or project files are active

### 2. High: WebSocket context fans out streamed messages across the app

File:

- `src/contexts/WebSocketContext.tsx`

Relevant locations:

- `src/contexts/WebSocketContext.tsx:71`
- `src/contexts/WebSocketContext.tsx:93`
- `src/contexts/WebSocketContext.tsx:290`

Why it matters:

- each flushed message updates `latestMessage` and `messageSequence`
- flushing is chained via `setTimeout(..., 0)`
- any consumer subscribed to this context can wake up on every streamed message

Why this is likely user-visible:

- this is a strong candidate for frontend CPU spikes, render churn, and lag during streaming output

### 3. High: PTY sessions remain resident for up to 30 minutes after disconnect

File:

- `server/handlers/ptyHandler.js`

Relevant locations:

- `server/handlers/ptyHandler.js:15`
- `server/handlers/ptyHandler.js:16`
- `server/handlers/ptyHandler.js:636`
- `server/handlers/ptyHandler.js:785`
- `server/handlers/ptyHandler.js:805`

Why it matters:

- PTY sessions are stored in `ptySessionsMap`
- a disconnected WebSocket does not immediately destroy the PTY
- cleanup is deferred by a `30 minute` timeout
- session-associated buffers can stay resident during that period

Why this is likely user-visible:

- this is a strong candidate for background memory staying high after terminal-heavy usage, especially on Windows with `node-pty` and PowerShell

### 4. Medium-High: terminal rendering path is expensive under heavy output

File:

- `src/components/Shell.jsx`

Relevant locations:

- `src/components/Shell.jsx:278`
- `src/components/Shell.jsx:435`
- `src/components/Shell.jsx:473`
- `src/components/Shell.jsx:572`

Why it matters:

- the terminal writes output and scrolls aggressively
- scrollback is set to `10000`
- WebGL addon setup and resize fitting add extra work

Why this is likely user-visible:

- sustained shell output can drive main-thread work, layout churn, and jank

### 5. Medium: project watcher cleanup does not retain the active debounce timer

File:

- `server/handlers/projectFileWatcher.js`

Relevant locations:

- `server/handlers/projectFileWatcher.js:59`
- `server/handlers/projectFileWatcher.js:97`
- `server/handlers/projectFileWatcher.js:110`
- `server/handlers/projectFileWatcher.js:130`

Why it matters:

- the live `debounceTimer` variable changes locally
- the object stored in `activeWatchers` keeps `debounceTimer: null`
- `stopProjectWatcher()` therefore cannot clear the real timer reliably

Impact:

- this is not the primary leak suspect, but it can leave stale scheduled work behind when switching projects repeatedly

### 6. Medium: `projects_updated` handling does heavy whole-state work

File:

- `src/hooks/useProjectsState.ts`

Relevant locations:

- `src/hooks/useProjectsState.ts:25`
- `src/hooks/useProjectsState.ts:474`
- `src/hooks/useProjectsState.ts:511`

Why it matters:

- project payloads are processed as larger state units
- `JSON.stringify`-based comparisons add serialization cost
- if the backend emits `projects_updated` frequently, the frontend pays repeatedly

Impact:

- this amplifies the cost of the watcher path rather than acting as the original source

### 7. Low-Medium: several periodic timers and animation loops increase idle overhead

Files:

- `src/components/sidebar/hooks/useSidebarController.ts`
- `src/components/live-grid/view/CardMessageList.tsx`
- `src/components/chat/components/MessageList.tsx`

Relevant locations:

- `src/components/sidebar/hooks/useSidebarController.ts:75`
- `src/components/sidebar/hooks/useSidebarController.ts:128`
- `src/components/live-grid/view/CardMessageList.tsx:11`
- `src/components/live-grid/view/CardMessageList.tsx:69`
- `src/components/chat/components/MessageList.tsx:218`

Why it matters:

- sidebar polling timers run on intervals
- `animatedIds` is module-scoped and only grows
- typewriter animation ticks every `16ms`
- smooth follow scrolling adds more work during streaming

Impact:

- each item is small on its own, but together they raise the idle CPU baseline

## Confidence Notes

- Items 1 to 3 are strong suspects backed by both code review passes and runtime symptoms.
- Items 4 to 7 are secondary contributors or amplifiers.
- None of the findings above should yet be described as a proven leak without additional instrumentation.

## Recommended Validation Order

### 1. Instrument the project watcher path

Add timing and trigger counters around:

- `clearProjectDirectoryCache()`
- `getProjects()`
- watcher event sources in `server/handlers/fileWatcher.js`

Goal:

- confirm how often full rescans run
- measure the real CPU cost per rescan

### 2. Measure PTY session retention

Track:

- `ptySessionsMap.size`
- buffer lengths per session
- process memory before terminal open, after close, and after timeout expiry

Goal:

- confirm whether memory drops only after delayed PTY cleanup

### 3. Profile WebSocket-driven rerenders

Use React Profiler around streaming scenarios that touch:

- chat
- live grid
- project updates

Goal:

- identify which consumers rerender on every message
- confirm whether context fan-out is the frontend hotspot

## Recommended Remediation Order

1. reduce or scope watcher-triggered `getProjects()` rescans
2. shorten PTY retention and bound buffer growth more aggressively
3. split WebSocket state so streamed messages do not invalidate broad UI regions

## Fix Results

### Finding 1 — global file watcher invalidates cache and triggers full project rescans

**Status: ALREADY FIXED**

The current code in `server/handlers/fileWatcher.js` already has:
- 300ms debounce via `WATCHER_DEBOUNCE_MS` (line 22) and `debouncedUpdate()` (line 61)
- Ignore patterns for `node_modules`, `.git`, `dist`, `build`, `.tmp`, `.swp`, `.DS_Store` (lines 13–21)
- A reentrancy guard (`isGetProjectsRunning`) preventing overlapping rescans (line 26)

No changes needed — the assessment describes a state that has since been addressed.

### Finding 2 — WebSocket context fans out streamed messages across the app

**Status: CANNOT FIX (requires architectural refactor)**

The core issue is that `setLatestMessage()` and `setMessageSequence()` in `WebSocketContext.tsx` cause a context value change on every flushed message, which wakes all subscribers. Splitting the context into a streaming-specific narrow context would require auditing and updating every consumer of `useWebSocket()` across the codebase (chat, live grid, sidebar, project state, settings, etc.). This is a high-risk change that warrants a dedicated PR with thorough regression testing. The existing queue/flush architecture already collapses noisy `projects_updated` and `loading_progress` messages, which mitigates the worst case.

### Finding 3 — PTY sessions remain resident for up to 30 minutes after disconnect

**Status: FIXED**

Changes in `server/handlers/ptyHandler.js`:
- Replaced single 30-minute timeout with differentiated timeouts: 5 minutes for plain-shell sessions, 10 minutes for AI sessions (claude/codex/cursor)
- Reduced periodic GC sweep from every 10 minutes to every 5 minutes
- GC sweep now uses provider-aware timeouts and clears any associated `timeoutId` before killing

### Finding 4 — terminal rendering path is expensive under heavy output

**Status: FIXED**

Changes in `src/components/Shell.jsx`:
- Reduced xterm scrollback from 10,000 to 3,000 lines (still generous, 3× cheaper memory)
- Increased resize observer debounce from 50ms to 150ms to reduce rapid fit/resize churn
- Resize observer and debounce timer are properly cleaned up on unmount (confirmed existing `resizeObserver.disconnect()` in cleanup, added `clearTimeout` for the debounce timer)

### Finding 5 — project watcher cleanup does not retain the active debounce timer

**Status: FIXED**

Changes in `server/handlers/projectFileWatcher.js`:
- The `debounceTimer` is now stored on the `watcherEntry` object itself (e.g., `watcherEntry.debounceTimer`) rather than a disconnected local variable
- `activeWatchers.set()` now stores the same object reference that `onEvent()` updates
- `stopProjectWatcher()` can now reliably clear the real pending timer via `entry.debounceTimer`

### Finding 6 — `projects_updated` JSON.stringify comparison

**Status: FIXED**

Changes in `src/hooks/useProjectsState.ts`:
- Added `shallowProjectEqual()` function that compares project objects by key fields (name, displayName, path, branch, session IDs, sessionMeta) instead of full `JSON.stringify` serialization
- Replaced the `serialize(updatedSelectedProject) !== serialize(selectedProject)` check with the shallow comparison
- The `serialize()` utility is retained for other call sites that still need deep comparison

### Finding 7 — periodic timers and animation loops increase idle overhead

**Status: PARTIALLY FIXED**

Changes made:
- `src/components/live-grid/view/CardMessageList.tsx`: Added a cap (`ANIMATED_IDS_MAX_SIZE = 500`) on the module-scoped `animatedIds` set with LRU-style eviction (evicts oldest 50% when full), preventing unbounded growth during long sessions
- `src/components/sidebar/hooks/useSidebarController.ts`: Verified — the 60-second `currentTime` interval (line 75) and the 1-second sort-order poll (line 128) both have proper `clearInterval` cleanup in their `useEffect` return. No changes needed.
- `src/components/chat/components/MessageList.tsx`: Verified — this file uses `react-virtuoso` with `followOutput="smooth"` rather than a manual animation loop. No 16ms ticker exists here. The typewriter animation in `CardMessageList.tsx` uses a self-terminating `setTimeout` chain that stops when the text is fully revealed. No changes needed.


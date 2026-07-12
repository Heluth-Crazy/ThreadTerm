# Terminal Surface Geometry

> Coordinate PTY dimensions when one session is rendered by multiple WebViews.

---

## Scenario: Every Newly Active Surface Reasserts Shared PTY Geometry

### 1. Scope / Trigger

- Trigger: changes to terminal fit/resize behavior, main/float visibility,
  overlay events, display scaling, or a Shell's local PTY-size cache.
- Applies to `Shell.jsx`, `FloatApp.tsx`, `OverlayBridge.tsx`, and
  `terminalSurfaceEvents.ts`.

### 2. Signatures

- `notifyTerminalSurfaceShown(focus?: boolean): void`
- `invalidateTerminalGeometry(ptyId?: string): void`
- DOM events:
  - `threadterm-terminal-surface-shown` with `{ focus: boolean }`
  - `threadterm-terminal-geometry-invalidated` with optional `{ ptyId: string }`
- Backend call remains `pty.resize(ptyId, rows, cols)`.

### 3. Contracts

- A main Shell and a float Shell for the same card share one backend PTY size;
  the most recently fitted visible surface owns the current rows/columns.
- `lastPtySizeRef` is WebView-local. A resize issued by the other WebView makes
  that cache stale even when the local DOM dimensions did not change.
- Showing or hiding the float invalidates the affected main/float cache. The
  next existing fit/recovery pass must re-send its measured dimensions once.
- A hidden-main recovery after float hide uses `focus: false`: it must not steal
  keyboard focus, scroll to bottom, or change selection/follow-output state.
- Geometry recovery must reuse the existing resize dedupe after cache
  invalidation. It must not change output writes, renderer registration, ACK,
  snapshot, or LRU ownership.

### 4. Validation & Error Matrix

- Invalidation carries another PTY id -> ignore it.
- Matching PTY invalidation followed by surface shown -> exactly one resize
  with current measured rows/columns.
- Float hidden while main is scrolled up -> main reasserts geometry without
  scrolling or focusing.
- Float shown at a different size -> shared PTY adopts float size; returning to
  main restores main size without requiring a manual maximize/restore cycle.
- Resize IPC rejects -> existing resize error handling applies; do not mutate
  output or ACK state to compensate.

### 5. Good/Base/Bad Cases

- Good: OpenCode/Codex TUI enters float, returns to main, and redraws at the
  correct width without character displacement.
- Base: a single visible Shell continues using ordinary fit and size dedupe.
- Bad: each WebView assumes its local `lastPtySizeRef` proves the backend PTY is
  still at that size.
- Bad: forcing `scrollToBottom()` or `focus()` to make a redraw look correct.

### 6. Tests Required

- `Shell.test.tsx`: unrelated invalidation is ignored; matching invalidation plus
  surface recovery causes one resize and no focus/scroll side effects.
- `OverlayBridge.test.tsx`: float show/hide invalidates the matching PTY; hide
  asks main to recover with `focus: false`.
- `FloatApp.test.tsx`: shown and hidden native events invalidate geometry.
- Desktop E2E/manual Windows release: complex alternate-screen TUI, repeated
  main/float show/hide, maximize/restore, and 125%/150%/200% DPI.

### 7. Wrong vs Correct

Wrong:

```typescript
if (lastPtySizeRef.current === `${rows}x${cols}`) return;
```

Correct:

```typescript
invalidateTerminalGeometry(ptyId);
notifyTerminalSurfaceShown(false);
// Shell clears its local cache, then the normal fit path sends one resize.
```

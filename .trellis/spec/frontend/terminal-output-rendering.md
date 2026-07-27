# Terminal Output Rendering

> Keep synchronized TUI frames atomic without breaking scrollback across desktop and mobile xterm surfaces.

## Scenario: DEC 2026 synchronized output in xterm.js

### 1. Scope / Trigger

- Trigger: any xterm.js core/addon upgrade or change to desktop `Shell` writes,
  mobile `MainTerminal` writes, scroll-follow behavior, or renderer ACK timing.
- Applies to `package.json`, `src/components/terminal/Shell.tsx`,
  `mobile-app/src/MainTerminal.tsx`, and their unit/E2E tests.

### 2. Signatures

- Desktop live output: `sequencer.receive({ seq, data })` eventually calls
  `terminal.write(data, onWritten)`.
- Mobile live output: `TerminalFeedMessage(kind = "terminal_output")` calls
  `terminal.write(message.data)` after the sequence guard.
- Both xterm instances set `scrollOnEraseInDisplay: false`.
- xterm public buffer coordinates: `terminal.buffer.active.baseY` and
  `terminal.buffer.active.viewportY`.
- Desktop renderer ACK remains tied to the completion callback of the original
  xterm write, or completes immediately for an empty payload.

### 3. Contracts

- Keep `@xterm/xterm` and the official fit, web-links, and WebGL addons on their
  matching release generation. xterm 6 must not receive the removed
  `windowsMode` option.
- Treat PTY output as an opaque ANSI control stream. Desktop and mobile must not
  delete, reorder, replace, or interpret producer bytes before xterm parses them.
- Preserve DEC 2026 begin/end markers (`CSI ? 2026 h/l`) and every frame-local
  erase command, including `ED2`/`ED3` (`CSI 2 J` / `CSI 3 J`). Agent TUIs use
  those erases to remove the previous prompt layout before atomically painting a
  replacement after history/composer height changes.
- PTY chunk boundaries are transport details, not ANSI boundaries. Pass each
  chunk through unchanged; xterm's parser retains partial escape-sequence state
  across `write` calls.
- Set `scrollOnEraseInDisplay: false` explicitly on every xterm surface. This
  preserves the erase operation while preventing `ED2` from turning non-blank
  viewport rows into scrollback movement.
- Desktop output sequencing and ACK flow control remain unchanged. Do not ACK a
  non-empty payload until xterm's `write` completion callback runs.
- Do not call an explicit full-surface `terminal.refresh()` while a DEC 2026
  frame is still open. A post-write refresh bypasses the producer's atomic
  visual transaction and can expose alternating intermediate layouts even when
  every ANSI byte was preserved. Coalesce refresh demand and release it once
  after `CSI ? 2026 l` has been written.
- A renderer may inspect DEC 2026 markers only to gate display effects. That
  tracker must never withhold or rewrite PTY bytes, must tolerate begin/end
  markers split across chunks, and must reset with the output sequencer epoch.
- `useXtermLifecycle` owns xterm construction and input/scroll listeners.
  `usePtyOutputLifecycle` owns renderer-consumer disposal, listener cleanup,
  and snapshot recovery. `createTerminalOutputPipeline` owns byte-preserving
  xterm writes, scroll-follow decisions, and post-write renderer ACKs.
  `usePtyConnectionController` owns session attach/create, output and exit
  listener wiring, retry timing, and explicit restart actions.
- `usePtyConnectionLifecycle` owns pane-change detachment and auto-connect
  effects. It must remain after xterm creation and surface-activation effects;
  the pane reset effect must remain before pane detachment and auto-connect.
- Scroll-follow decisions and tests use xterm's public `baseY`/`viewportY`
  model. Do not infer scroll position from `.xterm-viewport.scrollTop`; xterm 6
  uses a custom scrollbar whose internal DOM metrics are not the buffer model.
- After a live write completes, do not call `scrollToBottom()` when
  `viewportY >= baseY`. In xterm 6, a zero-distance `scrollToBottom()` still
  refreshes the full viewport, so unconditional calls make rapid resume/history
  replay repaint twice. Explicit user scroll recovery and surface activation may
  still request their intentional refresh.

### 4. Validation & Error Matrix

- Plain shell `clear` outside DEC 2026 -> `ED2` reaches xterm unchanged.
- `ED2` inside a synchronized frame -> xterm clears the old viewport in place,
  then commits the replacement frame without stale prompt rows.
- `ED3` inside a synchronized frame -> preserve it; an intentional scrollback
  purge must not be silently downgraded.
- Begin/end/erase sequence split across chunks -> every chunk reaches xterm
  byte-identically and xterm completes the sequence with its stateful parser.
- Repeated status-line redraws inside one DEC 2026 frame (for example the
  leading `•` appearing/disappearing while `/usage` wraps) -> no explicit
  renderer refresh occurs before the end marker; exactly one coalesced refresh
  may run after the frame closes.
- Lookalike sequence such as `CSI 20 J` -> preserve unchanged.
- Empty desktop payload -> skip `term.write('')`, finish the sequencer callback,
  and ACK the original sequence.
- Card/PTY/snapshot epoch changes -> xterm reset remains limited to the existing
  protocol boundaries; no ANSI-filter state may sit in the renderer/ACK path.
- User scrolls up under xterm 6 -> `baseY - viewportY > 0`; new output must not
  return the terminal to the bottom until the explicit action is used.
- Live output finishes while `viewportY >= baseY` -> synchronize the React
  follow indicator and ACK normally, but skip the zero-distance xterm scroll.
- Explicit scroll-to-bottom or surface recovery -> preserve the existing
  programmatic scroll/focus/refresh behavior.

### 5. Good/Base/Bad Cases

- Good: Codex or Claude emits `DEC 2026 start → ED2 → repaint → DEC 2026 end`;
  xterm receives the exact stream, removes the old prompt rows, and commits the
  new prompt/input area atomically.
- Base: PowerShell, zsh, vim, and ordinary `clear` behavior is unchanged outside
  synchronized frames.
- Bad: remove `CSI 2 J` or `CSI 3 J` inside synchronized frames. The producer
  has already reset its diff buffer, so xterm retains old rows underneath the
  new frame; prefixes disappear, wrapped text remains, and the input box jumps.
- Bad: concatenate or rewrite chunks to make escape sequences "complete";
  xterm already owns parser state and transport rewriting changes ACK timing.
- Bad: preserve the bytes but call `terminal.refresh()` after each frame-local
  `CR`, `ED2`, or `ED3`. This exposes the producer's in-progress layout and
  recreates the visible input-area shake.
- Bad: read or manipulate xterm's private viewport/scrollbar DOM to determine
  follow mode.
- Bad: call `scrollToBottom()` after every live write merely because follow mode
  is enabled; xterm repaints the whole viewport even when it moves zero rows.

### 6. Tests Required

- `src/components/terminal/Shell.test.tsx`: synchronized ED2/ED3 bytes remain
  present across sequenced writes, `scrollOnEraseInDisplay` is false, and ACK
  still waits for xterm's write callback. Live output at the bottom must ACK
  without another programmatic scroll, while explicit recovery still scrolls.
- `src/components/terminal/terminalOutputPipeline.test.ts`: the Codex status
  bullet plus `/usage` wrap fixture remains byte-identical, split DEC 2026
  markers are tracked, no mid-frame refresh occurs, and ordinary `CR` progress
  output outside a frame keeps its existing refresh behavior.
- `mobile-app/src/MainTerminal.test.tsx`: mirrored output preserves each
  split-chunk payload byte-for-byte and uses the same xterm erase option.
- `e2e/desktop/desktop.spec.ts`: wheel-scroll changes public buffer coordinates,
  streaming output preserves the distance, and a real synchronized `ED2`
  repaint removes the deliberately seeded stale prompt/input rows.
- Required gates: `npm run typecheck`, terminal/mobile Vitest targets,
  `npm run build`, `npm run build:mobile`, and desktop/mobile Playwright E2E.

### 7. Wrong vs Correct

Wrong:

```typescript
// This corrupts full-frame TUI repaint semantics.
const renderData = data.replaceAll('\x1b[2J', '').replaceAll('\x1b[3J', '');
terminal.write(renderData);
```

Correct:

```typescript
const terminal = new Terminal({
  scrollback: 3000,
  scrollOnEraseInDisplay: false,
});
const followOutput =
  terminal.buffer.active.type === 'alternate'
  || terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
if (data) {
  terminal.write(data, () => {
    if (
      followOutput
      && terminal.buffer.active.viewportY < terminal.buffer.active.baseY
    ) {
      terminal.scrollToBottom();
    }
    onWritten();
  });
} else {
  onWritten();
}
```

## Bug Analysis: Stale Agent Prompt Rows During Synchronized Repaint

- **Root cause category**: B (cross-layer contract) plus D (test coverage gap).
  ThreadTerm treated ANSI as presentation text and removed semantic producer
  commands; unit tests asserted the removal rather than the final xterm model.
- **Why the prior fix failed**: it addressed a viewport symptom at the stream
  layer. That made the producer's terminal model and xterm's model diverge.
- **Prevention**: keep the ANSI path opaque, configure erase/scroll behavior via
  public xterm options, and require a real-xterm E2E that seeds stale rows before
  replaying a synchronized clear-and-redraw frame.
- **Systematic expansion**: the rule applies to every desktop agent, float
  renderer, terminal card, and mobile mirror because they share `Shell` or the
  same mirrored PTY stream. Never special-case Codex/Claude message text.

## Bug Analysis: Atomic Frame Exposed by an Extra Renderer Refresh

- **Root cause category**: B (cross-layer contract) plus D (regression fixture
  gap). The byte-preservation repair was correct, but the output pipeline still
  treated `CR`/erase bytes as a reason to force a full refresh after every
  chunk. During DEC 2026 that refresh revealed intermediate status-line
  layouts, so the leading bullet and wrapped composer appeared to alternate.
- **Why this regressed**: the earlier stream filter was removed to restore
  correct ANSI semantics, but its visual-stability test was replaced only with
  a byte-preservation assertion. The separate post-write refresh path was not
  covered by the same synchronized-frame fixture.
- **Prevention**: keep producer bytes and ACK timing unchanged; gate only the
  optional renderer refresh, carry partial DEC 2026 markers across chunks,
  flush at most once after the end marker, and reset the gate with the
  sequencer.
- **Systematic expansion**: the fix belongs in the shared desktop output
  pipeline, so Codex, Claude, Gemini, OpenCode, and custom TUIs receive the same
  behavior without matching any provider-specific text.

## Bug Analysis: Resume Replay Repainted an Already-Following Viewport

### 1. Root Cause Category

- **Category**: E — implicit assumption.
- **Specific cause**: the desktop live-output path assumed that
  `scrollToBottom()` was a cheap no-op when `viewportY >= baseY`. In xterm 6 it
  still refreshes the full viewport, so rapid resume/history replay performed a
  second paint after every successful write.

### 2. Why Earlier Protection Was Incomplete

1. The synchronized-frame fix gated direct `terminal.refresh()` calls, but did
   not include the full refresh performed internally by a zero-distance
   `scrollToBottom()`.
2. Existing tests protected explicit recovery and user scroll behavior, but did
   not assert that live output already at the bottom avoids a programmatic
   scroll.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Architecture | Centralize the public-buffer guard in `useTerminalSurfaceController`. | DONE |
| P0 | Test coverage | Assert that live output at the bottom writes and ACKs without `scrollToBottom()`. | DONE |
| P1 | Documentation | Record zero-distance xterm scroll as a full-paint operation. | DONE |

### 4. Systematic Expansion

- **Similar issues**: all desktop Agent terminals share this controller, so the
  guard covers Codex, Claude, Gemini, OpenCode, and ordinary shell cards.
- **Design improvement**: output-follow checks stay on the public
  `baseY`/`viewportY` model; explicit surface recovery remains a separate,
  intentional repaint path.
- **Process improvement**: terminal performance reviews must count indirect
  display effects, not only direct `refresh()` calls.

### 5. Knowledge Capture

- [x] Updated the desktop scroll-follow contract and cases in this spec.
- [x] Added a Shell-level regression test for write, ACK, and scroll behavior.
- [x] Confirmed there is no second direct `scrollToBottom()` call site in the
      current mobile terminal implementation.

## Secondary Card Summaries and Headless Preview

The card's `lastOutput` text and headless preview are secondary projections.
They may optimize their own work, but they must never rewrite the byte stream
sent to a visible xterm or change renderer ACK timing.

### Contracts

- `lastOutput` keeps at most the configured visible tail. Large raw chunks must
  not be fully cleaned merely to discard all but the final 2 KB.
- Tail extraction must move to a verified ANSI boundary before cleaning a raw
  suffix. A blind raw `slice()` can begin inside a long OSC/DCS payload and
  expose control data as card text.
- A per-card summary sanitizer retains only parser state when CSI/OSC/DCS
  controls cross output-flush boundaries. It must never buffer the control
  payload itself.
- Clear summary parser state when a card is removed or archived and when its
  session reaches a non-live state. Restoring or restarting a card must not
  inherit an unfinished control from the previous process.
- Feed every raw chunk to the headless xterm immediately, but read its visible
  screen at most once per output coalescing window. Exit, waiting, and other
  forced flushes still read the final authoritative frame.
- Snapshot recovery remains authoritative after a sequence gap. A bounded
  display queue may discard replaceable increments only after recording the
  gap and requiring a snapshot.

### Required Validation

- `src/lib/ansiText.test.ts`: long control payloads, large-output equivalence,
  and CSI/OSC controls split across separate summary updates.
- `src/stores/terminalStore.test.ts`: the store-level recent text remains clean
  across separate output flushes.
- `src/components/terminal/headlessPreview.test.ts`: full-screen redraw,
  carriage-return progress, split controls, and wide glyphs.
- `src/components/terminal/TerminalEventBridge.test.tsx`: bounded recovery
  memory, gap diagnostics, and snapshot-first recovery.
- Run `npm run bench:terminal-output` for 10/100 MiB summary baselines, split
  controls, and repeated TUI redraw/preview-read measurements.

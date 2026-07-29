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

## Scenario: Agent Resume History Progress Overlay

### 1. Scope / Trigger

- Trigger: any visual loading treatment around a terminal-backed Agent history
  restore, or any change to `TerminalLaunchCommand.action === "resume"`.
- Applies to the main `TerminalView`, float `FloatSession`, `Shell`, the PTY
  connection controller, and the desktop terminal output pipeline.
- The overlay is a desktop presentation concern. It does not change Agent CLI
  commands, PTY protocol payloads, mobile bridge messages, or session binding.

### 2. Signatures

```typescript
interface ShellProps {
  resumeLoading?: boolean;
}

interface ResumeLoadingSnapshot {
  active: boolean;
  visible: boolean;
  monitoring: boolean;
  progress: number;
}

interface ResumeLoadingProgressObserver {
  connectionReady(): void;
  commandDispatching(): void;
  outputWriteStarted(outputChars: number): void;
  outputWriteCompleted(synchronizedFrameOpen: boolean): void;
  skip(): void;
  abort(): void;
}
```

- Provider entry points pass
  `resumeLoading={launch.action === "resume"}`. They must not match provider
  names or parse CLI output text.
- `createTerminalOutputPipeline` may notify the observer, but its input/output
  and ACK signatures remain unchanged.

### 3. Contracts

- Keep xterm mounted and geometrically valid under an opaque overlay. Do not
  use `display: none`, unmount xterm, pause writes, or replace the terminal with
  a separate fake output surface.
- The numeric progress state machine is determinate and monotonic for the whole
  resume guard:
  `0..23 -> 25..48 -> 50..73 -> 75..98 -> 100`.
  Only terminal readiness may enter 100; timers may approach only the current
  cap. The UI must always show an integer percentage. Progress never rolls
  backwards, never switches to indeterminate motion, and reaches 100 exactly
  once.
- Connection readiness and command dispatch are observation milestones.
  An attach snapshot that starts before command dispatch remains setup data;
  every live or snapshot write that starts after dispatch participates in the
  resume guard.
- Startup banners and empty Agent chrome are not restored history. The final
  range remains locked until at least 3072 post-dispatch output characters have
  completed inside a closed synchronized frame. This evidence threshold is
  below the measured first restored Claude frame and above the measured Codex
  bootstrap and OpenCode empty chrome.
- Completion requires replay evidence, a valid terminal size, a drained xterm
  write, a closed DEC 2026 frame, and at least 2 seconds without new output.
  After the final refresh and two paint frames, keep an additional 320 ms
  pre-commit guard below 100. Any live or snapshot write during either quiet
  window or this final guard cancels pending completion and requires a fresh
  quiet window, without reducing the percentage.
- Publishing 100% is the atomic, non-cancelable completion commit. Keep it
  visible for at least one painted frame, reveal once, stop monitoring, and
  never re-cover the terminal or replace the percentage with a moving fallback.
- Keep the timer/state machine in `resumeLoadingProgressController.ts`, the
  React lifecycle adapter in `useResumeLoadingProgress.ts`, and the shared
  observer/snapshot contracts in `resumeLoadingProgressTypes.ts`. Both Shell
  layouts render the same terminal-host/overlay component so their behavior
  cannot drift.
- Geometry was established before dispatching the resume command. The final
  reveal may request a coalesced xterm refresh, but must not run another fit,
  scroll-to-bottom, or PTY resize; those side effects can trigger a second TUI
  repaint after the curtain drops.
- Renderer ACK remains after xterm's write completion callback. Progress
  notifications must not mutate `data`, sequence numbers, chunk boundaries,
  scroll-follow decisions, or ACK timing.
- While progress is active, xterm key, paste, and `onData` input are rejected.
  Reveal restores the existing focus path; it must not create a second input or
  geometry controller.
- If `getSessionState` finds an existing PTY and the initial command is
  suppressed, call `skip()` before the delayed overlay becomes visible.
- Connection failure, process exit, and generation change call
  `abort()`/dispose and reveal the original terminal error state. Do not add an
  automatic fail-open timer that can expose unfinished history replay.

### 4. Validation & Error Matrix

- New PTY + resume action -> show delayed progress, send the existing resume
  command once, reveal after drained stable output.
- Existing PTY + resume action -> attach only; no overlay and no repeated
  resume command.
- New/start/discover/custom action -> no resume overlay.
- Snapshot write before command dispatch -> keep writing/ACKing, but do not
  count it as restored Agent history.
- Snapshot write after command dispatch -> count its characters and completion
  exactly like live output; a renderer-recovery snapshot cannot bypass the
  curtain.
- DEC 2026 frame remains open -> replay evidence is not accepted and progress
  stays below 75.
- Measured Codex bootstrap (about 519 characters) pauses for 2.5 seconds before
  history -> keep the percentage below 75 and the overlay visible.
- Measured OpenCode empty chrome (about 2395 characters) pauses for 2.8 seconds
  before history -> keep the percentage below 75 and the overlay visible.
- Substantive output reaches 3072 characters in a closed frame -> enter the
  75..98 range and start completion checks only after the write drains.
- Output arrives during the final 320 ms pre-commit guard -> keep progress below
  100, cancel completion, and require the new write plus another full quiet
  window.
- Output is observed after 100 was published -> do not cancel or restart the
  reveal. There must be no cancelable hold after the 100% commit, because that
  can strand an active overlay at 100.
- Geometry remains zero-sized -> keep retrying readiness until geometry is
  valid, exit occurs, or the component is disposed.
- PTY exits or connection throws -> hide the overlay immediately and preserve
  the existing exit/retry UI.
- Component/pane generation changes -> old timers and animation frames cannot
  reveal, focus, or cancel the new session.

### 5. Good/Base/Bad Cases

- Good: Claude, Codex, Gemini, and OpenCode all use the same `resume` action,
  share one progress controller, and keep their exact provider commands.
- Good: small startup output can pause beyond the ordinary idle window without
  advancing into the final range or revealing xterm.
- Base: an ordinary shell or a newly started Agent behaves exactly as before.
- Bad: stop forwarding PTY output until the overlay reaches 100. This defeats
  renderer flow control and can deadlock or lose the restored screen.
- Bad: replace determinate progress with an indeterminate moving stripe after a
  late write. Percentage is a product requirement, not an optional decoration.
- Bad: infer completion by matching prompts or provider-specific text. Agent
  versions, locales, and TUI layouts change independently.
- Bad: move the same 2-second silence timer into Rust and call the resulting
  event semantic completion, or wait for a `seq` value without an authoritative
  provider-supplied final watermark. Both preserve the original false-positive
  completion.
- Bad: show the overlay whenever a card has a provider session id. Returning to
  an already-running PTY is an attach, not a new history restore.

### 6. Tests Required

- `resumeLoadingProgress.test.ts`: fixed caps, synchronized-frame guard,
  existing-PTY skip, initial snapshot exclusion, post-dispatch output
  inclusion, measured Codex/OpenCode startup gaps, substantive replay
  threshold, geometry readiness, monotonic cancellation before 100, and the
  atomic 100%-then-reveal race.
- `ResumeLoadingOverlay.test.tsx`: progressbar semantics and stable integer
  percentage rendering.
- `terminalOutputPipeline.test.ts`: observer calls occur after byte-identical
  writes, report character counts and frame-open state, and retain renderer
  ACKs.
- `Shell.test.tsx`: history writes and ACKs continue under the overlay, input
  is blocked only while active, small bootstrap output plus a pause beyond the
  idle window cannot reveal, substantive restored output reveals once, final
  reveal performs no scroll/resize, existing PTYs skip, and exits reveal the
  original exit strip.
- `TerminalView.test.tsx` and `FloatSession.test.tsx`: shared signal reaches
  the main and float shells; bound Claude/Codex/Gemini/OpenCode sessions are
  covered without provider-specific progress branches.

### 7. Wrong vs Correct

Wrong:

```typescript
if (resumeLoading) {
  pendingHistory.push(data); // ACK/write is delayed until the UI says 100%.
  return;
}
```

Correct:

```typescript
terminal.write(data, () => {
  resumeLoadingObserverRef.current?.outputWriteCompleted(frameGate.isOpen());
  outputAcknowledger.ack(request);
  onWritten();
});

{monitoring && (
  <ResumeLoadingOverlay
    progress={progress}
    visible={visible}
  />
)}

// Startup text cannot enter the final range by itself.
if (
  postDispatchChars >= MINIMUM_REPLAY_CHARS
  && !frameGate.isOpen()
) {
  replayEvidenceObserved = true;
}
```

## Bug Analysis: Resume Curtain Revealed Between Output Bursts

### 1. Root Cause Category

- **Category**: B (cross-layer contract), D (test coverage gap), and E
  (implicit assumption).
- **Specific cause**: the UI treated the first post-command terminal output as
  restored history. Agent CLIs actually paint a small startup banner or empty
  chrome, pause longer than the ordinary idle window, and only then replay the
  conversation. The 2-second timer therefore started before history existed.

### 2. Why the Earlier Fixes Failed

1. The first implementation used 700 ms and repeated fit/scroll/resize at
   reveal. It confused the startup-to-history pause with completion and then
   triggered another TUI repaint.
2. The first repair increased quiet time to the backend's 2-second idle grace
   and kept completion cancelable through the 100% hold. It still started that
   timer after the first startup bytes, so a longer startup gap reproduced the
   same error. It also allowed a late write to cancel reveal after 100 had
   already been published, leaving the overlay permanently active at 100.
3. The repair excluded `meta.snapshot=true` writes, so renderer recovery could
   continue after the pending reveal was committed.
4. The regression paused for only 900 ms—longer than the obsolete 700 ms
   debounce but shorter than the new 2-second threshold—so it did not model the
   real Codex 2.5-second or OpenCode 2.8-second pre-history gaps.
5. A provisional-reveal design tried to re-cover after late data. It either
   left the UI stuck at 100, rolled the number backwards, or replaced the
   required percentage with indeterminate motion. All three violated the
   product contract instead of fixing the premature completion.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Evidence gate | Require 3072 post-dispatch output characters and a closed synchronized frame before entering the final progress range. | DONE |
| P0 | Real reproduction | Lock the measured Codex 519-byte/2.5-second and OpenCode 2395-byte/2.8-second startup gaps into tests. | DONE |
| P0 | Contract | Include every post-dispatch write; exclude only setup snapshots that started before dispatch. | DONE |
| P0 | Side-effect isolation | Final reveal refreshes xterm only; no fit/scroll/PTY resize. | DONE |
| P0 | Presentation | Keep an integer percentage for the entire load; remove rollback, indeterminate motion, and post-reveal re-cover. | DONE |
| P0 | Completion | Keep the final cancelable guard below 100; publish 100 as an atomic commit, paint it once, reveal once, and dispose monitoring. | DONE |
| P0 | Failure behavior | Exit/error reveals the original state; no timer-based fail-open that exposes unfinished history. | DONE |
| P1 | Windows validation | Resume a long real Agent history and watch the final reveal. | TODO |

### 4. Systematic Expansion

- **Similar issues**: any loading UI wrapped around a streaming producer can
  confuse a quiet interval, `Idle` projection, or current sequence watermark
  with semantic completion.
- **Design improvement**: when no producer-owned completion event exists, do
  not start an idle timer from arbitrary bootstrap bytes. First establish
  evidence that the substantive payload has begun, then use transport settling
  only to decide when that payload is ready to reveal.
- **Process improvement**: every debounce replacement test must cross the new
  threshold with a real measured pause, include alternate payload kinds such as
  snapshots, and assert ordering at the actual renderer sink.

### 5. Knowledge Capture

- [x] Updated this rendering contract.
- [x] Added controller, output-pipeline, and Shell integration regressions.
- [x] Recorded that startup output and empty TUI chrome are not replay evidence.
- [ ] Close only after Windows real-Agent validation.

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

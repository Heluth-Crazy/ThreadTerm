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
- `useXtermLifecycle` owns xterm construction and input/scroll listeners.
  `usePtyOutputLifecycle` owns renderer-consumer disposal, listener cleanup,
  and snapshot recovery. `createTerminalOutputPipeline` owns byte-preserving
  xterm writes, scroll-follow decisions, and post-write renderer ACKs. PTY
  connection setup must preserve the same ordering while it is moved into the
  remaining connection lifecycle.
- Scroll-follow decisions and tests use xterm's public `baseY`/`viewportY`
  model. Do not infer scroll position from `.xterm-viewport.scrollTop`; xterm 6
  uses a custom scrollbar whose internal DOM metrics are not the buffer model.

### 4. Validation & Error Matrix

- Plain shell `clear` outside DEC 2026 -> `ED2` reaches xterm unchanged.
- `ED2` inside a synchronized frame -> xterm clears the old viewport in place,
  then commits the replacement frame without stale prompt rows.
- `ED3` inside a synchronized frame -> preserve it; an intentional scrollback
  purge must not be silently downgraded.
- Begin/end/erase sequence split across chunks -> every chunk reaches xterm
  byte-identically and xterm completes the sequence with its stateful parser.
- Lookalike sequence such as `CSI 20 J` -> preserve unchanged.
- Empty desktop payload -> skip `term.write('')`, finish the sequencer callback,
  and ACK the original sequence.
- Card/PTY/snapshot epoch changes -> xterm reset remains limited to the existing
  protocol boundaries; no ANSI-filter state may sit in the renderer/ACK path.
- User scrolls up under xterm 6 -> `baseY - viewportY > 0`; new output must not
  return the terminal to the bottom until the explicit action is used.

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
- Bad: read or manipulate xterm's private viewport/scrollbar DOM to determine
  follow mode.

### 6. Tests Required

- `src/components/terminal/Shell.test.tsx`: synchronized ED2/ED3 bytes remain
  present across sequenced writes, `scrollOnEraseInDisplay` is false, and ACK
  still waits for xterm's write callback.
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
const atBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
if (data) terminal.write(data, onWritten);
else onWritten();
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

# Global Overlay — Manual Test Plan

This document describes the end-to-end manual verification steps for the
global overlay system (selector overlay + floating terminal + OS-level
hotkeys). Run this before every release that touches the
`src-tauri/src/overlay.rs`, `src/windows/`, or `src/stores/overlayStore.ts`
surfaces.

## 0. Preconditions

- macOS 12+ or Windows 10+ (Linux: global shortcut support varies by DE)
- ThreadTerm compiled in **desktop Tauri mode** (`npm run tauri:dev`). The
  global shortcut plugin does not work in frontend-only Vite mode (`npm run client`).
- At least two terminal cards created from the main window.
- macOS only: grant ThreadTerm accessibility permission on the first
  hotkey attempt if the system prompts.

## 1. Smoke — default hotkeys register

1. Launch the app; confirm the main window appears.
2. Open **Settings → Shortcuts**. The "Overlay hotkeys" card should show:
   - A  →  `⌘/Ctrl · ⇧ · Space`
   - B  →  `⌘/Ctrl · ⇧ · O`
3. Minimise the main window (or focus a different app like a browser).
4. Press `Cmd/Ctrl + Shift + Space` — the **selector overlay** should
   appear immediately, centered on screen, over the other app.
5. Press the same keys again — selector should close.

_Failure modes: accelerator conflicting with OS shortcut (Spotlight on
macOS). Rebind via Settings and retry._

## 2. Selector → float confirmation

1. Create ≥ 2 cards; pin both via the pin icon in each card's footer.
2. Open the selector overlay (hotkey A).
3. Cards should be rendered in **tile mode** (grid).
4. Press `M` — view should swap to **carousel mode** (coverflow).
5. Press `M` again — back to tile.
6. Arrow-left / arrow-right cycles the highlighted card; `Tab` /
   `Shift+Tab` does the same.
7. Press `1` — selector closes and the **floating terminal window**
   appears always-on-top, showing the first pinned card.

## 3. Float window behaviour

1. Drag the float-window title bar — it should move (macOS may require
   the user to click inside first to focus).
2. Resize from any edge. Close and re-launch the app → the window should
   return to the last position and size.
3. Click the pin icon in the header — always-on-top toggles off (icon
   changes to "pin-off"). Bring another app to front; the float stays
   behind it now.
4. Re-enable always-on-top.
5. Click the **⇔** button (recycle to main) — float hides and the main
   window is brought to the foreground with the session focused.

## 4. Mutual exclusion

1. With the float visible, press `Cmd/Ctrl + Shift + Space` — selector
   appears, float is hidden.
2. Press `Esc` (or hotkey A again) — selector closes **and the float
   reappears** with the same session.
3. Press `Cmd/Ctrl + Shift + O` while the float is visible — float
   hides, main window regains focus, selected session is focused in
   the main grid.

## 5. Shared PTY in main and float

1. Pick a card (card X) via selector → float shows it.
2. While the float is visible, open card X in the main window (double-
   click its card, or switch to it via `Ctrl+1..9`).
3. The main window and the float should mirror the same PTY session:
   output history is shared and typing in either focused xterm writes to
   the same backend session.
4. Press `Cmd/Ctrl + Shift + O` or click the recycle button in the float
   header → float closes and the main window focuses card X.

## 6. Notification click jump

1. In a pinned card session, run a command that triggers an "attention"
   notification (e.g. an interactive prompt like `read -p "confirm>"`).
2. With ThreadTerm not focused, confirm the OS notification appears.
3. **Click the notification** — the **floating terminal** should open
   directly with that card attached (bypassing the main window entirely).
4. Repeat the same with an **unpinned** card: clicking the notification
   should instead focus the main window and select that card in the grid.

## 7. Hotkey rebind

1. Settings → Shortcuts → Overlay hotkeys → **Rebind** next to slot A.
2. The pill shows *"Press keys… (Esc to cancel)"*. Press
   `Ctrl + Alt + P`.
3. The pill updates to `Ctrl · ⌥ · P`. A green confirmation banner
   appears: *"Bound to CmdOrCtrl+Alt+P"*.
4. Verify the OS accepts it: minimise the app and press `Ctrl+Alt+P` —
   selector appears.
5. Click the counter-clockwise **Reset** icon next to slot A to restore
   the default.

## 8. Edge cases

- **Quickly double-tapping hotkey A** should debounce to a single
  open→close cycle (no flash).
- **No pinned cards**: selector should display the *"No pinned sessions
  yet"* empty state; hotkey still works but Enter / 1-9 do nothing.
- **Kill PTY mid-float**: close the card from the main-window card
  footer (`trash` icon) while it is the active float session. Float
  should gracefully unmount the Shell and render the empty state.

## Regression checks after every overlay change

```bash
# fast — store-level correctness
npx vitest run src/stores/overlayStore.test.ts src/stores/terminalStore.test.ts

# full — TS typecheck
npx tsc --noEmit -p tsconfig.json

# long path — ensure Tauri build config + capabilities remain valid
(cd src-tauri && cargo check)
```

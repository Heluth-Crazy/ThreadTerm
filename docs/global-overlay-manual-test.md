# Global Overlay Manual Test

Use this checklist for every release candidate that changes terminal sessions,
shortcuts, selector state, floating windows, persistence, or platform window
handling. It is intentionally manual: automated frontend tests cannot prove
native focus, Space/desktop placement, global shortcuts, or multi-monitor
behavior.

Do not mark an item passed without running it. macOS and Windows acceptance
remain **BLOCKED** until their sections are completed on the real target
platform with the final signed build.

## Test record

Record before testing:

```text
Commit:
Artifact filename and checksum:
Signed/notarized status:
OS and version:
CPU architecture:
Display count, arrangement, and scaling:
ThreadTerm version:
Tester and date:
```

Use a packaged desktop application for release acceptance. `npm run tauri:dev`
may be used for diagnosis, but `npm run client` cannot validate native overlay
behavior.

## Shared setup

- [ ] Start ThreadTerm with **Lightweight mode** disabled under
  **Settings > Shortcuts**.
- [ ] Create at least two Shell cards in known directories and confirm both
  terminals accept input and display output.
- [ ] Pin both cards with **Pin to overlay selector**.
- [ ] Note the current shortcuts shown in **Overlay hotkeys**. Defaults are
  `Cmd/Ctrl + Shift + Space` for the selector and
  `Cmd/Ctrl + Shift + O` for recycling the floating terminal.
- [ ] Keep a harmless, recognizable command ready for each shell, such as
  `printf 'overlay-a\n'` on macOS or `Write-Output 'overlay-a'` in PowerShell.

## Shared selector and floating-window checks

- [ ] With the main window focused, press
  <kbd>Cmd/Ctrl</kbd> + <kbd>&#96;</kbd>. Confirm that the inline selector opens
  inside the main window and closes on a second press or `Esc`.
- [ ] Put another application in the foreground. Press the configured global
  selector shortcut and confirm that the dedicated selector appears without
  requiring the ThreadTerm main window to be focused.
- [ ] Press the global selector shortcut again and confirm that it closes.
- [ ] Reopen the selector. Use left/right navigation, numeric selection, and
  `M`; confirm both pinned cards are reachable and Tile/Carousel mode switches
  without changing the active terminal unexpectedly.
- [ ] Press `Enter` on the first card. Confirm the selector closes, the floating
  terminal opens, and its visible session matches the selected card.
- [ ] Type the platform-appropriate harmless command in the floating terminal.
  Confirm one copy of the command and output appears, with no lost or duplicated
  terminal data.
- [ ] Resize the floating window repeatedly. Confirm the terminal reflows and
  remains interactive.
- [ ] Toggle **Always on top** off and on; compare its stacking behavior with a
  normal application window.
- [ ] Close/hide the floating window, reopen the same card through the selector,
  and confirm the session stayed alive.
- [ ] While the floating terminal is visible, open the selector. Confirm the two
  overlay windows do not remain visibly stacked in a conflicting state.
- [ ] Press the configured recycle shortcut. Confirm the session returns to the
  main window and remains interactive.
- [ ] Repeat selection for the second pinned card and confirm that card identity
  and output are not mixed.

## Launch modes and settings persistence

On Windows, test each **Floating window size** option under
**Settings > Shortcuts**:

- [ ] Select **Floating**, open a pinned card, and confirm a movable/resizable
  floating window.
- [ ] Select **Maximized**, open a pinned card, and confirm the window uses the
  current monitor's maximized work area.
- [ ] Select **Fullscreen**, open a pinned card, and confirm fullscreen behavior
  and a working escape/recycle path.

On macOS, `Maximized` and `Fullscreen` are currently backend no-ops and remain
a release-blocking product mismatch. Confirm that selecting either option does
not crash or strand the overlay, record that the window still opens in floating
mode, and do not mark cross-platform launch-mode parity as passed.

Then verify settings behavior:

- [ ] Rebind the selector shortcut to a non-conflicting combination, put another
  application in front, and confirm the new binding works while the old binding
  no longer opens the selector.
- [ ] Attempt a shortcut known to be owned by the OS or another application.
  Confirm ThreadTerm reports/refuses the conflict without silently losing the
  previously working binding.
- [ ] Reset both shortcuts to their defaults.
- [ ] Restart ThreadTerm and confirm launch mode, selector mode, shortcuts, and
  pinned cards have the expected persisted values.
- [ ] Enable **Lightweight mode**. Confirm the global selector/floating webviews
  are unavailable while pinned cards and the inline selector remain usable.
- [ ] Disable **Lightweight mode** and confirm the global path works again.

## macOS checklist — BLOCK

Run on a real supported macOS system with the final signed and notarized build.

- [ ] Grant or review any notification/system permissions requested by the app;
  record the permission state.
- [ ] Create at least two macOS Spaces. From each Space, trigger the global
  selector and confirm it appears on the Space currently occupied by the user,
  without switching back to the Space that owns the main window.
- [ ] Put another application in native fullscreen and trigger the selector.
  Confirm it appears on the current fullscreen Space and accepts keyboard
  navigation.
- [ ] Open a floating terminal from that selector. Confirm focus enters the
  terminal and typing does not go to the previously active application.
- [ ] Recycle or hide the floating terminal. Confirm focus and Space behavior do
  not strand an invisible key window.
- [ ] Repeat the flow across two monitors, including a monitor with a different
  scale factor if available. Confirm selector placement and maximized/fullscreen
  launch mode use the intended display.
- [ ] Open Mission Control and switch Spaces between overlay invocations. Confirm
  no orphan selector or floating panel remains visible on the wrong Space.
- [ ] Verify the packaged app with Gatekeeper and confirm the final application
  signature/notarization evidence belongs to this artifact.

## Windows checklist — BLOCK

Run on a real supported Windows system with the final Authenticode-signed NSIS
installer.

- [ ] Launch the installed application and confirm no extra console window is
  present in the release build.
- [ ] Put another application in the foreground and trigger the selector with
  the configured `Ctrl` shortcut. Confirm it receives keyboard focus without
  activating an unrelated window.
- [ ] Exercise selector and floating-terminal behavior at 100%, 125%, and 150%
  scaling where available; check for clipping, wrong hit targets, or a window
  positioned outside the work area.
- [ ] Repeat the flow across two monitors, moving the foreground application
  between monitors before invoking the selector. Confirm selector placement and
  maximized/fullscreen launch mode use the intended monitor.
- [ ] Use `Alt + Tab` before and after opening/hiding each overlay. Confirm the
  main, selector, and floating windows have sensible task-switching and focus
  behavior, with no unreachable active window.
- [ ] Lock and unlock the session, then retry both global shortcuts. Confirm no
  stale overlay is left visible and the shortcuts recover.
- [ ] Type PowerShell input, including Unicode text, in the floating terminal;
  verify exact, single-copy output and working resize.
- [ ] Verify the installed files and NSIS installer show the expected
  Authenticode publisher and pass signature verification.

## Failure evidence

For every failure, capture:

- the exact checklist item and reproduction sequence;
- screenshot or screen recording showing window placement and focus;
- OS/display configuration and whether the app was dev or packaged;
- relevant application logs and the terminal command/output, with secrets
  removed;
- whether the failure reproduces after an app restart and on a second machine.

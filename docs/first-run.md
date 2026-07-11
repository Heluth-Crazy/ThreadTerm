# First Run

This guide covers the Tauri desktop application. The frontend-only preview
(`npm run client`) is useful for UI work, but it cannot validate PTY, global
shortcuts, floating windows, or OS notifications.

## 1. Prepare the repository

Install the following on the target computer:

- Node.js 22 LTS and npm 10 or newer.
- The Rust toolchain from <https://rustup.rs>.
- On Windows, Visual Studio Build Tools 2022 with the **Desktop development
  with C++** workload.
- Any optional AI CLI (`claude`, `codex`, `gemini`, and so on) that you want
  ThreadTerm to launch, available on `PATH`.

From a clean checkout, run:

```bash
npm install
npm run tauri:dev
```

`npm run tauri:dev` uses the repository-pinned `@tauri-apps/cli`; do not
install a global `cargo-tauri` command. Tauri runs `npm run dev:desktop` before
starting the Rust application. That script builds the embedded mobile client
and then starts Vite, so a clean checkout does not need an existing
`mobile-app/dist` directory.

You can instead use `./start.sh` on macOS/Linux or `.\start.ps1` from Windows
PowerShell for prerequisite checks followed by the same npm command.

## 2. Create a terminal card

1. Select **New terminal**, or press `Cmd/Ctrl + N`.
2. Choose an existing project directory. The project name is derived from the
   selected path and can be edited.
3. Select **Shell** for the simplest first-run check. Leave **Initial command**
   empty to use the type's default, or enter a harmless command you recognize.
4. Select **Create**.
5. Confirm that a shell prompt or command output appears and that the terminal
   accepts keyboard input.

If an AI preset reports that its CLI is missing, install that CLI or create a
Shell card instead. ThreadTerm does not install third-party AI CLIs.

## 3. Pin and select a session

1. In the card footer, use **Pin to overlay selector**. Up to six cards can be
   pinned.
2. Press `Cmd/Ctrl + Shift + Space` to open the global selector.
3. Use the arrow keys or `1` through `6` to choose a pinned card.
4. Press `M` and confirm that the selector changes between Tile and Carousel
   modes.
5. Press `Enter` to open the selected card in the floating terminal.
6. Confirm that the same session output is visible. Enter a harmless command
   and verify that its output is reflected without losing the session.
7. Press `Cmd/Ctrl + Shift + O` to return the floating session to the main
   window.

If the global selector does not appear, open **Settings > Shortcuts** and
confirm that **Lightweight mode** is disabled and the overlay shortcut is not
owned by another application. While the main window is focused,
<kbd>Cmd/Ctrl</kbd> + <kbd>&#96;</kbd> opens the inline selector instead.

## 4. Verify notifications

1. Open **Settings > Shortcuts**.
2. In **Notifications**, select **Send test notification**.
3. Confirm that ThreadTerm reports a successful request and check the operating
   system's notification centre for the test notification.

Development mode, OS permissions, and focus-assist settings can suppress a
banner. A successful request alone does not prove that the OS displayed it;
repeat this check with the packaged application before release.

## 5. Continue validation

For a complete overlay regression on macOS and Windows, use
[Global overlay manual test](global-overlay-manual-test.md). Packaging and
release gates are documented in [Build and release](build-release.md).

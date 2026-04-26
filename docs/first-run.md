# First-Run Guide

This guide walks through the first five minutes of ThreadTerm.

## 1. Start the Desktop App

```bash
npm install
npm run tauri:dev
```

Use the Tauri desktop app for PTY sessions, global shortcuts, floating windows,
and OS notifications. The frontend-only Vite preview is useful for UI work, but
it cannot exercise desktop integrations.

## 2. Create the First Card

1. Click **New** or press `Cmd/Ctrl + N`.
2. Choose a project directory.
3. Pick a terminal type:
   - **Shell** for a normal project shell.
   - **Claude**, **Codex**, or **Gemini** if the matching CLI is installed in
     `PATH`.
   - **Custom** for a one-off command.
4. Leave the initial command empty to use the type's default.
5. Create the card.

Double-click a card to open it as a focused terminal. Use `Cmd/Ctrl + Shift + M`
to return to the grid.

## 3. Pin a Card for the Selector

1. Return to the card grid.
2. Find the card's bottom action row.
3. Click the pin button. Its tooltip says **Pin to overlay selector**.
4. The card is now available in the global selector, carousel, and floating
   terminal.

Up to six cards can be pinned at once.

## 4. Use Tile and Carousel Modes

Open the selector with:

```text
Cmd/Ctrl + Shift + Space
```

While the main window is focused, you can also use:

```text
Cmd/Ctrl + `
```

Inside the selector:

- Press `M` to switch between Tile mode and Carousel mode.
- Press arrow keys or `Tab` to move between pinned cards.
- Press `1` to `6` to jump to a pinned card.
- Press `Enter` to open the selected card as a floating terminal.
- Press `Esc` to close the selector.

## 5. Verify Notifications

ThreadTerm has two notification layers:

- the in-app notification centre, opened from the bell button or `Cmd/Ctrl + B`
- desktop OS notifications in packaged Tauri builds

When a session needs attention or produces a reply, click the notification to
return to the relevant card. If the card is pinned, ThreadTerm can open it in
the floating terminal.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| AI CLI card exits immediately | Confirm the CLI is installed and visible in `PATH`. ThreadTerm marks Claude, Codex, and Gemini cards with a missing-CLI badge when output indicates the command was not found. |
| Global shortcut does not open the selector | Rebind the shortcut in Settings, then retry outside the main window. macOS shortcuts may conflict with Spotlight. |
| No desktop notification appears | Check OS notification permission and test from Settings. |
| Folder picker is unavailable | Make sure you are running the Tauri desktop app, not the frontend-only preview. |
| Windows build fails before packaging | Install Visual Studio Build Tools 2022 with the `Desktop development with C++` workload. |

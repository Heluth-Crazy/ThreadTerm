# Picker/backend impacts

- 2026-11-14: CodeGraph impact on pagePickerSource identified the picker script, page-comment IPC, native browser registration, picker tests, and browser-agent tests. Risk: untrusted page data crosses the desktop boundary; validation remains in sanitizePagePick.
- 2026-11-14: CodeGraph impact on sanitizePagePick identified desktop page-comment tests and the preview/browser callers. Risk: additive context fields must remain bounded and reject controls.
- 2026-11-14: CodeGraph impact on PagePick identified protocol bridge/preload plus renderer comments and context menus. Risk: preserve the existing target shape for callers.
- 2026-11-14: CodeGraph impact on makeView and handleDevtoolsShortcut identified native browser shortcut forwarding. Risk: Ctrl+Shift+D must be forwarded to renderer without changing the picker lifecycle.
- 2026-11-14: CodeGraph impact on installMockBridge and markPageTarget identified the renderer mock and every page-highlight caller. Risk: pins are additive and an ordinary highlight clear must retain them.
- 2026-11-14: Picker extension adds only bounded fields to PagePick. Shift selections resolve only on Enter or a plain click; editing stays within the picker overlay and is returned as data for desktop sanitization.
- 2026-11-14: CodeGraph impact on registerIpc and readHostPageShot identified the host-asset bridge. Risk: local page shots use the existing validated attachment persistence path; machine authority validation remains unchanged.

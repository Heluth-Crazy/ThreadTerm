# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

### Local UI Primitives

When a plan calls for a shadcn/ui primitive, verify that the primitive exists under
`src/components/ui/` before importing it. If the package/dependency is not present,
add a small local primitive in `src/components/ui/<primitive>.tsx` that matches the
component API needed by the feature instead of adding a new runtime dependency by
default.

Example: `BottomActionBar` uses `src/components/ui/popover.tsx` for a lightweight
`Popover` / `PopoverTrigger` / `PopoverContent` API because `@radix-ui/react-popover`
is not installed in this project.

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

<!-- How styles are applied (CSS modules, styled-components, Tailwind, etc.) -->

(To be filled by the team)

<spec-entry category="pattern" keywords="terminal-card-preview,summary-strip,composer-hints,theme-vars" date="2026-05-07" source="src/components/terminal/CardPreviewPanel.tsx:13">

### Terminal Card Preview Thumbnail + Summary

Grid card terminal previews should separate recognition from reading: render a dense monospace thumbnail for terminal shape, then place a single-line semantic summary over it.

The preview surface must use terminal theme variables such as `--terminal-background` and `--terminal-foreground`, not fixed dark-blue or muted colors, so theme and accent changes carry into cards.

The summary line should be built in the preview data layer, not guessed from the thumbnail rows at render time. `buildCardPreview()` should return a dedicated semantic summary (for example `summaryLine`) while `bodyLines` remains free to show the terminal thumbnail. For AI CLI cards, derive the summary from the active preview source (`lastReplyPreview`, or `lastOutput` when reply preview is unavailable) after structurally removing the trailing composer/input region; do not rely on a growing preset-prompt word list. Shell previews should continue to summarize normal shell prompts and commands without AI-composer filtering.

Tests for card preview changes should cover the thumbnail layer, one-line summary, empty output state, AI composer/input separation in `cardPreview.test.ts`, and display of the provided summary in `CardPreviewPanel.test.tsx`.

</spec-entry>

<spec-entry category="pattern" keywords="xterm-registry,multi-webview,float-window,block-overlay,buffer-range" date="2026-05-16" source="src/components/terminal/xtermRegistry.ts:23">

### Scenario: Multi-Instance xterm Registry

#### 1. Scope / Trigger
- Trigger: Any change to desktop `Shell`, floating terminal windows, block overlay/inspector, or `src/components/terminal/xtermRegistry.ts`.

#### 2. Signatures
- `registerTerminal(ptyId: string, term: Terminal): void`
- `unregisterTerminal(ptyId: string, term?: Terminal): void`
- `claimTerminalActive(ptyId: string, term: Terminal): void`
- `getTerminal(ptyId: string): Terminal | undefined`
- `getAbsoluteCursorRow(ptyId: string): number`
- `readBufferRange(ptyId: string, startRow: number, endRow: number): string`

#### 3. Contracts
- A single PTY may be rendered by more than one xterm instance, for example main window plus float window.
- Registry state is `ptyId -> registrations[]`, not `ptyId -> single Terminal`.
- Registering a terminal makes that instance active. A visible/foreground shell must call `claimTerminalActive()` when it becomes active.
- Unregistering with a `Terminal` removes only that instance and must fall back to the previous registration for the same PTY.
- Unregistering without a `Terminal` is a full cleanup escape hatch and removes all registrations for that PTY.
- `getTerminal()`, `getAbsoluteCursorRow()`, and `readBufferRange()` must use the active registration.

#### 4. Validation & Error Matrix
- No registration -> `getTerminal` returns `undefined`, cursor row returns `0`, buffer range returns `''`.
- Active float unregisters while main remains -> active terminal falls back to main.
- Main claims foreground while float remains mounted -> cursor/buffer reads use main.
- Invalid row range -> `readBufferRange()` returns `''`.

#### 5. Good/Base/Bad Cases
- Good: float opens for an existing card, claims active, and block overlay reads from the float until it closes.
- Base: one shell per PTY behaves exactly like the old registry.
- Bad: unmounting one Shell deletes another Shell's registration for the same PTY.

#### 6. Tests Required
- Registry unit tests for two terminal instances sharing one PTY, active claim selection, per-instance unregister fallback, and full cleanup.
- Affected frontend verification must include `npm run typecheck` and `npx vitest run`.

#### 7. Wrong vs Correct

Wrong:
```typescript
const terminals = new Map<string, Terminal>();
terminals.delete(ptyId);
```

Correct:
```typescript
registerTerminal(ptyId, term);
claimTerminalActive(ptyId, term);
unregisterTerminal(ptyId, term);
```

</spec-entry>

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

<!-- Component-related mistakes your team has made -->

(To be filled by the team)

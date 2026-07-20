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

<spec-entry category="pattern" keywords="project-sidebar,branch-tree,disclosure-column,worktree-state,aux-actions" date="2026-06-26" source="src/components/terminal/ProjectSidebar.tsx:65">

## Scenario: Project Sidebar Tree Row Alignment

### 1. Scope / Trigger
- Trigger: Any change to `ProjectSidebar`, `SidebarRow`, or project/branch
  tree rows in `src/components/terminal/ProjectSidebar.tsx`.

### 2. Signatures
- `SidebarRowAuxAction = { key: string; title?: string; icon: ReactNode; onClick(e): void }`
- `SidebarRow` receives `hasChildren`, `expanded`, `onToggle`, and optional
  `auxActions`.

### 3. Contracts
- Every expanded-width sidebar row reserves the same disclosure column before
  the main icon. Expandable rows render a chevron inside that column; leaf rows
  render an equal-width empty placeholder.
- Collapsed icon-rail mode hides the disclosure column and row labels, keeping
  the single main icon centered.
- The disclosure target owns expand/collapse only and must stop propagation so
  it does not select the project row.
- Project row aux actions are grouped at the row tail. Directory reveal and
  branch refresh must share this action pattern instead of adding independent
  header rows.
- Branch rows should remain isomorphic: branch icon, label/detail, then a
  persistent action icon. Existing worktrees use `Terminal`; branch-only rows
  use `Plus`; both are visible before hover.
- Current branch state must not insert a leading marker before the label. Use
  primary coloring and an inline trailing pill if a textual marker is needed.

### 4. Validation & Error Matrix
- Git project row with children -> disclosure column contains chevron.
- Non-git project row and `All terminals` row -> disclosure column contains an
  empty placeholder.
- Chevron click or keyboard activation -> expands/collapses only.
- Branch refresh action click -> refreshes branches only and does not select
  the project.
- Existing worktree branch -> action icon is visible `Terminal`.
- Branch without worktree -> action icon is visible `Plus`.

### 5. Good/Base/Bad Cases
- Good: git projects, non-git projects, and `All terminals` align their icon and
  label columns exactly because the disclosure column is always present.
- Base: collapsed sidebar remains a centered icon rail without branch rows.
- Bad: conditionally rendering the disclosure column only for expandable rows;
  this shifts folder icons and makes mixed project lists look uneven.
- Bad: hiding branch action icons until hover; this makes worktree and
  branch-only rows indistinguishable in a static scan.

### 6. Tests Required
- `ProjectSidebar.test.tsx` should cover fixed disclosure columns for leaf and
  expandable rows.
- Tests should verify branch refresh lives in the project row aux actions and
  the old `sidebar.branches` header row is absent.
- Tests should verify `Terminal` and `Plus` action icons are visible without
  hover and current branch marking does not use a leading dot.

### 7. Wrong vs Correct

Wrong:
```tsx
{hasChildren && <ChevronRight />}
<Folder />
```

Correct:
```tsx
<span className="w-4">
  {hasChildren ? <ChevronRight /> : <span className="w-4" />}
</span>
<Folder />
```

</spec-entry>

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
- A mounted `Shell` treats `paneId` as the PTY identity. If `paneId` changes, the
  shell must detach listeners and unregister the old xterm before connecting to
  the new PTY. Do not rely on React `key` remounts to hide stale connection
  state.
- Async PTY setup must guard stale awaits. Output/exit callbacks and ack calls
  should close over the `connectedPtyId` from that setup, not read a mutable
  `ptyIdRef` that may already point at a later pane.

#### 4. Validation & Error Matrix
- No registration -> `getTerminal` returns `undefined`, cursor row returns `0`, buffer range returns `''`.
- Active float unregisters while main remains -> active terminal falls back to main.
- Main claims foreground while float remains mounted -> cursor/buffer reads use main.
- Invalid row range -> `readBufferRange()` returns `''`.
- Same mounted Shell switches `pane-1` -> `pane-2` -> old output handler cannot
  write or ack as the new pane.
- Slow `pane-1` setup resolves after `pane-2` is selected -> stale setup must
  not send `pane-1`'s initial command or overwrite current listeners.

#### 5. Good/Base/Bad Cases
- Good: float opens for an existing card, claims active, and block overlay reads from the float until it closes.
- Base: one shell per PTY behaves exactly like the old registry.
- Bad: unmounting one Shell deletes another Shell's registration for the same PTY.
- Bad: adding `key={paneId}` at a parent boundary as the only fix for pane
  changes; that recreates xterm/WebGL surfaces and can leave async PTY setup
  racing the new pane.

#### 6. Tests Required
- Registry unit tests for two terminal instances sharing one PTY, active claim selection, per-instance unregister fallback, and full cleanup.
- `Shell.test.tsx` should cover mounted pane switches, old-output suppression,
  no kill when preserving PTYs, and stale async connect completion.
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

<spec-entry category="pattern" keywords="card-sort,activity-first,project-card-order,drag-sort,card-grid,mobile-parity,terminal-card-order" date="2026-06-15" source="src/components/terminal/CardGrid.tsx:64">

### Scenario: Activity-First and Project-Manual Card Ordering

#### 1. Scope / Trigger
- Trigger: Any change to how the desktop `CardGrid` or the mobile session
  list orders terminal cards, to directory-scoped drag sorting, or to
  `src/lib/cardSort.ts`.
- Applies to `src/lib/cardSort.ts`, `src/components/terminal/CardGrid.tsx`,
  `src/stores/terminalStore.ts`, and mobile `sortCardsForMobile` in
  `mobile-app/src/App.tsx`.

#### 2. Signatures
- `compareCardsByActivity(a: CardActivitySortFields, b: CardActivitySortFields): number`
- `orderCardsByIdList<T extends { id: string }>(cards, orderedIds): T[]`
- `isDesktopCardLive(status: string | null | undefined): boolean`
- `CardActivitySortFields = { status?, unread?, lastActivity?, createdAt?, ptyLive? }`
- `terminalStore.projectCardOrder: Record<string, string[]>`
- `terminalStore.moveProjectCard(projectPath: string, id: string, toIndex: number): void`
- `terminalStore.getCardsForProjectView(path: string | null): TerminalCard[]`

#### 3. Contracts
- "All terminals" on desktop and the mobile session list use the same
  "activity first" order. The single source of truth is
  `compareCardsByActivity`, imported on mobile via the `@shared` alias
  (`@shared/lib/cardSort`).
- Activity-first tiers, in priority order:
  1. live cards first (a PTY is running / waiting for input),
  2. then unread cards,
  3. then most recent first (`lastActivity`, falling back to `createdAt`).
- A selected desktop project view uses `projectCardOrder[projectPath]` instead
  of activity-first sorting. The drag handle writes only that project's id
  order via `moveProjectCard`.
- Liveness vocabulary is unified across layers: `running`, desktop `waiting`,
  and mobile `waiting_for_input` all count as live. An explicit `ptyLive`
  boolean (mobile) overrides the `status`-derived liveness.
- Sort helpers must never mutate inputs. Callers sort/project copies.
- `projectCardOrder` keys are raw `projectPath` strings. Do not normalize
  separators or case-fold them: Windows paths such as `C:\repo\app` and macOS
  paths such as `/Users/me/app` must remain independent byte-stable keys.
- Newly created cards prepend to their directory order.
- Desktop directory-view keyboard navigation (`nextCard` / `prevCard` /
  `jumpToIndex`) follows the same manual order as the visible project grid.
  "All terminals" navigation keeps store order and must not follow the
  activity-sorted view.
- The desktop `terminalStore.cards` array keeps creation order. Never reorder
  it to implement visual sorting.

#### 4. Validation & Error Matrix
- Live + read + old beats idle + unread + new (liveness dominates).
- Equal liveness: unread beats read.
- Equal liveness + unread: higher `lastActivity` wins, else higher `createdAt`.
- `ptyLive: false` on a `status: 'running'` mobile card is treated as not
  live.
- Equal cards preserve input order (stable sort).
- Invalid or duplicate ids in `projectCardOrder` are ignored; cards missing
  from the persisted order are appended in current input order.
- Deleting a card removes dead ids from `projectCardOrder`.
- A drag in project A must not affect project B or "All terminals".

#### 5. Good/Base/Bad Cases
- Good: `CardGrid.visibleCards` chooses activity-first for all terminals and
  `orderCardsByIdList(filtered, projectCardOrder[path])` for selected projects.
- Base: a newly created project card appears first in that project and can be
  moved later by drag handle.
- Bad: re-sorting `terminalStore.cards` in place, normalizing Windows paths into
  POSIX strings, or applying project manual order to mobile.

#### 6. Tests Required
- `src/lib/cardSort.test.ts` covers liveness vocabulary, each tier, the
  `ptyLive` override, stability, and id-list ordering edge cases.
- `src/stores/terminalStore.test.ts` covers new-card prepend, project-scoped
  move, delete cleanup, migration default, raw Windows/macOS path keys, and
  directory-view shortcut order.
- `src/components/terminal/CardGrid.test.tsx` covers drag-handle visibility:
  present in selected project views, absent in "All terminals".
- Affected frontend verification: `npm run typecheck` and
  `npx vitest run mobile-app/ src/`.

#### 7. Wrong vs Correct

Wrong:
```typescript
// Mutates global store order and breaks cross-window assumptions.
set({ cards: [...state.cards].sort(compareCardsByActivity) });
```

Correct:
```typescript
const visibleCards = selectedProjectPath
  ? orderCardsByIdList(filtered, projectCardOrder[selectedProjectPath])
  : [...filtered].sort(compareCardsByActivity);
```

</spec-entry>

<spec-entry category="pattern" keywords="terminal-card-footer,responsive-actions,overflow-menu,resize-observer,portal-menu" date="2026-06-16" source="src/components/terminal/CardFooter.tsx:35">

### Scenario: Responsive Terminal Card Footer Actions

#### 1. Scope / Trigger
- Trigger: Any change to terminal card footer controls, card action buttons, AI intent placement, or footer width behavior.
- Applies to `src/components/terminal/CardFooter.tsx`, `src/components/terminal/CardActions.tsx`, and their component tests.

#### 2. Signatures
- `CardActionDensity = 'wide' | 'compact' | 'narrow'`
- `getCardFooterDensity(width: number): CardActionDensity`
- `CardActionsProps.density?: CardActionDensity`
- `CardActionsProps.overflowContent?: React.ReactNode`

#### 3. Contracts
- The close button and copy action must stay directly reachable at every card width.
- `wide` footers render the full action strip inline.
- `compact` footers render copy, reveal, More, and close inline; pin/archive/export/auto-restart/AI intent move into More.
- `narrow` footers render copy, More, and close inline; reveal and all optional controls move into More.
- Footer density must be driven by the rendered footer width, not by global viewport width, because grid cards resize independently.
- A non-measurable width (`0`) must keep the default `wide` layout so tests and hidden/offscreen cards do not collapse controls before layout is available.
- More menus inside cards must render through a portal or otherwise escape card `overflow-hidden`; relative popovers inside the card can be clipped.
- Menu actions must stop propagation so clicking footer controls does not focus/open the card surface.

#### 4. Validation & Error Matrix
- Width `<= 0` -> `wide`.
- Width `< 300` -> `narrow`.
- Width `300..359` -> `compact`.
- Width `>= 360` -> `wide`.
- Missing `ResizeObserver` -> fall back to window resize measurement.
- Compact card with no archive/export/auto-restart still shows More because pin/unpin is folded into it.

#### 5. Good/Base/Bad Cases
- Good: a non-fullscreen window narrows cards and optional controls move into a portal More menu without clipping.
- Base: a normal desktop card keeps existing inline action buttons and AI intent select.
- Bad: hiding the AI intent select by clipping a fixed-width child inside `overflow-hidden`.
- Bad: moving close into an overflow menu; close must remain directly visible.

#### 6. Tests Required
- `CardFooter.test.tsx` covers density thresholds, including width `0`.
- `CardActions.test.tsx` covers compact/narrow direct controls, overflow items, and event propagation.
- Affected frontend verification must include `npm run typecheck`, `npm run test`, and `npm run build`.

#### 7. Wrong vs Correct

Wrong:
```tsx
<div className="overflow-hidden">
  <CardActions />
  <AiIntentSelect compact />
</div>
```

Correct:
```tsx
<CardActions
  density={density}
  overflowContent={density === 'wide' ? null : <AiIntentSelect compact />}
/>
```

</spec-entry>

<spec-entry category="contract" keywords="mobile-access,pairing,qr-code,empty-state,lan-confirmation" date="2026-07-14" source="src/components/settings/MobileAccessSettings.tsx:104">

### Scenario: Mobile Pairing Keeps Its Security Gate Visible

#### 1. Scope / Trigger
- Trigger: changing the desktop Mobile Access surface, bridge start controls,
  pairing-code state, or QR rendering.
- Applies to `MobileAccessSettings`, its settings locale keys, and component
  tests. Backend bridge authorization remains a separate contract.

#### 2. Signatures
- `MobileAccessSettings(): JSX.Element`
- `BridgeStatus.running: boolean`
- Existing actions: `startBridge()`, `runStartBridge(host)`, and
  `createPairQr()`.

#### 3. Contracts
- The pairing surface is always rendered. A stopped bridge must show a QR-sized
  placeholder, explain why no code exists, and provide a direct start action.
- The placeholder start action must reuse `startBridge()`. It must not call the
  backend directly or bypass the existing inline confirmation before binding
  to `0.0.0.0`.
- Entering the Mobile Access page must never start or expose the bridge merely
  to make a QR code appear.
- A running bridge with an in-flight pairing request shows a generating state.
  A running bridge without a usable `PairQrResponse` shows a retry state rather
  than an unexplained blank area.
- Render the real QR, OTP, and URL only when both `pairQr` and the derived
  `pairUrl` are present. Permission changes and retries continue through the
  existing serialized pairing-request funnel.

#### 4. Validation & Error Matrix
- Bridge stopped -> placeholder and start CTA visible; no QR element and no
  `pairQr` IPC call.
- Stopped with LAN binding selected -> either start control opens the inline
  LAN confirmation; `bridge_start` is not called before confirmation.
- Bridge running and pair request pending -> generating state visible.
- Bridge running and pair request fails -> error plus retry state visible; old
  QR is absent.
- Bridge running with a valid pair response -> QR, OTP, URL, permission controls,
  refresh, and copy actions visible.

#### 5. Good/Base/Bad Cases
- Good: a first-time user immediately sees where the QR will appear and how to
  generate it, while network exposure still requires explicit confirmation.
- Base: reopening an already-running bridge creates and displays a fresh
  five-minute code through the existing refresh flow.
- Bad: hide the entire pairing section while stopped, leaving users to infer
  that Start is required.
- Bad: auto-bind to all interfaces when the panel mounts just to avoid the
  stopped-state placeholder.

#### 6. Tests Required
- Component test: stopped state renders explanation and CTA, contains no QR,
  and preserves LAN confirmation before `mobileBridge.start`.
- Component test: pairing failure keeps the running status and renders an
  explicit unavailable/retry state without a stale QR.
- Existing tests must keep covering automatic pair-code creation for an
  already-running bridge and permission-bound request serialization.
- Update all four settings locales and run key-set parity, Vitest, typecheck,
  lint, desktop/mobile builds, and `git diff --check`.

#### 7. Wrong vs Correct

Wrong:

```tsx
{status.running && <PairingQrSection />}
```

Correct:

```tsx
<PairingSection>
  {status.running ? <PairingCodeState /> : <StoppedPairingPlaceholder />}
</PairingSection>
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

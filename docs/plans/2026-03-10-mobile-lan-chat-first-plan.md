# Mobile LAN Chat-First Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a mobile-first LAN flow where users can switch projects/sessions and continue chat quickly, while preserving the current desktop workbench behavior.

**Architecture:** Add a viewport-aware mobile shell branch that reuses existing project/session/chat state and callbacks from `useProjectsState` and `AppContent`. Keep backend/API contracts unchanged, and focus changes in app shell, mobile navigation surfaces, selection persistence, and connection-state UX.

**Tech Stack:** React 18, TypeScript, Tailwind utility classes, existing WebSocket context, existing projects/session state hooks, i18n JSON locale files.

---

## Preconditions

- No dedicated frontend unit/integration test harness currently validates this surface area.
- Primary automated validation for this plan:
  - `npm run typecheck`
  - `npm run build`
- Behavior validation relies on targeted manual smoke on desktop and mobile browser viewports.

### Task 1: Add Mobile Viewport Mode Detection

**Files:**
- Create: `src/hooks/useMobileViewport.ts`
- Modify: `src/components/app/AppContent.tsx`

**Step 1: Create mobile viewport hook**

Implement `useMobileViewport` with:

- configurable breakpoint (default `1024`)
- resize listener and initial calculation
- stable boolean output (`isMobileViewport`)

**Step 2: Integrate hook in app composition**

In `AppContent`, compute mobile mode once and pass it into the shell selection logic without changing project/session state behavior.

**Step 3: Validate**

Run:

```bash
npm run typecheck
```

Expected: pass with no type errors from new hook integration.

### Task 2: Introduce Mobile Shell and Primary Tabs

**Files:**
- Create: `src/components/mobile/MobileWorkbenchShell.tsx`
- Create: `src/components/mobile/MobileBottomTabs.tsx`
- Modify: `src/components/app/AppContent.tsx`
- Modify: `src/components/workbench/AppShell.tsx` (desktop path only, minimal if needed)

**Step 1: Create mobile shell container**

Build a mobile-only shell component with:

- single-column body
- fixed/sticky bottom tab bar slot
- safe-area-aware padding hooks via existing CSS variables/classes

**Step 2: Create bottom tabs**

Implement `Projects / Sessions / Chat` tabs with active state and callback props.

**Step 3: Branch shell rendering in AppContent**

Render desktop `AppShell` for non-mobile and `MobileWorkbenchShell` for mobile. Reuse existing callbacks (`onProjectSelect`, `onSessionSelect`) rather than creating parallel state.

**Step 4: Validate**

Run:

```bash
npm run typecheck
npm run build
```

Expected: build succeeds and desktop layout remains unchanged.

### Task 3: Implement Mobile Projects and Sessions Surfaces

**Files:**
- Create: `src/components/mobile/MobileProjectsView.tsx`
- Create: `src/components/mobile/MobileSessionsView.tsx`
- Modify: `src/components/app/AppContent.tsx`

**Step 1: Mobile projects view**

Render a compact project list using existing `projects` data and call `handleProjectSelect` path via `onSelectProject`.

**Step 2: Mobile sessions view**

Render selected-project sessions (Claude + Codex) using normalized labels and timestamps. Provide direct entry into selected session via existing `onSelectSession`.

**Step 3: Empty/fallback states**

Handle:

- no projects
- no project selected
- selected project with no sessions

Keep copy concise and action-oriented.

**Step 4: Validate**

Manual smoke:

- project list opens and selects correctly
- sessions update when project changes
- tapping a session opens chat view path

### Task 4: Add Mobile Chat Context Switchers

**Files:**
- Modify: `src/components/chat/ChatPanel.tsx`
- Create: `src/components/mobile/MobileChatContextBar.tsx`
- Modify: `src/components/app/AppContent.tsx`

**Step 1: Define mobile context-switch props**

Pass lightweight callbacks and option lists to `ChatPanel` only in mobile mode:

- `onOpenProjectPicker`
- `onOpenSessionPicker`
- current project/session labels

**Step 2: Render compact context bar**

Add top context bar in mobile chat mode:

- current project/session
- one-tap switch actions
- no desktop behavior changes

**Step 3: Preserve composer visibility**

Ensure chat composer remains visible and usable when viewport height changes from mobile keyboard.

**Step 4: Validate**

Manual smoke:

- switch project/session from chat header
- send message with keyboard open
- verify no message list clipping regression

### Task 5: Persist and Recover Mobile Selection State

**Files:**
- Modify: `src/hooks/useProjectsState.ts`
- Modify: `src/hooks/useUiPreferences.ts` (only if existing persistence helpers are needed)

**Step 1: Persist current project/session**

Save minimal mobile resume state on selection change:

- selected project identifier
- selected session identifier
- timestamp

**Step 2: Recover on app load**

On initialization, restore last selection when still valid in current projects data.

**Step 3: Handle stale state**

If restored project/session no longer exists:

- clear stale persisted state
- fall back to projects/sessions list safely

**Step 4: Validate**

Manual smoke:

- select project/session, reload page, verify resume
- delete target session/project, reload, verify graceful fallback

### Task 6: Add Mobile Connection and Error-State UX

**Files:**
- Modify: `src/components/chat/ChatPanel.tsx`
- Modify: `src/contexts/WebSocketContext.tsx` (only if additional connection status exposure is required)
- Modify: `src/i18n/locales/zh-CN/chat.json`
- Modify: `src/i18n/locales/en/chat.json`
- Modify: `src/i18n/locales/ja/chat.json`
- Modify: `src/i18n/locales/ko/chat.json`

**Step 1: Expose/consume connection state**

Use existing websocket status or add minimal exposed state needed for UI banners.

**Step 2: Add non-blocking status banners**

Show compact status in mobile chat for:

- reconnecting/disconnected
- host unreachable guidance
- session/project invalid fallback messages

**Step 3: Localize new text**

Add concise locale keys for all supported languages used by the app.

**Step 4: Validate**

Run:

```bash
npm run typecheck
npm run build
```

Manual smoke:

- simulate network disconnect/reconnect
- verify banner appears and clears correctly

### Task 7: Final Regression and Device Smoke

**Files:**
- Review all files changed in Tasks 1-6

**Step 1: Automated validation**

Run:

```bash
npm run typecheck
npm run build
```

Expected: all checks pass.

**Step 2: Desktop regression checklist**

- desktop `AppShell` still shows activity bar + secondary sidebar + main content
- existing project overview and workspace flows are unchanged
- existing tabs still switch and render correctly

**Step 3: Mobile checklist**

- bottom tabs work (`Projects / Sessions / Chat`)
- chat can be reached within a few taps
- project/session switching is quick and reliable
- keyboard interaction does not hide composer
- home-screen launch path remains functional

**Step 4: Handoff summary**

Provide a concise implementation summary with:

- files changed
- behavior changed
- known limitations and follow-up items

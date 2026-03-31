# Extensions Overview Workbench Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an Extensions Overview page and wire the Extensions workbench into a three-view structure: overview, skills, and MCP.

**Architecture:** Extend the existing workbench state instead of creating a new routing model. Reuse existing skills and MCP APIs to build lightweight summary cards on a new overview page, and keep all current Skills/MCP pages intact.

**Tech Stack:** React, TypeScript, JSX/TSX, Tailwind utility classes, react-i18next

---

### Task 1: Extend the workbench state model

**Files:**
- Modify: `src/types/workbench.ts`
- Modify: `src/hooks/useWorkbenchNavigation.ts`

**Step 1: Update the `ExtensionsView` union**
- Change `src/types/workbench.ts` so `ExtensionsView` becomes `'overview' | 'skills' | 'mcp'`.

**Step 2: Update the default workbench state**
- Change `DEFAULT_STATE.extensionsView` in `src/hooks/useWorkbenchNavigation.ts` from `'skills'` to `'overview'`.

**Step 3: Update the validator**
- Extend `isExtensionsView()` in `src/hooks/useWorkbenchNavigation.ts` to accept `'overview'`.

**Step 4: Run a narrow typecheck**
Run: `npm run typecheck`
Expected: PASS or new compiler errors only in code paths that still assume two extension views.

**Step 5: Commit**
```bash
git add src/types/workbench.ts src/hooks/useWorkbenchNavigation.ts
git commit -m "refactor: extend extensions workbench state"
```

### Task 2: Add Extensions Overview routing and sidebar navigation

**Files:**
- Modify: `src/components/workbench/extensions/ExtensionsSidebarPanel.tsx`
- Modify: `src/components/workbench/MainContentRouter.tsx`
- Modify: `src/components/app/AppContent.tsx`
- Create: `src/components/workbench/extensions/ExtensionsOverviewPage.tsx`

**Step 1: Update the Extensions sidebar items**
- Add a new first item for `overview` in `ExtensionsSidebarPanel.tsx`.
- Keep `skills` and `mcp` below it.

**Step 2: Update main content routing**
- In `MainContentRouter.tsx`, resolve `extensionsView === 'overview'` to `ExtensionsOverviewPage`.
- Keep current handling for `skills` and `mcp`.

**Step 3: Update activity-bar entry behavior**
- In `AppContent.tsx`, when the user clicks `Extensions`, explicitly set `extensionsView` to `overview`.
- Preserve refresh persistence from `useWorkbenchNavigation` for existing in-view navigation.

**Step 4: Scaffold `ExtensionsOverviewPage.tsx`**
- Create a workbench page shell with header, two main cards, and a bottom summary strip.
- Add props/callbacks for entering Skills, creating a skill, entering MCP, and adding MCP.

**Step 5: Run typecheck**
Run: `npm run typecheck`
Expected: PASS or only expected missing-data errors inside the new overview page.

**Step 6: Commit**
```bash
git add src/components/workbench/extensions/ExtensionsSidebarPanel.tsx src/components/workbench/MainContentRouter.tsx src/components/app/AppContent.tsx src/components/workbench/extensions/ExtensionsOverviewPage.tsx
git commit -m "feat: add extensions overview navigation"
```

### Task 3: Build the overview summary model from existing APIs

**Files:**
- Create: `src/components/workbench/extensions/useExtensionsOverview.ts`
- Optionally modify: `src/components/workbench/extensions/useSkills.ts`
- Optionally modify: `src/components/workbench/extensions/ExtensionsOverviewPage.tsx`

**Step 1: Create a dedicated overview hook**
- Add `useExtensionsOverview.ts` to load summary data from:
  - `api.skills.list()`
  - `api.mcp.claudeConfig()`
  - `api.mcp.codexList()`

**Step 2: Derive normalized summary values**
- Calculate:
  - total skills
  - recent skills
  - total MCP servers
  - Claude MCP count
  - Codex MCP count
  - one or two lightweight status hints

**Step 3: Handle partial failures**
- Keep skills and MCP summaries independent.
- If one side fails, expose an error only for that card instead of failing the whole page.

**Step 4: Wire the overview page to the hook**
- Render loading, partial error, success, and empty states from the new hook.

**Step 5: Run typecheck**
Run: `npm run typecheck`
Expected: PASS.

**Step 6: Commit**
```bash
git add src/components/workbench/extensions/useExtensionsOverview.ts src/components/workbench/extensions/ExtensionsOverviewPage.tsx src/components/workbench/extensions/useSkills.ts
git commit -m "feat: load extensions overview summaries"
```

### Task 4: Add the overview UI and actions

**Files:**
- Modify: `src/components/workbench/extensions/ExtensionsOverviewPage.tsx`

**Step 1: Render the page header**
- Add `OpenWork` eyebrow, title, and short subtitle matching the workbench style.

**Step 2: Render the Skills card**
- Show total skill count.
- Show recent skill items or a compact empty state.
- Add buttons for `Open Skills` and `New Skill`.

**Step 3: Render the MCP card**
- Show total count plus Claude/Codex breakdown.
- Show compact empty or partial state.
- Add buttons for `Open MCP` and `Add MCP`.

**Step 4: Render summary hints**
- Show one or two bottom status items derived from the hook state.
- Keep them short and operational, not analytical.

**Step 5: Ensure actions navigate correctly**
- `Open Skills` -> set `extensionsView` to `skills`
- `New Skill` -> navigate to `skills` and trigger create mode using the existing entry path
- `Open MCP` -> set `extensionsView` to `mcp`
- `Add MCP` -> navigate to `mcp` and open the add form using the existing entry path

**Step 6: Run build**
Run: `npm run build`
Expected: PASS.

**Step 7: Commit**
```bash
git add src/components/workbench/extensions/ExtensionsOverviewPage.tsx
git commit -m "feat: add extensions overview workspace"
```

### Task 5: Add i18n strings for the new overview

**Files:**
- Modify: `src/i18n/locales/zh-CN/sidebar.json`
- Modify: `src/i18n/locales/en/sidebar.json`
- Optionally modify: `src/i18n/locales/ja/sidebar.json`
- Optionally modify: `src/i18n/locales/ko/sidebar.json`

**Step 1: Add `workbench.extensionsOverview` strings**
- Include keys for:
  - nav label
  - title
  - subtitle
  - card titles/descriptions
  - actions
  - empty states
  - summary hints
  - loading/error strings

**Step 2: Wire the page to these keys**
- Replace any temporary copy in `ExtensionsOverviewPage.tsx` with `t()` lookups.

**Step 3: Run typecheck**
Run: `npm run typecheck`
Expected: PASS.

**Step 4: Commit**
```bash
git add src/i18n/locales/zh-CN/sidebar.json src/i18n/locales/en/sidebar.json src/i18n/locales/ja/sidebar.json src/i18n/locales/ko/sidebar.json src/components/workbench/extensions/ExtensionsOverviewPage.tsx
git commit -m "feat: localize extensions overview"
```

### Task 6: Manual validation and regression smoke

**Files:**
- No code changes required if validation passes

**Step 1: Run final validation**
Run:
```bash
npm run typecheck && npm run build
```
Expected: PASS.

**Step 2: Browser smoke in Chinese**
Verify in frontmost Chrome:
- Clicking `扩展` opens `扩展总览`
- Secondary sidebar shows `总览 / Skills / MCP`
- `进入 Skills` opens the Skills workbench
- `进入 MCP` opens the MCP workbench
- `新建技能` enters the current skill-creation flow
- `添加 MCP` enters the current MCP creation flow

**Step 3: Browser smoke in English**
Verify the same interactions after switching language to `en`.

**Step 4: Review for regressions**
- Confirm existing `Skills` and `MCP` pages still render with prior visual and interaction behavior.
- Confirm refresh preserves current extension subview.

**Step 5: Commit**
```bash
git add -A
git commit -m "feat: add extensions overview workbench"
```

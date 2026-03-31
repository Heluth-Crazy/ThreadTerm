# Extensions Overview Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refine `Extensions Overview` so it behaves like a compact extensions management home aligned with the rest of the OpenWork workbench.

**Architecture:** This is a frontend-only refinement of the overview page, its derived summary hook, and its locale strings. The implementation keeps the existing data sources and navigation callbacks, but tightens hierarchy, reduces visual looseness, and rewrites card/hint copy so the page feels operational rather than dashboard-like.

**Tech Stack:** React, TypeScript, Tailwind CSS, i18next, Vite

---

### Task 1: Tighten the overview page shell and card hierarchy

**Files:**
- Modify: `src/components/workbench/extensions/ExtensionsOverviewPage.tsx`
- Reference: `src/components/workbench/projects/ProjectsOverviewPage.tsx`
- Reference: `src/components/workbench/extensions/ExtensionsSkillsPage.tsx`
- Reference: `src/components/workbench/extensions/ExtensionsMcpPage.tsx`

**Step 1: Tighten the header**
- Reduce top spacing and subtitle length treatment.
- Keep refresh as the only header action.

**Step 2: Make Skills and MCP cards parallel**
- Align title, badge, description, action placement, and content hierarchy.
- Reduce internal whitespace to match the current workbench rhythm.

**Step 3: Make Skills recent items read like compact recent-change rows**
- Keep current content but tighten spacing and hierarchy.

**Step 4: Reframe MCP content as configuration summary**
- Keep counts but present them as operational summary rather than status tiles.

**Step 5: Run typecheck**
Run: `npm run typecheck`
Expected: PASS

### Task 2: Refine overview hint semantics

**Files:**
- Modify: `src/components/workbench/extensions/useExtensionsOverview.ts`

**Step 1: Keep partial-failure behavior**
- Do not change the current API resilience pattern.

**Step 2: Refine recommendation ordering**
- Ensure the bottom area always surfaces the most useful guidance first.
- Keep a neutral recommendation when everything is healthy.

**Step 3: Keep hints capped and compact**
- Preserve the lightweight homepage role.

**Step 4: Run typecheck**
Run: `npm run typecheck`
Expected: PASS

### Task 3: Align overview locale copy

**Files:**
- Modify: `src/i18n/locales/zh-CN/sidebar.json`
- Modify: `src/i18n/locales/en/sidebar.json`
- Modify: `src/i18n/locales/ja/sidebar.json`
- Modify: `src/i18n/locales/ko/sidebar.json`

**Step 1: Rewrite overview action labels for consistency**
- Keep localized action phrasing parallel across locales.

**Step 2: Rewrite card descriptions and guidance copy**
- Make them shorter, clearer, and more operational.

**Step 3: Keep locale structure aligned**
- Ensure all overview keys remain parallel across locales.

**Step 4: Run typecheck**
Run: `npm run typecheck`
Expected: PASS

### Task 4: Validate in build and browser

**Files:**
- Verify: `src/components/workbench/extensions/ExtensionsOverviewPage.tsx`
- Verify: `src/components/workbench/extensions/useExtensionsOverview.ts`
- Verify: `src/i18n/locales/zh-CN/sidebar.json`
- Verify: `src/i18n/locales/en/sidebar.json`
- Verify: `src/i18n/locales/ja/sidebar.json`
- Verify: `src/i18n/locales/ko/sidebar.json`

**Step 1: Run production build**
Run: `npm run build`
Expected: PASS

**Step 2: Run browser smoke checks**
- Verify overview loads directly from `Extensions`
- Verify `Skills` and `MCP` cards both render compact summaries
- Verify actions still route correctly
- Verify Chinese copy reads naturally

**Step 3: Record any residual risk**
- Keep unrelated worktree issues separate from this task.

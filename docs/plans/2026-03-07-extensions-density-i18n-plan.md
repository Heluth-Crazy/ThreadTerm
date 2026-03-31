# Extensions Density and I18n Alignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align the `Skills` and `MCP` workbench pages with the existing OpenWork layout rhythm, while cleaning up extensions-domain i18n and preserving all current flows.

**Architecture:** This work stays entirely in the frontend workbench layer. It refines existing pages and editor panes in place, reuses current actions and data hooks, and standardizes copy in locale files without introducing backend or storage changes.

**Tech Stack:** React, TypeScript, Tailwind CSS, i18next, Vite

---

### Task 1: Audit current extensions UI density and i18n drift

**Files:**
- Review: `src/components/workbench/extensions/ExtensionsSkillsPage.tsx`
- Review: `src/components/workbench/extensions/SkillEditorPage.tsx`
- Review: `src/components/workbench/extensions/ExtensionsMcpPage.tsx`
- Review: `src/components/workbench/projects/ProjectsOverviewPage.tsx`
- Review: `src/components/workbench/extensions/ExtensionsOverviewPage.tsx`
- Review: `src/i18n/locales/zh-CN/sidebar.json`
- Review: `src/i18n/locales/en/sidebar.json`
- Review: `src/i18n/locales/ja/sidebar.json`
- Review: `src/i18n/locales/ko/sidebar.json`

**Step 1: Identify spacing and copy mismatches**
- Record the specific header, list, empty-state, form, and toolbar areas that feel looser than `Projects Overview`.
- Record user-visible wording mismatches and hard-coded labels.

**Step 2: Define a page-level density checklist**
- Use `Projects Overview` as the baseline for title spacing, section padding, repeated row spacing, and action sizing.
- Keep the checklist in implementation notes while editing to avoid drifting page by page.

**Step 3: Verify no backend dependency is required**
- Confirm all target changes stay within current frontend files and locale JSON.

**Step 4: Commit working notes if isolated cleanly**
```bash
git add docs/plans/2026-03-07-extensions-density-i18n-design.md docs/plans/2026-03-07-extensions-density-i18n-plan.md
git commit -m "docs: plan extensions density and i18n alignment"
```
If the worktree is too dirty for a focused docs commit, skip the commit and proceed carefully.

### Task 2: Tighten the Skills page shell

**Files:**
- Modify: `src/components/workbench/extensions/ExtensionsSkillsPage.tsx`
- Reference: `src/components/workbench/projects/ProjectsOverviewPage.tsx`

**Step 1: Tighten the page header**
- Reduce vertical gaps between eyebrow, title, subtitle, and controls.
- Keep search, refresh, and create actions in the existing positions.

**Step 2: Tighten group headers and list rows**
- Reduce extra top/bottom spacing around root group labels.
- Reduce row padding and metadata gaps while preserving readability.

**Step 3: Normalize empty/loading/error blocks**
- Match their padding and corner treatment to the current workbench style.

**Step 4: Run typecheck for the page changes**
Run: `npm run typecheck`
Expected: PASS

**Step 5: Commit the shell refinement**
```bash
git add src/components/workbench/extensions/ExtensionsSkillsPage.tsx
git commit -m "refactor: tighten skills workbench shell"
```

### Task 3: Tighten SkillEditorPage without changing behavior

**Files:**
- Modify: `src/components/workbench/extensions/SkillEditorPage.tsx`
- Reference: `src/components/workbench/extensions/ExtensionsSkillsPage.tsx`

**Step 1: Tighten the top editor toolbar**
- Compress spacing for title, badges, edit/preview controls, and action buttons.
- Preserve current actions and state transitions.

**Step 2: Tighten create-state fields and empty state**
- Reduce oversized whitespace in the create form and empty state.
- Keep field order and behavior unchanged.

**Step 3: Keep preview readable while reducing page-length feel**
- Reduce container padding where it creates unnecessary vertical drift.

**Step 4: Run typecheck after editor changes**
Run: `npm run typecheck`
Expected: PASS

**Step 5: Commit the editor refinement**
```bash
git add src/components/workbench/extensions/SkillEditorPage.tsx
git commit -m "refactor: align skill editor with workbench density"
```

### Task 4: Tighten the MCP page shell and server list

**Files:**
- Modify: `src/components/workbench/extensions/ExtensionsMcpPage.tsx`
- Reference: `src/components/workbench/extensions/ExtensionsSkillsPage.tsx`
- Reference: `src/components/workbench/projects/ProjectsOverviewPage.tsx`

**Step 1: Tighten the page header**
- Align title, subtitle, counts, and action rhythm with `Skills`.

**Step 2: Tighten provider cards**
- Reduce header padding and section spacing.
- Keep provider split as `Claude` and `Codex`.

**Step 3: Tighten server rows**
- Reduce row padding and metadata spacing.
- Preserve edit/delete affordances and content ordering.

**Step 4: Normalize empty/loading/error states**
- Match the same visual rhythm used in the rest of the workbench.

**Step 5: Run typecheck after MCP shell changes**
Run: `npm run typecheck`
Expected: PASS

**Step 6: Commit the MCP shell refinement**
```bash
git add src/components/workbench/extensions/ExtensionsMcpPage.tsx
git commit -m "refactor: tighten mcp workbench shell"
```

### Task 5: Rework MCP form layout for denser workbench fit

**Files:**
- Modify: `src/components/workbench/extensions/ExtensionsMcpPage.tsx`

**Step 1: Tighten the form container hierarchy**
- Reduce excess spacing in the form header, badges, and action row.
- Keep close/save behavior unchanged.

**Step 2: Tighten field group layout**
- Group basic identity fields, transport fields, and provider-specific fields more compactly.
- Preserve current conditional rendering for `scope`, `projectPath`, `stdio`, and remote transports.

**Step 3: Keep labels and helper text aligned**
- Ensure field labels visually match the rest of the workbench and do not create unnecessary blank space.

**Step 4: Run typecheck after form changes**
Run: `npm run typecheck`
Expected: PASS

**Step 5: Commit the form refinement**
```bash
git add src/components/workbench/extensions/ExtensionsMcpPage.tsx
git commit -m "refactor: tighten mcp editor form"
```

### Task 6: Clean and align extensions-domain i18n

**Files:**
- Modify: `src/i18n/locales/zh-CN/sidebar.json`
- Modify: `src/i18n/locales/en/sidebar.json`
- Modify: `src/i18n/locales/ja/sidebar.json`
- Modify: `src/i18n/locales/ko/sidebar.json`
- Review: `src/components/workbench/extensions/ExtensionsSkillsPage.tsx`
- Review: `src/components/workbench/extensions/SkillEditorPage.tsx`
- Review: `src/components/workbench/extensions/ExtensionsMcpPage.tsx`
- Review: `src/components/workbench/extensions/ExtensionsOverviewPage.tsx`

**Step 1: Remove wording drift**
- Align action labels, field labels, provider descriptions, and state copy.
- Ensure Chinese mode does not expose leftover English where it should not.

**Step 2: Keep locale structure parallel**
- Make sure all four locale files contain the same keys for the extensions domain.

**Step 3: Re-run typecheck**
Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit locale cleanup**
```bash
git add src/i18n/locales/zh-CN/sidebar.json src/i18n/locales/en/sidebar.json src/i18n/locales/ja/sidebar.json src/i18n/locales/ko/sidebar.json
git commit -m "i18n: align extensions workbench copy"
```

### Task 7: Validate in browser and production build

**Files:**
- Verify: `src/components/workbench/extensions/ExtensionsSkillsPage.tsx`
- Verify: `src/components/workbench/extensions/SkillEditorPage.tsx`
- Verify: `src/components/workbench/extensions/ExtensionsMcpPage.tsx`
- Verify: `src/components/workbench/extensions/ExtensionsOverviewPage.tsx`

**Step 1: Run full typecheck**
Run: `npm run typecheck`
Expected: PASS

**Step 2: Run production build**
Run: `npm run build`
Expected: PASS

**Step 3: Run browser smoke checks**
- Launch dev server
- Verify `Extensions -> Overview -> Skills`
- Verify `Extensions -> Overview -> New Skill`
- Verify `Extensions -> Overview -> MCP`
- Verify `Extensions -> Overview -> Add MCP`
- Verify `zh-CN` and `en` basic copy

**Step 4: Record any residual risks**
- Note any existing non-blocking CSS warnings or unrelated dirty-worktree issues separately.

**Step 5: Commit final verification-safe changes**
```bash
git add src/components/workbench/extensions/ExtensionsSkillsPage.tsx src/components/workbench/extensions/SkillEditorPage.tsx src/components/workbench/extensions/ExtensionsMcpPage.tsx src/i18n/locales/zh-CN/sidebar.json src/i18n/locales/en/sidebar.json src/i18n/locales/ja/sidebar.json src/i18n/locales/ko/sidebar.json
git commit -m "refactor: align extensions pages with workbench density"
```

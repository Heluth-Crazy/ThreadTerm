# Overview Polish And Extensions I18n Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Polish the `Projects` continue-working overview for tighter hierarchy and better operational clarity, while adding complete `zh-CN + en` i18n coverage for the `Extensions -> Skills` and `Extensions -> MCP` pages.

**Architecture:** Keep the current workbench routing and existing backend APIs intact. Refine the `ProjectsOverviewPage` presentation in place, then extract all user-facing English strings in the Skills and MCP workbench pages into i18n-backed keys using the existing locale structure.

**Tech Stack:** React 18, TypeScript, React i18next, Tailwind CSS, lucide-react, existing OpenWork frontend architecture

---

## Constraints And Notes

- Do not redesign workbench routing or project/session transport in this slice.
- Do not introduce a new test framework.
- Validation remains:
  - `npm run typecheck`
  - `npm run build`
  - manual browser smoke checks with language switching
- Language scope for this slice is explicitly:
  - `zh-CN`
  - `en`
- `ja` and `ko` may remain partially untranslated for the new Extensions copy in this slice.
- Avoid broad visual rewrites. This is a polish pass, not a new layout concept.

### Task 1: Audit Current Overview And Extensions Copy Surface

**Files:**
- Inspect: `src/components/workbench/projects/ProjectsOverviewPage.tsx`
- Inspect: `src/components/workbench/extensions/ExtensionsSkillsPage.tsx`
- Inspect: `src/components/workbench/extensions/SkillEditorPage.tsx`
- Inspect: `src/components/workbench/extensions/ExtensionsMcpPage.tsx`
- Inspect: `src/i18n/locales/zh-CN/sidebar.json`
- Inspect: `src/i18n/locales/en/sidebar.json`
- Inspect: `src/i18n/locales/zh-CN/common.json`
- Inspect: `src/i18n/locales/en/common.json`

**Step 1: Inventory Overview polish targets**

List the exact UI areas to tighten inside `ProjectsOverviewPage.tsx`:
- section padding and vertical gaps
- recent-session row density and text hierarchy
- quick-start tile hierarchy and icon treatment
- starred/recent project list rhythm and metadata treatment

Expected outcome: a concrete checklist of 4 polish targets before editing begins.

**Step 2: Inventory all Extensions strings still hardcoded in English**

Record all user-facing labels/messages in:
- `ExtensionsSkillsPage.tsx`
- `SkillEditorPage.tsx`
- `ExtensionsMcpPage.tsx`

Expected outcome: every visible string is accounted for before i18n edits begin.

**Step 3: Commit the plan**

```bash
git add docs/plans/2026-03-07-overview-polish-extensions-i18n-plan.md
git commit -m "docs: add overview polish and extensions i18n plan"
```

### Task 2: Polish Projects Overview Density And Hierarchy

**Files:**
- Modify: `src/components/workbench/projects/ProjectsOverviewPage.tsx`

**Step 1: Tighten section spacing without collapsing readability**

Reduce excess height in:
- page wrapper gaps
- hero/main card padding
- card header spacing
- row vertical padding where safe

The first screen should reveal more useful content without feeling cramped.

**Step 2: Refine recent-session rows**

Adjust the session row so that:
- title remains dominant
- provider/project metadata is clearer and more compact
- time and affordance do not visually compete with the title
- repeated whitespace between row elements is reduced

Expected behavior: rows feel more like operational list items than generic cards.

**Step 3: Refine quick-start tiles**

Adjust quick-start actions so they read as workbench commands, not feature promos:
- slightly reduce descriptive text weight/space
- keep click targets clear
- ensure the four actions read as one control group

**Step 4: Refine project lists**

Adjust starred/recent project entries to be more list-like:
- tighter rows
- clearer separation between project label and path
- quieter timestamp/right-side affordance

**Step 5: Run validation**

Run:
```bash
npm run typecheck
npm run build
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/components/workbench/projects/ProjectsOverviewPage.tsx
git commit -m "style: polish projects overview hierarchy"
```

### Task 3: Add I18n Coverage For Skills Workbench

**Files:**
- Modify: `src/components/workbench/extensions/ExtensionsSkillsPage.tsx`
- Modify: `src/components/workbench/extensions/SkillEditorPage.tsx`
- Modify: `src/i18n/locales/zh-CN/sidebar.json`
- Modify: `src/i18n/locales/en/sidebar.json`
- Optional if a better namespace fit emerges: `src/i18n/locales/zh-CN/common.json`, `src/i18n/locales/en/common.json`

**Step 1: Introduce localized keys for Skills list states**

Move all visible Skills page copy into i18n, including:
- page titles/subtitles
- empty states
- loading/error states
- buttons/actions
- helper copy and validation messages

**Step 2: Introduce localized keys for Skill editor states**

Move all visible Skill editor copy into i18n, including:
- editor headings
- metadata labels
- save/create/delete actions
- placeholder/help text
- validation or error messages

**Step 3: Keep key structure coherent**

Prefer a stable shape such as:
- `workbench.skills.*`
- `workbench.skills.editor.*`

Do not scatter one-off keys across unrelated namespaces unless an existing shared string clearly fits.

**Step 4: Run validation**

Run:
```bash
npm run typecheck
npm run build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/workbench/extensions/ExtensionsSkillsPage.tsx src/components/workbench/extensions/SkillEditorPage.tsx src/i18n/locales/zh-CN/sidebar.json src/i18n/locales/en/sidebar.json src/i18n/locales/zh-CN/common.json src/i18n/locales/en/common.json
git commit -m "feat: localize skills workbench"
```

### Task 4: Add I18n Coverage For MCP Workbench

**Files:**
- Modify: `src/components/workbench/extensions/ExtensionsMcpPage.tsx`
- Modify: `src/i18n/locales/zh-CN/sidebar.json`
- Modify: `src/i18n/locales/en/sidebar.json`
- Optional if shared form labels already exist elsewhere: `src/i18n/locales/zh-CN/common.json`, `src/i18n/locales/en/common.json`

**Step 1: Extract all visible MCP strings**

Localize all visible MCP page copy, including:
- section titles/descriptions
- add/edit/delete labels
- provider/scope hints
- form labels/placeholders
- empty states
- errors and success status text

**Step 2: Normalize key organization**

Prefer a consistent structure such as:
- `workbench.mcp.*`
- `workbench.mcp.form.*`

Keep terminology consistent between Chinese and English.

**Step 3: Run validation**

Run:
```bash
npm run typecheck
npm run build
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/components/workbench/extensions/ExtensionsMcpPage.tsx src/i18n/locales/zh-CN/sidebar.json src/i18n/locales/en/sidebar.json src/i18n/locales/zh-CN/common.json src/i18n/locales/en/common.json
git commit -m "feat: localize mcp workbench"
```

### Task 5: Manual Browser Smoke With Language Switching

**Files:**
- Verify only: `src/components/workbench/projects/ProjectsOverviewPage.tsx`
- Verify only: `src/components/workbench/extensions/ExtensionsSkillsPage.tsx`
- Verify only: `src/components/workbench/extensions/SkillEditorPage.tsx`
- Verify only: `src/components/workbench/extensions/ExtensionsMcpPage.tsx`

**Step 1: Start local dev server**

Run:
```bash
npm run dev
```

Expected: Vite and server both start successfully.

**Step 2: Smoke-check Overview polish**

Verify in browser:
- first screen shows more useful content with tighter spacing
- recent-session rows are visually clearer and denser
- quick-start actions still read clearly and click correctly
- project list rows remain readable and easier to scan

**Step 3: Smoke-check Extensions in Chinese**

Switch app language to Chinese and verify:
- Skills page titles/actions/empty states are Chinese
- Skill editor labels/actions/help text are Chinese
- MCP page titles/forms/buttons/statuses are Chinese
- no obvious raw English strings remain on those pages except technical proper nouns that should remain untranslated

**Step 4: Smoke-check Extensions in English**

Switch app language to English and verify:
- all newly localized strings read correctly in English
- no missing-key output appears

**Step 5: Final validation**

Run:
```bash
npm run typecheck
npm run build
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/components/workbench/projects/ProjectsOverviewPage.tsx src/components/workbench/extensions/ExtensionsSkillsPage.tsx src/components/workbench/extensions/SkillEditorPage.tsx src/components/workbench/extensions/ExtensionsMcpPage.tsx src/i18n/locales/zh-CN/sidebar.json src/i18n/locales/en/sidebar.json src/i18n/locales/zh-CN/common.json src/i18n/locales/en/common.json
git commit -m "test: verify overview polish and extensions i18n"
```

## Expected End State

After completing this plan:
- the `Projects` overview feels tighter and more deliberate without changing its approved structure
- the Skills and MCP workbench surfaces support complete `zh-CN + en` copy coverage
- language switching no longer leaves those pages largely in English for Chinese users
- the slice is validated through typecheck, build, and manual browser smoke

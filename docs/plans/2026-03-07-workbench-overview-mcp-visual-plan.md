# Workbench Overview And MCP Visual Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Tighten and unify the visual hierarchy of the Projects Overview and MCP workbench pages without changing any functional behavior.

**Architecture:** Keep all existing state and API flows intact, and limit changes to component structure, utility class composition, and copy presentation. Reuse the denser workbench styling direction already established in Skills.

**Tech Stack:** React, TypeScript, Tailwind utility classes, react-i18next

---

### Task 1: Refine Projects Overview layout rhythm

**Files:**
- Modify: `src/components/workbench/projects/ProjectsOverviewPage.tsx`

**Step 1: Tighten section container rhythm**
- Reduce outer vertical spacing between overview sections.
- Keep current structure but compress hero card and follow-up sections.

**Step 2: Tighten row density**
- Reduce padding and gaps for recent session rows, quick-start tiles, and project rows.
- Preserve readability for timestamps and provider badges.

**Step 3: Align empty state styling**
- Make empty states visually consistent with compact workbench panels.

**Step 4: Preserve current behavior**
- Do not change project/session sorting, click actions, or navigation behavior.

### Task 2: Refine MCP page hierarchy

**Files:**
- Modify: `src/components/workbench/extensions/ExtensionsMcpPage.tsx`

**Step 1: Densify page header**
- Make header spacing and action grouping match the workbench style used in Skills.

**Step 2: Strengthen provider section hierarchy**
- Use clearer badge/count/action composition for provider sections.
- Keep add/edit/delete behavior unchanged.

**Step 3: Improve server row information grouping**
- Present transport/scope and metadata with clearer separation.
- Maintain current displayed fields.

**Step 4: Tighten form panel rhythm**
- Reduce spacing and align footer actions with the rest of the workbench.

### Task 3: Validate and smoke test

**Files:**
- No code changes required if validation passes

**Step 1: Run typecheck**
- Run: `npm run typecheck`

**Step 2: Run production build**
- Run: `npm run build`

**Step 3: Browser verify Chinese pages**
- Check `Projects Overview` and `MCP`

**Step 4: Browser verify English pages**
- Check `Projects Overview` and `MCP`

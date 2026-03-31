# Settings Workbench Visual Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify the embedded Settings workbench with the rest of the OpenWork workbench visual system without changing functional behavior.

**Architecture:** Keep routing, state, and persistence exactly as-is. Limit changes to JSX structure, utility classes, and a few high-visibility child components that render inside Settings.

**Tech Stack:** React, JSX, Tailwind utility classes, react-i18next

---

### Task 1: Refine embedded Settings shell

**Files:**
- Modify: `src/components/Settings.jsx`

**Step 1: Update embedded header rhythm**
- Make the embedded header match workbench cards and typography.

**Step 2: Restyle tab navigation**
- Keep the same tabs and switching behavior.
- Present them with a denser segmented-control style.

**Step 3: Tighten footer actions**
- Keep save/cancel behavior the same.
- Make the footer match the workbench action rhythm.

### Task 2: Refine key child components

**Files:**
- Modify: `src/components/settings/AgentListItem.jsx`
- Modify: `src/components/LanguageSelector.jsx`
- Modify: `src/components/GitSettings.jsx`

**Step 1: Restyle agent list item**
- Make desktop and mobile agent selectors visually consistent with workbench side lists.

**Step 2: Restyle language selector card**
- Keep language switching logic unchanged.
- Align card spacing and select styling with current workbench panels.

**Step 3: Restyle git settings card**
- Keep git config behavior unchanged.
- Align section spacing and action styling with workbench cards.

### Task 3: Validate and smoke test

**Files:**
- No code changes required if validation passes

**Step 1: Run typecheck**
- Run: `npm run typecheck`

**Step 2: Run build**
- Run: `npm run build`

**Step 3: Browser verify settings in Chinese**
- Check header, tabs, embedded content, and footer rhythm

**Step 4: Browser verify settings in English**
- Check the same embedded settings surfaces after language switch

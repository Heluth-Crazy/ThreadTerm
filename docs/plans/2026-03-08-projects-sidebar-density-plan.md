# Projects Sidebar Density Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Tighten the Projects tree and session list density while keeping all existing information and behavior intact.

**Architecture:** Apply a UI-only pass to the sidebar header, project rows, session subtree, and session rows. Preserve the current data flow and callbacks, and limit changes to Tailwind classes and light structural wrappers where needed for cleaner feedback states.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, i18next, Vite

---

### Task 1: Tighten sidebar header and search rhythm

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarHeader.tsx`
- Inspect: `src/components/sidebar/view/subcomponents/SidebarContent.tsx`

**Step 1: Review current desktop and mobile header spacing**

Check the top controls, divider, and search field spacing.

**Step 2: Reduce excess whitespace without shrinking usability**

Adjust margins, button hover feel, and search placement so the header sits more tightly within the updated Projects shell.

**Step 3: Run static validation**

Run: `npm run typecheck`
Expected: PASS

### Task 2: Tighten project row density and hover/selected feedback

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx`

**Step 1: Review desktop and mobile project row structure**

Identify the row padding, icon blocks, secondary meta spacing, and action button reveal behavior.

**Step 2: Reduce row slack while preserving all visible information**

Adjust padding, spacing, icon sizing rhythm, and selected/hover styling for both desktop and mobile rows.

**Step 3: Keep edit/delete/new-session actions intact**

Ensure action affordances remain reachable and readable.

**Step 4: Run static validation**

Run: `npm run typecheck`
Expected: PASS

### Task 3: Tighten session subtree and session row density

**Files:**
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx`

**Step 1: Review indentation and session row spacing**

Check the subtree wrapper, row spacing, and action reveal area.

**Step 2: Reduce indentation and row padding slightly**

Keep hierarchy readable while making the list feel more compact.

**Step 3: Refine hover/selected/action states**

Make action reveal smoother and selected rows more stable.

**Step 4: Run static validation**

Run: `npm run typecheck`
Expected: PASS

### Task 4: Browser smoke and final verification

**Files:**
- Review changed files only

**Step 1: Start dev server**

Run: `npm run dev`
Expected: app loads normally

**Step 2: Verify sidebar interactions**

Confirm:

- search still works
- project rows still expand/collapse
- session rows still select correctly
- hover actions still appear and remain clickable

**Step 3: Run full validation**

Run: `npm run typecheck && npm run build`
Expected: PASS

**Step 4: Stop dev server and summarize**

Provide a concise summary focused on density/interaction improvements and preserved behavior.

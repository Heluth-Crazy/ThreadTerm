# File Access Assessment And Terminal-First Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Assess main-path file access flows, define a global file access mode, and prepare the highest-risk project-file paths for terminal-first migration without changing current product scope.

**Architecture:** First produce a graded inventory of file-access entry points across the current repository, focusing on project files, chat references, terminal, Git, and command flows. Then design a global file access mode and a managed terminal-backed file channel so the highest-risk project-file APIs can migrate away from direct backend process reads/writes in a controlled order.

**Tech Stack:** Node.js, Express, React 18, TypeScript/JSX, Tailwind CSS, Vite, node-pty / terminal-backed execution concepts

---

### Task 1: Build the main-path file access inventory

**Files:**
- Review: `server/index.js`
- Review: `server/routes/projects.js`
- Review: `server/routes/git.js`
- Review: `server/routes/commands.js`
- Review: `src/components/FileTree.jsx`
- Review: `src/components/CodeEditor.jsx`
- Review: `src/components/ImageViewer.jsx`
- Review: `src/components/chat/ChatPanel.tsx`
- Review: `src/components/GitPanel.jsx`
- Review: `src/utils/api.js`
- Create: `docs/plans/2026-03-08-file-access-assessment-report.md`

**Step 1: Enumerate frontend user entry points**

List each user-facing file interaction on the main path, including file tree loading, file reading, file saving, image preview, chat file references, Git file views, and command-related file usage.

**Step 2: Map each frontend entry to backend endpoints**

Record which route or server handler serves each action.

**Step 3: Record the actual file I/O implementation style**

For each backend endpoint, classify whether it uses:

- direct process-level `fs`/`fsPromises`
- CLI/terminal-driven execution
- mixed mode
- no project file content access

**Step 4: Assign initial severity and migration candidacy**

For each entry, assign `P0`, `P1`, or `P2` and note whether it should migrate in phase 1.

**Step 5: Save the assessment report**

Write the results into `docs/plans/2026-03-08-file-access-assessment-report.md` in a table or structured list.

### Task 2: Compare with the Windows reference repository only where relevant

**Files:**
- Review: `../openwork-source-v1.21.0-20260306-1030/server/index.js`
- Review: `../openwork-source-v1.21.0-20260306-1030/server/openai-codex.js`
- Review: `../openwork-source-v1.21.0-20260306-1030/src/components/Shell.jsx`
- Update: `docs/plans/2026-03-08-file-access-assessment-report.md`

**Step 1: Restrict comparison scope**

Only compare terminal/codex/file-access patterns that are directly relevant to the main-path migration problem.

**Step 2: Record reusable implementation ideas, not feature diffs**

Document only the terminal-oriented patterns that may be reused, and explicitly avoid treating the older repository as the feature source of truth.

**Step 3: Add a “reference findings” section to the assessment report**

Capture what is reusable versus what is incompatible with the current repository.

### Task 3: Audit hidden-or-legacy modules without deleting them yet

**Files:**
- Review: `server/routes/taskmaster.js`
- Review: `server/routes/mcp-utils.js`
- Review: `src/components/TaskMaster*.jsx`
- Review: contexts or settings files that reference TaskMaster or related hidden flows
- Update: `docs/plans/2026-03-08-file-access-assessment-report.md`

**Step 1: Identify residual call chains**

For each hidden or weakly-reachable module, note imports, routes, UI references, and indirect dependencies.

**Step 2: Classify reachability and removal risk**

Mark each candidate as:

- still reachable
- indirectly coupled
- likely removable later
- unknown / needs separate review

**Step 3: Add a cleanup backlog section**

Do not delete code yet; only append cleanup recommendations and risks to the report.

### Task 4: Define the global file access mode contract

**Files:**
- Create or update design notes in `docs/plans/2026-03-08-file-access-assessment-report.md`
- Review: `src/components/Settings.jsx`
- Review: relevant settings storage code

**Step 1: Define user-facing modes**

Document the three modes:

- `自动`
- `兼容模式`
- `高性能模式`

and their internal names:

- `Auto`
- `Terminal First`
- `Direct`

**Step 2: Define default platform behavior**

Document the `Auto` mapping:

- Windows prefers terminal-first
- macOS prefers direct

**Step 3: Define no-silent-fallback behavior**

Document that when a terminal-first path is required but not available, the system must surface the limitation and wait for user decision instead of silently falling back.

### Task 5: Design the managed terminal-backed file channel

**Files:**
- Update: `docs/plans/2026-03-08-file-access-assessment-report.md`
- Review: `src/components/Shell.jsx`
- Review: `server/index.js`

**Step 1: Describe the channel boundary**

Specify that file operations should use a dedicated managed terminal-backed channel rather than visible interactive panes.

**Step 2: Define the first supported operations**

Document a minimal internal operation set for phase 1, such as:

- list files
- read text file
- write text file
- create directory
- fetch metadata
- binary file access strategy

**Step 3: Record platform concerns**

Document Windows vs POSIX shell adaptation concerns, quoting rules, encoding, and binary transport limitations.

### Task 6: Prepare the phase-1 remediation sequence

**Files:**
- Update: `docs/plans/2026-03-08-file-access-assessment-report.md`

**Step 1: Choose the P0 migration order**

Recommend the order for first implementation, starting with the project file APIs most likely to fail in the Windows environment.

**Step 2: Separate P1 and P2 work**

Leave Git mixed flows and extension/config modules in later phases unless phase-1 dependencies force earlier action.

**Step 3: Record explicit deferrals**

State that chat slash-command autocomplete remains paused until this foundation is approved.

### Task 7: Final review and planning handoff

**Files:**
- Review: `docs/plans/2026-03-08-file-access-assessment-terminal-first-design.md`
- Review: `docs/plans/2026-03-08-file-access-assessment-report.md`
- Review: `docs/plans/2026-03-08-file-access-assessment-terminal-first-plan.md`

**Step 1: Review report completeness**

Ensure the report includes inventory, severity, hidden-module audit notes, reference findings, global mode contract, and migration order.

**Step 2: Summarize unresolved decisions**

Call out any file categories, binary flows, or module dependencies that still require user approval.

**Step 3: Present remediation entry point**

Recommend starting implementation with the first P0 file-access endpoint after user approval.

# OpenWork Workbench Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a VS Code-style OpenWork shell with `Projects`, `Extensions`, and `Settings`, move `MCP` out of Settings into `Extensions`, add `Skills` management, and align visible branding to `OpenWork`.

**Architecture:** Add a shell-level navigation state above the current project/session model instead of rewriting the runtime. Reuse the existing project workspace components, migrate MCP UI into a new Extensions domain, and add backend-driven skill discovery/editing APIs so macOS and Windows remain compatible.

**Tech Stack:** React 18, TypeScript/JSX, Vite, Tailwind, Express, Electron, CodeMirror, i18next

---

## Preconditions

- Work on a branch or worktree before implementation.
- Do not rename the local checkout folder automatically.
- Treat `OpenWork` as the product name everywhere user-facing.
- Because the repo has no frontend test harness, validate each slice with `npm run typecheck`, `npm run build`, and targeted manual checks in web and desktop builds.

### Task 1: Audit naming and shell entry points

**Files:**
- Modify: `src/components/app/AppContent.tsx`
- Modify: `src/components/sidebar/view/Sidebar.tsx`
- Modify: `src/components/main-content/view/MainContent.tsx`
- Modify: `src/components/Settings.jsx`
- Modify: `electron/main.cjs`
- Modify: `package.json`
- Modify: `src/i18n/locales/zh-CN/sidebar.json`
- Modify: `src/i18n/locales/en/sidebar.json`
- Modify: `src/i18n/locales/ko/sidebar.json`
- Modify: `src/i18n/locales/ja/sidebar.json`

**Step 1: Inventory remaining legacy product strings**

Run:
```bash
rg -n "claudecodeui|Claude Code Desktop|claude code desktop|claudecodeui" src electron server docs package.json
```
Expected: a list of remaining user-facing strings and metadata references.

**Step 2: Add a temporary migration checklist comment in the plan branch notes**

Capture the exact files that still render product names before making shell changes.

**Step 3: Normalize user-facing product labels to `OpenWork`**

Target visible strings such as window title, app label, and shell headers.

Example snippet:
```js
const PRODUCT_NAME = 'OpenWork';
```

**Step 4: Run baseline validation**

Run:
```bash
npm run typecheck
npm run build
```
Expected: current baseline passes before large shell edits.

**Step 5: Commit**

```bash
git add package.json src electron docs/plans
git commit -m "chore: align product naming for openwork shell"
```

### Task 2: Introduce shell-level navigation state

**Files:**
- Create: `src/hooks/useWorkbenchNavigation.ts`
- Create: `src/types/workbench.ts`
- Modify: `src/components/app/AppContent.tsx`
- Modify: `src/types/app.ts`
- Modify: `src/hooks/useUiPreferences.ts`

**Step 1: Add top-level shell types**

Create `src/types/workbench.ts` with:
```ts
export type WorkbenchNav = 'projects' | 'extensions' | 'settings';
export type ProjectsView = 'overview' | 'workspace';
export type ExtensionsView = 'skills' | 'mcp';

export type WorkbenchState = {
  activeNav: WorkbenchNav;
  projectsView: ProjectsView;
  extensionsView: ExtensionsView;
};
```

**Step 2: Add persisted navigation hook**

Create `src/hooks/useWorkbenchNavigation.ts` that reads/writes:
```ts
const STORAGE_KEY = 'openwork.workbench';
```
and returns setters for `activeNav`, `projectsView`, and `extensionsView`.

**Step 3: Mount workbench state in `AppContent`**

Pass the new shell state alongside existing `selectedProject`, `selectedSession`, and `activeTab`.

**Step 4: Validate typing**

Run:
```bash
npm run typecheck
```
Expected: new shell types compile cleanly.

**Step 5: Commit**

```bash
git add src/hooks/useWorkbenchNavigation.ts src/types/workbench.ts src/components/app/AppContent.tsx src/hooks/useUiPreferences.ts src/types/app.ts
git commit -m "feat: add workbench navigation state"
```

### Task 3: Build the Activity Bar shell

**Files:**
- Create: `src/components/workbench/ActivityBar.tsx`
- Create: `src/components/workbench/AppShell.tsx`
- Modify: `src/components/app/AppContent.tsx`
- Modify: `src/index.css`
- Modify: `src/i18n/locales/zh-CN/sidebar.json`
- Modify: `src/i18n/locales/en/sidebar.json`
- Modify: `src/i18n/locales/ko/sidebar.json`
- Modify: `src/i18n/locales/ja/sidebar.json`

**Step 1: Create Activity Bar component**

Implement buttons for `Projects`, `Extensions`, `Settings` using explicit ids:
```tsx
const NAV_ITEMS = [
  { id: 'projects', label: t('nav.projects') },
  { id: 'extensions', label: t('nav.extensions') },
  { id: 'settings', label: t('nav.settings') },
];
```

**Step 2: Create shell wrapper layout**

`AppShell` should render:
```tsx
<div className="flex h-full">
  <ActivityBar ... />
  <SecondarySidebarRouter ... />
  <MainContentRouter ... />
</div>
```
Use placeholder children first so layout can ship incrementally.

**Step 3: Replace direct `Sidebar + MainContent` composition in `AppContent`**

Wrap existing content with `AppShell`, but keep current `Sidebar` and `MainContent` mounted through compatibility props.

**Step 4: Validate layout**

Run:
```bash
npm run typecheck
npm run build
```
Then manually verify in browser: the narrow first column renders and switches active state without breaking the existing project workspace.

**Step 5: Commit**

```bash
git add src/components/workbench src/components/app/AppContent.tsx src/index.css src/i18n/locales
git commit -m "feat: add workbench activity bar shell"
```

### Task 4: Route the secondary sidebar by domain

**Files:**
- Create: `src/components/workbench/SecondarySidebarRouter.tsx`
- Create: `src/components/workbench/projects/ProjectsSidebarPanel.tsx`
- Create: `src/components/workbench/extensions/ExtensionsSidebarPanel.tsx`
- Create: `src/components/workbench/settings/SettingsSidebarPanel.tsx`
- Modify: `src/components/sidebar/view/Sidebar.tsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarContent.tsx`
- Modify: `src/components/app/AppContent.tsx`

**Step 1: Extract current project sidebar usage into `ProjectsSidebarPanel`**

Keep the current project list behavior, but add an explicit `Overview` entry above the list.

**Step 2: Create extensions and settings sidebars**

Use minimal nav lists first:
```tsx
['skills', 'mcp']
['general', 'account', 'agent', 'permissions', 'git']
```
Do not include `mcp` in the settings sidebar.

**Step 3: Add `SecondarySidebarRouter`**

Switch on `activeNav` and render the correct panel.

**Step 4: Validate domain switching**

Run:
```bash
npm run typecheck
```
Manual check: switching between top-level domains changes the second column instead of the main workspace only.

**Step 5: Commit**

```bash
git add src/components/workbench src/components/sidebar/view src/components/app/AppContent.tsx
git commit -m "feat: route secondary sidebar by workbench domain"
```

### Task 5: Add the Projects overview page

**Files:**
- Create: `src/components/workbench/projects/ProjectsOverviewPage.tsx`
- Create: `src/components/workbench/MainContentRouter.tsx`
- Modify: `src/components/main-content/view/MainContent.tsx`
- Modify: `src/components/app/AppContent.tsx`
- Modify: `src/hooks/useProjectsState.ts`
- Modify: `src/utils/dateUtils.ts`

**Step 1: Create a dedicated projects overview page**

Render sections for:
```tsx
['quick-actions', 'starred-projects', 'recent-projects', 'continue-session', 'environment-status']
```
Populate with existing project/session data only; no new backend calls yet unless required.

**Step 2: Add a main-content router**

Route:
```ts
if (activeNav === 'projects' && projectsView === 'overview') return <ProjectsOverviewPage ... />;
if (activeNav === 'projects' && projectsView === 'workspace') return <MainContent ... />;
```

**Step 3: Wire project and session selection transitions**

Rules:
- clicking `Overview` sets `projectsView = 'overview'`
- clicking a project sets `projectsView = 'workspace'`
- clicking a session sets `projectsView = 'workspace'`

**Step 4: Validate project flow**

Run:
```bash
npm run typecheck
npm run build
```
Manual check: overview loads by default, and entering a project returns to the existing workspace.

**Step 5: Commit**

```bash
git add src/components/workbench src/components/app/AppContent.tsx src/components/main-content/view/MainContent.tsx src/hooks/useProjectsState.ts src/utils/dateUtils.ts
git commit -m "feat: add projects overview page"
```

### Task 6: Move MCP out of Settings and into Extensions

**Files:**
- Create: `src/components/workbench/extensions/ExtensionsMcpPage.tsx`
- Modify: `src/components/settings/McpServersContent.jsx`
- Modify: `src/components/Settings.jsx`
- Modify: `src/components/workbench/MainContentRouter.tsx`
- Modify: `src/components/workbench/extensions/ExtensionsSidebarPanel.tsx`
- Modify: `src/i18n/locales/zh-CN/settings.json`
- Modify: `src/i18n/locales/en/settings.json`
- Modify: `src/i18n/locales/ko/settings.json`
- Modify: `src/i18n/locales/ja/settings.json`

**Step 1: Rehost the existing MCP content into an extensions page**

Wrap or rename the existing component so it can render in the extensions main panel.

**Step 2: Remove MCP from Settings navigation and selection logic**

Delete the settings tab/entry and any default-tab fallback that points to MCP.

**Step 3: Render `ExtensionsMcpPage` from the workbench router**

Example:
```tsx
if (activeNav === 'extensions' && extensionsView === 'mcp') {
  return <ExtensionsMcpPage agent="claude" ... />;
}
```
Extend later for per-agent sections if needed.

**Step 4: Validate migration**

Run:
```bash
npm run typecheck
npm run build
```
Manual check: MCP is reachable only from `Extensions`, not from `Settings`.

**Step 5: Commit**

```bash
git add src/components/workbench src/components/settings/McpServersContent.jsx src/components/Settings.jsx src/i18n/locales
 git commit -m "refactor: move mcp management into extensions"
```

### Task 7: Add backend skill discovery and editing APIs

**Files:**
- Create: `server/routes/skills.js`
- Create: `server/utils/skills.js`
- Modify: `server/index.js`
- Modify: `server/utils/paths.cjs`
- Modify: `server/routes/codex.js`
- Modify: `server/routes/agent.js`

**Step 1: Add skill discovery utilities**

Implement backend functions similar to:
```js
export async function listSkills() {}
export async function readSkill(skillId) {}
export async function writeSkill({ targetRoot, slug, content }) {}
export async function deleteSkill(skillId) {}
```
Return normalized records with:
```js
{ id, name, description, provider, path, writable, updatedAt }
```

**Step 2: Resolve platform-specific roots on the server**

Use `os.homedir()` and existing path utilities to discover Claude and Codex skill directories per platform.

**Step 3: Mount REST routes**

Add endpoints:
```txt
GET /api/skills
GET /api/skills/:id
POST /api/skills
PUT /api/skills/:id
DELETE /api/skills/:id
```

**Step 4: Validate backend endpoints**

Run:
```bash
npm run server
```
Then manually call the endpoints with `curl` or browser devtools to confirm returned JSON is normalized and path-safe.

**Step 5: Commit**

```bash
git add server/routes/skills.js server/utils/skills.js server/index.js server/utils/paths.cjs server/routes/codex.js server/routes/agent.js
git commit -m "feat: add backend skill management apis"
```

### Task 8: Add Skills list and editor UI

**Files:**
- Create: `src/components/workbench/extensions/ExtensionsSkillsPage.tsx`
- Create: `src/components/workbench/extensions/SkillEditorPage.tsx`
- Create: `src/components/workbench/extensions/SkillListItem.tsx`
- Create: `src/components/workbench/extensions/useSkills.ts`
- Modify: `src/components/workbench/MainContentRouter.tsx`
- Modify: `src/utils/api.js`
- Modify: `src/components/CodeEditor.jsx`
- Modify: `src/i18n/locales/zh-CN/settings.json`
- Modify: `src/i18n/locales/en/settings.json`
- Modify: `src/i18n/locales/ko/settings.json`
- Modify: `src/i18n/locales/ja/settings.json`

**Step 1: Add client API wrappers**

In `src/utils/api.js`, add wrappers for the new `/api/skills` endpoints.

**Step 2: Implement `ExtensionsSkillsPage`**

The page should render:
```tsx
<SkillList />
<SkillDetailOrEditor />
```
using server-provided skill metadata.

**Step 3: Implement Markdown editing flow**

Use the existing editor foundation if possible, otherwise a lightweight CodeMirror markdown setup:
```tsx
<CodeEditor language="markdown" value={content} onChange={setContent} />
```
Support create, edit, save, delete, and template insertion.

**Step 4: Validate skill management UX**

Run:
```bash
npm run typecheck
npm run build
```
Manual checks:
- open `Extensions -> Skills`
- view discovered skills
- create a new skill
- edit and save `SKILL.md`
- confirm saved content reloads correctly

**Step 5: Commit**

```bash
git add src/components/workbench src/utils/api.js src/components/CodeEditor.jsx src/i18n/locales server
git commit -m "feat: add skills management ui"
```

### Task 9: Persist restore behavior across domains

**Files:**
- Modify: `src/components/app/AppContent.tsx`
- Modify: `src/hooks/useWorkbenchNavigation.ts`
- Modify: `src/components/main-content/view/MainContent.tsx`
- Modify: `src/components/main-content/view/subcomponents/MainContentHeader.tsx`
- Modify: `src/hooks/useLocalStorage.jsx`

**Step 1: Persist top-level navigation and subview state**

Store:
```ts
activeNav
projectsView
extensionsView
activeTab
lastProjectName
lastSessionId
```

**Step 2: Restore state safely on startup**

If a saved project/session no longer exists, fall back to:
```ts
activeNav = 'projects';
projectsView = 'overview';
```

**Step 3: Make headers domain-aware**

Ensure the main header labels and tab switchers behave correctly when not inside a project workspace.

**Step 4: Validate restoration**

Run:
```bash
npm run typecheck
npm run build
```
Manual checks:
- refresh on `Projects -> Overview`
- refresh on `Extensions -> Skills`
- refresh inside a project chat session
- confirm each returns to the correct domain/view

**Step 5: Commit**

```bash
git add src/components/app/AppContent.tsx src/hooks/useWorkbenchNavigation.ts src/components/main-content/view src/hooks/useLocalStorage.jsx
git commit -m "feat: persist workbench navigation state"
```

### Task 10: Finish OpenWork branding and desktop polish

**Files:**
- Modify: `electron/main.cjs`
- Modify: `electron/utils/menu.cjs`
- Modify: `electron/splash.html`
- Modify: `src/components/SessionProviderLogo.tsx`
- Modify: `src/components/ClaudeLogo.jsx`
- Modify: `src/components/CodexLogo.jsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarHeader.tsx`
- Modify: `src/components/main-content/view/subcomponents/MainContentHeader.tsx`
- Modify: `docs/index.md`
- Modify: `docs/build-release.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Step 1: Align desktop-visible labels**

Update app/window/menu labels to `OpenWork`.

**Step 2: Audit icon/provider presentation after shell changes**

Do not swap Claude/Codex provider identities. Keep provider-specific styling scoped to session content, not product branding.

**Step 3: Update docs and packaging references**

Replace stale product references in user-facing docs.

**Step 4: Validate web and desktop presentation**

Run:
```bash
npm run build
npm run build:mac
```
Expected: build completes; desktop app title and splash reflect `OpenWork`.

**Step 5: Commit**

```bash
git add electron src/components docs README.md README.zh-CN.md
git commit -m "chore: finalize openwork branding"
```

### Task 11: Regression pass for desktop and Windows compatibility

**Files:**
- Modify as needed from prior tasks only
- Reference: `docs/windows-exe-build.md`
- Reference: `docs/mac-sync-requirements-2026-03-04.json`

**Step 1: Run the complete local validation set**

Run:
```bash
npm run typecheck
npm run build
npm run build:mac
```

**Step 2: Run desktop smoke tests**

Manual checks:
- launch desktop build
- switch top-level domains
- open project overview
- open project chat/shell
- open `Extensions -> MCP`
- open `Extensions -> Skills`
- save a skill

**Step 3: Prepare Windows validation checklist**

Verify on Windows x64:
- skill discovery paths
- MCP config read/write
- dual-sidebar scroll/focus behavior
- desktop title/branding

**Step 4: Fix only regressions introduced by this feature**

Do not broaden scope into unrelated issues.

**Step 5: Commit**

```bash
git add relevant/files
 git commit -m "fix: address workbench migration regressions"
```

## Manual Verification Matrix

After implementation, verify these scenarios end-to-end:
- default launch opens `Projects -> Overview`
- clicking a project opens its workspace
- clicking a session opens that session directly
- `Extensions -> MCP` fully replaces Settings-based MCP management
- `Extensions -> Skills` supports create/edit/delete/save
- refresh restores the last domain and valid subview
- macOS desktop shows `OpenWork` in title/menu/splash
- Windows x64 build preserves the same navigation model and skill/MCP behavior

## Notes for Execution

- Prefer incremental PR-sized changes; keep the app runnable after every task.
- Avoid broad renames of internal identifiers unless the affected area is already being modified.
- If skill storage differs between Claude and Codex, expose that difference in backend metadata rather than splitting the frontend navigation model.

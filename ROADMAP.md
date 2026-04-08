# OpenWork Product Roadmap / OpenWork 产品路线图

> **Last Updated / 最后更新**: 2025-07
>
> This is a living document that outlines the strategic direction for OpenWork — a desktop and web UI for Claude Code, Codex, and Cursor AI sessions.
>
> 本文档概述了 OpenWork 的战略方向——一个面向 Claude Code、Codex 和 Cursor AI 会话的桌面及 Web 界面工具。

---

## Table of Contents / 目录

1. [Current State Assessment / 当前状态评估](#1-current-state-assessment--当前状态评估)
2. [Priority Bugs & Tech Debt / 优先级 Bug 与技术债务](#2-priority-bugs--tech-debt--优先级-bug-与技术债务)
3. [Prioritized Feature Roadmap / 优先级功能路线图](#3-prioritized-feature-roadmap--优先级功能路线图)
4. [Architecture Improvements / 架构改进](#4-architecture-improvements--架构改进)
5. [Competitive Analysis / 竞品分析](#5-competitive-analysis--竞品分析)
6. [Design & UX Direction / 设计与用户体验方向](#6-design--ux-direction--设计与用户体验方向)

---

## 1. Current State Assessment / 当前状态评估

### What Works Well / 运行良好的部分

**Multi-Agent Architecture / 多代理架构** ✅
OpenWork supports three AI backends — Claude Code (via `@anthropic-ai/claude-agent-sdk`), OpenAI Codex (via `@openai/codex-sdk`), and Cursor CLI — all through a unified chat interface. This provider-agnostic design is a significant differentiator. Users can switch between providers per-session, compare outputs, and leverage the strengths of each model.

OpenWork 支持三个 AI 后端——Claude Code、OpenAI Codex 和 Cursor CLI——均通过统一的聊天界面。这种与提供商无关的设计是一个重要的差异化优势。用户可以按会话切换提供商，比较输出，并利用每个模型的优势。

**Desktop-Class Experience / 桌面级体验** ✅
The Electron shell provides a polished native experience with system tray integration, auto-update via `electron-updater`, deep linking (`openwork://`), window state persistence, and platform-specific styling (macOS `hiddenInset` title bar, Windows native frame). The splash screen and graceful shutdown (10s timeout) add production polish.

Electron shell 提供了精致的原生体验，包括系统托盘集成、自动更新、深链接 (`openwork://`)、窗口状态持久化以及平台特定样式。启动画面和优雅关闭进一步提升了产品品质。

**Comprehensive Git Integration / 全面的 Git 集成** ✅
The Git panel (`server/routes/git.js`, 43 KB) provides a near-complete Git workflow: status, diff, staging, commit (with AI-generated messages), branches, checkout, push/pull, fetch, remote status, and untracked file management. This covers 90%+ of daily Git operations without leaving the app.

Git 面板提供了几乎完整的 Git 工作流：状态、差异、暂存、提交（含 AI 生成的提交信息）、分支管理、签出、推送/拉取等。这覆盖了 90% 以上的日常 Git 操作。

**Responsive Design / 响应式设计** ✅
The app has dedicated mobile components (`MobileWorkbenchShell`, `MobileProjectsView`, `MobileSessionsView`) with a bottom-tab navigation pattern, making it usable on tablets and phones — rare for developer tools.

应用有专门的移动端组件，采用底部标签导航模式，在平板和手机上也能使用——这在开发者工具中非常少见。

**Internationalization / 国际化** ✅
Full i18n support via `react-i18next` with 4 locales (English, Chinese, Korean, Japanese) across 7 namespaces (common, settings, auth, sidebar, chat, codeEditor, tasks). Translation coverage is comprehensive for all major UI strings.

通过 `react-i18next` 实现完整的国际化支持，提供 4 种语言（英语、中文、韩语、日语）和 7 个命名空间的翻译覆盖。

**Live Grid Multi-Session View / 实时网格多会话视图** ✅
The Live Grid (`src/components/live-grid/`) allows monitoring multiple AI sessions simultaneously in configurable grid layouts (1×2, 2×2, 2×3, 3×3). This is a unique feature not found in competing tools, enabling power users to orchestrate parallel AI workflows.

实时网格允许在可配置的网格布局中同时监控多个 AI 会话。这是竞品工具中没有的独特功能，使高级用户能够编排并行 AI 工作流。

### What Needs Improvement / 需要改进的部分

**Performance Bottlenecks / 性能瓶颈** ⚠️
- `GitPanel.jsx` (1,427 LOC, 34 `useState` hooks) is a monolithic component causing excessive re-renders
- FileTree lacks virtualization — rendering 1000+ files will be slow
- Only 4 components use `React.memo` out of 45+ total
- No request deduplication or caching layer (no React Query/SWR)
- 76+ console.log statements remain in production code

- `GitPanel.jsx`（1,427 行代码，34 个 `useState` 钩子）是一个单体组件，导致过多的重新渲染
- FileTree 缺少虚拟化——渲染 1000+ 文件时会很慢
- 45+ 组件中仅有 4 个使用 `React.memo`
- 没有请求去重或缓存层
- 生产代码中仍有 76+ 条 console.log 语句

**Error Handling Gaps / 错误处理不足** ⚠️
- Only 1 ErrorBoundary in the entire app
- Git operation errors are caught but not displayed with user-friendly messages
- No global error tracking (Sentry, etc.)
- Silent failures in some API calls

- 整个应用中仅有 1 个 ErrorBoundary
- Git 操作错误被捕获但未以用户友好的方式显示
- 没有全局错误追踪
- 某些 API 调用存在静默失败

**Testing Infrastructure / 测试基础设施** ⚠️
- No unit tests exist
- Only E2E tests via Playwright (5 test files)
- No component tests (Vitest config exists but no test files)
- No CI/CD pipeline for automated testing

- 不存在单元测试
- 仅有通过 Playwright 进行的 E2E 测试（5 个测试文件）
- 没有组件测试
- 没有自动化测试的 CI/CD 管道

---

## 2. Priority Bugs & Tech Debt / 优先级 Bug 与技术债务

### P0 — Critical / 关键

**P0-1: GitPanel Monolith Decomposition / GitPanel 单体拆分**
The `GitPanel.jsx` component at 1,427 lines with 34 `useState` hooks is the largest technical debt item. Every state change triggers a full re-render of the entire Git UI. This should be decomposed into: `GitStatusPanel`, `GitDiffViewer`, `GitBranchManager`, `GitCommitForm`, `GitRemoteSync`, each with their own hooks. Estimated: 3-5 days.

`GitPanel.jsx` 组件有 1,427 行代码和 34 个 `useState` 钩子，是最大的技术债务项。每次状态变化都会触发整个 Git UI 的完全重新渲染。应拆分为独立子组件，各自拥有自己的 hooks。预计工期：3-5 天。

**P0-2: Error Boundary Coverage / 错误边界覆盖**
A crash in the Git panel, terminal, or chat can take down the entire app. Each major feature area needs its own `ErrorBoundary` with recovery UI: "Something went wrong in [Git Panel]. Click to retry." This prevents cascading failures and keeps other features functional.

Git 面板、终端或聊天中的崩溃可能导致整个应用崩溃。每个主要功能区都需要自己的 `ErrorBoundary`，并提供恢复 UI。这可以防止级联失败并保持其他功能正常工作。

**P0-3: Remove Production Console Logs / 移除生产环境 Console 日志**
76+ `console.log`/`console.error` statements exist in frontend components. These leak implementation details, slow down rendering, and pollute browser DevTools. Replace with a proper logging facade that can be disabled in production (or use the existing `electron-log` for desktop).

前端组件中存在 76+ 条 `console.log`/`console.error` 语句。这些泄漏了实现细节，减慢了渲染速度。应替换为可在生产环境中禁用的日志门面。

### P1 — High Priority / 高优先级

**P1-1: Request Caching & Deduplication / 请求缓存与去重**
Multiple components independently fetch the same data (projects, sessions, branches). Adopting React Query or SWR would provide: automatic caching, background refetching, request deduplication, loading/error states, and optimistic updates. This would significantly reduce API calls and improve perceived performance.

多个组件独立获取相同的数据。采用 React Query 或 SWR 将提供：自动缓存、后台重新获取、请求去重、加载/错误状态和乐观更新。这将显著减少 API 调用并提高感知性能。

**P1-2: FileTree Virtualization / 文件树虚拟化**
`FileTree.jsx` (729 LOC) renders all tree nodes in the DOM. For large projects (10K+ files), this causes significant lag. Implementing `react-window` or a virtual tree component would keep render costs constant regardless of tree size.

`FileTree.jsx`（729 行代码）在 DOM 中渲染所有树节点。对于大型项目（10K+ 文件），这会导致明显卡顿。实现虚拟树组件将保持渲染成本恒定。

**P1-3: useMemo/useCallback Audit / useMemo/useCallback 审计**
Only ~149 instances of `useMemo`/`useCallback` exist across the entire codebase. Many expensive computations and callback references are recreated on every render. A systematic audit of top-level components (AppContent, ChatPanel, Sidebar) would identify the highest-impact optimization targets.

整个代码库中仅有约 149 个 `useMemo`/`useCallback` 实例。许多昂贵的计算和回调引用在每次渲染时都会重新创建。系统审计顶层组件将找出最高影响的优化目标。

**P1-4: Code Splitting / 代码分割**
All features are bundled into a single JavaScript bundle. Heavy dependencies like CodeMirror, xterm.js, and Mermaid are loaded even when unused. Implementing `React.lazy()` for route-level splitting and dynamic imports for heavy libraries would improve initial load time by 40-60%.

所有功能打包在一个 JavaScript 包中。即使未使用，CodeMirror、xterm.js 和 Mermaid 等重量级依赖也会被加载。实现路由级别的代码分割和重量级库的动态导入将使初始加载时间改善 40-60%。

### P2 — Medium Priority / 中等优先级

**P2-1: Props Drilling Elimination / 消除 Props 透传**
`AppContent.tsx` passes 15+ props down multiple levels. Creating dedicated contexts or Zustand stores for `project data`, `session data`, and `settings` would simplify the component tree and reduce coupling. The existing `useProjectsState` hook (946 LOC) is itself becoming a monolith.

`AppContent.tsx` 向下传递 15+ 个 props。为项目数据、会话数据和设置创建专门的 context 或 Zustand store 将简化组件树并减少耦合。

**P2-2: Service Layer Abstraction / 服务层抽象**
API calls are scattered through components and hooks. Creating a `services/` layer (`ProjectService`, `GitService`, `SessionService`) would centralize data access, enable easier mocking for tests, and provide a single place for caching, retries, and error transformation.

API 调用分散在组件和 hooks 中。创建 `services/` 层将集中数据访问，便于测试模拟，并提供缓存、重试和错误转换的统一位置。

**P2-3: TypeScript Migration Completion / TypeScript 迁移完成**
The frontend has a mix of `.jsx` and `.tsx` files. Newer components use TypeScript, but many core components (`GitPanel.jsx`, `FileTree.jsx`, `Shell.jsx`, `CodeEditor.jsx`) are still JavaScript. Migrating these to TypeScript would catch type errors early and improve IDE support.

前端混合使用 `.jsx` 和 `.tsx` 文件。许多核心组件仍为 JavaScript。将这些迁移到 TypeScript 将更早捕获类型错误并改善 IDE 支持。

**P2-4: Database Migration System / 数据库迁移系统**
The SQLite schema (`server/database/init.sql`) has no migration mechanism. Schema changes require manual DB deletion. Implementing a versioned migration system (like `better-sqlite3-migrations`) would ensure backward compatibility across updates.

SQLite schema 没有迁移机制。架构变更需要手动删除数据库。实现版本化迁移系统将确保跨更新的向后兼容性。

---

## 3. Prioritized Feature Roadmap / 优先级功能路线图

### Tier 1: Core Experience (P0) / 核心体验

> Features that make OpenWork feel production-grade and competitive.
>
> 使 OpenWork 达到生产级品质的核心功能。

#### 1.1 Conversation Branching & Forking / 对话分支与分叉
**Priority**: P0 | **Effort**: 5-8 days | **Impact**: High

Allow users to fork a conversation at any point, creating a branch where they can explore an alternative approach without losing the original thread. This is critical for AI-assisted development where users often want to try multiple approaches.

**Implementation**: Add a `parentMessageId` field to conversation messages. Create a branch selector in the chat UI header. Store branch metadata in the session store. The backend already stores messages in JSONL — extend with branch tagging.

允许用户在任意点分叉对话，创建一个分支来探索替代方案而不丢失原始线程。这对 AI 辅助开发至关重要，用户经常想尝试多种方案。

**实现方案**：在对话消息中添加 `parentMessageId` 字段。在聊天 UI 头部创建分支选择器。在会话存储中存储分支元数据。

#### 1.2 Context Window Visualization / 上下文窗口可视化
**Priority**: P0 | **Effort**: 3-5 days | **Impact**: High

Display a real-time visualization of token usage within the context window. Show how much context is consumed by: conversation history, attached files, tool outputs, and system prompts. Add a progress bar and warnings when approaching limits. This helps users understand why Claude "forgets" earlier context and when to use `/compact`.

**Implementation**: The backend already sends `token-budget` WebSocket events. Build a `ContextWindowMeter` component that parses these events into a stacked bar chart (conversation vs files vs tools). Add a warning banner at 80% usage.

显示上下文窗口内令牌使用的实时可视化。展示对话历史、附加文件、工具输出和系统提示分别消耗了多少上下文。在接近限制时添加进度条和警告。

#### 1.3 Keyboard Shortcuts System / 键盘快捷键系统
**Priority**: P0 | **Effort**: 3-4 days | **Impact**: High

While `KeyboardShortcutsOverlay` exists, the shortcut system is incomplete. Implement a comprehensive shortcut system covering: navigation (Cmd+1-9 for tabs), chat (Cmd+Enter send, Cmd+K clear), editor (standard code shortcuts), and custom user-defined shortcuts. Show a searchable shortcut reference (Cmd+/).

**Implementation**: Create a `ShortcutRegistry` class that manages key bindings, supports customization, handles conflicts, and persists to settings. Use `useHotkeys` or a similar library for consistent cross-platform behavior.

虽然 `KeyboardShortcutsOverlay` 已存在，但快捷键系统不完整。实现全面的快捷键系统，涵盖导航、聊天、编辑器和自定义快捷键。

#### 1.4 Inline Code Diff Review / 内联代码差异审查
**Priority**: P0 | **Effort**: 5-7 days | **Impact**: High

When Claude proposes file edits, show an inline diff view (similar to GitHub PR review) with Accept/Reject per-hunk. Currently, tool results show diffs but without interactive approval. This bridges the gap between "Claude suggests a change" and "the change is applied", giving users fine-grained control.

**Implementation**: Use `@codemirror/merge` or a standalone diff library. Render diffs inside the chat message with per-hunk accept/reject buttons. On accept, call the existing file-write APIs.

当 Claude 提出文件编辑时，显示内联差异视图（类似 GitHub PR 审查），支持逐块接受/拒绝。这弥合了"Claude 建议更改"和"更改被应用"之间的差距。

#### 1.5 Session Templates & Prompts Library / 会话模板与提示词库
**Priority**: P0 | **Effort**: 4-6 days | **Impact**: Medium-High

Allow users to save and reuse conversation starters, system prompts, and session configurations as templates. Pre-built templates for common tasks: "Code Review", "Bug Fix", "Feature Implementation", "Documentation", "Refactoring". This reduces the friction of starting new sessions.

**Implementation**: Create a `templates/` collection in the settings store. Add a template selector in the new-session flow. Each template stores: provider, model, system prompt, initial message, and file attachments.

允许用户保存和重复使用对话启动器、系统提示和会话配置作为模板。预设常见任务的模板。

### Tier 2: Power Features (P1) / 高级功能

> Advanced features for power users and development teams.
>
> 面向高级用户和开发团队的高级功能。

#### 2.1 Cross-Project Code Search / 跨项目代码搜索
**Priority**: P1 | **Effort**: 5-8 days | **Impact**: High

Implement a global code search (Ctrl+Shift+F) that searches across all registered projects. Support regex, file-type filters, and result preview with syntax highlighting. This is table-stakes for any IDE-like tool and currently a major gap.

**Implementation**: Use `ripgrep` (already available on most dev machines) or a WASM-based search engine. Build a `SearchPanel` component with result grouping by file. Index files asynchronously on project registration.

实现全局代码搜索（Ctrl+Shift+F），可跨所有注册项目搜索。支持正则表达式、文件类型过滤器和带语法高亮的结果预览。这对任何类 IDE 工具来说都是基本要求。

#### 2.2 AI Model Comparison View / AI 模型对比视图
**Priority**: P1 | **Effort**: 4-6 days | **Impact**: Medium-High

Send the same prompt to multiple AI providers simultaneously and display results side-by-side. Users can compare Claude vs Codex vs Cursor responses for the same task, then choose the best approach. This leverages OpenWork's unique multi-provider architecture.

**Implementation**: Extend the Live Grid to support a "comparison mode" where a single prompt is dispatched to multiple sessions. Add a unified diff view for comparing code outputs between providers.

同时向多个 AI 提供商发送相同的提示，并排显示结果。用户可以比较不同 AI 对同一任务的响应，然后选择最佳方案。这充分利用了 OpenWork 独特的多提供商架构。

#### 2.3 Git Merge Conflict Resolution UI / Git 合并冲突解决 UI
**Priority**: P1 | **Effort**: 6-10 days | **Impact**: Medium-High

When merge conflicts occur, provide an interactive 3-way merge editor showing: base, ours, theirs, and the merged result. Allow users to accept either side per-conflict or manually edit. Optionally, let Claude AI suggest conflict resolutions.

**Implementation**: Use `@codemirror/merge` for the 3-way editor. Parse conflict markers from `git diff --check`. Build a `ConflictResolver` component that wraps the merge editor with accept/reject controls.

当合并冲突发生时，提供交互式三路合并编辑器。允许用户逐冲突接受任一方或手动编辑。可选让 Claude AI 建议冲突解决方案。

#### 2.4 Session Cost & Token Analytics / 会话成本与令牌分析
**Priority**: P1 | **Effort**: 3-5 days | **Impact**: Medium

Track and display token usage and estimated cost per session, per project, and over time. Show charts for daily/weekly/monthly usage trends. This helps users and teams manage AI spend and understand usage patterns.

**Implementation**: Capture token counts from API responses (already partially available). Store in SQLite with timestamps. Build an `AnalyticsDashboard` component with chart.js or recharts for visualization.

跟踪和显示每个会话、每个项目和随时间的令牌使用量和估计成本。显示每日/每周/每月使用趋势图表。

#### 2.5 Task Queue & Batch Operations / 任务队列与批量操作
**Priority**: P1 | **Effort**: 5-8 days | **Impact**: Medium

Allow users to queue multiple prompts/tasks that execute sequentially or in parallel. Example: "Review all files in src/components/, one at a time, and suggest improvements." This enables unattended AI workflows.

**Implementation**: Create a `TaskQueue` store with items containing: prompt, provider, project, status, dependencies. Build a `TaskQueuePanel` UI. Execute tasks via the existing WebSocket-based session system.

允许用户排队多个提示/任务，按顺序或并行执行。例如："逐个审查 src/components/ 中的所有文件，并建议改进。"这实现了无人值守的 AI 工作流。

#### 2.6 File Watcher & Auto-Refresh / 文件监视与自动刷新
**Priority**: P1 | **Effort**: 2-3 days | **Impact**: Medium

Watch project directories for file changes and automatically refresh the file tree, git status, and related panels. Currently, users must manually refresh to see changes made by AI or external editors.

**Implementation**: Use `chokidar` (already a transitive dependency) on the backend. Emit WebSocket events for file changes. Debounce updates (500ms) to avoid thrashing.

监视项目目录的文件变更并自动刷新文件树、Git 状态和相关面板。目前用户必须手动刷新才能看到 AI 或外部编辑器所做的更改。

#### 2.7 Snippet & Code Block Manager / 代码片段管理器
**Priority**: P1 | **Effort**: 3-4 days | **Impact**: Medium

Allow users to save, tag, search, and reuse code blocks from AI responses. Build a searchable library of saved snippets with syntax highlighting, tags, and source attribution (which session/conversation produced it).

**Implementation**: Create a `snippets` table in SQLite. Add a "Save" button to code blocks in chat messages. Build a `SnippetsPanel` with search, filter by language/tag, and copy-to-clipboard.

允许用户保存、标记、搜索和重复使用 AI 响应中的代码块。构建一个可搜索的代码片段库。

#### 2.8 Custom Slash Commands / 自定义斜杠命令
**Priority**: P1 | **Effort**: 3-4 days | **Impact**: Medium

Allow users to define custom slash commands with predefined prompts, file attachments, and configurations. Example: `/deploy` could run a sequence of prompts that review, test, and prepare code for deployment.

**Implementation**: Extend the `SLASH_COMMANDS` registry to support user-defined entries stored in settings. Each custom command specifies: a template prompt, optional file globs, and a provider preference.

允许用户定义带有预定义提示、文件附件和配置的自定义斜杠命令。

### Tier 3: Platform Features (P2) / 平台功能

> Enterprise, team, and ecosystem features.
>
> 企业级、团队和生态系统功能。

#### 3.1 Team Collaboration / 团队协作
**Priority**: P2 | **Effort**: 15-20 days | **Impact**: High (enterprise)

Enable multiple team members to share projects, sessions, and conversations. Features include: shared project boards, session handoff between team members, shared prompt libraries, and activity feeds.

**Implementation**: Requires a server-side component with user accounts, team management, and real-time sync via WebSocket. This is the biggest feature gap for enterprise adoption and represents a significant architecture evolution from the current single-user design.

使多个团队成员能够共享项目、会话和对话。功能包括：共享项目板、团队成员间的会话交接、共享提示词库和活动信息流。这是企业级采用的最大功能差距。

#### 3.2 Plugin & Extension System / 插件与扩展系统
**Priority**: P2 | **Effort**: 10-15 days | **Impact**: High (ecosystem)

Build a plugin architecture that allows third-party developers to extend OpenWork with: custom panels, custom commands, tool integrations, theme packs, and AI provider adapters. This transforms OpenWork from a tool into a platform.

**Implementation**: Define a plugin manifest format, sandboxed execution environment, and plugin API surface. Use dynamic imports for loading plugins. Create a plugin marketplace UI. The existing MCP server management (`server/routes/mcp.js`) provides a partial model.

构建插件架构，允许第三方开发者通过自定义面板、命令、工具集成、主题包和 AI 提供商适配器来扩展 OpenWork。这将 OpenWork 从工具转变为平台。

#### 3.3 Cloud Sync & Backup / 云同步与备份
**Priority**: P2 | **Effort**: 8-12 days | **Impact**: Medium-High

Sync session history, settings, templates, and snippets across devices via cloud storage. Support multiple backends: GitHub Gist, S3, Google Drive, or a first-party sync service. This enables seamless switching between desktop and web instances.

**Implementation**: Create a `SyncService` abstraction with provider adapters. Use content-addressed storage for efficient diffing. Implement conflict resolution for simultaneous edits.

跨设备同步会话历史、设置、模板和代码片段。支持多种后端：GitHub Gist、S3、Google Drive 等。这实现了桌面和 Web 实例之间的无缝切换。

#### 3.4 Audit Logging & Compliance / 审计日志与合规
**Priority**: P2 | **Effort**: 4-6 days | **Impact**: Medium (enterprise)

Log all AI interactions, file operations, and git commands with timestamps, user identity, and context. Provide an audit log viewer and export (CSV/JSON). This is required for enterprise compliance (SOC 2, HIPAA) and helps teams understand AI usage patterns.

**Implementation**: Create an `AuditLog` table in SQLite with structured event data. Hook into all API routes via Express middleware. Build an `AuditLogPanel` UI with filtering and export.

记录所有 AI 交互、文件操作和 Git 命令的时间戳、用户身份和上下文。这对企业合规性（SOC 2、HIPAA）至关重要。

#### 3.5 API Documentation & SDK / API 文档与 SDK
**Priority**: P2 | **Effort**: 5-7 days | **Impact**: Medium

Generate OpenAPI/Swagger documentation from the Express routes. Publish a JavaScript SDK (`@openwork/sdk`) for programmatic access to OpenWork's capabilities. This enables: CI/CD integration, scripted AI workflows, and third-party tool building.

**Implementation**: Use `swagger-jsdoc` to annotate existing routes. Auto-generate the SDK from the OpenAPI spec. Publish to npm.

从 Express 路由生成 OpenAPI/Swagger 文档。发布 JavaScript SDK 以实现编程访问。这使 CI/CD 集成、脚本化 AI 工作流和第三方工具构建成为可能。

#### 3.6 Self-Hosted Enterprise Mode / 自托管企业版模式
**Priority**: P2 | **Effort**: 8-12 days | **Impact**: High (enterprise)

Package OpenWork as a Docker container for self-hosted deployment with: SSO/SAML authentication, LDAP user directory, centralized configuration, and multi-user management. This unlocks enterprise sales where data sovereignty is required.

**Implementation**: Create a `Dockerfile` and `docker-compose.yml` with configurable auth backends. Add RBAC (role-based access control) to the middleware layer. Store user/team data in PostgreSQL for scalability.

将 OpenWork 打包为 Docker 容器，支持自托管部署：SSO/SAML 身份验证、LDAP 用户目录、集中配置和多用户管理。

#### 3.7 CI/CD Pipeline Integration / CI/CD 流水线集成
**Priority**: P2 | **Effort**: 5-8 days | **Impact**: Medium

Integrate with GitHub Actions, GitLab CI, and Jenkins to: trigger AI code reviews on PR creation, run automated refactoring on schedule, and post review comments back to PRs. This extends OpenWork's value beyond interactive use.

**Implementation**: Create webhook endpoints for CI events. Build a `PipelinePanel` that shows active runs. Use the existing Git API for PR comment integration.

与 GitHub Actions、GitLab CI 和 Jenkins 集成：在 PR 创建时触发 AI 代码审查，按计划运行自动重构，并将审查评论发回 PR。

#### 3.8 Voice Input & Accessibility / 语音输入与无障碍
**Priority**: P2 | **Effort**: 5-7 days | **Impact**: Medium

Add voice-to-text input for chat messages using the Web Speech API. Implement comprehensive accessibility: ARIA labels, screen reader support, keyboard-only navigation, high contrast mode, and reduced motion preferences. Currently, no ARIA attributes exist in the codebase.

**Implementation**: Use the Web Speech API for voice input (no external service required). Audit all components for ARIA compliance. Add a focus management system for keyboard navigation. Support `prefers-reduced-motion` and `prefers-contrast` media queries.

使用 Web Speech API 添加语音转文字输入。实现全面的无障碍功能：ARIA 标签、屏幕阅读器支持、纯键盘导航、高对比度模式。目前代码库中不存在 ARIA 属性。

---

## 4. Architecture Improvements / 架构改进

### 4.1 State Management Consolidation / 状态管理统一
**Current State / 当前状态**: State is fragmented across React useState (most components), Zustand stores (liveGridStore, sessionStatusStore), and React Context (Auth, Theme, WebSocket, TasksSettings). `useProjectsState` at 946 LOC acts as a mega-hook combining data fetching, state management, and side effects.

**Target Architecture / 目标架构**: Consolidate into a layered state architecture:
```
UI State (component-local useState)
  ↓
Feature Stores (Zustand — projects, sessions, settings, git)
  ↓
Data Layer (React Query — caching, deduplication, background sync)
  ↓
API Client (centralized, with retry & error handling)
```

This eliminates props drilling, provides a single source of truth, and enables optimistic updates. The `useProjectsState` hook should be decomposed into: `useProjectsFetch`, `useProjectsActions`, `useSessionNavigation`.

当前状态分散在 React useState、Zustand stores 和 React Context 中。目标是统一为分层状态架构，消除 props 透传，提供单一真实来源。

### 4.2 API Client & Service Layer / API 客户端与服务层
**Current State**: `src/utils/api.js` is a flat object with ~30 methods, each returning a raw `fetch` call. No retry logic, no caching, no request cancellation.

**Target**: Create a typed `ApiClient` class with:
- Automatic retry with exponential backoff (3 attempts)
- Request deduplication (same URL within 100ms → single request)
- AbortController integration for request cancellation
- Response type safety (generics)
- Interceptors for auth token injection and error transformation

当前 `src/utils/api.js` 是一个扁平对象。目标是创建带有自动重试、请求去重、请求取消和类型安全的 `ApiClient` 类。

### 4.3 Component Architecture Standards / 组件架构标准
**Establish and enforce**:
- Maximum component size: 300 LOC (anything larger must be decomposed)
- All new components must be TypeScript (`.tsx`)
- Feature components follow the established pattern: `view/`, `hooks/`, `types/`, `utils/`
- Every feature area has its own `ErrorBoundary`
- Performance-critical list components must use virtualization
- Memoize components that receive complex object props

**建立并执行标准**：组件最大 300 行代码，新组件必须使用 TypeScript，每个功能区有自己的 ErrorBoundary，性能关键的列表组件必须使用虚拟化。

### 4.4 Testing Strategy / 测试策略
**Current State**: Zero unit tests, 5 E2E test files, `vitest.config.ts` configured but unused.

**Target / 目标**:
| Layer | Tool | Coverage Target | Priority |
|-------|------|-----------------|----------|
| Unit Tests | Vitest | 60% of utils, hooks, stores | P1 |
| Component Tests | Vitest + Testing Library | Key user flows | P1 |
| E2E Tests | Playwright | Critical paths (10 flows) | P1 |
| API Tests | Supertest | All endpoints | P2 |
| Visual Regression | Playwright screenshots | UI components | P2 |

Start with the highest-value tests: store logic (liveGridStore, sessionStatusStore), API client methods, and critical hooks (useProjectsState, useChatPanel).

从最高价值的测试开始：store 逻辑、API 客户端方法和关键 hooks。

### 4.5 Build & Bundle Optimization / 构建与打包优化
**Current Issues**:
- Single bundle for all features
- No tree-shaking analysis
- No bundle size monitoring
- Heavy dependencies loaded eagerly

**Improvements / 改进**:
1. **Route-level code splitting** via `React.lazy()` for: LiveGridView, Settings, GitPanel, CodeEditor
2. **Dynamic imports** for CodeMirror, xterm.js, Mermaid (only load when feature is activated)
3. **Bundle analysis** via `rollup-plugin-visualizer` in the Vite build
4. **Bundle size budgets** in CI: total < 2MB gzipped, individual chunks < 500KB
5. **Pre-loading** of likely-needed chunks based on user navigation patterns

通过路由级代码分割、动态导入、打包分析和大小预算来优化构建。

### 4.6 Backend Scalability / 后端可扩展性
**Current**: Single-process Express server with in-memory state.

**For multi-user / team scenarios / 多用户/团队场景**:
1. **Session process isolation**: Each AI session runs in a separate worker process to prevent one slow session from blocking others
2. **WebSocket connection pooling**: Use Redis or a shared message bus for WebSocket message routing across multiple server instances
3. **Database scaling**: Migrate from SQLite to PostgreSQL for concurrent multi-user access
4. **Background job processing**: Use a job queue (BullMQ) for long-running operations (clone, build, AI processing)

单进程 Express 服务器需要演进为支持多用户。每个 AI 会话在独立工作进程中运行，使用 Redis 进行 WebSocket 消息路由，迁移到 PostgreSQL。

---

## 5. Competitive Analysis / 竞品分析

### Direct Competitors / 直接竞争对手

#### VS Code + GitHub Copilot
**Strengths**: Massive ecosystem (40K+ extensions), deeply integrated into the editor workflow, inline code completions, Copilot Chat as a sidebar. VS Code is the default IDE for most developers.

**OpenWork Advantages**:
- Multi-provider support (Claude + Codex + Cursor vs Copilot-only)
- Dedicated AI session management (not a sidebar afterthought)
- Live Grid for parallel session monitoring
- Git operations through AI-native workflow (vs separate Git panel)
- Mobile-responsive design

**VS Code 优势**：庞大的生态系统，深度集成的编辑器工作流。**OpenWork 优势**：多提供商支持、专用 AI 会话管理、实时网格、移动响应设计。

#### Cursor IDE
**Strengths**: Full IDE experience with AI-first design, inline editing with Cmd+K, chat panel, codebase-aware context, and Composer for multi-file edits. Tight integration between editor and AI.

**OpenWork Advantages**:
- Not locked to a single AI provider
- Lighter weight (doesn't replace your IDE — works alongside it)
- Open-source core (vs proprietary)
- Terminal-first workflow (closer to how CLI tools actually work)
- Desktop + Web + Mobile support

**Cursor 优势**：AI-first 的完整 IDE 体验。**OpenWork 优势**：不绑定单一 AI 提供商、更轻量、开源核心、终端优先的工作流。

#### Aider (Terminal AI Coding)
**Strengths**: Pure terminal tool, supports many models (OpenAI, Anthropic, local), git-aware, edit/ask modes, voice coding, excellent context management.

**OpenWork Advantages**:
- Visual UI (chat, file tree, git panel, diffs)
- Multi-session management (Aider is single-session)
- Project organization and management
- Non-terminal users can participate (designers, PMs)
- Integrated terminal (best of both worlds)

**Aider 优势**：纯终端工具，出色的上下文管理。**OpenWork 优势**：可视化 UI、多会话管理、项目组织。

#### Continue.dev (VS Code Extension)
**Strengths**: Open-source, supports many LLM providers, inline edit suggestions, context providers system, model configuration UI.

**OpenWork Advantages**:
- Standalone app (works without VS Code)
- Full project management (not just AI chat)
- Live Grid multi-session view
- Built-in terminal and git integration
- Electron desktop app with native features

**Continue.dev 优势**：开源，VS Code 集成。**OpenWork 优势**：独立应用、完整项目管理、Live Grid、内置终端和 Git 集成。

### Key Differentiators to Protect & Extend / 需要保护和扩展的关键差异化

1. **Multi-Provider Architecture**: This is OpenWork's strongest moat. No other tool lets you seamlessly switch between Claude, Codex, and Cursor in the same workspace. **Extend** by adding more providers (Gemini, local models via Ollama).

2. **Live Grid**: Unique multi-session monitoring. **Extend** with session templates, auto-refresh, and comparison mode.

3. **Standalone + Lightweight**: Unlike Cursor/VS Code, OpenWork doesn't try to replace your IDE. **Protect** by keeping the app focused and fast.

4. **Mobile Access**: Developer tools on mobile is nearly non-existent. **Extend** with a proper mobile app (React Native or PWA) for code review on-the-go.

1. **多提供商架构**：这是 OpenWork 最强的护城河。扩展更多提供商（Gemini、本地模型）。
2. **实时网格**：独特的多会话监控。扩展会话模板和对比模式。
3. **独立 + 轻量**：不替代 IDE。保持应用聚焦和快速。
4. **移动端访问**：移动端开发者工具几乎不存在。扩展为 PWA 或 React Native 应用。

---

## 6. Design & UX Direction / 设计与用户体验方向

### 6.1 Design System Formalization / 设计系统规范化
**Current State**: UI primitives exist in `src/components/ui/` using `class-variance-authority` + `tailwind-merge`, with CSS custom properties in `src/index.css`. However, there's no formal design system documentation.

**Direction / 方向**:
1. **Storybook**: Create a component storybook documenting all UI primitives with usage examples, variants, and accessibility notes
2. **Design Tokens**: Formalize the HSL color system into named semantic tokens (e.g., `--color-success`, `--color-warning`, `--color-ai-claude`, `--color-ai-codex`)
3. **Spacing Scale**: Standardize spacing using Tailwind's default scale consistently (currently mixed)
4. **Typography Scale**: Define heading levels, body text, caption, and code font sizes

创建组件 Storybook，规范化 HSL 颜色系统为语义化令牌，标准化间距和字体大小。

### 6.2 Dark Mode Enhancement / 深色模式增强
**Current State**: Dark mode works via Tailwind `class` strategy with `nativeTheme` sync in Electron. The implementation is solid.

**Enhancements / 增强**:
1. **Syntax theme parity**: Ensure CodeMirror and xterm.js themes match the app's dark/light theme precisely
2. **OLED dark mode**: Add a true-black variant for OLED displays (background: `#000000` instead of `#0a0a0b`)
3. **Auto-switch**: Follow OS schedule (sunset/sunrise) for automatic theme switching
4. **Per-session themes**: Allow different AI providers to have subtle color accents (purple for Claude, blue for Codex, green for Cursor)

语法主题一致性、OLED 深色模式、自动切换、每个 AI 提供商的独特色彩标识。

### 6.3 Mobile Experience / 移动端体验
**Current State**: Mobile components exist with bottom-tab navigation. Basic functionality works on small screens.

**Improvements / 改进**:
1. **Swipe gestures**: Swipe left/right to switch between panels (chat, files, git)
2. **Compact message view**: Show condensed AI responses with "expand" buttons for code blocks
3. **Quick actions bar**: Floating action button with common operations (new session, attach file, voice input)
4. **Offline support**: Cache recent conversations for reading when offline (service worker)
5. **PWA install prompt**: Enable "Add to Home Screen" for mobile web users
6. **Touch-optimized code**: Larger tap targets for code blocks, swipe-to-copy, pinch-to-zoom on diffs

滑动手势、紧凑消息视图、快速操作栏、离线支持、PWA 安装提示、触控优化的代码显示。

### 6.4 Accessibility Roadmap / 无障碍路线图
**Current State**: No ARIA attributes found in the codebase. No keyboard navigation system beyond basic tab order.

**Phase 1 (P1) / 第一阶段**:
- Add ARIA labels to all interactive elements
- Implement focus trap for modals and popovers
- Add skip navigation link
- Ensure color contrast ratios meet WCAG 2.1 AA (4.5:1 for text)

**Phase 2 (P2) / 第二阶段**:
- Screen reader testing with VoiceOver (macOS) and NVDA (Windows)
- Keyboard shortcut documentation (accessible help dialog)
- Reduced motion support (`prefers-reduced-motion`)
- High contrast mode with `prefers-contrast`

**Phase 3 (P2) / 第三阶段**:
- WCAG 2.1 AAA compliance audit
- Automated accessibility testing in CI (axe-core)
- Accessible code diff viewer with line-by-line navigation
- Voice control for common actions

当前没有 ARIA 属性。分阶段实现：先添加 ARIA 标签和焦点管理，然后屏幕阅读器测试，最后 WCAG AAA 合规。

### 6.5 Onboarding & Discovery / 入门引导与功能发现
**Current State**: `Onboarding.jsx` (586 LOC) exists but is a one-time setup wizard.

**Improvements / 改进**:
1. **Interactive tour**: On first launch, guide users through key features with tooltips (react-joyride)
2. **Progressive disclosure**: Hide advanced features behind "Show more" toggles; reveal as users gain experience
3. **Contextual help**: Show relevant tips based on current activity (e.g., "Did you know you can use /compact to save context?")
4. **Empty states**: All panels should have helpful empty states with action prompts (not just "No data")
5. **Sample project**: Include a demo project that users can explore to learn features

交互式导览、渐进式功能揭示、上下文帮助、有意义的空状态、示例项目。

### 6.6 Notification System / 通知系统
**Current State**: Desktop notifications exist via Electron's `Notification` API. No in-app notification system.

**Direction / 方向**:
1. **Toast notifications**: In-app toast system for non-blocking feedback (file saved, commit pushed, AI response ready)
2. **Notification center**: Panel showing recent notifications with timestamps and actions
3. **Sound alerts**: Optional audio feedback for long-running AI completions (useful when multitasking)
4. **Priority levels**: Differentiate between info (blue), success (green), warning (yellow), and error (red)
5. **Do Not Disturb**: Respect system DND settings and add app-level quiet hours

应用内 Toast 通知、通知中心、声音提醒、优先级、勿扰模式。

---

## Implementation Timeline / 实施时间线

```
Q3 2025 — Stability & Core (Tier 1)
├── P0-1: GitPanel decomposition
├── P0-2: Error boundary coverage
├── P0-3: Remove console logs
├── P1-1: Request caching (React Query)
├── 1.1: Conversation branching
├── 1.2: Context window visualization
├── 1.3: Keyboard shortcuts system
├── 1.4: Inline code diff review
└── 1.5: Session templates

Q4 2025 — Power Features (Tier 2)
├── P1-2: FileTree virtualization
├── P1-4: Code splitting
├── 2.1: Cross-project code search
├── 2.2: AI model comparison view
├── 2.3: Git merge conflict UI
├── 2.4: Session cost analytics
├── 2.6: File watcher
└── 4.4: Testing strategy (unit + component tests)

Q1 2026 — Platform & Enterprise (Tier 3)
├── 3.1: Team collaboration
├── 3.2: Plugin system
├── 3.3: Cloud sync
├── 3.4: Audit logging
├── 3.6: Self-hosted enterprise
├── 6.4: Accessibility (Phase 1-2)
└── 4.6: Backend scalability
```

---

## Contributing / 贡献

This roadmap is a guide, not a rigid plan. We welcome community input on priorities and feature suggestions. To propose changes:

1. Open a GitHub Issue with the `roadmap` label
2. Reference specific items by their ID (e.g., "2.1: Cross-Project Code Search")
3. Include use cases and user stories to justify priority changes

本路线图是一个指南，而非固定计划。我们欢迎社区对优先级和功能建议提出意见。

---

*This document is maintained by the OpenWork team and updated quarterly.*

*本文档由 OpenWork 团队维护，每季度更新一次。*

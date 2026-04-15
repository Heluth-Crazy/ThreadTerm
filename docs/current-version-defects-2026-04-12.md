# OpenWork 当前版本缺陷报告

日期：2026-04-12

范围：
- 仅聚焦当前版本的缺陷
- 不讨论任务管理转型路线
- 不讨论未来产品重构方向

说明：
- 当前桌面主线应视为 `Tauri + Rust + React`
- `Node / Express / Electron` 属于遗留旧代码
- 遗留旧代码建议标记为待删除，不应继续作为主线能力维护

验证基线：
- `npm run typecheck`：通过
- `cargo test`：本轮复审环境仍未安装 `cargo`，未复跑
- 当前运行中的核心监听进程：
  - `5173`：Vite
  - `3002`：Tauri 后端 HTTP 服务

复审更新：
- 以下状态以本轮代码复审为准
- 已确认修复：
  - Web / mobile bridge 已接入新的 token 鉴权链路
  - 会话重命名链路已闭环
  - Codex 会话删除与名称覆盖已落地
  - 前端类型检查失败
  - 项目删除后被自动发现重新加入
  - 项目重命名后端接口缺失
  - Extensions 总览读取错误数据源
  - Git 的 discard changes、staged diff 与历史 diff 错误/缺失实现
- 仍然成立或新暴露的问题：
  - Web 模式仍有部分写操作是空实现
  - 多 Provider 支持仍不对称
  - 登录状态与鉴权状态仍不可信
  - 分支工作区创建入口在 Tauri 主线仍未实现
  - README / 文档 / public API docs / i18n 中仍保留大量旧主线叙事
  - 旧兼容 API 封装与测试仍保留 Node / Express 时代的接口形状

## 1. 结论摘要

当前版本的核心问题已经不再是最初那几条 P0 断裂，而是“主线能力仍然不完全对称，且若干状态语义仍不可信”：

- Web / mobile token 鉴权链路已经接上，但 web 模式仍有若干写操作空实现
- 会话重命名、Codex 删除/命名覆盖已经补齐，不再是当前版本主断点
- 多 Provider 支持比上轮更完整，但底层能力仍然明显不对称
- 登录状态、受保护路由、鉴权语义仍不可信
- 文档、public API docs、i18n 与遗留兼容层仍混杂旧的 3001 / TaskMaster / server 模式
- 侧边栏里的 branch workspace 入口仍未在 Tauri 主线实现

同时，仓库中的 `Node / Electron` 已经不应再视为当前版本的一部分，而应标记为：

- 旧代码
- 可删除代码
- 仅在迁移过程中作为参考

## 2. 版本范围说明

### 2.1 当前主线

当前应视为主线的代码：

- `src-tauri/`
- `src/`
- `src/lib/tauri-bridge.ts`

### 2.2 遗留旧代码

以下代码应在文档和认知上明确标注为旧代码：

- `server/`
- `electron/`
- README / docs / i18n 中围绕旧 Node/Electron 主线的叙事

判断依据：

- 当前桌面运行主入口已经是 Tauri
- Tauri 初始化时会直接启动内置 HTTP 服务
- 当前实际运行端口也落在 Tauri 主线

结论：

- `Node / Electron` 不是当前版本主线
- 可以删除
- 至少应先在文档中明确标注为“遗留代码，待清理”

## 3. P0 缺陷（本轮无未关闭项）

### 3.1 [已修复] Web / Mobile Bridge 与 Tauri token 鉴权脱节

本项已关闭。

复审结果：

- `src/lib/tauri-bridge.ts` 的 web 模式已经：
  - 为 HTTP 请求附加 `Authorization: Bearer <token>`
  - 为 PTY WebSocket 附加 `?token=...`
  - 不再调用旧的 `/api/auth/login`，而是按 token 配对方式校验
- `src-tauri/src/http_server.rs` 的 token 中间件与 web/mobile bridge 已形成可工作的最小闭环

剩余问题已不再是“整条链路无法鉴权”，而是“web 模式仍有若干能力空实现”，详见后文。

关键文件：

- `src/lib/tauri-bridge.ts`
- `src-tauri/src/http_server.rs`

### 3.2 [已修复] 会话重命名链路未真正闭环

本项已关闭。

复审结果：

- 侧边栏、Session Focus、Project Sessions 面板都已实际调用 `renameSession`
- 前端传给后端的已是 `projectPath`，不再是错误的 `project.name`
- 后端会将名称写入 `~/.openwork/session-names.json`
- 前端本地状态也会同步更新 Claude / Codex 会话标题

关键文件：

- `src/components/sidebar/hooks/useSidebarController.ts`
- `src/components/sidebar/view/Sidebar.tsx`
- `src/components/session-focus/SessionFocusLayout.tsx`
- `src/components/projects/ProjectSessionsPanel.tsx`
- `src-tauri/src/projects.rs`

### 3.3 [已修复] Codex 会话删除 / 重命名未真实落地

本项已关闭。

复审结果：

- `delete_session` 已会回退查找并删除 Codex 会话文件
- `projects_update_session_name` 已引入跨 provider 的 `session-names.json`
- `session_list` 已对 Claude / Codex 都应用名称覆盖

剩余问题不再是“Codex 删除/重命名不生效”，而是“项目主数据与 provider 能力仍不对称”，详见 `4.3`。

关键文件：

- `src-tauri/src/session_history.rs`
- `src-tauri/src/projects.rs`
- `src/components/workbench/projects/SelectedProjectOverviewPage.tsx`

### 3.4 [已修复] 前端类型检查失败

本项已关闭。

复审结果：

- `npm run typecheck` 已通过
- `settings.getAll()` 调用点已经补上类型兜底，至少不再构成当前版本的 P0 缺陷

关键文件：

- `src/lib/tauri-bridge.ts`
- `src/components/settings/CustomSlashCommandsEditor.tsx`
- `src/components/templates/SessionTemplatesEditor.tsx`
- `src/components/templates/SessionTemplatesPicker.tsx`
- `src/components/workbench/extensions/useExtensionsOverview.ts`
- `src/hooks/useCustomSlashCommands.ts`

### 3.5 [已修复] 项目删除与项目发现机制冲突

本项已关闭。

复审结果：

- `projects_remove` 已将被删除路径加入 `excluded_paths`
- 自动发现逻辑不会再把已删除项目直接加回主列表

关键文件：

- `src-tauri/src/projects.rs`

## 4. P1 缺陷

### 4.1 [部分修复] Tauri HTTP 服务暴露边界仍偏大

本项不再是“完全无鉴权”，但问题没有彻底结束。

现状：

- 已新增 token 鉴权中间件
- 但服务仍然：
  - 监听 `0.0.0.0:3002`
  - `allow_origin(Any)`
  - 暴露项目、会话、PTY、历史、命令发现等多类能力
- 同时还保留：
  - `/api/auth/token-info`
  - `/api/local-ip`

结果：

- 暴露面依然偏大
- 旧的“鉴权收紧后兼容链路直接断裂”结论已不再成立；当前更现实的问题是 web 模式能力仍不完整

关键文件：

- `src-tauri/src/http_server.rs`

### 4.2 [已修复] 项目重命名未实现

本项已关闭。

复审结果：

- `rename_project` 已存在
- 项目总览页已经调用该后端接口

关键文件：

- `src-tauri/src/projects.rs`
- `src/components/workbench/projects/SelectedProjectOverviewPage.tsx`

### 4.3 [部分修复] 多 Provider 支持仍不对称

相比上次复审，这一项已有进展，但还不能算闭环。

现状：

- `session_list` 已支持 Codex
- `session_messages` 已支持 Codex
- `delete_session` 与会话命名覆盖已支持 Codex
- `ai_list_sessions` 仍然只支持 Claude
- `projects_list` / `projects_get` 仍只自动挂载 Claude 会话
- Cursor 仍没有成体系的历史 / 恢复 / 浏览能力
- Cursor 仍没有 commands / skills discovery

结果：

- UI 层“Claude / Codex / Cursor 一致体验”仍不成立
- Codex 已不再是“完全不可维护”，但仍未达到与 Claude 对齐的程度

关键文件：

- `src-tauri/src/session_history.rs`
- `src-tauri/src/ai.rs`
- `src-tauri/src/projects.rs`
- `src-tauri/src/commands.rs`

### 4.4 [部分修复] Git 面板存在剩余未闭环项

本项不再包含之前的 discard / staged diff 错误，但仍有缺口。

#### 4.4.1 [已修复] Discard changes 实现错误

复审结果：

- 前端已改为调用 `git_discard_file`
- 后端已按单文件 discard 语义实现

#### 4.4.2 [已修复] staged diff 语义不一致

复审结果：

- 前端已调用 `git_staged_diff`
- 后端已使用 `git diff --cached`

#### 4.4.3 [部分修复] 历史 diff 已补齐，但 AI commit message 仍未落到后端能力

现状：

- commit history diff 已有真实后端能力：
  - `GitPanel` 已调用 `showCommit`
  - Rust 侧已实现 `git_show_commit`
- AI commit message 仍是前端基于 staged 文件名和目录的启发式拼装，不是后端真实 AI 能力

关键文件：

- `src/components/GitPanel.jsx`
- `src-tauri/src/git.rs`

### 4.5 登录状态与鉴权状态不可信

当前版本在登录与权限感知上仍存在明显的“伪状态”。

现状：

- Onboarding 的 Claude / Codex 登录状态已经不是写死值，而是改成真实 `cliAuth.getStatus`
- 但 `ProtectedRoute` 仍直接返回 children
- `AuthContext` 默认态仍然把 `default-user` / `local` 视为已认证
- `isAuthenticated` 仍然是硬编码 `true`
- web 模式 token 还存在双存储：
  - `AuthContext` 读的是 `auth_token`
  - `tauri-bridge` 读的是 `openwork_api_token`
  - 刷新后的校验链路仍不统一

结果：

- 用户看到的认证状态仍不可靠
- 代码中关于“是否已认证”的判断仍然不可信

关键文件：

- `src/components/Onboarding.jsx`
- `src/components/ProtectedRoute.jsx`
- `src/contexts/AuthContext.jsx`
- `src/lib/tauri-bridge.ts`

### 4.6 [已修复] Extensions 总览数据源错误

本项已关闭。

复审结果：

- 总览页已经改为读取 `skills_list`
- 不再依赖 `settings.getAll()` 中的 `skills` / `skillRoots`

关键文件：

- `src/components/workbench/extensions/useExtensionsOverview.ts`
- `src/components/workbench/extensions/useSkills.ts`
- `src-tauri/src/skills.rs`
- `src/lib/tauri-bridge.ts`

### 4.7 [新增] 分支工作区创建入口在 Tauri 主线仍未实现

这不是底层 Git worktree 能力完全缺失，而是“用户可见入口”仍没有真正接上主线。

现状：

- 侧边栏 `createBranchWorkspace` 仍然直接 `TODO + alert`
- Git 低层已经有：
  - `git_worktree_list`
  - `git_worktree_add`
  - `git_worktree_remove`
- 但侧边栏项目流转并没有真正接到这些能力上

结果：

- 用户能看到相关交互入口或文案
- 但当前 Tauri 主线下该链路仍不能真正完成 branch workspace 创建

关键文件：

- `src/components/sidebar/hooks/useSidebarController.ts`
- `src/lib/tauri-bridge.ts`
- `src-tauri/src/git.rs`

## 5. P2 缺陷

### 5.1 模板与 Slash Commands 配置链路脆弱

当前版本中：

- session templates
- custom slash commands

都依赖 `settings.getAll()` 读取聚合结果。

这带来的问题：

- 类型脆弱
- 配置结构不稳定
- 后续增加字段时容易继续破裂

关键文件：

- `src/components/templates/SessionTemplatesEditor.tsx`
- `src/components/templates/SessionTemplatesPicker.tsx`
- `src/components/settings/CustomSlashCommandsEditor.tsx`
- `src/hooks/useCustomSlashCommands.ts`

### 5.2 文件访问策略过于保守，影响真实使用

当前文件访问要求路径必须位于 home 目录内。

这在安全上简单，但会导致：

- 真实项目若不在 home 下，将直接不可用或受限
- 未来若要服务更多开发场景，这个限制会持续成为阻碍

关键文件：

- `src-tauri/src/fs_commands.rs`

### 5.3 README / docs / public API docs 与当前版本不一致

README 与周边文档仍然保留较多旧主线叙事：

- Node server
- 3001 端口
- TaskMaster 集成

而当前代码实际更接近：

- Tauri
- 3002
- 终端/会话管理

结果：

- 文档对当前版本描述不准确
- 新接手的人会建立错误认知
- `package.json` 中旧启动链已基本清理，但 README / docs / public API docs / i18n 仍未同步

关键文件：

- `README.md`
- `docs/development.md`
- `docs/installation.md`
- `docs/troubleshooting.md`
- `public/api-docs.html`
- `src/i18n/locales/*/settings.json`

### 5.4 [新增] 旧兼容 API 封装与测试仍保留旧 REST/Auth 路径

当前主线 bridge 已切到 `src/lib/tauri-bridge.ts`，但仓库里仍保留一套旧的 fetch 封装与测试样例。

现状：

- `src/utils/api.js` 仍保留：
  - `/api/auth/status`
  - `/api/auth/login`
  - 旧版项目 / 会话 REST 路径
- 当前看起来主要是兼容残留和测试样例，不像主线调用

结果：

- 它不一定直接影响当前主线运行
- 但会继续污染接口认知，未来如果有人误用，会重新引入旧链路

关键文件：

- `src/utils/api.js`
- `src/utils/api.test.ts`

## 6. 当前版本不应继续保留的旧代码

以下代码建议在文档中明确标注为：

- 旧代码
- 非当前版本主线
- 可删除

### 6.1 `server/`

原因：

- 当前工作区中已不存在该目录
- 但 README / docs / 历史计划文档里仍大量保留对 `server/` 的引用
- 这些叙事应继续清理，避免让人误以为当前仓库仍以 Node server 为主线

### 6.2 `electron/`

原因：

- 当前工作区中已不存在该目录
- 但文档与历史说明中仍保留 Electron 时代的描述
- 这些叙事应继续清理

### 6.3 `package.json` 中旧启动链

复审结果：

- `package.json` 中旧启动链已基本清理
- 当前保留的主脚本已主要围绕：
  - `vite`
  - `tauri:dev`
  - `tauri:build`

结论：

- 当前更需要清理的是 README / docs / public API docs / i18n 中的旧叙事，而不是 `package.json` 脚本本身

## 7. 当前运行状态补充

当前核心监听进程的运行内存：

- `5173` Vite RSS 约 `202272 KB`
- `3002` `openwork` RSS 约 `158224 KB`

两者合计约：

- `352 MB`

## 8. 最终结论

当前版本最需要关注的不是新功能，而是先把已有主线缺陷收口。

优先顺序应理解为：

1. 收口登录状态、受保护路由与鉴权语义
2. 继续补齐多 Provider 的底层能力边界
3. 补齐 web 模式仍为空实现的写操作
4. 清理 README / docs / public API docs / i18n / 旧兼容 API 封装中的旧主线叙事
5. 决定是否保留并真正实现 branch workspace 入口

当前仓库里最容易造成误判的一点是：

- 看起来功能很多
- 但真正稳定、闭环、可信的当前版本能力仍然还没有完全收口

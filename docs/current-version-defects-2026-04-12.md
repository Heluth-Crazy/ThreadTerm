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
- `cargo test`：通过，21/21
- `npm run typecheck`：失败
- 当前运行中的核心监听进程：
  - `5173`：Vite
  - `3002`：Tauri 后端 HTTP 服务

## 1. 结论摘要

当前版本的核心问题不是“功能太少”，而是“主线存在一批已经暴露出来的断裂点”：

- 前端类型系统未通过
- Tauri 主线存在多处未闭环功能
- 多 Provider 支持表面完整，底层不对称
- 项目/会话/Git 的部分能力是伪实现或半实现
- HTTP 暴露边界过大

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
- `package.json` 中与 `server`、`electron:*`、旧 web 启动相关的部分

判断依据：

- 当前桌面运行主入口已经是 Tauri
- Tauri 初始化时会直接启动内置 HTTP 服务
- 当前实际运行端口也落在 Tauri 主线

结论：

- `Node / Electron` 不是当前版本主线
- 可以删除
- 至少应先在文档中明确标注为“遗留代码，待清理”

## 3. P0 缺陷

### 3.1 前端类型检查失败

当前版本无法通过 `npm run typecheck`。

报错集中在：

- `src/components/settings/CustomSlashCommandsEditor.tsx`
- `src/components/sidebar/hooks/useSidebarController.ts`
- `src/components/templates/SessionTemplatesEditor.tsx`
- `src/components/templates/SessionTemplatesPicker.tsx`
- `src/components/workbench/extensions/useExtensionsOverview.ts`
- `src/hooks/useCustomSlashCommands.ts`

核心问题：

- `settings.getAll()` 返回类型过宽
- 调用方直接访问：
  - `customSlashCommands`
  - `sessionTemplates`
  - `skills`
  - `skillRoots`
  - `worktreeRootPath`

这意味着：

- 当前主线在静态检查层面就不稳定
- 设置、模板、扩展、Slash Commands 这几块存在明确断裂

关键文件：

- `src/lib/tauri-bridge.ts`
- `src/components/settings/CustomSlashCommandsEditor.tsx`
- `src/components/templates/SessionTemplatesEditor.tsx`
- `src/components/templates/SessionTemplatesPicker.tsx`
- `src/components/workbench/extensions/useExtensionsOverview.ts`
- `src/hooks/useCustomSlashCommands.ts`
- `src/components/sidebar/hooks/useSidebarController.ts`

### 3.2 Tauri HTTP 服务暴露边界过大

当前 Tauri 主线会启动一个内置 HTTP 服务：

- 监听：`0.0.0.0:3002`
- CORS：`allow_origin(Any)`

而该服务暴露的不是只读信息，而是：

- 项目管理
- 会话创建/发送/终止
- PTY WebSocket
- 会话历史

当前实现中未见明确鉴权边界。

这意味着：

- 当前版本存在明显的暴露面过大问题
- 即便它最初只是兼容层，也已经具备高风险接口集合

关键文件：

- `src-tauri/src/http_server.rs`

### 3.3 项目删除与项目发现机制冲突

当前版本的项目删除并不可靠。

现状：

- 前端执行删除项目
- Tauri 后端只会把项目从 `.openwork/projects.json` 中移除
- 但项目列表又会从 `~/.claude/projects` 自动发现项目

结果：

- 用户“删除”的项目，后续仍可能再次出现
- 删除语义和用户预期不一致

这属于真实的功能错误，不是单纯未实现。

关键文件：

- `src/components/workbench/projects/SelectedProjectOverviewPage.tsx`
- `src/components/sidebar/hooks/useSidebarController.ts`
- `src-tauri/src/projects.rs`

## 4. P1 缺陷

### 4.1 项目重命名未实现

项目详情页与侧边栏都保留了重命名入口，但 Tauri 主线没有对应完整实现。

现状：

- 前端弹出输入框
- 实际只打印 warning 或刷新
- 不会真正完成重命名

影响：

- 用户可见按钮存在，但没有兑现行为

关键文件：

- `src/components/workbench/projects/SelectedProjectOverviewPage.tsx`
- `src/components/sidebar/hooks/useSidebarController.ts`

### 4.2 会话删除未真正落地

当前版本中的会话删除仍主要是本地状态层操作。

现状：

- UI 上允许删除会话
- 状态中会移除该会话
- Tauri 主线没有完整的真实删除命令

结果：

- 删除结果不可靠
- 一旦重新拉取历史或重新发现数据，状态可能不一致

关键文件：

- `src/hooks/useProjectsState.ts`
- `src/components/workbench/projects/SelectedProjectOverviewPage.tsx`
- `src/components/sidebar/hooks/useSidebarController.ts`

### 4.3 多 Provider 支持不对称

当前 UI 显示支持：

- Claude
- Codex
- Cursor

但底层历史/会话能力明显偏 Claude。

现状：

- `session_list` 对非 Claude 返回空
- `session_messages` 对非 Claude 返回空
- `ai_list_sessions` 对非 Claude 返回空

结果：

- UI 层“多 Provider 一致体验”不成立
- Codex/Cursor 在恢复、历史、浏览等核心体验上缺失

关键文件：

- `src-tauri/src/session_history.rs`
- `src-tauri/src/ai.rs`

### 4.4 Git 面板存在真实行为错误

当前 Git 面板不是只有“没做完”，而是已经有错误实现。

#### 4.4.1 Discard changes 实现错误

前端把文件路径伪装成 branch 参数传给 `git_checkout_branch`。

但后端 `git_checkout_branch` 的语义是：

- checkout branch / rev

不是：

- checkout 单个文件

因此当前 discard changes 逻辑是错误的。

#### 4.4.2 staged diff 语义不一致

前端会为 staged、unstaged、untracked 文件统一请求 diff。

但后端当前的 `git_diff` 主要是：

- `index -> workdir`

这会导致：

- staged-only 变更的 diff 不准确或为空

#### 4.4.3 历史 diff 与 AI commit message 未实现

现状：

- commit history diff 明确未实现
- AI commit message 是占位逻辑

关键文件：

- `src/components/GitPanel.jsx`
- `src-tauri/src/git.rs`

### 4.5 登录状态与鉴权状态不可信

当前版本在登录与权限感知上存在多处“伪状态”。

现状：

- Onboarding 里 Claude/Codex 登录状态是写死未登录
- `ProtectedRoute` 直接返回 children
- `AuthContext` 的默认态和 `isAuthenticated` 判定宽松

结果：

- 用户看到的认证状态不可靠
- 代码中关于“是否已认证”的判断也不可靠

关键文件：

- `src/components/Onboarding.jsx`
- `src/components/ProtectedRoute.jsx`
- `src/contexts/AuthContext.jsx`

### 4.6 Extensions 总览数据源错误

当前版本的技能总览页没有用真实技能 API。

现状：

- 总览页从 `settings.getAll()` 中读取 `skills` 和 `skillRoots`
- 真实技能数据来自 `skills_list`

结果：

- 总览页和真实技能系统脱节
- 这不是简单的 UI 偏差，而是数据层接错

关键文件：

- `src/components/workbench/extensions/useExtensionsOverview.ts`
- `src/components/workbench/extensions/useSkills.ts`
- `src-tauri/src/skills.rs`
- `src/lib/tauri-bridge.ts`

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

### 5.3 README 与当前版本不一致

README 仍然保留较多旧主线叙事：

- Node server
- 3001 端口
- TaskMaster 集成

而当前版本实际主线更接近：

- Tauri
- 3002
- 终端/会话管理

结果：

- 文档对当前版本描述不准确
- 新接手的人会建立错误认知

关键文件：

- `README.md`

## 6. 当前版本不应继续保留的旧代码

以下代码建议在文档中明确标注为：

- 旧代码
- 非当前版本主线
- 可删除

### 6.1 `server/`

原因：

- 属于旧 Node/Express 后端
- 当前 Tauri 主线已经承担核心桌面服务能力
- 继续保留会加重维护负担和认知混乱

### 6.2 `electron/`

原因：

- 属于旧桌面壳
- 当前桌面主线已经切到 Tauri
- 没有继续保留为主路径的必要

### 6.3 `package.json` 中旧启动链

需要标注为旧链路的内容包括：

- `server`
- `start`
- `electron:dev`
- `electron:build`
- 其他围绕旧 Node/Electron 主线的脚本

结论：

- 这些代码可以删除
- 至少应先在文档中明确标为遗留代码

## 7. 当前运行状态补充

当前核心监听进程的运行内存：

- `5173` Vite RSS 约 `197936 KB`
- `3002` `openwork` RSS 约 `165888 KB`

两者合计约：

- `355 MB`

如果把开发链父进程一起计入，整条开发链常驻约：

- `531 MB`

## 8. 最终结论

当前版本最需要关注的不是新功能，而是先把已有主线缺陷收口。

优先顺序应理解为：

1. 修复主线类型错误
2. 收紧 Tauri HTTP 暴露边界
3. 补齐项目/会话/Git 的真实闭环
4. 统一多 Provider 的底层能力
5. 明确把 `Node / Electron` 标为旧代码并清理

当前仓库里最容易造成误判的一点是：

- 看起来功能很多
- 但真正稳定、闭环、可信的当前版本能力还没有完全收口


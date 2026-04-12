# OpenWork 完整审查报告

日期：2026-04-12

范围：
- 当前仓库全部代码
- 当前主线：Tauri + Rust + React
- 遗留线：Node/Express + Electron + React

约束：
- 本次只做审查，不改动业务代码
- 结论基于当前工作树与当前运行状态

验证基线：
- `cargo test`：通过，21/21
- `npm run typecheck`：失败
- 当前运行中的开发进程：
  - `5173`：Vite
  - `3002`：Tauri 后端内置 HTTP 服务

## 1. 总体判断

这个仓库目前仍然是一个“终端/会话管理”系统，不是“任务管理”系统。

虽然 Tauri/Rust 主线已经加入了 `tasks`、`loop`、`handoff`、`skills` 等能力，但主导航、主信息架构、主交互路径仍围绕：

- 项目
- 会话
- 聊天/终端
- Git
- LiveGrid 多会话观察

任务能力目前更像一个局部附属面板，而不是一级业务对象。

同时，仓库仍保留 Node/Electron 旧架构，导致：

- 架构双轨并存
- 功能重复且不完全一致
- 文档与实际运行方式不一致
- 维护成本和认知成本偏高

## 2. 高优先级问题总表

### P0

1. Tauri 兼容 HTTP 服务直接监听 `0.0.0.0:3002`，并开放全量 CORS，路由包含项目、会话、PTY、WS 等能力，但未接入鉴权。
   - 文件：`src-tauri/src/http_server.rs`

2. 当前主线前端无法通过类型检查。
   - 核心根因：`settings.getAll()` 返回类型过宽，调用方直接把结果当成聚合设置对象使用。
   - 文件：
     - `src/lib/tauri-bridge.ts`
     - `src/components/settings/CustomSlashCommandsEditor.tsx`
     - `src/components/templates/SessionTemplatesEditor.tsx`
     - `src/components/templates/SessionTemplatesPicker.tsx`
     - `src/components/workbench/extensions/useExtensionsOverview.ts`
     - `src/hooks/useCustomSlashCommands.ts`
     - `src/components/sidebar/hooks/useSidebarController.ts`

3. Tauri 主线中的项目删除、会话删除、项目重命名没有完整落地。
   - 前端文案和用户预期是“真实管理”，但实现层大多仍是占位、局部状态变更或伪实现。

4. 项目删除语义与项目发现机制冲突。
   - 当前删除仅移除 `.openwork/projects.json` 记录。
   - 但项目列表又会从 `~/.claude/projects` 自动发现项目，导致用户删除后项目可能再次出现。

### P1

5. 多 Provider 支持在 UI 层看起来完整，但底层主要只对 Claude 完整。
   - `session_list`、`session_messages`、`ai_list_sessions` 对非 Claude 基本直接返回空。
   - Codex/Cursor 在历史、恢复、归档、对称能力上明显不足。

6. Git 面板存在真实行为 bug，不只是“未实现”。
   - “Discard changes” 通过 `git_checkout_branch` 传递 `-- <file>`，后端却按 branch/rev 解析。
   - staged-only diff 的前后端语义也不一致。

7. 任务系统存在，但没有进入主产品流。
   - 没有一级导航
   - 没有任务驱动的主流程
   - 命令面板也不以任务为中心

8. Extensions 总览页的数据源设计错误。
   - 总览页从 `settings.getAll()` 读取 `skills/skillRoots`
   - 真实技能系统来自 `skills_list`
   - 这两套来源没有统一

### P2

9. 登录/接入状态不可信。
   - Onboarding 中 Claude/Codex 登录状态为写死未登录
   - `ProtectedRoute` 直接放行
   - `AuthContext` 的 `isAuthenticated` 判定过宽

10. 文件系统安全边界与可用性策略冲突。
   - 当前文件访问必须位于 home 目录内
   - 这对真实开发场景限制很大

11. README 与当前主线存在明显偏差。
   - 文档仍大量强调 Node server、3001、TaskMaster 集成
   - 与当前 Tauri 主线实际运行方式不完全一致

12. 如果审查范围包含遗留 Node/Electron 线，则旧线仍然存在高风险的“弱鉴权/近似无鉴权”实现，应明确标红。

## 3. 功能审查

### 3.1 登录与接入

问题：
- Onboarding 不会展示真实 Claude/Codex CLI 登录状态
- 用户会被长期误导为“未登录”

证据：
- `src/components/Onboarding.jsx`

影响：
- 首次接入体验失真
- 用户会怀疑 CLI 配置或产品本身异常

### 3.2 项目管理

问题：
- 项目重命名未实现
- 项目删除不是完整删除，只是移除本地记录
- Claude 自动发现机制会让“已删除项目”重新出现

证据：
- `src/components/workbench/projects/SelectedProjectOverviewPage.tsx`
- `src/components/sidebar/hooks/useSidebarController.ts`
- `src-tauri/src/projects.rs`

影响：
- 用户对“项目管理”功能的心理模型会被破坏
- 删除操作缺乏可信性

### 3.3 会话管理

问题：
- 会话删除在 Tauri 主线没有真实后端支持
- 当前更多是本地状态删除
- 历史能力主要偏向 Claude
- Codex/Cursor 会话的恢复和历史不对称

证据：
- `src/hooks/useProjectsState.ts`
- `src-tauri/src/session_history.rs`
- `src-tauri/src/ai.rs`

影响：
- 会话管理不可靠
- 多 Provider 用户体验不一致

### 3.4 Git 能力

问题：
- commit 历史 diff 未实现
- AI commit message 未实现，仅为占位
- discard changes 存在错误实现
- staged diff 的展示模型与后端能力不一致

证据：
- `src/components/GitPanel.jsx`
- `src-tauri/src/git.rs`

影响：
- Git 面板不能作为稳定的日常主工具
- 关键操作存在误导

### 3.5 扩展、技能、模板、Slash Commands

问题：
- 技能真实列表与总览页不是一套数据源
- session templates 与 custom slash commands 依赖脆弱的 settings 聚合读取
- 当前这部分是“能堆数据”，但不是稳定的数据契约

证据：
- `src/components/workbench/extensions/useExtensionsOverview.ts`
- `src/components/workbench/extensions/useSkills.ts`
- `src/components/templates/SessionTemplatesEditor.tsx`
- `src/components/templates/SessionTemplatesPicker.tsx`
- `src/components/settings/CustomSlashCommandsEditor.tsx`
- `src/hooks/useCustomSlashCommands.ts`

影响：
- 扩展生态页面可靠性不足
- 配置项扩展时容易继续裂开

### 3.6 任务能力

问题：
- 任务只有局部面板，没有主入口
- 没有任务详情页
- 没有优先级、负责人、评论、子任务、交付物、审查流
- 没有与 session/git/worktree 的完整关联视图

证据：
- `src/components/task-panel/view/TaskPanel.tsx`
- `src/components/task-panel/hooks/useTaskPanel.ts`
- `src-tauri/src/tasks.rs`

影响：
- 这还不是任务系统，只是本地任务清单

### 3.7 Loop / 自动化执行

问题：
- `loop_runner` 是终端执行编排器，不是任务系统
- worker/verifier 机制更像会话自动化，而不是任务生命周期管理

证据：
- `src-tauri/src/loop_runner.rs`
- `src/components/loop/view/LoopDialog.tsx`

影响：
- 如果继续把它当任务能力宣传，会造成产品定位漂移

### 3.8 LiveGrid

问题：
- LiveGrid 是多会话观察/操作视图，不是任务看板
- 它强化了“并行终端会话”的产品心智，而不是“任务推进”

证据：
- `src/components/live-grid/view/LiveGridView.tsx`
- `src/components/live-grid/view/CardGrid.tsx`

影响：
- 与“从终端管理转向任务管理”的目标相冲突

## 4. 代码审查

### 4.1 当前主线问题

#### 4.1.1 类型系统断裂

`npm run typecheck` 当前报错如下：

- `src/components/settings/CustomSlashCommandsEditor.tsx`
- `src/components/sidebar/hooks/useSidebarController.ts`
- `src/components/templates/SessionTemplatesEditor.tsx`
- `src/components/templates/SessionTemplatesPicker.tsx`
- `src/components/workbench/extensions/useExtensionsOverview.ts`
- `src/hooks/useCustomSlashCommands.ts`

根因：
- `settings.getAll()` 在 bridge 层被声明为宽泛对象
- 调用方却直接访问：
  - `customSlashCommands`
  - `sessionTemplates`
  - `skills`
  - `skillRoots`
  - `worktreeRootPath`

#### 4.1.2 HTTP 服务暴露面过大

问题：
- 默认监听 `0.0.0.0:3002`
- `CORS allow_origin(Any)`
- 暴露项目、会话、WS、PTY 等能力
- 未体现明确鉴权边界

文件：
- `src-tauri/src/http_server.rs`

#### 4.1.3 文件访问实现存在边界问题

问题：
- 文件 API 被限制在 home 目录内
- 这在安全上简单粗暴，但会直接削弱真实开发可用性
- 从实现看，对“不存在目标 + symlink 父目录”的场景需要额外谨慎

文件：
- `src-tauri/src/fs_commands.rs`

#### 4.1.4 项目和会话模型偏 Claude

问题：
- 项目自动发现依赖 `~/.claude/projects`
- session history 也主要来自 Claude 的磁盘格式
- UI 已经做了 Claude/Codex/Cursor 的统一展示，但底层没有统一抽象

文件：
- `src-tauri/src/projects.rs`
- `src-tauri/src/session_history.rs`
- `src-tauri/src/ai.rs`

#### 4.1.5 Git 行为不一致

问题：
- `git_checkout_branch` 只能做 branch/rev checkout
- 但前端拿它做文件 discard
- `git_diff` 只做 `index -> worktree`
- 前端却需要覆盖 staged/unstaged/untracked 多种场景

文件：
- `src/components/GitPanel.jsx`
- `src-tauri/src/git.rs`

#### 4.1.6 任务模型过轻

当前 `tasks.rs` 采用 Markdown + frontmatter 存储，这个方案适合轻量起步，但不适合成为完整任务系统的数据底座，缺少：

- 优先级
- assignee
- 子任务
- 评论/活动流
- artifact
- review 状态
- 多 session / 多 commit 关联

### 4.2 遗留 Node/Electron 线问题

如果审查范围覆盖全仓库，这部分不能忽略。

#### 4.2.1 鉴权近似无效

问题：
- `/auth/status` 直接返回已认证
- `/login`、`/register` 直接成功
- JWT 中间件默认匿名放行
- WebSocket 也允许匿名回退

文件：
- `server/routes/auth.js`
- `server/middleware/auth.js`
- `server/index.js`

#### 4.2.2 Windows 下 MCP CLI 调用存在风险点

问题：
- Windows 分支下对 `claude` 使用 `spawn(..., { shell: true })`
- 参数来自请求体，虽然不等于直接注入成立，但这是需要重点收敛的风险面

文件：
- `server/routes/mcp.js`

#### 4.2.3 旧线并不是“完全失效”，而是“部分修过、但不应再继续扩大”

当前观察到：
- 一些历史上常见的 `git` shell 拼接问题已经在较多路径上改为 `execFile/spawn(shell:false)`
- 命令加载路径校验也已经比旧版本明显加强

因此，对旧线的判断应是：

- 不能再把它当主线继续扩展
- 也不能假设它已经达到了可持续维护的安全水平

## 5. 迭代方向建议

### 5.1 架构收敛

建议：
- 明确 Tauri/Rust 为唯一主线
- Node/Electron 线降级为迁移参考或兼容层
- 不再接受双线功能平行扩展

### 5.2 优先补“假功能”

优先补齐这些看起来存在、实际上没闭环的功能：

- 真实 CLI 登录状态检测
- 项目重命名
- 项目删除的真实语义
- 会话删除的后端支持
- commit 历史 diff
- Codex/Cursor 会话历史能力

### 5.3 统一数据契约

建议统一以下配置/对象的数据入口：

- settings
- skills
- templates
- slash commands
- worktree settings

原则：
- 不再通过 `settings.getAll()` 伪装复杂聚合对象
- 为稳定对象建立专门命令和稳定返回结构

### 5.4 收敛文档

README 需要和当前主线对齐，至少要统一：

- 主启动方式
- 主监听端口
- Tauri 与 Node 的关系
- TaskMaster 与内建 tasks 的边界
- 当前产品定位到底是终端管理还是任务管理

## 6. 从“终端管理”转向“任务管理”的迭代路线

### Phase 1：把任务升为一级对象

目标：
- 顶层导航从“项目/会话”切换为“任务/项目/自动化/设置”
- 默认首页改为任务收件箱或任务看板
- Session 不再是默认起点

建议：
- 保留项目作为任务的归属容器
- 把 `TaskPanel` 提升为完整任务模块

### Phase 2：重做任务数据模型

在现有 `tasks.rs` 基础上扩展：

- `priority`
- `assignee`
- `labels`
- `due_at`
- `parent_id`
- `subtasks`
- `artifacts`
- `linked_sessions`
- `linked_commits`
- `review_status`
- `completion_criteria`

原则：
- 当前单个 `session_id` 字段不够
- 任务必须能关联多次执行、多次提交、多次评审

### Phase 3：让任务驱动执行

新的主流程应改为：

1. 创建任务
2. 生成计划
3. 启动执行会话/工作树
4. 产出代码/提交
5. 审查
6. 完成/回退/重开

终端应降级为：
- 任务执行器
- 调试器
- 临时人工介入界面

### Phase 4：重挂现有能力

把现有能力重新接到任务之下：

- `loop_runner`：任务自动执行流
- `handoff`：任务阶段切换
- `git worktree`：任务隔离工作空间
- `skills`：任务模板/执行策略
- `session templates`：任务启动模板

### Phase 5：重做界面信息架构

任务详情页应该是新的核心页面，至少包含：

- 目标
- 上下文
- 活动流
- 关联 session
- 关联 commit
- 关联文件
- 交付物
- review 结论

命令面板也应优先搜索：

- 任务
- 项目
- 自动化动作

而不是优先搜索 session。

### Phase 6：重新定义 LiveGrid

LiveGrid 不应继续承担“主工作模式”角色。

更适合的定位是：
- 并行任务执行监控台
- 多任务观察面板
- 任务编排结果可视化视图

## 7. 补充审查项

### 7.1 运行内存

当前监听进程观察结果：

- `5173` Vite RSS 约 `197936 KB`
- `3002` `openwork` RSS 约 `165888 KB`

只计算这两个核心监听进程时：
- 合计约 `355 MB`

如果把 `npm run tauri:dev`、`cargo-tauri`、`npm run client` 父进程一起算，整个开发链常驻约：

- `531 MB`

### 7.2 文档与实现不一致

当前 README 仍明显带有旧主线叙事：

- Node server / Web 模式叙述占比高
- `3001` 仍是主要文档端口
- TaskMaster 被强调为项目管理能力

但当前实际代码演进显示：

- Tauri/Rust 才是当前桌面主线
- 内建 `tasks` 仍很早期
- 产品核心依然是终端/会话管理

### 7.3 审查结论

结论可以概括为三句：

1. 当前系统能跑，但主线产品定位仍然是“终端/会话管理”。
2. 任务能力已经出现，但还没有成为系统的中心对象。
3. 如果目标要转向“任务管理”，需要先收敛架构，再把任务提升为一级对象，再让会话/终端退居执行层。


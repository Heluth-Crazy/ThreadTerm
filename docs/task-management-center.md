# 任务管理中心使用文档

> 适用版本：OpenWork Phase 0 · Control Plane

---

## 概述

**任务管理中心**（Mission Control / Task Management Center）是 OpenWork 的核心调度系统，让你可以把"要让 AI 做的事"拆解成一个个可追踪、可排队、可流转的**任务（Task）**，然后自动或手动地把任务分配给 Claude / Codex 会话执行。

核心价值：
- 多项目并行开发时，无需盯着每一个终端窗口
- 任务执行完成后自动排队下一个，或等待人工审批
- 支持把一个 AI 会话的工作移交给另一个 AI 会话继续

---

## 核心概念

### 任务（Task）

一条"工作指令"，包含：
- **标题（Title）** — 一句话描述要做什么
- **提示词（Prompt）** — 完整指令，发给 AI 执行
- **状态（Status）** — 见下文《任务状态》
- **角色（Role）** — AI 在这条任务里的职责
- **执行方式（Execution Strategy）** — 如何运行这条任务
- **派发目标（Dispatch Target）** — 在哪个 Worktree / 项目路径中运行

### 任务状态（Status）

| 状态 | 说明 |
|------|------|
| **Queued（排队中）** | 任务已创建，等待执行 |
| **Running（执行中）** | 任务正在 AI 会话中运行 |
| **Pending Review（待审查）** | AI 执行完毕，等待人工确认结果 |
| **Approved（已通过）** | 审查通过，任务成功 |
| **Failed（失败）** | 执行过程中出错 |
| **Cancelled（已取消）** | 手动取消 |
| **Blocked（被阻塞）** | 依赖的任务尚未完成 |

### 角色（Role）

AI 在这条任务中的**工作职责**，决定了它应该做什么：

| 角色 | 说明 |
|------|------|
| **Implement（实现）** | 写代码、做功能开发 |
| **Review（代码审查）** | 审查已有代码，给出反馈 |
| **Verify（验证）** | 运行测试、验证结果是否正确 |
| **Research（调研）** | 调研技术方案或分析问题 |

### 执行方式（Execution Strategy）

任务**如何被分配和执行**：

| 执行方式 | 说明 |
|----------|------|
| **This Project（当前项目）** | 直接在当前会话的项目路径中执行 |
| **Worktree（Worktree 分支）** | 在 Git Worktree 独立分支目录中执行 |
| **Handoff（移交）** | 把任务移交给另一个 AI 会话执行 |

### 移交（Handoff）

**Handoff** 是一种特殊的执行方式：当前 AI 会话（来源会话）把任务交给另一个 AI 会话（运行会话）来完成。

```
来源会话 (Source Session)
    │
    │  创建 Handoff 任务
    ▼
目标 AI 会话 (Runtime Session)
    │
    │  实际执行任务
    ▼
结果回到任务队列等待审查
```

典型使用场景：Claude 会话完成代码后，自动移交给 Codex 做验证，或移交给另一个 Claude 会话做代码审查。

### 来源会话 / 运行会话（Source Session / Runtime Session）

- **来源会话（Source Session）** — 触发或创建了这条任务的 AI 会话
- **运行会话（Runtime Session）** — 实际执行任务的 AI 会话

对于 Handoff 任务，这两个通常是不同的会话。对于普通任务，两者可以是同一个。

### 派发目标（Dispatch Target）

任务运行在**哪个目录**里：
- `This Project` — 主项目根目录
- `review-a worktree` — Git Worktree 目录（路径通常为 `<项目路径>/.worktrees/<分支名>`）

---

## 界面区域说明

任务管理中心（Mission Control）由以下几个面板组成：

### 1. 任务时间线（Task Timeline）

水平分为四列，显示所有任务的流动状态：

```
Backlog（待办）→ Running（执行中）→ Review（审查中）→ Completed（已完成）
```

每张任务卡片显示：
- 任务标题
- 执行方式徽章（如 `Handoff`、`Worktree`）
- 角色徽章（如 `Review`、`Verify`）
- 主路径徽章（当前任务所在功能区，如 `Approval Inbox`、`Review Queue`）

### 2. 审批收件箱（Approval Inbox）

执行过程中，AI 需要**人工授权**才能继续的请求。

例如：AI 要执行某个有风险的命令时，会暂停并在这里等待你的批准。

操作：
- **Approve（批准）** — AI 继续执行
- **Reject（拒绝）** — AI 停止当前操作

### 3. 关注收件箱（Attention Inbox）

需要你**注意但不一定需要立即批准**的事项，例如：
- AI 遇到了问题需要你的指引
- 某个会话长时间无响应

### 4. 后台运行（Background Runs）

所有在**后台运行**的任务会话列表，分为：
- **Active（活跃）** — 正在执行中
- **Recent（最近完成）** — 近期结束的运行记录

每条记录显示：
- 任务名称和状态
- 执行方式（如 `Handoff`）
- 关联的来源会话和运行会话
- 最后一条输出摘要
- 操作按钮：打开对应会话或进入相关面板

### 5. 审查队列（Review Queue）

AI 执行完毕、**等待人工审查结果**的任务列表。

你可以在这里：
- 查看 AI 完成的工作内容
- **Accept（接受）** — 任务成功，移入结果收件箱
- **Reject（拒绝）** — 要求 AI 重做或修改

### 6. 结果收件箱（Result Inbox）

已经通过审查、**执行成功完成**的任务归档记录。

### 7. 任务队列面板（Task Queue Panel）

侧边或浮动面板，显示当前项目的任务队列，可以：
- 添加新任务（`+` 按钮）
- 查看排队中/运行中/审查中的任务数量
- 开启/关闭自动执行（Auto Execute）
- 设置并发上限（Max 并发数）
- 清除已完成任务

---

## 使用流程（完整示例）

### 场景：给当前项目添加一个"代码审查"任务

**第一步：添加任务**

1. 点击侧边栏的**任务队列（Queue）**图标
2. 点击右上角 `+` 按钮（或 `Add Task`）
3. 填写：
   - **标题**：`Review authentication module`
   - **提示词**：`请审查 src/auth/ 下所有文件的代码质量，关注安全漏洞和代码规范`
   - **角色**：`Review`
   - **执行方式**：`Handoff`（移交给 Codex 执行）
4. 点击确认创建

任务此时状态为 **Queued**。

**第二步：执行**

- 如果**自动执行**已开启：系统会自动把任务分配给合适的 AI 会话开始运行
- 如果关闭：点击任务卡片上的 **Run** 按钮手动触发

任务状态变为 **Running**，出现在**后台运行（Background Runs）**面板中。

**第三步：监控**

在 Background Runs 面板可以看到：
- 当前输出摘要
- 执行进度
- 点击 **Open Session** 可以直接跳转到对应 AI 会话

**第四步：审查**

AI 执行完毕后，任务移入**审查队列（Review Queue）**，状态变为 **Pending Review**。

- 打开审查队列
- 查看 AI 完成的内容
- 点击 **Accept** 接受，或 **Reject** 打回重做

**第五步：完成**

接受后，任务进入**结果收件箱（Result Inbox）**，标记为完成。

---

## 任务卡片字段解读

任务卡片上的徽章和字段释义：

```
Session 019da0f0                        ← 关联的 AI 会话 ID
Task · Handoff Session 019da0f0 to Claude  ← 任务标题（自动生成）
Implement                               ← 角色：要让 AI 实现某功能
Handoff                                 ← 执行方式：移交给另一个会话
Handoff Session                         ← Handoff 绑定来源标签
Background Runs                         ← 当前任务所在的功能面板
Failed                                  ← 任务状态：失败
Dispatch target · This project          ← 派发到当前项目路径运行
Source session · /path · Codex · Session 019da0f0-0d3  ← 触发此任务的来源会话
Runtime session · This session          ← 实际执行此任务的会话
Open Background Runs                    ← 主操作按钮：打开后台运行面板
💬 Chat                                 ← 打开对话界面
🖥 Terminal                             ← 打开终端界面
```

> **提示**：`Failed` 状态通常表示 AI 会话在执行过程中遇到了错误。可以点击 `Open Background Runs` 查看详细日志，或点击 `💬 Chat` 查看 AI 会话中的完整输出。

---

## 自动执行（Auto Execute）

在任务队列面板中可以开启**自动执行**模式：

- **开启**：新加入队列的任务会自动按顺序分配给 AI 会话运行，无需手动触发
- **关闭**：任务进入队列后停留在 Queued 状态，等待手动启动
- **Max 并发数**：控制同时最多运行几个任务，防止资源竞争

> 建议多项目并行开发时开启自动执行，并设置合适的并发上限（推荐 2-3）。

---

## 常见问题

### Q: 任务一直是 Queued 状态，没有自动执行？

A: 检查任务队列面板的 **Auto Execute** 开关是否已开启，或手动点击任务上的 Run 按钮。

### Q: 任务显示 Failed，如何查看原因？

A: 点击任务卡片上的 **Open Background Runs** 或 **💬 Chat** 按钮，查看 AI 会话的输出日志。

### Q: Handoff 任务的运行会话是哪一个？

A: Handoff 任务会在系统中匹配一个空闲的目标 AI 会话（或新建一个），你可以在任务卡片的 `Runtime session` 字段看到具体是哪个会话在执行。

### Q: 如何取消一个正在运行的任务？

A: 在 Background Runs 面板找到对应的运行记录，点击 **Cancel** 按钮，或直接在 AI 会话的终端中中断执行。

### Q: 审查队列中积压了很多任务怎么办？

A: 在 Review Queue 面板可以批量操作。如果任务结果明显正确，可以直接 Accept；如果需要重做，点击 Reject 会把任务重新放入队列。

---

## 技术说明（开发者参考）

任务管理中心的状态存储在本地 SQLite 数据库中（通过 Tauri 的 Rust 后端管理）。关键数据结构：

```typescript
interface Task {
  id: string;                        // 唯一 ID
  title: string;                     // 任务标题
  prompt: string;                    // 发给 AI 的完整指令
  status: TaskStatus;                // 当前状态
  role?: TaskRole;                   // AI 角色
  execution_strategy?: ExecutionStrategy;  // 执行方式
  project_path: string;              // 所属项目路径
  worktree_path?: string;            // Worktree 路径（如适用）
  source_session_id?: string;        // 来源会话 ID
  runtime_session_id?: string;       // 运行会话 ID
  review_required: boolean;          // 是否需要人工审查
  deps: string[];                    // 依赖的其他任务 ID
  created_at: string;                // 创建时间
  updated_at: string;                // 更新时间
}
```

任务在界面中的展示逻辑由以下模块控制：
- `src/lib/task-dispatch.ts` — 任务派发上下文格式化
- `src/lib/task-main-path.ts` — 任务所在功能面板徽章
- `src/components/overview/` — Mission Control 各面板组件
- `src/components/task-queue/` — 任务队列面板组件

---

*文档最后更新：2026-04-19 | OpenWork Phase 0 Control Plane*

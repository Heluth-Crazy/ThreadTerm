# OpenWork 最终架构方案 v2

> 日期：2026-04-19  
> 适用范围：当前 Tauri + Rust + React 主线  
> 性质：主架构文档，面向后续实现，不是评审记录  
> 结论原则：尽量复用现有代码资产，明确主线、冻结实验线、停止旧叙事污染

---

## 1. 最终产品 / 架构判断

### 1.1 最终判断

OpenWork 的主产品方向应明确为：

**终端型 AI 编程代理控制平面（terminal AI coding control plane / mission control）**。

它不是新的 IDE，也不是普通聊天壳，更不是再做一层“会话列表 + 文件/Git 辅助工具”。它的核心价值是：

1. **同时管理多个 AI session / agent**
2. **把注意力成本集中化**，让用户只在需要审批、失败、完成、复核时介入
3. **把任务、队列、会话、worktree 串成闭环**
4. **逐步演进为多 agent 调度台，而不是一次性上重编排系统**

### 1.2 基于代码现实的判断

当前真正可复用、且已经接近主线的资产是：

- Rust 执行底座：`src-tauri/src/pty.rs`
- 多 provider 会话启动：`src-tauri/src/ai.rs`
- Git / worktree：`src-tauri/src/git.rs`
- 文件化任务持久化：`src-tauri/src/tasks.rs`
- Tauri + HTTP/WS 双桥：`src-tauri/src/http_server.rs`、`src/lib/tauri-bridge.ts`
- 前端运行态感知：`src/stores/sessionStatusStore.ts`、`src/hooks/useSessionStatusTracker.ts`
- 任务队列 UI 雏形：`src/stores/taskQueueStore.ts`、`src/components/task-queue/TaskQueuePanel.tsx`、`src/hooks/useAutoExecutor.ts`
- 控制台入口：`src/components/overview/MissionControlView.tsx`
- 并行观察入口：`src/components/live-grid/view/LiveGridView.tsx`

### 1.3 必须纠正的过度乐观判断

现有 draft 对 `handoff.rs` 和 `loop_runner.rs` 的产品化价值偏乐观，实际应降级判断：

- `handoff.rs` 目前只是 **“读取最近 PTY buffer + 拼一段 prompt + 拉起新 session”** 的 PoC，不是可靠的协作协议
- `loop_runner.rs` 目前是 **内存态、启发式轮询、基于最近输出文本做验证回路** 的实验 harness，不是正式 orchestration engine
- 它们都可以保留，但**不能作为主架构中心**，更不能跳过任务模型统一和 attention center 就往上堆功能

### 1.4 当前主线的核心问题

不是“功能太少”，而是下面四件事没有统一：

1. **任务模型分裂**：`tasks.rs` 与 `taskQueueStore.ts` 双轨
2. **注意力入口缺失**：有 `needs_attention`，没有统一 inbox / approval center
3. **会话与任务关系不正式**：session 是运行容器，但系统里没有稳定的一等关联
4. **旧叙事污染仍在**：TaskMaster / 旧 Node/Electron 认知残留仍影响命名与边界

### 1.5 最终结论

**OpenWork 接下来的主线不是“继续加更多 agent 功能”，而是先把控制平面的骨架补齐。**

优先顺序必须是：

1. 统一任务真相
2. 建 Attention / Approval Center
3. 明确 Mission Control / Live Grid / Queue 的边界
4. 再收编 handoff / loop 为高级执行策略

---

## 2. 目标架构分层与职责

建议采用 **4 层 + 2 个横切面**，并严格区分 durable state 与 runtime projection。

```text
┌──────────────────────────────────────────────────────────────┐
│ Layer 4  Control Plane UI                                   │
│ Mission Control / Attention Center / Task Queue / Review    │
├──────────────────────────────────────────────────────────────┤
│ Layer 3  Application State / Orchestration                  │
│ Task projection / Session registry / Attention router       │
│ Dispatcher / Approval actions / Derived counters            │
├──────────────────────────────────────────────────────────────┤
│ Layer 2  Runtime Adapters                                   │
│ Tauri bridge / Event normalization / HTTP fallback          │
├──────────────────────────────────────────────────────────────┤
│ Layer 1  Execution Kernel                                   │
│ PTY / AI CLI / Git / Worktree / FS / Session history        │
└──────────────────────────────────────────────────────────────┘
横切面 A：Durable models（tasks / project metadata / settings）
横切面 B：Event stream（pty-output / session-state / attention / loop-state）
```

### 2.1 Layer 1：Execution Kernel

**职责：执行，不决策。**

对应代码：

- `src-tauri/src/pty.rs`
- `src-tauri/src/ai.rs`
- `src-tauri/src/git.rs`
- `src-tauri/src/fs_commands.rs`
- `src-tauri/src/session_history.rs`
- `src-tauri/src/projects.rs`
- `src-tauri/src/http_server.rs`（其会话/PTY转发部分）

这一层允许做的事：

- 拉起/结束 PTY
- 启动 Claude / Codex / Cursor CLI
- 发送输入、接收输出、发出 runtime event
- 枚举 git 状态、worktree、历史、文件差异
- 读取持久化任务文件

这一层**不允许**承担的事：

- 判定任务完成是否需要 review
- 判定 Mission Control 如何排序
- 判定 approval item 如何归并
- 自己直接修改前端 queue 语义

### 2.2 Layer 2：Runtime Adapters

**职责：把 Rust runtime 能力翻译成前端稳定接口。**

对应代码：

- `src/lib/tauri-bridge.ts`
- `src/contexts/TauriEventContext.tsx`
- `src/contexts/WebSocketContext.tsx`

当前桥层已经有价值，但有两个现实问题：

1. 同时承担了 **Tauri IPC、HTTP fallback、类型定义、部分领域模型**，职责偏重
2. `tasks` / `loop` / `handoff` 虽然暴露出 bridge API，但前端主路径并未真正以其为中心

建议：

- bridge 继续保留，不重写
- 但后续要把其中的领域类型逐步挪到独立 `src/domain/*` 或 `src/types/*`
- bridge 只负责 transport，不再承担主领域判断

### 2.3 Layer 3：Application State / Orchestration

**职责：把底层事件和 durable 模型整合成前端可操作的业务状态。**

这一层是 OpenWork 现在最缺的层。

建议主要包含：

- `sessionRegistryStore`：会话运行态投影与 task 绑定关系
- `attentionStore`：注意力项、审批项、已处理项
- `taskViewStore`：任务列表的投影、过滤、排序、选择态
- `dispatcher`：从 task 派发到 session 的流程控制
- `approvalActions`：approve / deny / open session / snooze

当前可复用但需调整的代码：

- `src/stores/sessionStatusStore.ts`
- `src/hooks/useSessionStatusTracker.ts`
- `src/hooks/useAttentionRouter.ts`
- `src/hooks/useAutoExecutor.ts`

### 2.4 Layer 4：Control Plane UI

**职责：让用户在少量入口中完成观察、决策、审批、派发、回收。**

对应 UI 应分为三类，不再混用：

1. **Mission Control**：总览 + attention + active sessions + key task signals
2. **Live Grid**：高并发观察与快捷干预
3. **Task Queue / Task Board**：任务池、待派发、运行中、完成待复核

当前代码对应：

- `src/components/overview/MissionControlView.tsx`
- `src/components/live-grid/view/LiveGridView.tsx`
- `src/components/task-queue/TaskQueuePanel.tsx`

问题是：三个入口都存在，但还没有形成清晰分工。后文会给出明确边界。

---

## 3. 核心领域 / 实体模型

这里的原则是：

- **Task 是 durable control object**
- **Session 是 runtime execution object**
- **Queue 是 task 的视图或调度状态，不是平行真相**
- **Attention / Approval 是 runtime 业务实体，但必须结构化**

## 3.1 Task：系统主任务实体

### 当前现实

`src-tauri/src/tasks.rs` 当前字段只有：

- `id`
- `title`
- `description`
- `status`
- `created_at`
- `updated_at`
- `deps`
- `session_id`

优点：

- 已有 `.openwork/tasks/*.md` 文件化持久化
- 已有 `task_list / task_create / task_update / task_delete`
- 已接到 `tauri-bridge.ts`

缺点：

- 还不够支撑 control plane
- 没有 prompt、provider、priority、role、review、approval policy、result summary、worktree 等字段

### 目标定义

```rust
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub prompt: Option<String>,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub provider: Option<String>,
    pub role: TaskRole,
    pub project_path: String,
    pub worktree_path: Option<String>,
    pub session_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub deps: Vec<String>,
    pub review_required: bool,
    pub approval_policy: ApprovalPolicy,
    pub result_summary: Option<String>,
    pub result_ref: Option<String>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}
```

```rust
pub enum TaskStatus {
    Open,
    Queued,
    Dispatched,
    InProgress,
    PendingApproval,
    PendingReview,
    Done,
    Failed,
    Cancelled,
}
```

### 关键判断

- **Task 应是任务真相源**
- Queue 不再是另一套任务系统
- `Queued / Dispatched / InProgress / PendingReview` 都应该是 TaskStatus 的一部分，而不是只存在于前端 store

## 3.2 Session / AgentRuntime：执行容器

### 当前现实

- `ai.rs` 用 session id / pty id 启动 CLI
- `pty.rs` 维护活跃 PTY map 和状态机
- 前端 `sessionStatusStore.ts` 维护 `idle / processing / needs_attention / completed`

问题：

- Rust 侧没有正式的 `AgentRuntime` durable / query model
- 前端状态是 UI-friendly 的，但不是完整 runtime registry
- `projects.rs` 中的 session 元数据、`pty.rs` 中的 PTY runtime、`session_history.rs` 中的历史记录是分离的

### 目标定义

建议引入统一概念：

```ts
interface AgentRuntime {
  sessionId: string;
  ptyId: string;
  provider: 'claude' | 'codex' | 'cursor';
  projectPath: string;
  worktreePath?: string;
  boundTaskId?: string;
  runtimeState: 'starting' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'killed';
  startedAt: string;
  updatedAt: string;
}
```

注意：

- 第一阶段不需要把它完整持久化到 Rust DB
- 但必须在前端建立**统一投影**，并通过 `sessionId` / `ptyId` 与任务挂钩

## 3.3 QueueEntry：任务队列视图，不是独立真相

### 当前现实

`src/stores/taskQueueStore.ts` 现在维护独立 `QueuedTask`：

- `id`
- `title`
- `prompt`
- `projectPath`
- `provider`
- `status`
- `sessionId`
- `error`

这套模型今天确实“在跑”，但架构上必须降级：

### 最终定义

```ts
interface QueueEntry {
  taskId: string;
  queueState: 'queued' | 'claiming' | 'running' | 'blocked' | 'done' | 'failed';
  rank: number;
  dispatcher?: 'manual' | 'auto';
  lastError?: string;
}
```

关键点：

- QueueEntry 引用 Task，而不是替代 Task
- queue 的顺序、过滤、自动执行等是 runtime UI / dispatch concern
- 任务本体仍然由 Rust `tasks.rs` 持久化

## 3.4 AttentionItem：统一注意力实体

当前 `sessionStatusStore.ts` 只有：

- `statuses`
- `pendingPermissions`

这不够。需要新的一等实体：

```ts
interface AttentionItem {
  id: string;
  sessionId: string;
  taskId?: string;
  provider?: 'claude' | 'codex' | 'cursor';
  type: 'permission_request' | 'waiting_input' | 'runtime_error' | 'session_aborted' | 'task_completed' | 'review_required';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  summary: string;
  createdAt: number;
  status: 'active' | 'resolved' | 'dismissed';
  sourceEvent: string;
}
```

## 3.5 ApprovalRequest：审批中心的一等对象

当前 `pendingPermissions` 是：

- 以 `sessionId -> request` 的 map 表示
- 没有列表语义
- 没有 risk / timestamp / 生命周期

应提升为：

```ts
interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  taskId?: string;
  provider?: 'claude' | 'codex' | 'cursor';
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high';
  requestedAt: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decidedAt?: number;
}
```

## 3.6 ReviewItem：结果回收实体

这不是第一阶段就全实现，但架构上必须预留。

```ts
interface ReviewItem {
  id: string;
  taskId: string;
  sessionId: string;
  status: 'pending' | 'accepted' | 'rework' | 'archived';
  resultSummary?: string;
  changedFiles?: string[];
  diffSummary?: string;
  riskFlags?: string[];
  createdAt: number;
}
```

---

## 4. 状态机与事件流

## 4.1 Task 状态机

建议采用下面的正式流转：

```text
Open
  -> Queued
  -> Dispatched
  -> InProgress
  -> PendingApproval   （遇到审批，任务被阻塞）
  -> InProgress        （审批通过继续）
  -> PendingReview     （完成但需要人工回收）
  -> Done

InProgress -> Failed
Open/Queued/Dispatched/InProgress -> Cancelled
PendingReview -> Open             （要求返工）
```

### 当前代码与此状态机的落差

- `tasks.rs` 只有 `open / in_progress / done / failed`
- `taskQueueStore.ts` 额外引入 `queued / running / cancelled`
- `useAutoExecutor.ts` 实际是在拿 session 状态推断 queue 完成

因此第一优先级不是加更多自动化，而是**把状态机并回 Task 本体**。

## 4.2 Session 运行状态机

### Rust 已有

`pty.rs::SessionState`：

- `Idle`
- `Running`
- `WaitingForInput`
- `Completed`
- `Failed`

### 前端已有投影

`sessionStatusStore.ts`：

- `idle`
- `processing`
- `needs_attention`
- `completed`

### 最终建议

两者都保留，但分清语义：

- Rust `SessionState`：**底层 runtime state**
- 前端 `SessionRuntimeStatus`：**控制台视角状态**

映射关系：

| Rust runtime | Frontend control status | 说明 |
|---|---|---|
| Running | processing | 正常执行 |
| WaitingForInput | needs_attention | 需要人工输入/批准 |
| Completed | completed | 进程结束，但任务未必 done |
| Failed | needs_attention | 对控制台来说应进入处理池 |
| Idle | idle | 空闲 |

注意：**session completed ≠ task done**。只有在任务策略判断通过后，task 才能 done 或 pending_review。

## 4.3 事件流：PTY → Status → Attention → UI

### 当前现实

- `pty.rs` 发出 `pty-output`
- `pty.rs` 发出 `session-state-changed`
- `pty.rs` 发出 `attention-required`
- `useSessionStatusTracker.ts` 主要监听 WebSocket 消息型事件（`claude-response` 等）
- `useAttentionRouter.ts` 直接把 `needs_attention` 路由到 Live Grid focus

### 问题

现在存在两套并行事件理解：

1. Rust PTY/Tauri event 流
2. 前端消息流（Claude/Codex message type）

这会导致状态语义不一致，尤其在 web / tauri / provider 差异场景下更容易漂移。

### 最终建议

统一成 4 步：

1. **Execution event**：来自 PTY / provider / HTTP WS
2. **Normalized runtime event**：桥层标准化
3. **Store update**：更新 session / task / attention store
4. **UI reaction**：Mission Control / Live Grid / Queue 分别订阅

建议标准事件类型：

```ts
type RuntimeEvent =
  | { type: 'session.started'; sessionId: string; provider: string }
  | { type: 'session.state_changed'; sessionId: string; state: string }
  | { type: 'session.output'; sessionId: string; chunk: string }
  | { type: 'session.permission_requested'; sessionId: string; requestId: string; toolName: string; input: unknown }
  | { type: 'session.permission_resolved'; sessionId: string; requestId: string; approved: boolean }
  | { type: 'session.failed'; sessionId: string; reason?: string }
  | { type: 'task.bound'; taskId: string; sessionId: string }
  | { type: 'task.state_changed'; taskId: string; status: string }
```

## 4.4 Auto Execute 的正确位置

`useAutoExecutor.ts` 当前直接：

- 观察 `sessionStatusStore`
- session 从 processing -> completed/idle 时，标记 queue task done
- 然后 claim next

这对 MVP 有用，但架构上位置不对。后续应变成：

- `dispatcher` 消费 Task 列表和会话容量
- 绑定 task -> session
- 调用后端更新 `task.status`
- queue store 只显示结果

也就是说：

**AutoExecutor 不再直接操作本地 queue 真相，而是操作 Task + Session 的绑定关系。**

---

## 5. Mission Control / Live Grid / Task Queue 的边界

这是本次架构文档必须明确的重点。

## 5.1 Mission Control 的职责

Mission Control 不是“大号 session 列表页”。

### 应负责

1. 显示当前最重要的 attention items
2. 展示 active sessions 的概况
3. 展示任务池中最重要的任务状态摘要
4. 提供审批入口、跳转入口、派发入口
5. 展示今日/当前项目的控制台级指标

### 不应负责

- 展示完整实时终端输出
- 承担大量并行观察细节
- 直接承载复杂编辑/对比器

### 对当前代码的结论

`src/components/overview/MissionControlView.tsx` 目前只是在：

- flatten projects 下的 sessions
- 按状态排序
- 显示 card grid

它可保留为入口，但必须升级为：

- 顶部：Attention / Approval Center
- 中部：Active Sessions
- 底部或右侧：Task summary / review-needed summary

## 5.2 Live Grid 的职责

Live Grid 是 **并行观察与快速干预视图**，不是系统总控中心。

### 应负责

- 多 session 并排监视
- 快速切换 focus
- 快速发送输入/提示
- 强调 session-level runtime signal

### 不应负责

- 作为 attention 的唯一入口
- 决定任务优先级
- 承担审批中心或任务总览

### 对当前代码的结论

`src/components/live-grid/view/LiveGridView.tsx` 现状良好，应保留为专门模式。

但 `useAttentionRouter.ts` 现在把 attention 直接自动聚焦到 Live Grid card，这会把 Live Grid 变成隐式主控制层。应改成：

- 默认先进入 Attention Center
- 用户可从 Attention Center 跳转到 Live Grid / Session Focus
- 自动聚焦只作为可配置辅助，不再是核心流程

## 5.3 Task Queue 的职责

Task Queue 应是 **任务派发与调度视图**，不是另一个独立系统。

### 应负责

- 查看待执行任务
- 调整顺序 / 优先级
- 手动派发 / 自动派发
- 查看运行中、失败、待 review 的任务

### 不应负责

- 自己维护独立任务真相
- 用本地 Zustand 状态替代 Rust tasks

### 对当前代码的结论

`TaskQueuePanel.tsx` 和 `taskQueueStore.ts` 可保留 UI 形态，但必须换底盘。

**最终边界一句话：**

- Mission Control = 看全局、做决策
- Live Grid = 看并行执行、做快速干预
- Task Queue = 管任务池、做派发调度

---

## 6. Tasks vs Queue vs Sessions 的 source-of-truth 方案

这是主架构最关键的部分。

## 6.1 总原则

### 真相源

- **Task 真相源：Rust `tasks.rs` + `.openwork/tasks/*.md`**
- **Session runtime 真相源：Rust `pty.rs` 活跃 session map + provider runtime event**
- **Project / session history 真相源：`projects.rs` + `session_history.rs`**
- **Queue 真相源：不存在独立真相；它只是 Task 的调度视图**
- **Attention / Approval 真相源：前端结构化 store，来源于 runtime events**

## 6.2 为什么不能继续双轨

当前双轨的具体问题：

### Rust `tasks.rs`
优点：
- durable
- 可跨前端模式复用
- 可与 worktree / review / remote mode 对接

缺点：
- 字段少
- 前端未真正接主路径

### 前端 `taskQueueStore.ts`
优点：
- 已有 UI
- 已接 `useAutoExecutor.ts`
- 上手快

缺点：
- 本地状态即真相，无法和 Rust runtime 正式闭环
- 与 session / review / worktree 的关联全是临时拼接
- Web / LAN / remote 场景无法长期成立

### 最终结论

**保 Rust tasks，降级 taskQueueStore。**

## 6.3 三类状态如何分工

### Task（durable）
必须持久化：
- title / prompt / role / provider / priority
- deps
- status
- session_id
- worktree_path
- result_summary
- review_required

### Queue（runtime projection）
不必持久化或只做轻量本地缓存：
- 当前排序
- 是否展开
- 当前过滤器
- autoExecute 开关
- maxConcurrent
- 任务临时 claim 中状态

### Session（runtime）
不进入 Task 文件，但要有统一投影：
- 当前 provider
- 绑定任务
- 当前运行状态
- 最后注意力原因
- 最近活动时间

## 6.4 具体落地方案

### Phase 1 过渡方案

先不删除 `taskQueueStore.ts`，而是把它改成：

- `queueOrder: string[]`
- `uiStateByTaskId`
- `autoExecute`
- `maxConcurrent`

把 `QueuedTask` 中真正属于任务本体的字段移到 Rust tasks。

### Phase 2 目标方案

前端 Task Queue 页面加载流程改为：

1. `tasks.list(projectPath)` 拉 durable tasks
2. `sessionStatusStore` / `sessionRegistryStore` 注入运行态信息
3. `taskQueueStore` 只提供排序、筛选、autoExecute 配置
4. 派发时调用新的 dispatcher：
   - 更新 task.status=queued/dispatched/in_progress
   - 启动 session
   - 绑定 session_id

### 6.5 不再允许的写法

后续不应再新增以下模式：

- 前端本地新建“任务对象”但不写入 `tasks.rs`
- 以 `session completed` 直接视为任务完成
- queue 状态比 task 状态更可信
- `taskQueueStore.queue` 成为徽标、面板、控制逻辑的唯一数据源

---

## 7. Attention / Approval Center 设计

## 7.1 为什么这是第一优先级之一

OpenWork 的核心产品价值不是“我能开很多 session”，而是：

**我不需要一直盯着很多 session。**

所以 attention center 必须成为控制平面中心，而不是 session badge 的附属物。

## 7.2 当前现状

当前已有的前置信号：

- Rust `pty.rs` 会发 `attention-required`
- `sessionStatusStore.ts` 有 `needs_attention`
- `useSessionStatusTracker.ts` 可识别 `claude-permission-request`
- `pendingPermissions` 已存在
- Live Grid / Session UI 已能显示状态徽标

缺口：

- 没有统一 Attention 列表
- 没有明确 risk level
- 没有审批记录与已处理态
- 没有批量处理或统一入口

## 7.3 最终结构

建议拆成两个 store：

### A. `attentionStore.ts`
负责：
- AttentionItem 列表
- 归并规则
- 已处理/忽略状态
- 与 Mission Control UI 的直接对接

### B. `approvalStore.ts` 或 attentionStore 子域
负责：
- ApprovalRequest 列表
- riskLevel 计算
- approve / deny / expire
- 与 `ai_approve_tool` 调用闭环

## 7.4 事件到审批项的转换规则

### 来源一：provider 消息
如：
- `claude-permission-request`
- `claude-permission-cancelled`
- `session-aborted`

### 来源二：Rust PTY attention event
如：
- `attention-required(waiting)`
- `attention-required(error)`

### 归并规则

同一 `sessionId + requestId` 只保留一个 active approval item；
同一 session 的普通 waiting/error attention 可以按时间窗口去重。

## 7.5 风险分级初版

建议前端先做简单静态映射：

- `high`：写文件、执行 shell、git commit、git push、删除操作
- `medium`：stage、checkout、跨项目读取、worktree 删除
- `low`：项目内读文件、status、diff、history 读取

这不是最终安全系统，但足够支持 UI 优先级与通知策略。

## 7.6 Mission Control 中的呈现

Mission Control 首屏应固定包含：

1. **Approval Inbox**：待批准操作
2. **Attention Inbox**：错误 / 等待输入 / 会话异常
3. **Active Sessions**：活跃会话卡片
4. **Task Summary**：queued / running / pending_review / failed 计数

## 7.7 审批动作闭环

审批动作必须走完整链路：

1. 用户在 Approval Center 点击 approve / deny
2. 前端调用 `ai_approve_tool(sessionId, permissionId, approved)`
3. approvalStore 更新状态为 resolving -> approved/denied
4. sessionStatusStore 清除 pending 状态
5. 如任务因此解除阻塞，dispatcher 再把 task 恢复到 in_progress

---

## 8. handoff.rs 与 loop_runner.rs 的定位

## 8.1 `handoff.rs` 的最终定位

### 当前实现事实

`src-tauri/src/handoff.rs` 当前流程：

1. 从 `pty::get_recent_output()` 读取最近输出
2. 拼接 handoff prompt
3. 调 `start_session_internal()` 拉起新 provider session
4. 把 prompt 直接写入新 PTY

这说明它是：

**session-to-session prompt handoff helper**

不是：

- durable handoff protocol
- task-aware transfer system
- result-aware context package

### 最终定位

在 Phase 1-2：
- 保留为实验性辅助能力
- 不作为主任务模型的前提
- UI 上不要过度包装成“已成熟多 agent 协作”

在 Phase 3 以后：
- 收编为 Task 的一种执行动作：`handoff_to_provider`
- 输入不再只是 PTY 最近 200 行，而应包含：task prompt、git status、diff summary、result summary、worktree path

## 8.2 `loop_runner.rs` 的最终定位

### 当前实现事实

`src-tauri/src/loop_runner.rs` 当前依赖：

- 全局内存 `LOOPS`
- 轮询 `pty::list_sessions_internal()`
- 用 `get_recent_output()` 抓 worker/verifier 输出
- 通过包含 `APPROVED` / `RETRY` 的文本判断流程

这说明它现在是：

**实验性 worker-verifier harness**

不是：

- durable loop scheduler
- workflow engine
- 可恢复 orchestration runtime

### 最终定位

在中短期：
- 只保留给高级实验用户 / 内部测试
- 不纳入主任务闭环主路径
- 不让核心 UI 和任务模型依赖它

长期：
- 如果要升级，必须先满足：
  1. task model 完整
  2. session binding 正式化
  3. verifier 输出结构化
  4. loop state 可恢复/可审计

### 结论

**handoff 和 loop 都是“策略插件候选”，不是当前主架构主干。**

---

## 9. 旧代码 / 旧叙事清理策略

## 9.1 必须明确的主线与遗留边界

主线：

- `src-tauri/`
- `src/`
- `src/lib/tauri-bridge.ts`

遗留：

- `server/`
- `electron/`
- README / i18n / 旧类型中的 TaskMaster / Node 叙事

这与 `docs/current-version-defects-2026-04-12.md` 的判断一致，应该继续制度化。

## 9.2 当前已确认的叙事污染

### README
`README.md` 仍同时描述：
- 当前 Tauri 产品
- 旧 TaskMaster 集成
- 旧 CLI / Node 服务式叙事

### App 类型/文案
- `src/types/app.ts` 仍保留 `AppTab = ... | 'tasks'`
- `src/components/main-content/view/subcomponents/MainContentTitle.tsx` 在 tasks tab 上返回 `TaskMaster`

### CLAUDE.md / 开发叙事
存在已过时 provider / context 描述，不适合作为当前架构依据。

## 9.3 清理策略

### 第一类：立即改名/改文案

- TaskMaster → Task Queue / Tasks / Control Queue
- “tasks tab” 保留功能但清除旧命名
- 所有 UI 中的 TaskMaster 文案尽快移除

### 第二类：显式标注 legacy

- README 中单列 legacy section
- Node/Electron 相关内容标记为旧主线，不再暗示当前能力

### 第三类：不要急删代码，但要切断主线依赖

- 旧兼容 API 或遗留类型如果短期还要保留，可先隔离
- 但新功能禁止再依赖旧命名和旧叙事

---

## 10. 分阶段路线图、依赖与风险

## Phase 0：主线去噪与边界固定（非常短）

### 目标

给后续迭代扫清语义障碍。

### 动作

- 清理 TaskMaster UI 命名
- 文档明确当前主线是 Tauri + Rust + React
- 在架构文档中冻结 `handoff.rs` / `loop_runner.rs` 为实验模块
- 列出当前 durable / runtime source-of-truth

### 依赖

- 无强依赖

### 风险

- 风险低，但如果不做，后续每轮讨论都会继续混线

## Phase 1：Attention / Approval Center（最高优先级）

### 目标

把“多 session 盯屏”变成“有事回来处理”。

### 动作

- 新建 `attentionStore.ts`
- 将 `pendingPermissions` 从 `sessionStatusStore.ts` 抽象为正式 approval items
- Mission Control 顶部加入 Attention / Approval Center
- `useAttentionRouter.ts` 改为“中心优先，自动聚焦降级为辅助”
- 明确通知策略：只通知 permission / failed / completed / review_required

### 依赖

- 依赖已有 `sessionStatusStore.ts` 与 `useSessionStatusTracker.ts`
- 不依赖 tasks 重构先完成

### 风险

- provider 事件不完全对称，尤其 Claude 之外的 approval 流可能暂时不完整
- 需接受第一版 attention 仍带部分 heuristic

## Phase 2：统一任务模型（最高优先级）

### 目标

结束 `tasks.rs` 与 `taskQueueStore.ts` 双轨。

### 动作

- 扩展 `src-tauri/src/tasks.rs` 字段与状态机
- 前端新增 task repository / task view model
- `TaskQueuePanel.tsx` 改为读取 Rust tasks
- `useAutoExecutor.ts` 重写为 dispatcher 投影层
- `taskQueueStore.ts` 降级为 queue UI state

### 依赖

- 最好先完成 Phase 1 的 attention center，因为任务阻塞状态需要 attention 入口

### 风险

- 会影响较多前端引用点：ActivityBar、BottomStatusStrip、Queue 页面、Quick Add
- 需要谨慎做兼容迁移，避免一次性打断现有 queue UI

## Phase 3：Task-Session-Worktree 闭环

### 目标

让任务真正知道“由谁、在哪个 worktree、以什么角色执行”。

### 动作

- 为 Task 加入 `provider / role / worktree_path`
- dispatcher 支持 worktree-aware 派发
- Mission Control / Session Card / Queue 卡片显示 worktree / branch / role
- 建立 `taskId <-> sessionId <-> worktreePath` 显式关联

### 依赖

- 依赖 Phase 2 的任务字段扩展
- 依赖 `git.rs` 的 worktree API 继续可用

### 风险

- 当前 `projects_list / projects_get` 对多 provider 和 worktree 语义并不完全对齐
- 需要避免把 worktree 变成 UI 装饰信息，而要真正接入任务派发

## Phase 4：收编 handoff / loop 为高级策略

### 目标

让高级编排建立在稳固主线之上，而不是反过来。

### 动作

- handoff 改为 task action，而不是单独 PoC 入口
- loop 改为 optional strategy，不进入默认主路径
- 引入 review queue / result inbox

### 依赖

- 依赖 Phase 2、3 基本完成

### 风险

- 如果过早做，会再次造成“看起来很先进，但任务和审批没闭环”的假繁荣

---

## 11. 文件 / 模块级改造地图

## 11.1 Rust 后端

### `src-tauri/src/tasks.rs`

**优先级：最高**

需要做：

- 扩展 `Task` 字段
- 扩展 `TaskStatus`
- 更稳健地解析/序列化 frontmatter
- 支持 `Queued / PendingReview / Cancelled / PendingApproval`
- 支持 `prompt / provider / role / priority / worktree_path / review_required / approval_policy / result_summary`

不建议现在做：

- 直接迁 SQLite
- 一次性做复杂数据库 schema

### `src-tauri/src/pty.rs`

**优先级：高**

需要做：

- 保持 execution kernel 地位
- 补充更清晰的 runtime event contract
- 把 attention event 的 message/type 结构固定化
- 继续保留 output buffer，但明确它只是辅助手段

不建议现在做：

- 在这里写任务业务逻辑
- 在这里内建复杂调度判断

### `src-tauri/src/ai.rs`

**优先级：高**

需要做：

- 保持 provider 启动层职责
- 与 dispatcher 的 task binding 接口对齐
- 后续为 provider 差异补齐更标准的 permission / session metadata

不建议现在做：

- 让 `ai.rs` 直接负责 task state machine

### `src-tauri/src/git.rs`

**优先级：中高**

需要做：

- 继续作为 worktree ground truth
- 为后续 task-worktree 绑定提供稳定接口

不建议现在做：

- 过早做复杂 review 逻辑

### `src-tauri/src/handoff.rs`

**优先级：冻结 / 实验**

需要做：

- 只做最小维护
- 文档上降级为实验功能

不建议现在做：

- 产品主路径化
- 依赖最近 200 行 PTY output 去承载正式 handoff 协议

### `src-tauri/src/loop_runner.rs`

**优先级：冻结 / 实验**

需要做：

- 保持可用但不扩张
- 如果保留 UI 入口，明确标注实验能力

不建议现在做：

- 与主任务流深度耦合
- 把它当正式 orchestrator

### `src-tauri/src/http_server.rs`

**优先级：中**

需要做：

- 继续保留 LAN / web fallback 底座
- 后续补齐 task / attention 相关接口时，优先保证模型对齐

注意：

- 它现在承担很多兼容职责，不适合作为架构主心骨
- 其安全边界仍需谨慎控制，但这不是本文主线重点

## 11.2 前端

### `src/stores/sessionStatusStore.ts`

**优先级：高**

需要做：

- 从“单 store 包所有 runtime/approval 语义”改为更轻的 session status projection
- 保留：`status / attentionReason / updatedAt`
- 抽离：`pendingPermissions` 到独立 attention/approval store
- 补字段：`taskId / projectPath / worktreePath / provider`

### `src/hooks/useSessionStatusTracker.ts`

**优先级：高**

需要做：

- 从 provider message tracker 升级为 runtime event normalizer 的一部分
- 同时消费 `session-state-changed`、permission events、error events
- 不再只依赖 `claude-* / codex-*` 前缀判断整个系统状态

### `src/hooks/useAttentionRouter.ts`

**优先级：高**

需要做：

- 从“attention -> auto focus live grid”改为“attention -> attention center 更新；必要时建议跳转”

### `src/stores/taskQueueStore.ts`

**优先级：最高（重定义）**

需要做：

- 从任务真相 store 改成 queue UI state store
- 保留：排序、autoExecute、maxConcurrent、UI flags
- 移除：任务本体字段主导权

### `src/hooks/useAutoExecutor.ts`

**优先级：最高（重写）**

需要做：

- 改成 dispatcher hook/service
- 基于 Rust tasks + session capacity 运行
- task 完成与否不能再只靠本地 queue 绑定

### `src/components/overview/MissionControlView.tsx`

**优先级：最高**

需要做：

- 从纯 session grid 升级为控制台首页
- 加入 Attention / Approval Center
- 加入任务摘要区
- SessionCard 中展示 task/worktree/attention 摘要

### `src/components/live-grid/view/LiveGridView.tsx`

**优先级：中**

需要做：

- 保持并行观察模式定位
- 接收来自 attention center 的跳转
- 不再承担 attention 主入口职责

### `src/components/task-queue/TaskQueuePanel.tsx`

**优先级：最高**

需要做：

- UI 结构可以保留
- 数据源切换到 `tasks.list(...)`
- 支持 task status 真实显示
- 与 dispatcher / review / approval 状态联动

### `src/App.tsx`

**优先级：中**

需要做：

- 初始化顺序上接入新的 attention/task dispatcher store
- 不再让 AppInitializer 隐式绑定旧 queue 真相

### `src/types/app.ts`

**优先级：高**

需要做：

- 移除或重命名旧 `tasks` / TaskMaster 相关叙事
- 补充 task/session/worktree 控制平面相关类型

### `src/components/main-content/view/subcomponents/MainContentTitle.tsx`

**优先级：高**

需要做：

- 移除 `TaskMaster` 文案
- 替换为 `Task Queue` / `Tasks`

---

## 12. 最终建议：先做什么，暂时不要碰什么

## 12.1 现在最该优先做的

### 第一优先级（立刻开始）

1. **Mission Control 顶部增加 Attention / Approval Center**
2. **把 `pendingPermissions` 提升为正式审批模型**
3. **把 `taskQueueStore.ts` 明确降级为 UI 投影层**
4. **开始扩展 `tasks.rs`，把 queue 语义并回 TaskStatus**

这是最核心的一组动作，因为它们会直接决定 OpenWork 是否能从“多 session 壳”变成“控制平面”。

### 第二优先级

5. **重写 `useAutoExecutor.ts` 为基于 Task 的 dispatcher**
6. **把 Mission Control、Task Queue、Session Card 全部改为任务/审批感知**
7. **建立 taskId <-> sessionId 的正式绑定**

### 第三优先级

8. **把 worktree 作为任务派发的一等上下文**
9. **再考虑 handoff / loop 的收编方式**

## 12.2 现在不要优先碰的

### 暂时不要把大量精力投入到：

1. **把 `handoff.rs` 产品主路径化**
2. **把 `loop_runner.rs` 扩成完整 orchestrator**
3. **大规模重写 PTY 执行层**
4. **从头推翻前端 UI 架构**
5. **过早迁移到数据库任务系统**

原因很简单：

- 执行底座已经够用
- 真正的缺口在控制层和状态模型，不在执行层
- 先补控制平面骨架，才能让高级策略有落点

## 12.3 一句话最终建议

**把 OpenWork 的下一阶段严格收敛为：先统一任务真相、先做 Attention/Approval Center、先确立 Mission Control/Live Grid/Task Queue 边界；在此之前，不要把 handoff.rs 和 loop_runner.rs 当成主线。**

这才是最符合当前代码现实、实现成本、产品方向的一条路线。

---

## 附：最终架构决策摘要

- **产品定位**：终端 AI 编程控制平面，不是 IDE，不是聊天壳
- **任务真相源**：Rust `tasks.rs`
- **队列定位**：Task 的 UI/调度投影，不是第二真相源
- **会话定位**：运行容器，真相在 Rust runtime，前端做投影
- **Mission Control**：总控首页
- **Live Grid**：并行观察模式
- **Task Queue**：任务池/派发视图
- **Attention / Approval Center**：必须成为控制台中心能力
- **handoff.rs / loop_runner.rs**：保留，但冻结为实验策略，不作为主架构核心
- **首要工程动作**：先补控制层，不先追求重编排

# OpenWork 目标架构方案 v1.0

> 制定时间：2026-04-19  
> 基于代码现状：src-tauri/ + src/ Tauri+Rust+React 主线  
> 协同分析：claude-sonnet-4.6 × claude-opus-4.6 交叉验证  
> 性质：可直接作为下一版架构文档的基础，不是评审意见

---

## 1. 最终架构结论

**直接判断，不是摘要：**

1. OpenWork 的目标定位是 **终端 AI 编程代理的控制台（Control Plane）**，不是 AI IDE，不是聊天 UI。这条主线已经在代码结构里隐约成立，但还没有被明确产品化。

2. 现有代码中真正有价值的资产是：PTY 执行层（`pty.rs`）、多 Provider 会话层（`ai.rs`）、session status 雏形（`sessionStatusStore.ts`）、Live Grid（已有多卡布局和键盘导航）、worktree API（`git.rs`）、file-based tasks（`tasks.rs`）。它们加在一起已经是一个控制台的 40%。

3. 现有最大的断点是**控制层缺失**：有状态但无统一处理入口、有任务但双轨割裂、有注意力信号但无集中 inbox。这些断点是功能缺口，不是架构问题，可以在现有主线上直接补。

4. `handoff.rs` 和 `loop_runner.rs` 是实验性代码，不是成熟主线基础设施，**不能跳过任务模型统一就直接冲向它们的产品化**。

5. 旧叙事（TaskMaster / Node / Electron）的污染已经超出文档层，深入到部分 UI 代码和 i18n 文案中，必须在架构迭代开始前完成一轮显式清洗，否则每次判断都要先辨别"这是旧代码还是新代码"。

6. 最值钱的下一步：**先补控制层（Attention Inbox + 统一任务模型），再谈 handoff/loop 产品化**。

---

## 2. OpenWork 目标架构（三层 + 横切面）

### 2.1 三层模型

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 3: Control Plane                                          │
│  ───────────────────────────────────────────────────────────────  │
│  Mission Control  │  Attention Inbox  │  Task Dispatcher         │
│  Review Queue     │  Approval Center  │  Result Inbox            │
│  (src/components/overview/ + src/components/task-queue/)        │
├──────────────────────────────────────────────────────────────────┤
│  Layer 2: Attention Layer                                        │
│  ───────────────────────────────────────────────────────────────  │
│  SessionStatusStore  │  AttentionRouter  │  PermissionBus        │
│  NotificationPolicy  │  AttentionItem/ApprovalRequest store      │
│  (src/stores/sessionStatusStore.ts + src/stores/attentionStore)  │
├──────────────────────────────────────────────────────────────────┤
│  Layer 1: Execution Layer                                        │
│  ───────────────────────────────────────────────────────────────  │
│  PTY Sessions  │  AI CLI Spawner  │  Git / Worktree              │
│  Loop Runner   │  Handoff         │  File System                 │
│  (src-tauri/src/{pty,ai,git,loop_runner,handoff}.rs)            │
└──────────────────────────────────────────────────────────────────┘
                           横切面
  ┌───────────────────────────────────────────────────────┐
  │  Tasks.rs (Rust)  ←→  TaskQueueStore(降级为view model)│
  │  db.rs (SQLite settings)                              │
  │  http_server.rs (LAN/Web/Mobile 访问 fallback)        │
  │  tauri-bridge.ts (Tauri IPC ↔ HTTP 双路由)            │
  └───────────────────────────────────────────────────────┘
```

### 2.2 各层职责

#### Layer 1：Execution Layer（已有，需维护稳定）

**职责**：做，不判断。只负责执行，不做业务决策。

| 模块 | 职责 | 现状 |
|------|------|------|
| `pty.rs` | PTY 生命周期、输出流、状态机、桌面通知 | 可用，但状态检测是启发式 |
| `ai.rs` | Claude/Codex/Cursor CLI 会话启动/消息发送/abort/approve | 可用，但 approve 只支持 Claude |
| `git.rs` | git 操作 + worktree CRUD | 可用 |
| `fs_commands.rs` | 文件读写 + 设置管理 | 可用，路径策略偏保守 |
| `loop_runner.rs` | Worker-Verifier 循环（内存态） | 实验性，不应当主线 |
| `handoff.rs` | 跨 session 上下文传递 | PoC，不应当主线 |

**Layer 1 的规则**：  
- Layer 1 只向上发事件（`pty-output`, `attention-required`, `session-state-changed`）  
- Layer 1 不直接操作 Task 模型  
- Layer 1 的状态变化必须通过事件传递给 Layer 2，不能绕过

#### Layer 2：Attention Layer（半成品，需补充）

**职责**：感知，不执行。把底层事件翻译为业务状态，让用户知道"什么时候该回来"。

| 模块 | 职责 | 现状 |
|------|------|------|
| `sessionStatusStore.ts` | session 状态机 (idle/processing/needs_attention/completed) | 可用，语义偏粗 |
| `useSessionStatusTracker.ts` | PTY 事件 → store 状态映射 | 可用，但只识别 claude-*/codex-* 前缀 |
| `useAttentionRouter.ts` | needs_attention → LiveGrid 自动聚焦 | 有效但绑定 LiveGrid，应解耦 |
| **缺：attentionStore.ts** | AttentionItem + ApprovalRequest 统一 store | 需要新建 |
| **缺：notificationPolicy.ts** | 通知策略决策（什么时候发/发什么） | 需要新建 |

**Layer 2 的规则**：  
- Layer 2 消费 Layer 1 的事件，生成结构化 AttentionItem  
- Layer 2 不直接渲染 UI，只维护状态  
- Layer 2 向 Layer 3 暴露"可操作的注意力列表"，不是原始 PTY 事件

#### Layer 3：Control Plane（骨架有了，实体需重建）

**职责**：决策、派发、回收。让用户"一个界面管所有 agent"。

| 模块 | 职责 | 现状 |
|------|------|------|
| `MissionControlView.tsx` | 控制台主界面：会话总览 + 审批收件箱 + 任务概况 | 目前只是会话列表 |
| `LiveGridView.tsx` | 并行观察模式：多 session 实时输出 | 功能完整，定位需明确 |
| `TaskQueuePanel.tsx` | 任务管理面板 | 只读 taskQueueStore，与 Rust tasks 断裂 |
| **缺：AttentionInbox.tsx** | 审批/权限/错误 的集中处理面板 | 需要新建 |
| **缺：ReviewQueue.tsx** | 完成任务的结构化结果收集 | 需要新建（V4） |

### 2.3 哪些模块不应继续在主线扩展

| 模块 | 判断 | 原因 |
|------|------|------|
| `loop_runner.rs`（当前形态） | 冻结/实验 | 内存态，无持久化，idle 检测启发式 |
| `handoff.rs`（当前形态） | 冻结/实验 | 只读 PTY buffer 200 行，上下文构造质量低 |
| `taskQueueStore.ts`（当前角色） | 降级为 view model | 不能再是 source of truth |
| `src/utils/api.js` | 标记删除 | 旧 Node/REST 路径残留 |
| TaskMaster 相关 UI 文案和类型 | 立即清理 | 污染产品语义 |

---

## 3. 核心实体模型设计

### 3.1 Task（核心，需扩展）

**必要性**：任务是控制层的基本调度单元，既是 prompt 的载体，也是 session 的关联对象，也是 review 的前提。

**当前缺陷**：`tasks.rs` 缺少 `prompt`、`provider`、`worktree_path`、`role`、`priority`、`approval_policy`、`review_required` 等字段。

**目标 Rust Schema**（`tasks.rs` 需扩展）：

```rust
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub prompt: Option<String>,          // NEW: 实际发给 AI 的 prompt
    pub status: TaskStatus,              // open | in_progress | done | failed | pending_review | cancelled
    pub priority: TaskPriority,          // NEW: low | normal | high | critical
    pub provider: Option<String>,        // NEW: "claude" | "codex" | "cursor"
    pub role: Option<TaskRole>,          // NEW: implement | review | verify | research
    pub worktree_path: Option<String>,   // NEW: 绑定 worktree
    pub session_id: Option<String>,      // EXISTING: 绑定运行 session
    pub parent_task_id: Option<String>,  // NEW: 支持子任务/分解
    pub review_required: bool,           // NEW: 完成后是否需要人工 review
    pub approval_policy: ApprovalPolicy, // NEW: none | require_approval | auto_approve_low_risk
    pub created_at: String,
    pub updated_at: String,
    pub deps: Vec<String>,               // EXISTING
    pub result_summary: Option<String>,  // NEW: 完成后结果摘要
    pub tags: Vec<String>,               // NEW: 便于过滤
}

pub enum TaskStatus {
    Open,
    InProgress,
    Done,
    Failed,
    PendingReview,   // NEW: 完成但等待人工 review
    Cancelled,       // NEW
}

pub enum TaskPriority { Low, Normal, High, Critical }
pub enum TaskRole { Implement, Review, Verify, Research, Generic }
pub enum ApprovalPolicy { None, RequireApproval, AutoApproveLowRisk }
```

**存储**：Rust 侧 `.openwork/tasks/<id>.md`（YAML frontmatter）。**Rust 是 source of truth**。

**前端投影**：`taskQueueStore.ts` 降级为 read-through cache + optimistic UI，从 `task_list` + `task_create/update` 读写。

**管理方**：Rust 侧持久化；前端只做 view model。

---

### 3.2 Session / AgentRuntime（已有，需标准化）

**必要性**：Session 是 agent 实际运行的容器，对应一个 PTY 进程。

**当前缺陷**：`Session`（`projects.rs`）和 `PtySession`（`pty.rs`）是两个不同的概念，没有统一的 runtime 视图。

**目标设计**（前后端各保持自己的投影，通过 sessionId 关联）：

```rust
// Rust 侧 (projects.rs 的 Session + pty.rs 的 runtime state)
pub struct AgentRuntime {
    pub session_id: String,        // 唯一 ID
    pub pty_id: String,            // 对应 PTY session
    pub task_id: Option<String>,   // NEW: 正在执行的 task
    pub provider: String,          // "claude" | "codex" | "cursor"
    pub project_path: String,
    pub worktree_path: Option<String>, // NEW: 是否在 worktree 里跑
    pub state: SessionState,       // PTY state: Idle|Running|WaitingForInput|Completed|Failed
    pub started_at: String,
}
```

```typescript
// 前端投影 (sessionStatusStore 扩展)
interface SessionStatusEntry {
    status: SessionRuntimeStatus;       // idle|processing|needs_attention|completed
    attentionReason?: AttentionReason;
    updatedAt: number;
    provider?: 'claude' | 'codex' | 'cursor';
    taskId?: string;                    // NEW: 绑定的任务 ID
    worktreePath?: string;              // NEW: 当前 worktree
    projectPath?: string;               // NEW
}
```

**管理方**：Rust 侧是 runtime ground truth；前端 `sessionStatusStore` 只是最后已知状态的镜像，持久化到 localStorage 用于 UI 渲染。

---

### 3.3 AttentionItem（需新建）

**必要性**：把底层的 `attention-required` 事件提升为可操作的业务实体，解决"有信号无入口"问题。

```typescript
// src/stores/attentionStore.ts (新建)
interface AttentionItem {
    id: string;                         // UUID
    sessionId: string;
    taskId?: string;                    // 关联任务（如有）
    type: 'waiting_input' | 'error' | 'aborted' | 'permission_request' | 'review_required';
    severity: 'info' | 'warning' | 'critical';
    title: string;                      // 人可读标题
    summary: string;                    // 最后一条输出摘要或错误信息
    timestamp: number;
    isResolved: boolean;
    resolveAction?: 'approved' | 'denied' | 'dismissed' | 'handled';
}
```

**管理方**：纯前端，不持久化（不写 Rust DB）。Session 重启后自然消失。

---

### 3.4 ApprovalRequest（需从 pendingPermissions 独立）

**必要性**：`pendingPermissions` 目前只是 sessionId→req 的 map，没有 id、时间戳、风险等级、审批历史。需要提升为一等实体。

```typescript
interface ApprovalRequest {
    requestId: string;
    sessionId: string;
    taskId?: string;
    toolName: string;                   // "bash" | "write_file" | "read_file" etc.
    input: Record<string, unknown>;
    riskLevel: 'low' | 'medium' | 'high';  // NEW: 基于 toolName 和 input 判断
    requestedAt: number;
    autoApproveDeadline?: number;       // NEW: 支持定时自动批准（低风险）
    status: 'pending' | 'approved' | 'denied' | 'expired';
    decidedAt?: number;
    decidedBy?: 'user' | 'auto';
}
```

**风险等级规则（初版）**：
- `high`：`bash`, `write_file`, `delete_file`, `git_push`, `git_commit`
- `medium`：`read_file`（非项目目录）, `git_stage`
- `low`：`read_file`（项目内）, `git_status`, `git_diff`

**管理方**：前端 attentionStore。但审批结果（approve/deny）通过 `ai_approve_tool` 写回 Rust。

---

### 3.5 Project（已有，需加 worktree 感知）

```typescript
// 现有 Project 类型需补充
interface Project {
    name: string;
    path: string;
    sessions: ProjectSession[];         // Claude sessions
    codexSessions: ProjectSession[];
    worktrees?: WorktreeContext[];      // NEW: 关联 worktree 列表
    activeTasks?: number;               // NEW: 派生字段，从 task_list 统计
}
```

---

### 3.6 WorktreeContext（需新建）

**必要性**：让任务知道自己在哪个分支/worktree 执行，是 worktree-aware dispatch 的前提。

```typescript
interface WorktreeContext {
    path: string;                       // worktree 绝对路径
    branch: string;
    linkedProjectPath: string;          // 主仓库路径
    status: 'clean' | 'dirty' | 'unknown';
    sessionId?: string;                 // 正在此 worktree 运行的 session
    taskId?: string;                    // 正在此 worktree 执行的 task
}
```

**管理方**：Rust 侧 `git_worktree_list` 是 ground truth；前端 `liveGridStore` 的 card 可以携带 `worktreePath`。

---

### 3.7 HandoffRequest / HandoffArtifact（暂不进入核心模型）

**判断**：当前 `handoff.rs` 的实现质量不足以支撑成为一等实体。等 Task 模型统一后，handoff 应作为 Task 的一种执行策略（`execution_strategy: 'handoff_to:<provider>'`），而不是独立实体。

等 Phase 3 时再定义 `HandoffArtifact`：

```typescript
// Phase 3 再纳入
interface HandoffArtifact {
    id: string;
    sourceSessionId: string;
    targetSessionId: string;
    taskId: string;
    contextSnapshot: string;            // 结构化上下文，不是 PTY buffer
    gitDiff: string;                    // 当时的 staged diff
    handoffPrompt: string;
    createdAt: number;
}
```

---

### 3.8 ReviewItem（V4 纳入，暂定义接口）

```typescript
interface ReviewItem {
    id: string;
    taskId: string;
    sessionId: string;
    filesChanged: string[];
    diffSummary: string;
    riskFlags: string[];
    status: 'pending' | 'accepted' | 'rework' | 'archived';
    createdAt: number;
}
```

---

## 4. 核心状态机与事件流设计

### 4.1 Task 生命周期

```
open
  │ task_create() 
  ▼
open ─── [dispatch to session] ──→ in_progress
  │                                    │
  │                              [session done]
  │                                    │
  │                            review_required?
  │                           ┌────YES─┘ NO──┐
  │                           ▼              ▼
  │                     pending_review      done
  │                           │
  │                    [human review]
  │                    ┌─────┴──────┐
  │                    ▼            ▼
  │                  done          rework
  │                                 │
  └────────────────────────────────┘
  
  任何状态 ─── [user cancels] ──→ cancelled
  in_progress ─── [session failed] ──→ failed
```

**哪些事件驱动 Task 状态**：

| 事件来源 | 事件 | Task 状态变化 |
|----------|------|--------------|
| Rust PTY | `session-state-changed: Completed` | in_progress → done (或 pending_review) |
| Rust PTY | `session-state-changed: Failed` | in_progress → failed |
| 前端用户 | dispatch task | open → in_progress |
| 前端用户 | approve review | pending_review → done |
| 前端用户 | request rework | pending_review → open (reset) |

**Durable vs Runtime**：
- Task 的所有字段：**durable**，写 `.openwork/tasks/<id>.md`
- `session_id` 绑定：**durable**（写回 tasks.rs）
- Task 的 UI 排序/过滤状态：**runtime only**（前端）

---

### 4.2 Session / AgentRuntime 生命周期

```
[ai_start_session()]
        │
        ▼
     Running  ◄──── [user sends message]
        │
  [PTY output]
        │
   ┌────┴────┐
   │         │
   ▼         ▼
WaitingFor  Running
Input      continues
   │
   │ WAITING_PATTERNS 匹配
   │
   ▼
attention-required 事件发出
   │
[user approves / ai_approve_tool()]
        │
        ▼
     Running
        │
  [process exits]
        │
   exit code?
   ┌──0──┴──other──┐
   ▼               ▼
Completed        Failed
```

**Durable**：session 的 JSONL（Claude）或历史文件在磁盘上，由 CLI 自己管理  
**Runtime**：PTY 进程状态 → `PTY_SESSIONS` DashMap（进程级内存）  
**前端镜像**：`sessionStatusStore` localStorage（跨 restart 恢复 UI 状态）

---

### 4.3 Attention / ApprovalRequest 生命周期

```
PTY output → regex match → attention-required event
                                    │
                         useSessionStatusTracker
                                    │
                         sessionStatusStore: setNeedsAttention()
                                    │
                              AttentionStore 创建 AttentionItem
                                    │
                         (if type === permission_request)
                                    │
                         ApprovalRequest 创建 (severity 分级)
                                    │
                         Attention Inbox 显示
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
              [user approves]               [user denies]
                    │                               │
             ai_approve_tool(true)          ai_approve_tool(false)
                    │                               │
             AttentionItem resolved         AttentionItem resolved
             ApprovalRequest: approved      ApprovalRequest: denied
             sessionStatus: processing      sessionStatus: needs_attention(aborted)
```

**Durable**：ApprovalRequest 不需要持久化（session 重启清空）  
**Runtime**：attentionStore（纯内存，React）

---

### 4.4 Handoff 生命周期（Phase 3 后）

```
Task: in_progress (source session)
        │
[user triggers handoff / auto rule]
        │
        ▼
HandoffArtifact 构建：
  - git diff (staged + unstaged)
  - task context
  - last N lines 结构化输出（不是 raw PTY buffer）
        │
        ▼
新 session 启动 (target provider)
        │
        ▼
HandoffArtifact 注入为 initial message
        │
        ▼
Task: session_id 更新为新 session
Task: status 维持 in_progress
```

---

### 4.5 Loop 生命周期（Phase 3 后）

当前 `loop_runner.rs` 的生命周期是：  
`Running → WaitingVerification → Passed/Failed/Cancelled`  

目标升级为与 Task 系统集成：

```
Task (role: verify) 派发时带 loop config
        │
Rust: loop_start(config) → LoopState 与 Task 绑定
        │
loop_id 写回 Task.metadata
        │
Loop 完成后：
  - Passed → Task: done (或 pending_review)
  - Failed → Task: failed
  - Cancelled → Task: cancelled
```

---

## 5. Mission Control / Live Grid / Task Queue 的职责边界

### 5.1 Mission Control：**默认主界面**

**主职责**：
- 显示所有 session 的当前状态（按注意力优先级排列）
- **Attention Inbox**：聚合所有需要处理的 AttentionItem 和 ApprovalRequest
- **Task 派发入口**：创建任务并选择执行策略（直接 / worktree / handoff）
- **系统总览**：活跃 agents 数 / 待处理审批数 / 队列中任务数

**Mission Control 不是**：
- 不是 PTY 终端（那是 SessionFocusLayout）
- 不是任务详情（那是 TaskQueuePanel）
- 不是代码 diff（那是 GitPanel）

**目标 UI 结构**（Phase 4 时）：
```
┌─────────────────────────────────────────────────┐
│ Attention Inbox (needs_attention sessions)       │
│  [permission req] [error] [aborted] ...          │
├──────────────────────────┬──────────────────────┤
│ Active Sessions          │ Task Queue Overview  │
│ [session cards sorted    │ [queued: 3]          │
│  by priority]            │ [running: 2]         │
│                          │ [pending review: 1]  │
└──────────────────────────┴──────────────────────┘
```

---

### 5.2 Live Grid：**并行观察模式（辅助界面）**

**主职责**：
- 同时观察多个 session 的实时 PTY 输出
- 支持向多个 session 发送消息（`useMultiSessionDispatcher`）
- 支持快速聚焦（keyboard navigation）
- 与 Mission Control 联动（`useAttentionRouter` 触发聚焦）

**Live Grid 不是**：
- 不是任务管理中心
- 不是 Mission Control 的替代（不负责 inbox 和 dispatch）
- 不是默认主界面

**调用关系**：Mission Control 有入口可以"进入 Live Grid 模式"；Live Grid 有返回 Mission Control 的路径。

---

### 5.3 Task Queue / Task Inbox：**任务管理专项面板**

**主职责**：
- 显示所有任务（从 Rust `task_list` 读，不是 `taskQueueStore`）
- 支持创建、排序、重试、取消任务
- 显示 task-session 绑定关系
- 显示 review required 任务（等待人工处理）

**调用关系**：嵌入在 Mission Control 右侧栏 / 或作为独立 workbench tab 存在。不是独立主界面。

---

### 5.4 互相配合原则

```
Mission Control ──[选中任务]──→ TaskQueuePanel (详情)
Mission Control ──[选中 session]──→ SessionFocusLayout (chat+terminal)
Mission Control ──[进入网格]──→ LiveGridView (并行观察)
LiveGridView ──[session 需要注意]──→ Mission Control Attention Inbox (事件)
TaskQueuePanel ──[任务完成需 review]──→ Mission Control Attention Inbox (事件)
```

---

## 6. 统一任务模型的详细方案

### 6.1 Source of Truth 的明确判断

**Rust `tasks.rs` 是 source of truth。`taskQueueStore.ts` 降级为 UI 投影层。**

理由：
1. Rust tasks 有真正的持久化语义（`.openwork/tasks/*.md` 跟着项目走）
2. 适合多端同步（Tauri + HTTP server 都能访问）
3. `taskQueueStore` 的 localStorage 只适合临时 UI 状态
4. `useAutoExecutor` 中的关键 bug（`markRunning` 未传 sessionId）根源就是双轨引起的

### 6.2 当前双轨的具体断点

**`useAutoExecutor.ts` 的 bug（第 31-37 行）**：
```typescript
// 当前代码
if (sent) {
    taskQueue.markRunning(task.id);  // ← 没传 sessionId！
}
// 导致后面的匹配永远失败：
const runningTask = taskQueue.queue.find(
    (t) => t.status === 'running' && t.sessionId === sessionId, // ← sessionId 永远是 undefined
);
```

**修复方案**：sendMessage 需要返回 sessionId，或者 dispatch 后立即绑定：
```typescript
const { sessionId } = await dispatchToNewSession(task);
taskQueue.markRunning(task.id, sessionId);
// 同时写回 Rust: task_update({ session_id: sessionId })
```

### 6.3 迁移路径（不推翻，逐步替换）

**Phase 2 的迁移步骤**：

**Step 1**：扩展 `tasks.rs` Schema，加入 `prompt`, `provider`, `priority`, `role` 字段。同时扩展 `task_create` 和 `task_update` 接口。

**Step 2**：`tauri-bridge.ts` 补齐 `task_list`, `task_create`, `task_update`, `task_delete` 的完整类型绑定（当前已有桩，需要完善 payload 类型）。

**Step 3**：新建 `src/stores/taskStore.ts`（替换 taskQueueStore 作为主 store），直接从 Rust `task_list` 读取，用 Tauri event 监听 task 变化。

```typescript
// src/stores/taskStore.ts
export const useTaskStore = create<TaskState>()((set, get) => ({
    tasks: [],
    loading: false,
    
    refresh: async (projectPath: string) => {
        const tasks = await invoke('task_list', { projectPath });
        set({ tasks });
    },
    
    dispatch: async (taskId: string) => {
        // 1. 启动 session
        // 2. 发送 prompt
        // 3. task_update({ session_id })
    }
}));
```

**Step 4**：`TaskQueuePanel.tsx` 改为从 `useTaskStore` 读取，而不是 `useTaskQueueStore`。**UI 不需要大改**，只是 data source 换掉。

**Step 5**：`useAutoExecutor.ts` 改写为 `useTaskDispatcher.ts`，直接操作 `taskStore`，修复 sessionId 绑定 bug。

**Step 6**：`taskQueueStore.ts` 保留但标记为 deprecated，只在兼容路径使用，3个月内删除。

### 6.4 字段归属原则

**必须进入 Rust schema 的字段**：
- `prompt`：执行语义，需要持久化
- `provider`：调度语义，需要持久化
- `status`：任务生命周期，需要持久化
- `session_id`：执行绑定，需要持久化
- `worktree_path`：执行上下文，需要持久化
- `role`：调度策略，需要持久化
- `priority`：调度顺序，需要持久化
- `review_required`：质控策略，需要持久化
- `result_summary`：产出归档，需要持久化

**只适合作为前端派生状态的字段**：
- `isRunning`（派生自 sessionStatusStore）
- `hasAttention`（派生自 attentionStore）
- `displayStatus`（UI 展示用的合并状态）
- `isSelected`、`isExpanded`（纯 UI 状态）
- `estimatedTime`（前端启发式计算）

---

## 7. Attention / Approval 中心设计

### 7.1 建模决策：AttentionItem 和 ApprovalRequest 分开建模

**理由**：
- `AttentionItem` 是宽泛的"需要关注"信号，涵盖错误、aborted、review、waiting
- `ApprovalRequest` 是有明确决策动作（approve/deny）的具体实体
- 两者有关联（一个 permission 请求会同时产生 AttentionItem 和 ApprovalRequest），但生命周期不同

### 7.2 新建 `src/stores/attentionStore.ts`

```typescript
interface AttentionState {
    items: AttentionItem[];
    approvals: ApprovalRequest[];
    
    // 从 sessionStatusStore 同步
    syncFromSession: (sessionId: string, entry: SessionStatusEntry) => void;
    
    // 创建 attention item
    createItem: (item: Omit<AttentionItem, 'id' | 'timestamp' | 'isResolved'>) => string;
    
    // 审批动作
    approveRequest: (requestId: string) => Promise<void>;
    denyRequest: (requestId: string) => Promise<void>;
    
    // 批量操作
    approveAll: (riskLevel?: 'low' | 'medium') => Promise<void>; // 批量批准低/中风险
    dismissItem: (itemId: string) => void;
    
    // 查询
    getUnresolvedItems: () => AttentionItem[];
    getPendingApprovals: () => ApprovalRequest[];
    getItemsForSession: (sessionId: string) => AttentionItem[];
}
```

### 7.3 UI：统一 Inbox，而不是两个面板

**UI 设计原则**：用户只有一个 inbox，但 inbox 内部按类型分区。

```
Attention Inbox
├── 🔴 CRITICAL (0)
├── 🟡 WAITING (2)         ← 等待输入 / 权限请求
│   ├── [session-abc] bash: rm -rf dist/ [Approve] [Deny]
│   └── [session-def] write_file: src/config.ts [Approve] [Deny]
├── 🔵 NEEDS REVIEW (1)    ← 任务完成等 review
│   └── [task-xxx] "Fix auth bug" completed [Review Now] [Later]
└── ⚫ ERRORS (1)          ← 错误 / aborted
    └── [session-ghi] process failed [Retry] [View Log] [Dismiss]
```

### 7.4 高风险 / 低风险分级

**分级规则（初版）**：

```typescript
function classifyRisk(toolName: string, input: Record<string, unknown>): 'low' | 'medium' | 'high' {
    const HIGH_RISK_TOOLS = ['bash', 'execute', 'git_push', 'git_commit'];
    const MEDIUM_RISK_TOOLS = ['write_file', 'delete_file', 'git_stage'];
    
    if (HIGH_RISK_TOOLS.includes(toolName)) {
        // bash: rm/git push 是 high，普通查询是 medium
        const cmd = String(input.command || '');
        if (/rm\s+-rf|git push|chmod|sudo/.test(cmd)) return 'high';
        return 'medium';
    }
    if (MEDIUM_RISK_TOOLS.includes(toolName)) return 'medium';
    return 'low';
}
```

### 7.5 批量批准

**支持批量批准低风险请求**：

```typescript
// UI 上显示
[批量批准 3 个低风险请求] [逐条确认]

// 实现
approveAll: async (maxRisk = 'low') => {
    const eligible = get().approvals.filter(
        a => a.status === 'pending' && riskOrder[a.riskLevel] <= riskOrder[maxRisk]
    );
    for (const req of eligible) {
        await invoke('ai_approve_tool', { sessionId: req.sessionId, permissionId: req.requestId, approved: true });
        // 更新 store
    }
}
```

### 7.6 与 sessionStatusStore 的关系

**当前**：`sessionStatusStore` 同时承担 attention 信号和 permission 存储，角色不清晰。

**目标关系**：

```
sessionStatusStore → (仍然保留) → 只存 session 的 runtime status（4态）
                                  清除 pendingPermissions 字段（迁移到 attentionStore）
                                  
attentionStore → (新建) → 存所有 AttentionItem + ApprovalRequest
               ← sessionStatusStore 的变化触发 attentionStore 同步
```

**迁移**：`sessionStatusStore.pendingPermissions` 的内容迁移到 `attentionStore.approvals`。

### 7.7 通知系统配合

**通知策略原则**：只在需要人工决策时通知，不在普通运行时打扰。

```typescript
// src/hooks/useNotificationPolicy.ts (新建)
const NOTIFY_ON: AttentionItem['type'][] = [
    'permission_request',  // 需要审批
    'error',               // 出错
    'review_required',     // 需要 review
];

// 不通知：
// - processing
// - idle
// - 普通 PTY output
// - completed (只在 Attention Inbox 里显示)
```

Tauri 桌面通知 → 点击跳转到 Mission Control + 自动聚焦到对应 AttentionItem。

---

## 8. handoff.rs 与 loop_runner.rs 的定位

### 8.1 handoff.rs 的正确定位

**当前实现质量评估**：
- 只读 PTY buffer 最后 200 行（raw 字符串，含 ANSI 垃圾）
- 上下文只有："continuing work started by session X" + truncated raw output
- 没有 git diff、没有任务描述、没有文件变更列表
- 800ms sleep 等待 CLI 初始化（fragile）

**定位**：**实验能力 / 暂时冻结**。不应该继续扩展当前实现。

**何时进入主线**：当且仅当满足以下前提：
1. Task 模型统一完成（Phase 2）
2. handoff 成为 Task 的一种执行策略，而不是独立操作
3. 上下文构造升级为：`git diff --staged` + task description + 结构化最后输出
4. 接收方 session 的初始 prompt 经过验证能正确被 CLI 理解

**Phase 3 的 handoff 应该长这样**：
```rust
// 新的 handoff_via_task() 而不是 handoff_session()
pub async fn handoff_task(
    task_id: String,
    target_provider: String,
    app_handle: AppHandle,
) -> Result<HandoffArtifact, String> {
    // 1. 读取 Task（从 tasks.rs，有完整上下文）
    // 2. 构建 git diff（staged + unstaged）
    // 3. 构建结构化 prompt（不是 raw PTY buffer）
    // 4. 启动新 session
    // 5. task_update: session_id = new_pty_id
    // 6. 返回 HandoffArtifact
}
```

---

### 8.2 loop_runner.rs 的正确定位

**当前实现质量评估**：
- 纯内存 HashMap，进程重启后丢失所有 loop 状态
- 完成检测依赖"5秒空闲"启发式（不可靠）
- Verifier 通过 "APPROVED" 字符串匹配来解析结果（脆弱）
- 不与 Task 系统集成：loop 完成后不更新任何 Task 状态
- 没有与 worktree 集成（worker/verifier 在同一目录跑）

**定位**：**实验能力 / 可升级但优先级低**。

**何时进入主线**：当且仅当满足以下前提：
1. Task 模型统一完成（Phase 2）
2. Loop 与 Task 绑定：loop_start 时传入 task_id，loop 完成后更新 Task 状态
3. 完成检测升级：不再依赖"5秒空闲"，而是监听 `session-state-changed: Completed`
4. Verifier 输出解析升级：使用 `--output-format stream-json` 解析而非字符串匹配
5. 持久化：LoopState 写入磁盘（或 SQLite），不是内存 HashMap

**暂时不需要关闭 loop_runner.rs 的 Tauri 注册**，但也**不应继续扩展它的当前实现**。

---

## 9. 旧代码 / 旧叙事清理策略

### 9.1 必须马上清理（P0，影响认知正确性）

| 位置 | 问题 | 清理动作 |
|------|------|---------|
| `src/utils/api.js` | 旧 Node REST 路径（`/api/auth/login`, `/api/auth/status`） | **删除文件** |
| `src/utils/api.test.ts` | 测试旧 REST 路径 | **删除文件** |
| `src/components/main-content/view/subcomponents/MainContentTitle.tsx` | tasks tab 返回 `TaskMaster` 文案 | **替换文案为 "Tasks"** |
| `src/types/app.ts` 中 TaskMaster 相关类型 | 污染类型定义 | **清除相关 type** |
| `README.md` 中 TaskMaster 功能叙事 | 误导产品理解 | **重写相关章节** |
| `CLAUDE.md` 中 `TasksSettingsProvider`/`TaskMasterProvider` | App.tsx 已无这些 provider | **更新 CLAUDE.md** |
| `src/contexts/AuthContext.jsx` 中 `isAuthenticated: hardcoded true` | 安全问题 + 认知污染 | **修复为真实 auth 状态** |

### 9.2 可以先隔离（P1，短期兼容，但停止扩展）

| 位置 | 问题 | 处置 |
|------|------|------|
| `src/stores/taskQueueStore.ts` | 双轨问题的一极 | 加注释 `// DEPRECATED: migrating to taskStore.ts`；停止在新代码中 import |
| `src-tauri/src/loop_runner.rs` | 实验性内存态 | 加注释 `// EXPERIMENTAL: not production-ready`；停止继续扩展 |
| `src-tauri/src/handoff.rs` | PoC 质量 | 加注释 `// POC: pending task model integration`；停止继续扩展 |
| `src/components/Onboarding.jsx` | 旧认证流程 | 继续保留但不扩展 |
| `src/components/ProtectedRoute.jsx` | 直接 return children | 继续保留但修复为真实 auth |
| `docs/development.md`, `docs/installation.md`, `docs/troubleshooting.md` | 旧 Node 叙事 | 加警告横幅 "⚠️ Outdated - refers to legacy Node architecture" |
| `public/api-docs.html` | 旧 REST API 文档 | 加 deprecation 警告 |

### 9.3 短期不要再扩展（P2，维持稳定，等替换）

| 位置 | 建议 |
|------|------|
| `src/hooks/useAutoExecutor.ts` | 不再扩展，等 Phase 2 用 `useTaskDispatcher.ts` 替换 |
| `src/hooks/useAttentionRouter.ts` | 不再扩展，等 Phase 1 用 attentionStore 重构 |
| `src-tauri/src/pty.rs` 的 WAITING_PATTERNS / ERROR_PATTERNS | 不再扩展 regex 列表，等 Phase 2 引入 provider-aware 检测 |
| `src/i18n/locales/*/settings.json` 中旧 provider/model 文案 | 不再增加旧文案，等 i18n 清洗统一做 |

---

## 10. 分阶段迭代路线图

### Phase 0（1 周）：语义清洗 + 认知对齐

**目标**：让代码库的认知层和实际能力层对齐，为后续迭代移除认知摩擦。

**交付物**：
1. 清除 `src/utils/api.js` 和 `api.test.ts`
2. 修复 `MainContentTitle.tsx` 的 TaskMaster 文案
3. 清除 `src/types/app.ts` 中 TaskMaster 相关类型
4. 更新 `CLAUDE.md`（已过时的 provider context 和 TaskMasterProvider 描述）
5. 修复 `AuthContext.jsx` 的 hardcoded isAuthenticated
6. 给 `taskQueueStore.ts`, `loop_runner.rs`, `handoff.rs` 加隔离注释
7. `README.md` 重写主叙事章节（移除 TaskMaster/Node 主线描述）

**依赖条件**：无依赖，可立即开始

**风险**：
- `MainContentTitle.tsx` 改动可能影响 tasks tab 展示（需测试 tab 切换正常）
- `AuthContext.jsx` 修复可能导致用户被要求重新登录（这是正确行为）

**为什么先做**：不做这步，后续每次改代码都要先辨别"这是旧代码还是新代码"，摩擦极高。

---

### Phase 1（2~3 周）：Attention Inbox + Mission Control 强化

**目标**：让 Mission Control 从"会话列表页"变成"统一审批 + 注意力控制台"。

**交付物**：

1. **新建 `src/stores/attentionStore.ts`**
   - AttentionItem + ApprovalRequest 实体
   - 从 `sessionStatusStore` 的变化中同步 AttentionItem
   - `pendingPermissions` 从 `sessionStatusStore` 迁移到 `attentionStore`
   - 风险分级逻辑

2. **新建 `src/components/overview/AttentionInbox.tsx`**
   - 分区显示：WAITING / REVIEW / ERROR
   - 单条审批 + 批量审批低风险
   - 跳转到对应 session

3. **强化 `SessionCard.tsx`**
   - 显示当前状态 badge（status + attention reason）
   - 显示 pending approvals count
   - 显示 worktree/branch（如有）
   - 显示关联 task 名称（如有）

4. **新建 `src/hooks/useNotificationPolicy.ts`**
   - 替换 pty.rs 的全量通知
   - 只在 permission/error/review 时通知

5. **修复 `useAttentionRouter.ts`**
   - 解耦 LiveGrid 依赖：有 attention 时先更新 attentionStore，不直接操作 liveGridStore
   - liveGridStore 侧另外订阅 attentionStore 变化

**依赖条件**：Phase 0 完成（旧叙事清除，认知干净）

**风险**：
- `pendingPermissions` 迁移需要保持 `ai_approve_tool` 调用链不断
- `useAttentionRouter` 解耦后需要确认 LiveGrid 聚焦功能仍然正常

**为什么先做**：Attention 是控制台最核心的用户价值，而且现有代码已经很接近（`sessionStatusStore` 已有 `pendingPermissions`，`useAttentionRouter` 已有基础）。这一步成本最低，价值最高。

---

### Phase 2（3~4 周）：统一任务模型

**目标**：结束前端 queue / Rust tasks 双轨割裂，让 Rust tasks 成为唯一 source of truth。

**交付物**：

1. **扩展 `src-tauri/src/tasks.rs`**
   - 加入 `prompt`, `provider`, `priority`, `role`, `worktree_path`, `review_required`, `result_summary` 字段
   - 扩展 `task_create` / `task_update` 命令接口
   - 加入 `task_dispatch` 命令：创建 session + 绑定 task（原子操作）

2. **扩展 `src-tauri/src/ai.rs`**
   - `ai_start_session` 支持传入 `task_id`，启动后立即调用 `task_update(session_id)`
   - 或新增 `ai_start_session_for_task(task_id, ...)` 专用命令

3. **新建 `src/stores/taskStore.ts`**
   - 从 Rust `task_list` 读取
   - 监听 Tauri 事件更新（或 polling）
   - `dispatch(taskId)` → invoke task_dispatch

4. **改写 `src/components/task-queue/TaskQueuePanel.tsx`**
   - data source 换为 `useTaskStore`
   - UI 结构基本不变

5. **新建 `src/hooks/useTaskDispatcher.ts`**（替换 `useAutoExecutor`）
   - 监听 session 完成事件 → 更新对应 task 状态
   - 支持 auto dispatch next queued task
   - 修复 sessionId 绑定 bug

6. **标记 `taskQueueStore.ts` 为 deprecated**，加迁移注释

**依赖条件**：Phase 1 完成（attentionStore 已有，approval 链路稳定）

**风险**：
- `tasks.rs` schema 扩展后，旧 `.md` 文件需要向后兼容（`parse_task` 的 unknown key 忽略策略已有，但新增字段的默认值需要定义）
- `task_dispatch` 是新原子命令，需要处理"session 启动失败时 task 回滚到 open 状态"的错误路径

**为什么在 Phase 1 后做**：没有 attentionStore，task 完成后的 review/approval 路径无法闭环。必须先有 attention 层再统一任务层。

---

### Phase 3（3~5 周）：Worktree-Aware Dispatch + Handoff 重写

**目标**：任务可以选择在新 worktree 中执行，handoff 成为 task 的一种执行策略。

**依赖条件**：Phase 2 完成（统一任务模型存在）

**交付物**：

1. **`src/components/task-queue/TaskCreateForm.tsx`（或扩展 QuickAdd）**
   - 新增：选择执行策略：当前项目 / 新建 worktree / handoff 给其他 provider
   - 新增：选择 role（implement / review / verify / research）

2. **`src-tauri/src/git.rs`**：补全 worktree create 的 UI 链路（目前 `git_worktree_add` 存在但入口未接通）

3. **重写 `src-tauri/src/handoff.rs`**：
   - 改为 `handoff_task(task_id, target_provider)` API
   - 上下文：从 task.description + git diff + 最后 N 条结构化输出构建（不再是 raw PTY buffer）
   - 完成后更新 task.session_id

4. **Live Grid + Mission Control 卡片显示 worktree 信息**

5. **`src-tauri/src/loop_runner.rs` 升级**（可选，如果 Phase 2 稳定）：
   - Loop 与 Task 绑定（传入 task_id）
   - 完成检测改为监听 `session-state-changed: Completed`
   - LoopState 持久化（写回 task 的 metadata）

**风险**：worktree 执行策略引入并发复杂度（多 worktree 同时写同一个 repo），需要在 dispatch 时做互斥检查。

---

### Phase 4（3~6 周）：Review Queue + Result Inbox + Mission Control 三栏

**目标**：解决多 agent 最后的瓶颈——"跑完了但人没法高效回收结果"。

**依赖条件**：Phase 3 完成（任务有完整生命周期，handoff 可用）

**交付物**：

1. **ReviewItem 实体 + Review Queue**
   - Task 完成后（`review_required: true`）自动进入 review 队列
   - 显示：文件变更 diff、风险 flags、建议下一步

2. **Mission Control 三栏布局**：
   - 左：Active + Attention Inbox
   - 中：Task Timeline（按时间的 task 进度）
   - 右：Review / Diff Detail / Approval

3. **结果卡（ResultCard）**：每个完成的 task 生成结构化结果卡（改了什么 / 测试情况 / git diff）

4. **Compare / Accept / Rework / Archive**：Review 动作闭环

---

## 11. 代码级改造地图

### 11.1 优先改动文件（Phase 0~1）

**第一批（Phase 0，1周内）**：

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/utils/api.js` | **删除** | 旧 Node REST 路径 |
| `src/utils/api.test.ts` | **删除** | 旧 REST 测试 |
| `src/types/app.ts` | **删除字段** | 清除 TaskMaster 相关 type 定义 |
| `src/components/main-content/view/subcomponents/MainContentTitle.tsx` | **改文案** | tasks tab 去掉 TaskMaster |
| `CLAUDE.md` | **重写** | 去掉过时的 provider context 描述 |
| `README.md` | **重写核心章节** | 移除 TaskMaster 主线叙事 |
| `src/contexts/AuthContext.jsx` | **修复** | `isAuthenticated` 改为真实状态 |
| `src/components/ProtectedRoute.jsx` | **修复** | 不再直接 return children |

**第二批（Phase 1，2~3周）**：

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/stores/attentionStore.ts` | **新建** | AttentionItem + ApprovalRequest |
| `src/components/overview/AttentionInbox.tsx` | **新建** | 统一审批 inbox UI |
| `src/components/overview/SessionCard.tsx` | **增强** | 加 attention/approval badge |
| `src/stores/sessionStatusStore.ts` | **迁移** | 移出 pendingPermissions |
| `src/hooks/useAttentionRouter.ts` | **重构** | 解耦 liveGridStore 依赖 |
| `src/hooks/useNotificationPolicy.ts` | **新建** | 通知策略 |
| `src/components/overview/MissionControlView.tsx` | **扩展** | 加入 AttentionInbox 区块 |

---

### 11.2 第二版优先改动（Phase 2）

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src-tauri/src/tasks.rs` | **扩展 schema** | 加入 prompt/provider/priority/role/worktree_path |
| `src-tauri/src/ai.rs` | **扩展** | ai_start_session 支持 task_id 绑定 |
| `src/stores/taskStore.ts` | **新建** | 替代 taskQueueStore 的主 task store |
| `src/hooks/useTaskDispatcher.ts` | **新建** | 替代 useAutoExecutor，修复 sessionId bug |
| `src/components/task-queue/TaskQueuePanel.tsx` | **数据源替换** | 读 taskStore 而非 taskQueueStore |
| `src/lib/tauri-bridge.ts` | **扩展** | 补全 task_dispatch, task_list 等类型 |
| `src/stores/taskQueueStore.ts` | **标记 deprecated** | 加注释，停止扩展 |

---

### 11.3 危险区文件（不能随便改）

| 文件 | 为什么危险 | 建议 |
|------|----------|------|
| `src-tauri/src/pty.rs` | 全局共享状态（DashMap），改出 bug 会影响所有 session | 只加新功能，不改现有逻辑；重点测试 session 创建/销毁 |
| `src/contexts/TauriEventContext.tsx` | WebSocket + PTY 事件的核心分发器，改错会导致所有 session 状态丢失 | 只加新 message type 处理，不改现有 case |
| `src-tauri/src/db.rs` | SQLite schema，改错影响所有设置 | 加列时做 migration，不删列 |
| `src/lib/tauri-bridge.ts` | Tauri IPC + HTTP fallback 双路由，改错影响 LAN 模式 | 加新命令时保持对称（Tauri + HTTP 两个路径都要加） |

---

### 11.4 适合先包兼容层的文件

| 文件 | 兼容策略 |
|------|---------|
| `src/stores/taskQueueStore.ts` | 保留导出，在内部替换为读 `taskStore`（外部调用方不感知） |
| `src-tauri/src/tasks.rs` 的 `parse_task` | 新增字段设 default 值，已有 `.md` 文件正常加载 |
| `src/hooks/useAutoExecutor.ts` | 在文件顶部加 `// @deprecated use useTaskDispatcher`，新代码不引用 |

---

### 11.5 应该成为新中心枢纽的文件

| 文件 | 新角色 |
|------|------|
| `src/stores/attentionStore.ts`（新建） | Layer 2 的注意力层核心 store，所有 attention 信号的汇聚点 |
| `src/stores/taskStore.ts`（新建） | Layer 3 的任务层核心 store，与 Rust tasks.rs 的唯一 bridge |
| `src/components/overview/MissionControlView.tsx` | Layer 3 的主 UI 入口，扩展为三区域控制台 |
| `src-tauri/src/tasks.rs` | Rust 侧的任务持久化和调度核心，需要承担 task_dispatch 原子操作 |
| `src/hooks/useTaskDispatcher.ts`（新建） | task 执行调度的唯一前端入口，替代 useAutoExecutor |

---

## 12. 最终一句话：OpenWork 接下来最该押注的主线

> **先把 Attention Inbox 做实（Phase 1），再把任务模型统一（Phase 2）**——这两步做完，OpenWork 就已经是一个真正可用的多 Agent 控制台；之后 handoff、loop、review queue 都是自然延伸，而不是空中楼阁。

---

*本文档由 claude-sonnet-4.6 × claude-opus-4.6 协同分析，基于代码实际现状制定。*  
*直接可用于下一轮 sprint 规划和代码审查基准。*

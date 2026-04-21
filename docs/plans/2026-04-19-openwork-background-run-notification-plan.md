# OpenWork 后台 Agent Run / 完成通知最小落地方案

> **For Hermes:** 这是一个 Phase 1.5 级别的实现计划。优先用子agent推进，保持改动小、边界清晰，不进入 Phase 2 的任务真相统一。  
> **日期：** 2026-04-19  
> **定位：** Mission Control 异步执行控制层补丁，不是全量 orchestration 重写

**Goal:** 把 Hermes 里“后台执行 + 可追踪状态 + 完成通知”的机制抽象进 OpenWork，让后台 agent / Codex / future runner 成为 Mission Control 可见、可追踪、可投递的一等对象。

**Architecture:** 在现有 `sessionStatusStore`、`attentionStore`、`MissionControlView`、`TauriEventContext` 基础上，新增一个最小 `backgroundRun` 领域层。先把“后台 run 的状态、事件、完成通知、注意力投递”接上 Mission Control / Attention Inbox / Approval Inbox，不碰 `tasks.rs` 真相统一，不做重 orchestration。

**Tech Stack:** Tauri + Rust、React、TypeScript、Zustand、现有 `tauri-bridge.ts` / `TauriEventContext.tsx` 事件桥。

---

## 1. 为什么现在要做这个

OpenWork 现在已经在做 Mission Control / Attention Center，但还缺一块很关键的拼图：

1. **后台执行没有正式对象**  
   现在能跑 session、能看状态、能处理 approval，但“一个后台 agent run”本身还不是系统里的一等对象。

2. **完成通知还是瞬时的，不是控制层资产**  
   用户真正关心的是：
   - 哪个 run 在跑
   - 哪个 run 跑完了
   - 哪个 run 失败了
   - 哪个 run 需要批准/人工输入
   - 哪个 run 值得现在切进去看

3. **这正是 Mission Control 的主价值**  
   控制层不是“多开几个窗口”，而是“把需要你介入的时刻集中起来”。

所以这一步不是锦上添花，而是把 OpenWork 从“多 session 壳”再往真正控制台推一步。

---

## 2. 目标边界

### 2.1 这份方案明确要做的

- 为后台执行引入正式 `backgroundRun` 模型
- 为后台执行引入最小事件流
- 为 Mission Control 提供：
  - running / completed / failed / needs_attention 的 run 可见性
  - completion notification 的可追踪落点
  - run 与 session / project 的最小关联
- 把后台 run 的 attention / approval 继续投递到现有 inbox
- 让“完成通知”不只是一条 toast，而是 Mission Control 能回看的状态

### 2.2 这份方案明确不做的

- 不进入 Phase 2：
  - 不做 `tasks.rs` schema 统一
  - 不做 durable task truth 合并
  - 不做 `taskStore`
- 不做完整 orchestration engine
- 不做分布式消息总线
- 不做完整 review queue / result inbox 正式版
- 不重写 PTY / provider bridge
- 不让 `handoff.rs` / `loop_runner.rs` 进入主路径

### 2.3 方案定位

这是一个 **Phase 1.5** 方案：

- 比 Phase 1 的 attention center 更进一步
- 但仍然早于 Phase 2 的任务统一
- 重点是把“异步执行可见性”做出来，而不是把任务系统做大

---

## 3. 核心设计判断

### 3.1 不要把它叫“通知中心”

更准确的名字应该是：

- **Background Run Layer**
- 或 **Async Execution Layer**
- 或 **Agent Run Event Layer**

因为“通知”只是最后一个投递面；真正值钱的是：

- run 作为对象存在
- run 有状态
- run 有事件
- run 的 attention 能被路由
- run 的完成能被回看

### 3.2 一条后台执行 = 一条 run

无论来源是：

- Codex
- Claude Code
- future internal runner
- future review worker

统一都抽象成一条 `backgroundRun`。

### 3.3 run 和 task / session 的关系

当前阶段明确：

- **Run 不是 Task**
- **Run 也不是 Session 本身**
- **Run 是一次后台执行实例**

建议关系：

- `task`：未来 durable control object（Phase 2 再统一）
- `session`：runtime container / conversation shell
- `backgroundRun`：一次异步执行实例，可挂在某个 session / project / future task 上

也就是说：

> 先把 run 建起来，别急着让 run 承担 task truth。

---

## 4. 最小数据模型

### 4.1 `BackgroundRun`

建议先放前端 `src/types/background-run.ts`：

```ts
export type BackgroundRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'awaiting_input'
  | 'needs_attention'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BackgroundRun {
  id: string;
  provider: 'codex' | 'claude' | 'custom';
  title: string;
  summary?: string;
  status: BackgroundRunStatus;
  projectId?: string;
  sessionId?: string;
  source: 'mission-control' | 'task-queue' | 'manual' | 'agent';
  startedAt?: string;
  finishedAt?: string;
  lastOutputExcerpt?: string;
  attentionReason?: 'approval' | 'error' | 'input' | 'completed';
  requiresApproval?: boolean;
  awaitingInput?: boolean;
  processRef?: string; // 先作为兼容字段，可映射到后台进程/session id
}
```

### 4.2 `BackgroundRunEvent`

```ts
export type BackgroundRunEventType =
  | 'run-created'
  | 'run-started'
  | 'run-progress'
  | 'run-awaiting-input'
  | 'run-approval-requested'
  | 'run-completed'
  | 'run-failed'
  | 'run-cancelled';

export interface BackgroundRunEvent {
  id: string;
  runId: string;
  type: BackgroundRunEventType;
  createdAt: string;
  sessionId?: string;
  projectId?: string;
  message?: string;
  excerpt?: string;
}
```

### 4.3 为什么先不落 Rust durable schema

因为这一步的目标是：

- 先把控制层的“异步执行可见性”跑通
- 先用前端 store + 运行时 bridge 承接
- 后面 Phase 2 再决定是否把 run 纳入 durable task/runtime projection 体系

否则会提前把 Phase 1.5 做成 Phase 2.5。

---

## 5. 最小状态流转

### 5.1 建议状态机

```text
queued
  -> starting
  -> running
    -> awaiting_input
    -> needs_attention
    -> completed
    -> failed
    -> cancelled
```

补充规则：

- `awaiting_input` 和 `needs_attention` 可以视作 `running` 的子状态投影，但 Phase 1.5 先直接建成显式状态，方便 UI 消费
- `completed` / `failed` / `cancelled` 是终态

### 5.2 最小事件映射

Hermes 那套逻辑，在 OpenWork 里可先这样映射：

- 启动后台执行 → `run-created`, `run-started`
- 中途输出摘要更新 → `run-progress`
- 请求批准 → `run-approval-requested`
- 请求人工输入 → `run-awaiting-input`
- 失败 → `run-failed`
- 成功完成 → `run-completed`

---

## 6. UI 落点

### 6.1 Mission Control（主入口）

Mission Control 应新增一个最小区域：

- Running Background Runs
- Recently Completed
- Needs Attention

不需要现在就做复杂三栏改造，先放在 summary strip 下方或 inbox 区域下方即可。

### 6.2 Attention Inbox

继续承接：

- `run-failed`
- `run-awaiting-input`
- 需要人工查看的 completed-with-warning

关键点：

> attention 不只属于 session，也属于 background run。

### 6.3 Approval Inbox

继续承接：

- `run-approval-requested`

并与现有 session approval 共用一个消费界面。

### 6.4 Completion Surface

完成通知不要只做临时 toast，至少要有一个：

- `Recently Completed Runs`

每条显示：

- title
- provider
- project
- finishedAt
- final summary / lastOutputExcerpt
- Open Session / View Log

这样用户错过瞬时通知，也能回看。

---

## 7. 代码落点建议

### 7.1 新增文件

#### `src/types/background-run.ts`
定义 `BackgroundRun`、`BackgroundRunStatus`、`BackgroundRunEvent`。

#### `src/stores/backgroundRunStore.ts`
最小 store，先提供：

```ts
runs: Record<string, BackgroundRun>
recentEventIds: string[]
createRun(run)
markRunStarted(runId)
updateRunProgress(runId, excerpt)
markRunAwaitingInput(runId, message?)
markRunNeedsAttention(runId, reason?)
markRunCompleted(runId, summary?)
markRunFailed(runId, message?)
markRunCancelled(runId)
getActiveRuns()
getRecentCompletedRuns()
```

#### `src/components/overview/BackgroundRunPanel.tsx`
Mission Control 中的最小 run 面板。

### 7.2 修改文件

#### `src/components/overview/MissionControlView.tsx`
接入：

- active background runs
- recent completed runs
- 与现有 attention / approval 区域并排或上下排列

#### `src/hooks/useSessionStatusTracker.ts`
只做最小联动：

- 当某类 session event 明确来自 background run 时，更新 `backgroundRunStore`
- 不要把整个 session tracker 重写成 run tracker

#### `src/contexts/TauriEventContext.tsx`
如需要，补最小事件透传：

- run started
- run completed
- run failed
- run approval requested

但原则是：**只加兼容事件，不重做桥层。**

#### `src/lib/approval-actions.ts`
如果 approval 是由某个 run 发起，执行 approve/deny 后顺手更新对应 run 状态。

---

## 8. 分阶段实施顺序

### Task 1：先建最小 run 领域模型

**Objective:** 让后台执行第一次成为正式对象。  
**Files:**
- Create: `src/types/background-run.ts`
- Create: `src/stores/backgroundRunStore.ts`
- Test: `src/stores/backgroundRunStore.test.ts`

**Step 1: Write failing test**

至少覆盖：
- createRun 后能拿到 active run
- markRunCompleted 后 run 从 active 转到 recent completed
- markRunFailed 后会进入 needs-attention 语义

**Step 2: Run test to verify failure**

Run: `npx vitest run src/stores/backgroundRunStore.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

- Zustand store
- 最小 selector
- 不接 UI

**Step 4: Run test to verify pass**

Run: `npx vitest run src/stores/backgroundRunStore.test.ts`
Expected: PASS

---

### Task 2：把 Mission Control 接上最小 run 面板

**Objective:** 让用户第一次在 Mission Control 看到后台 run。  
**Files:**
- Create: `src/components/overview/BackgroundRunPanel.tsx`
- Modify: `src/components/overview/MissionControlView.tsx`
- Test: `src/components/overview/BackgroundRunPanel.test.tsx`

**Step 1: Write failing test**

覆盖：
- active run 显示
- completed run 显示在 recent 区域
- 能打开对应 session（若有 sessionId）

**Step 2: Run test to verify failure**

Run: `npx vitest run src/components/overview/BackgroundRunPanel.test.tsx`
Expected: FAIL

**Step 3: Write minimal implementation**

- 只做最小面板
- 不做复杂筛选/分页/分组

**Step 4: Run test to verify pass**

Run: `npx vitest run src/components/overview/BackgroundRunPanel.test.tsx`
Expected: PASS

---

### Task 3：把 approval / completion 映射到 run store

**Objective:** 让后台 run 的关键事件能被追踪。  
**Files:**
- Modify: `src/lib/approval-actions.ts`
- Modify: `src/hooks/useSessionStatusTracker.ts`
- Modify: `src/contexts/TauriEventContext.tsx`（仅在需要时）
- Test: `src/lib/approval-actions.test.ts`
- Test: `src/hooks/useSessionStatusTracker.test.ts`

**Step 1: Write failing tests**

至少覆盖：
- approval requested 时对应 run 进入 requiresApproval
- approval resolved 后 run 状态更新
- completed / failed 时 run store 收到最终态

**Step 2: Run tests to verify failure**

Run:
```bash
npx vitest run src/lib/approval-actions.test.ts src/hooks/useSessionStatusTracker.test.ts
```
Expected: FAIL

**Step 3: Write minimal implementation**

- 只更新 run store
- 不扩大现有 attention store 职责

**Step 4: Run tests to verify pass**

Run:
```bash
npx vitest run src/lib/approval-actions.test.ts src/hooks/useSessionStatusTracker.test.ts
```
Expected: PASS

---

### Task 4：补一个最小 completed surface

**Objective:** 让完成通知可回看，不再只靠瞬时感知。  
**Files:**
- Modify: `src/components/overview/BackgroundRunPanel.tsx`
- Test: `src/components/overview/BackgroundRunPanel.test.tsx`

**Step 1: Write failing test**

覆盖：
- recent completed 至少显示最近 N 条
- 每条能显示 summary / lastOutputExcerpt

**Step 2: Run test to verify failure**

Run: `npx vitest run src/components/overview/BackgroundRunPanel.test.tsx`
Expected: FAIL

**Step 3: Write minimal implementation**

- 不做完整日志系统
- 先展示 excerpt / summary

**Step 4: Run test to verify pass**

Run: `npx vitest run src/components/overview/BackgroundRunPanel.test.tsx`
Expected: PASS

---

## 9. 验收标准

### 9.1 用户可感知结果

用户在 Mission Control 中至少能看到：

- 哪些后台 run 正在跑
- 哪些后台 run 已完成
- 哪些后台 run 失败/需要介入
- approval/attention 处理后，run 状态能联动更新

### 9.2 工程约束结果

- 不新增 durable schema
- 不修改 `tasks.rs` 任务真相
- 不让 `backgroundRunStore` 成为新的 task truth
- 不要求重写 bridge
- 不要求改写 Live Grid 主结构

### 9.3 验证命令

```bash
npm run typecheck
npx vitest run src/stores/backgroundRunStore.test.ts
npx vitest run src/components/overview/BackgroundRunPanel.test.tsx
npx vitest run src/lib/approval-actions.test.ts src/hooks/useSessionStatusTracker.test.ts
```

如果 Rust bridge 有轻微变动，再补：

```bash
cargo check --lib
```

---

## 10. 风险点

1. **不要让 run store 偷偷演化成 task store**  
   这是最大风险。一旦把 prompt、owner、deps、review 等 durable 语义全塞进去，就会偷跑到 Phase 2。

2. **不要把 session tracker 重写成统一运行时总线**  
   这一步只做最小映射，不做“大一统 runtime engine”。

3. **不要过早要求跨 provider 完全一致协议**  
   先允许 Codex / Claude / future runner 的 event payload 有差异，在 adapter 层做最小归一化。

4. **不要一口气做完整 Result Inbox**  
   Phase 1.5 只要把 completed surface 补出来，不要直接长成 V4。

---

## 11. 最后判断

这套方案最值钱的地方，不是“又多了个通知组件”，而是：

> 它把 OpenWork 里“异步执行何时值得你回来介入”这件事，第一次正式建模了。

这会让 Mission Control 更像真正的控制台，而不只是会话总览。

同时它又刻意不碰 Phase 2 的任务真相统一，所以适合放在当前阶段先落地。
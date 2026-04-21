# OpenWork Phase 0 / 1 / 2 实施计划（基于 final architecture v2）

> 日期：2026-04-19  
> 设计依据：`docs/plans/2026-04-19-openwork-final-architecture-v2.md`  
> 代码基线：当前 `src-tauri/` + `src/` 主线  
> 文档性质：实施计划，不是架构复述；仅覆盖 Phase 0 / Phase 1 / Phase 2

---

## 1. 目标与架构意图

本计划的目标不是“继续堆功能”，而是把 OpenWork 从“多会话壳 + 本地队列实验”收敛成**终端型 AI 编程代理控制平面**的可执行主线。

结合当前代码现实，Phase 0~2 的核心意图如下：

1. **先去噪，再补骨架**：先清掉 TaskMaster / 旧叙事污染，并修掉当前 queue → session 绑定里的立即阻塞 bug。
2. **先建立 Attention/Approval 中心**：让用户从“盯很多会话”转成“只在需要决策时回来处理”。
3. **再统一任务真相**：把 Rust `src-tauri/src/tasks.rs` 提升为唯一 durable task truth，前端 queue/store 退回投影层。

这三阶段完成后，OpenWork 才有条件进入后续的 task-session-worktree 闭环；在此之前，不应把 `handoff.rs` / `loop_runner.rs` 推到主路径中心。

### 1.1 当前对齐结论（2026-04-21 重新按计划文档复核）

- **Phase 0：已完成**
- **Phase 1：已完成**
- **Phase 2：已完成**
- **本文覆盖范围内已无未完成主项**

因此，后续推进应**停止继续在 Phase 0 / 1 / 2 反复兜圈**，把注意力集中到本文范围外的剩余工作：

- **Phase 3：Worktree-aware Dispatch + Handoff 产品化**
- **Phase 4：Review Queue / Result Inbox / Mission Control 三栏版的剩余未完成项**

> 说明：当前分支里已经混入部分 Phase 3 / 4 能力，但它们不属于本文的主执行范围；本文现在只保留“Phase 0 / 1 / 2 已完成”的事实基线，避免后续再把已完成阶段当成待办反复推进。

---

## 2. 范围边界

### 2.1 本计划明确包含

- Phase 0：
  - 语义/命名清理
  - TaskMaster 旧叙事清理
  - 修复当前 auto-execute 的 **session 绑定断链 bug**
  - 清除进入 control-plane 改造前的必须阻塞项
- Phase 1：
  - 建立 Attention Inbox / Approval Inbox
  - 强化 Mission Control 为真正控制台首页
  - 把 `useAttentionRouter` 从“自动跳转 Live Grid”降级为辅助行为
- Phase 2：
  - 统一任务模型，以 `src-tauri/src/tasks.rs` 为 source of truth
  - 前端 `taskQueueStore.ts` 迁移为 queue UI state
  - 改写 auto executor 为 dispatcher / projection 层

### 2.2 本计划明确不包含

- Phase 3 以后的 task-worktree-role 深度闭环实现
- `handoff.rs` 产品化
- `loop_runner.rs` 主路径化
- PTY 执行层大改写
- SQLite/数据库任务系统迁移
- 全量 UI 重构
- 完整 review queue / result inbox 正式实现

### 2.3 当前代码中的关键现实约束

1. **任务双轨**仍存在：
   - durable：`src-tauri/src/tasks.rs`
   - runtime/local：`src/stores/taskQueueStore.ts`
2. **审批语义混入 session store**：
   - `src/stores/sessionStatusStore.ts` 同时持有 `statuses` 与 `pendingPermissions`
3. **Mission Control 仍是 session grid，不是 control plane 首页**：
   - `src/components/overview/MissionControlView.tsx`
4. **Live Grid 仍承担了部分 attention 主入口职责**：
   - `src/hooks/useAttentionRouter.ts`
5. **立即执行断链 bug 已存在且会污染后续控制平面工作**：
   - `src/hooks/useAutoExecutor.ts:31-34` 调用 `taskQueue.markRunning(task.id)` 未传 `sessionId`
   - 随后 `src/hooks/useAutoExecutor.ts:59-63` 通过 `t.sessionId === sessionId` 查找运行任务时会失配

---

## 3. Phase 0：主线去噪 + 立即阻塞问题清理

### 3.1 Phase 0 目标

在不进入 control-plane 主改造前，先完成三件事：

1. 清掉会持续误导实现边界的旧命名/旧叙事；
2. 修掉当前 queue 自动执行链路里最直接的 session 绑定 bug；
3. 把后续 Phase 1 / 2 要依赖的兼容边界标清楚。

### 3.2 必做任务

#### 任务 A：清理可见 TaskMaster 旧叙事，统一为 Task Queue / Tasks

**目标**：先改用户可见和主线开发可见的命名，不急着清全部 legacy 类型。  
**涉及文件**：

- `src/components/main-content/view/subcomponents/MainContentTitle.tsx`
- `src/types/app.ts`
- `src/components/task-queue/TaskQueuePanel.tsx`
- `src/components/workbench/ActivityBar.tsx`
- `src/components/sidebar/view/subcomponents/SidebarContent.tsx`
- `src/i18n/locales/*/settings.json`（只做标注，不做深度设置页改造）

**实施方式**：

- 把主界面标题里 `TaskMaster` 改成 `Task Queue` 或 `Tasks`。
- 保留 `AppTab = 'tasks'` 这个技术字段，**Phase 0 不改 tab id**，避免触发大范围路由/条件渲染连锁。
- 对多语言设置文案中的 TaskMaster 项，先改成：
  - 标记为 legacy / historical integration；或
  - 明确其不属于当前控制平面主线。

**Phase 0 不做**：

- 不删除 `src/components/main-content/types/types.ts` 中 legacy `TaskMaster*` 类型。
- 不重命名所有 `tasks` 相关技术字段。
- 不碰 settings 页复杂逻辑。

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 0**
- 本轮对应计划项：**任务 A：清理可见 TaskMaster 旧叙事，统一为 Task Queue / Tasks**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - `src/components/main-content/view/subcomponents/MainContentTitle.tsx`、`src/components/task-queue/TaskQueuePanel.tsx`、`src/components/sidebar/view/subcomponents/SidebarContent.tsx` 与 `src/components/workbench/ActivityBar.tsx` 的主路径可见命名已经统一到 `Task Queue` / `Queue` 语义，当前控制平面主界面不再把 TaskMaster 当作默认主线文案。
  - `src/types/app.ts` 仍保留 `AppTab = 'tasks'` 的技术字段，并在文件顶部补充了历史兼容注释，符合“Phase 0 只清可见命名、不触发路由/条件渲染大改”的边界要求。
  - 四套 `src/i18n/locales/*/settings.json` 已把 TaskMaster 明确标记为 legacy / historical integration；同时仓库仍保留 `src/components/main-content/types/types.ts` 与 `src/i18n/locales/*/tasks.json` 等 legacy 表面，说明本轮只完成了计划要求的主线可见清理，没有越界做全量 legacy 删除。
- 验证：
  - `npx vitest run src/components/task-queue/TaskQueuePanel.test.tsx src/components/workbench/ActivityBar.test.tsx src/components/sidebar/view/subcomponents/SidebarContent.test.tsx` ✅（3 files / 7 tests passed）
  - `npm run typecheck` ✅
- 下一最小项：继续完成 **Phase 0 任务 C：为 Phase 1/2 标出兼容层与冻结区**，把 queue/session/attention 相关迁移边界直接补到代码注释中，为 Phase 1 / 2 收敛路径做冻结说明。

#### 任务 B：修复 auto-execute 的 session 绑定断链 bug

**问题现状**：

- `src/hooks/useAutoExecutor.ts` 里 `executeTask()` 发送消息成功后只调用 `taskQueue.markRunning(task.id)`。
- `QueuedTask.sessionId` 没被写入。
- 后续完成态依赖 `t.sessionId === sessionId` 匹配，导致 running task 无法被可靠标记 done。
- 这也是 Phase 2 迁移前最明显的 blocker，因为它会让“任务 -> 会话”关系持续失真。

**Phase 0 修复目标**：不是彻底重写 dispatcher，而是先让当前兼容路径能正确绑定 session。

**建议落点**：

- `src/hooks/useAutoExecutor.ts`
- `src/contexts/TauriEventContext.tsx`
- 视情况增加一个最小兼容 helper：
  - `src/lib/tauri-bridge.ts` 或
  - 新增 `src/lib/runtime-dispatch.ts`（如果不想污染 bridge）

**具体做法**：

- 不再把 `sendMessage()` 的同步 `boolean` 返回值当成“任务已成功进入 running”的可靠依据。
- 为 queue 兼容链路补一个**可拿到 sessionId 的派发路径**，至少满足：
  1. 先生成/确定 sessionId；
  2. 派发成功后 `markRunning(task.id, sessionId)`；
  3. Claude/Codex 分支都能拿到一致的 session 标识。
- 如果 `sendMessage()` 暂时无法返回结构化结果，则在 `useAutoExecutor.ts` 中改为：
  - 直接创建本次 dispatch 所使用的 `sessionId`
  - 将该 `sessionId` 显式塞入消息 options
  - 在发送前/发送后立即写回 queue running 记录

**验收标准**：

- auto-execute 打开时，任务被 claim 后必须立即有可追踪的 `sessionId`
- 会话完成事件抵达时，running task 能被正确转成 done
- 不允许再出现“任务运行中，但 sessionId 为空”的兼容路径

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 1**
- 本轮对应计划项：**Phase 0 任务 B：修复 auto-execute 的 session 绑定断链 bug**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - `src/hooks/useAutoExecutor.ts` 已不再依赖旧的 `taskQueue.markRunning(task.id)` 本地队列写法；当前兼容 dispatcher 会在派发前生成 `sessionId`，并通过 durable task 更新把 `task.session_id` 与 `status=dispatched/in_progress` 显式写回。
  - `src/hooks/useSessionStatusTracker.ts` 已覆盖 `session-created` 重绑定场景：当 synthetic session 被真实 runtime session 替换时，会同步回写 `task.session_id`、`sessionStatusStore` runtime projection 与 `backgroundRunStore`，避免“任务运行中但 sessionId 丢失”的断链。
  - 仓库主实现路径中已不存在依赖空 `sessionId` 完成任务匹配的兼容链路；当前任务/会话绑定以 durable task + runtime projection 为准，满足本项在进入 Phase 2 前要先消除的阻塞条件。
- 验证：
  - `npx vitest run src/hooks/useSessionStatusTracker.test.ts src/stores/sessionStatusStore.test.ts src/lib/approval-actions.test.ts src/lib/attention-actions.test.ts` ✅（4 files / 31 tests passed）
  - `npm run typecheck` ✅
- 下一最小项：继续在 **Phase 1** 内核验并补记 **任务 A：新建 attention/approval 结构化 store** 的完成状态，确认其状态结构、事件来源映射与风险分级已经满足计划定义。

#### 任务 C：为 Phase 1/2 标出兼容层与冻结区

**目标**：在代码结构上先明确哪些文件是下一阶段高风险入口，哪些暂时不碰。

**需要补的最小注释/文档说明**：

- `src/stores/taskQueueStore.ts`：标记为 queue UI / 兼容投影，不再视为任务真相
- `src/stores/sessionStatusStore.ts`：标记 pendingPermissions 将迁出
- `src/hooks/useAttentionRouter.ts`：标记将降级为辅助跳转，而非主入口
- `src-tauri/src/tasks.rs`：标记即将扩 schema，但仍保持 Markdown frontmatter 主线

这一步可以通过代码注释或文档补充完成，不要求单独建立新系统。

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 0**
- 本轮对应计划项：**任务 C：为 Phase 1/2 标出兼容层与冻结区**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - `src/stores/taskQueueStore.ts` 顶部已明确标记为 “queue UI state / ordering projection”，声明 durable task 真相在 Rust-backed `taskStore` / `tasks.rs`，满足“taskQueueStore 不再视为任务真相”的冻结边界。
  - `src/stores/sessionStatusStore.ts` 顶部已明确标记为 runtime session-status projection only，并注明 approval / permission state 已迁至 `attentionStore`；`src/hooks/useAttentionRouter.ts` 顶部注释也已把该 hook 降级为 Live Grid convenience bridge，符合后续 Phase 1 的主入口迁移方向。
  - 本轮核验范围内，Phase 0 计划要求标记的高风险兼容入口都已在代码中留下迁移/冻结说明；虽然 `src-tauri/src/tasks.rs` 的具体 schema 扩展属于 Phase 2 主战场，但本阶段所需的前端兼容层边界已经补齐，不需要额外引入新系统。
- 验证：
  - `npx vitest run src/stores/taskQueueStore.test.ts src/stores/sessionStatusStore.test.ts src/hooks/useAttentionRouter.test.ts` ✅（3 files / 24 tests passed）
  - `npm run typecheck` ✅
- 下一最小项：**Phase 0 任务 A-C 已全部完成（含本轮核验补记）**；可以按主计划顺序进入 **Phase 1 任务 A：新建 attention/approval 结构化 store**。

### 3.3 Phase 0 文件级改造地图

#### Rust / 后端

- `src-tauri/src/tasks.rs`
  - 仅补注释/边界说明；**Phase 0 不扩 schema**
- `src-tauri/src/lib.rs`
  - 无必要不改
- `src-tauri/src/ai.rs`
  - Phase 0 原则上不改业务，除非需要补最小 session 绑定辅助接口

#### 前端

- `src/hooks/useAutoExecutor.ts`
  - 修复 sessionId 断链
  - 不再依赖“发送成功 boolean = 完整 dispatch 成功”
- `src/contexts/TauriEventContext.tsx`
  - 如有必要，补返回/回传 session identity 的兼容能力
- `src/components/main-content/view/subcomponents/MainContentTitle.tsx`
  - 移除 `TaskMaster` 主标题文案
- `src/components/task-queue/TaskQueuePanel.tsx`
  - 仅做文案和说明层清理
- `src/types/app.ts`
  - 保持技术字段兼容，不进行破坏性重命名
- `src/stores/taskQueueStore.ts`
  - 增加兼容层注释
- `src/stores/sessionStatusStore.ts`
  - 增加迁移注释

### 3.4 Phase 0 测试 / 验证清单

#### 功能验证

- [x] Task Queue 中新增任务后，manual trigger / auto-execute 仍可启动执行
- [x] 执行中的 queue item 拥有 `sessionId`
- [x] session 完成后，对应 queue item 能转为 done
- [x] ActivityBar、Sidebar、BottomStatusStrip 的 queue 数字没有因为文案/注释调整而失效
- [x] 主界面标题不再显示 `TaskMaster`

#### 代码级验证

- [x] 补 `useAutoExecutor` 单测，覆盖“运行任务绑定 sessionId 后完成态能回写”
- [x] 补/更新 `sessionStatusStore`、`useSessionStatusTracker` 相关测试快照（如受影响）
- [x] `npm run typecheck`
- [x] 如可运行：`cargo check --lib`（确保前端联动未要求新增 Rust API）

### 3.5 Phase 0 风险点

- `src/contexts/TauriEventContext.tsx` 是高风险文件：既处理 provider dispatch，又承担 PTY/session 消息映射；小改也可能影响 chat 主路径。
- `src/hooks/useAutoExecutor.ts` 当前设计依赖 store 静态 `getState()` + subscribe，修复时容易引入重复 dispatch 或状态竞争。
- `taskQueueStore.ts` 仍是多个徽标/计数来源，Phase 0 不能过早拆掉。

---

## 4. Phase 1：Attention Inbox + Mission Control 强化

### 4.1 Phase 1 目标

把当前分散在：

- `sessionStatusStore.statuses`
- `pendingPermissions`
- `useAttentionRouter`
- Live Grid 卡片 inline permission

里的注意力语义，收敛成一个**Mission Control 优先**的 Attention / Approval 中心。

### 4.2 Phase 1 设计原则

1. `sessionStatusStore` 继续保留，但只做 **session runtime projection**。
2. approval / attention 从 `sessionStatusStore` 拆出，不再和 session status 混存。
3. Mission Control 成为第一入口；Live Grid 只负责并行观察和快捷干预。
4. 第一版允许 heuristic，但必须结构化。

### 4.3 必做任务

#### 任务 A：新建 attention/approval 结构化 store

**建议新增文件**：

- `src/stores/attentionStore.ts`
- 可选：`src/stores/approvalStore.ts`

**建议 Phase 1 实现方式**：优先一个 store 内分两个子域，避免首版过度拆散。

**最少状态结构**：

- `attentionItems`
- `approvalRequests`
- `upsertAttentionItem`
- `resolveAttentionItem`
- `dismissAttentionItem`
- `upsertApprovalRequest`
- `approveRequestOptimistic`
- `denyRequestOptimistic`
- `expireRequest`

**来源映射**：

- provider 消息：
  - `claude-permission-request`
  - `claude-permission-cancelled`
  - `session-aborted`
  - `claude-error` / `codex-error`
- PTY runtime 事件：
  - `session-state-changed`
  - `attention-required`

**Phase 1 注意**：

- Codex/Cursor 暂时没有完整 approval 事件，也要允许只生成一般 attention item。
- riskLevel 可以先用前端静态规则计算，不要求 Rust 参与。

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 1**
- 本轮对应计划项：**任务 A：新建 attention/approval 结构化 store**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - `src/stores/attentionStore.ts` 已提供计划要求的双子域结构：`attentionItems` / `approvalRequests`，并具备 `upsertAttentionItem`、`resolveAttentionItem`、`dismissAttentionItem`、`upsertApprovalRequest`、`approveRequestOptimistic`、`denyRequestOptimistic`、`expireRequest` 等主动作，首版以单 store 收敛 approval + attention，符合 Phase 1 的实现边界。
  - 风险分级已在前端静态规则中落地：permission 类请求按 toolName 派生 `riskLevel`，高风险操作（如 Bash / Write / Delete / Exec）会优先出现在 approval 队列前部，满足“第一版允许 heuristic，但必须结构化”的计划要求。
  - `src/hooks/useSessionStatusTracker.ts` 已把 `claude-permission-request`、`claude-permission-cancelled`、`session-aborted`、`claude-error` / `codex-error`、`attention-required` 等事件归一后写入 `attentionStore`；仓库主实现路径中对 `pendingPermissions` 的引用已仅剩测试文件，说明 approval 主读写入口已经迁出 `sessionStatusStore`。
- 验证：
  - `npx vitest run src/stores/attentionStore.test.ts src/hooks/useSessionStatusTracker.test.ts src/lib/approval-actions.test.ts src/lib/attention-actions.test.ts` ✅（4 files / 16 tests passed）
  - `npm run typecheck` ✅
- 下一最小项：继续核验 **Phase 1 任务 B**，确认 `useSessionStatusTracker.ts` 与 `sessionStatusStore.ts` 已稳定收敛为 runtime event normalizer / runtime projection，且 `pendingPermissions` 不再作为主写入口。

#### 任务 B：把 `useSessionStatusTracker.ts` 升级为 runtime event normalizer

**涉及文件**：

- `src/hooks/useSessionStatusTracker.ts`
- `src/stores/sessionStatusStore.ts`
- `src/lib/tauri-bridge.ts`
- `src/contexts/TauriEventContext.tsx`（如需要补标准事件流）

**改造目标**：

- `sessionStatusStore` 只留下：
  - `status`
  - `attentionReason`
  - `updatedAt`
  - 可新增 `provider / taskId / projectPath / worktreePath` 占位字段
- 将 `pendingPermissions` 迁出到新 attention store
- tracker 同时消费：
  - WebSocket/provider message
  - Tauri PTY events
- 不再只靠 `claude-*` / `codex-*` 前缀驱动整个 runtime 语义

**兼容要求**：

- Phase 1 期间，为了不一次性打断 chat/live-grid：
  - 可以保留 `pendingPermissions` 的只读镜像或桥接 selector
  - 但写入口必须逐步收敛到新 store

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 1**
- 本轮对应计划项：**任务 B：把 `useSessionStatusTracker.ts` 升级为 runtime event normalizer**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - `src/stores/sessionStatusStore.ts` 已收敛为 runtime projection store：主状态仅保留 `status` / `attentionReason` / `updatedAt` / `provider`，并补有 `taskId`、`taskTitle`、`taskStatus`、`taskRole`、`taskExecutionStrategy`、`projectPath`、`worktreePath` 等 runtime projection 字段；`pendingPermissions` 已从主状态结构中迁出。
  - `src/hooks/useSessionStatusTracker.ts` 已同时归一 provider 消息与 PTY/runtime 事件：覆盖 `session-created`、`claude-*` / `codex-*`、`session-state-changed`、`attention-required`、`session-aborted` 等来源，并在事件处理时同步回写 `sessionStatusStore`、`attentionStore`、`backgroundRunStore` 与 task runtime projection，符合“runtime event normalizer”定位。
  - 仓库主实现路径中已无 `sessionStatusStore.pendingPermissions` 读写引用；当前仅测试桩仍提到该字段以覆盖兼容场景，满足“兼容期允许镜像/selector，但主写入口迁出新 store”的阶段要求。
- 验证：
  - `npx vitest run src/hooks/useSessionStatusTracker.test.ts src/stores/sessionStatusStore.test.ts src/lib/approval-actions.test.ts src/lib/attention-actions.test.ts` ✅（4 files / 31 tests passed）
  - `npm run typecheck` ✅
- 下一最小项：**Phase 1 任务 A-E 已全部完成（含本轮核验补记）**；**phase 完成，准备进入 Phase 2 任务 A：扩展 `src-tauri/src/tasks.rs` 的 Task schema 与状态机**。

#### 任务 C：重写 `useAttentionRouter.ts` 的定位

**现状**：

- 当前逻辑是 session 进入 `needs_attention` 就直接聚焦 Live Grid 卡片。

**目标**：

- 改为“写入 Attention Center + 可选建议聚焦”，不再默认抢焦点。
- 允许以下策略：
  - 如果用户当前在 Mission Control：只刷新 inbox
  - 如果用户当前在 Live Grid 且该 session 卡片可见：轻提示，不强制 focus
  - 仅对 `critical` / permission 高风险请求考虑提示升级

**涉及文件**：

- `src/hooks/useAttentionRouter.ts`
- `src/components/live-grid/view/LiveGridView.tsx`
- 可能新增 `src/hooks/useMissionControlAttentionNavigation.ts`（可选）

**执行状态（2026-04-21 cron，本轮推进）**：

- 当前所在 phase：**Phase 1**
- 本轮对应计划项：**任务 C：重写 `useAttentionRouter.ts` 的定位**
- 状态：**已完成（经本轮修正 + 核验）**
- 本轮实现：
  - `src/hooks/useAttentionRouter.ts` 已从“高风险 approval 自动聚焦 Live Grid 卡片”改为“仅当用户已处于 Live Grid 时给出轻量 warning toast 提示”，不再调用 `setFocusedCard()` 抢占焦点。
  - 新增 `getActiveWorkbenchNav()` 读取当前 workbench 导航态；当用户停留在 Mission Control / Projects / 其他视图时，attention 仅通过 `attentionStore` 驱动 inbox 刷新，不再隐式改写 Live Grid 焦点。
  - 新增 `src/hooks/useAttentionRouter.test.ts`，覆盖“非 Live Grid 不抢焦点”和“Live Grid 内仅 toast 提示、不强制 focus”两个最小行为。
- 核验结论：
  - `useAttentionRouter` 现已降级为 Attention Center 优先下的辅助提醒桥接，符合“Mission Control 优先、Live Grid 非主入口”的计划定位。
  - 高风险 approval 到达时，若用户不在 Live Grid，Mission Control/Attention Inbox 保持为主处理入口；若用户已在 Live Grid，仅出现轻量提醒，不再强制切入 focused session。
- 验证：
  - `npx vitest run src/hooks/useAttentionRouter.test.ts src/components/overview/MissionControlView.test.tsx src/components/overview/MissionControlInboxes.test.tsx` ✅（3 files / 18 tests passed）
  - `npm run typecheck` ✅
- 下一最小项：继续核验 **Phase 1 任务 B**，确认 `useSessionStatusTracker.ts` 与 `sessionStatusStore.ts` 已稳定收敛为 runtime event normalizer / runtime projection，且 `pendingPermissions` 不再作为主写入口。

#### 任务 D：强化 Mission Control 为控制台首页

**涉及文件**：

- `src/components/overview/MissionControlView.tsx`
- 可新增子组件：
  - `src/components/overview/ApprovalInbox.tsx`
  - `src/components/overview/AttentionInbox.tsx`
  - `src/components/overview/TaskSummaryStrip.tsx`
  - `src/components/overview/ActiveSessionSection.tsx`

**具体 UI 改造**：

Mission Control 首屏固定分四块：

1. Approval Inbox
2. Attention Inbox
3. Active Sessions
4. Task Summary

**数据来源约束**：

- Approval/Attention：新 store
- Active Sessions：`sessionStatusStore` + 项目 session 列表
- Task Summary：Phase 1 暂时允许继续从 `taskQueueStore` 统计，但要标注这是过渡态

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 1**
- 本轮对应计划项：**任务 D：强化 Mission Control 为控制台首页**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - `src/components/overview/MissionControlView.tsx` 已将 Mission Control 首屏收敛为控制平面入口：首屏核心可见 `Approval Inbox`、`Attention Inbox`、`Active Sessions`，并通过 `MissionControlSummaryStrip` + `TaskTimelineOverview` 承担 Task Summary / task flow 总览。
  - 数据源符合 Phase 1 方向：审批与注意力来自 `attentionStore`，Active Sessions 来自 `sessionStatusStore` 与项目 session 列表；任务侧已进一步前移到 durable `taskStore`，同时仍保留 `taskQueueStore.queueOrder` 作为队列投影排序兼容层，未越出本阶段边界。
  - 相关子组件 `ApprovalInbox.tsx` / `AttentionInbox.tsx` / `MissionControlSummaryStrip.tsx` 已接入 `MissionControlView`，Mission Control 不再只是 session grid 首页。
- 验证：`npx vitest run src/components/overview/MissionControlView.test.tsx src/components/overview/MissionControlInboxes.test.tsx` ✅（2 files / 16 tests passed）
- 下一最小项：继续核验 **Phase 1 任务 C**，确认 `useAttentionRouter.ts` 已稳定降级为 Attention Center 优先下的辅助跳转，不再默认抢占 Live Grid 焦点。

#### 任务 E：清理 inline approval 的控制权重复

当前重复入口：

- `src/components/live-grid/view/LiveCard.tsx` 直接读取 `pendingPermissions`
- `src/components/chat/hooks/useChatPanel.ts` 直接读取/清空 `pendingPermissions`

**Phase 1 目标**：

- 不禁止 inline approve UI，但它必须消费新 approval store，而不是继续直连 `sessionStatusStore.pendingPermissions`
- `ai_approve_tool` 的调用闭环统一通过一个 action/helper

**建议新增文件**：

- `src/lib/approval-actions.ts` 或 `src/hooks/useApprovalActions.ts`

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 1**
- 本轮对应计划项：**任务 E：清理 inline approval 的控制权重复**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - `src/components/live-grid/view/LiveCard.tsx` 已从 `attentionStore.approvalRequests` 读取待审批项，并统一通过 `src/lib/approval-actions.ts` 的 `respondToApprovalRequest()` 执行 approve / deny。
  - `src/components/chat/hooks/useChatPanel.ts` 已切到 `attentionStore.approvalRequests` 作为当前待审批来源，不再读取 `sessionStatusStore.pendingPermissions` 作为主读入口。
  - `src/lib/approval-actions.ts` 已承担 `ai_approve_tool` 调用闭环与 optimistic 状态回滚；仓库内仅剩测试 mock 提及 `pendingPermissions`，主实现路径未再直连该字段。
- 验证：`npx vitest run src/lib/approval-actions.test.ts src/lib/attention-actions.test.ts src/hooks/useSessionStatusTracker.test.ts` ✅（3 files / 13 tests passed）
- 下一最小项：继续核验 **Phase 1 任务 D**，确认 `MissionControlView` 首屏四区块（Approval Inbox / Attention Inbox / Active Sessions / Task Summary）与数据源约束是否都已满足计划。

### 4.4 Phase 1 文件级改造地图

#### Rust / 后端

- `src-tauri/src/pty.rs`
  - 明确 `attention-required` payload contract
  - 尽量固定 `type/message` 字段语义
  - 不在此阶段加入任务业务逻辑
- `src-tauri/src/ai.rs`
  - 保持 `ai_approve_tool` 闭环稳定
- `src-tauri/src/http_server.rs`
  - 此阶段只检查 web fallback 是否会丢 attention 事件；无必要不扩接口

#### 前端核心

- `src/stores/sessionStatusStore.ts`
  - 缩减为 session runtime projection
  - 迁出 `pendingPermissions`
- `src/hooks/useSessionStatusTracker.ts`
  - 升级为事件归一化器
- `src/stores/attentionStore.ts`
  - 新建
- `src/hooks/useAttentionRouter.ts`
  - 重定义为中心优先
- `src/components/overview/MissionControlView.tsx`
  - 升级为 control plane 首页
- `src/components/live-grid/view/LiveGridView.tsx`
  - 接受由 attention center 导航而来，但不做主入口
- `src/components/live-grid/view/LiveCard.tsx`
  - 改用新 approval store
- `src/components/chat/hooks/useChatPanel.ts`
  - 改用新 approval store / 统一 approve action
- `src/App.tsx`
  - 调整初始化顺序，引入新 attention store 相关 hook

### 4.5 Phase 1 测试 / 验证清单

#### 事件与状态验证

- [x] `claude-permission-request` 会生成 approval item + attention item
- [x] `claude-permission-cancelled` 会正确清理 active approval
- [x] `session-aborted` 会生成 attention item
- [x] `attention-required(waiting/error)` 会进入 attention inbox
- [x] 同一 `sessionId + requestId` 不会生成重复 active approval 项

#### UI 验证

- [x] Mission Control 首屏可见 Approval Inbox / Attention Inbox / Active Sessions / Task Summary
- [x] 不进入 Live Grid 也能完成批准/拒绝操作
- [x] Live Grid 中 inline approval 仍可工作，但数据源已切到新 store
- [x] Chat 面板中的 pending permission 展示未回退
- [x] `useAttentionRouter` 不再强制抢占 Live Grid 焦点

#### 回归验证

- [x] `ai_approve_tool` 调用后 UI 状态从 pending → resolving/approved/denied 正确推进
- [x] `sessionStatusStore` 仍能提供 `processing / needs_attention / completed / idle` 状态
- [x] `npm run typecheck`
- [x] 前端相关测试通过：
  - `src/hooks/useSessionStatusTracker.test.ts`
  - `src/stores/sessionStatusStore.test.ts`
  - 新增 `attentionStore` / `approval actions` 测试

### 4.6 Phase 1 风险点

- `src/components/chat/hooks/useChatPanel.ts` 体量大、耦合深，是最容易因为 approval 迁移而引发回归的文件之一。
- `src/contexts/TauriEventContext.tsx` 同时服务 chat 和 runtime event，任何事件名/归一化方式变化都要做回归验证。
- `src/components/live-grid/view/LiveCard.tsx` 目前直接调用 `invoke('ai_approve_tool')`，迁移时要避免 Mission Control 与 Live Card 双写状态。
- `src/stores/sessionStatusStore.ts` 被多个 selector 依赖，迁出 `pendingPermissions` 时需要兼容期桥接。

---

## 5. Phase 2：统一任务模型，以 Rust tasks.rs 为真相源

### 5.1 Phase 2 目标

结束当前这套双轨：

- durable task：`src-tauri/src/tasks.rs`
- local queue task：`src/stores/taskQueueStore.ts`

统一后：

- **Task 真相源 = Rust `tasks.rs`**
- **Queue = Task 的调度/排序/UI 投影**
- **Session = runtime execution object**

### 5.2 Phase 2 迁移原则

1. **不一次性删除旧 queue UI**，先换数据源。
2. **先扩 Rust schema，再迁前端 store**。
3. **TaskQueuePanel 可保留外观，先替换模型和动作**。
4. **auto executor 必须重写成 dispatcher**，不能继续靠本地 queue 假定任务完成。

### 5.3 必做任务

#### 任务 A：扩展 `src-tauri/src/tasks.rs` 的 Task schema 与状态机

**目标字段（至少 Phase 2 先落一版）**：

- `id`
- `title`
- `description`
- `prompt`
- `status`
- `provider`
- `project_path`
- `session_id`
- `deps`
- `review_required`
- `result_summary`
- `created_at`
- `updated_at`

**Phase 2 可选先占位，不强依赖完整 UI 的字段**：

- `priority`
- `role`
- `worktree_path`
- `approval_policy`
- `parent_task_id`
- `tags`

**状态机至少扩到**：

- `Open`
- `Queued`
- `Dispatched`
- `InProgress`
- `PendingApproval`
- `PendingReview`
- `Done`
- `Failed`
- `Cancelled`

**涉及文件**：

- `src-tauri/src/tasks.rs`
- `src-tauri/src/lib.rs`（若命令签名变化）
- `src/lib/tauri-bridge.ts`（Task 类型与调用参数同步）

**实施要求**：

- 保持 Markdown frontmatter 持久化，不迁数据库
- frontmatter 解析要兼容旧任务文件：
  - 老字段缺失时给默认值
  - 旧 `open/in_progress/done/failed` 要能无损映射
- `task_create` / `task_update` 不要只支持 title/description，需支持新增字段 patch

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 2**
- 本轮对应计划项：**任务 A：扩展 `src-tauri/src/tasks.rs` 的 Task schema 与状态机**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - `src-tauri/src/tasks.rs` 已将 durable task schema 扩到 Phase 2 主线所需：`status/provider/project_path/session_id/deps/review_required/result_summary/created_at/updated_at` 已稳定落地，并额外具备 `role`、`execution_strategy`、`worktree_path` 与结果摘要相关字段，仍保持 Markdown frontmatter 为唯一持久化格式。
  - 状态机已覆盖 `Open / Queued / Dispatched / InProgress / PendingApproval / PendingReview / Done / Failed / Cancelled`，并额外保留 `Archived` 终态；旧 frontmatter 缺字段时会回退到 Phase 2 默认形状，`open/in_progress/done/failed` 等旧状态可继续无损解析。
  - `task_create` / `task_update` 已支持新增字段 patch；`src/lib/tauri-bridge.ts` 的 `Task` / `CreateTaskInput` / `TaskUpdateInput` 与 invoke 参数形状已同步到扩展后的 Rust schema，前后端模型边界一致。
- 验证：
  - `cargo test tasks` ✅（16 passed，覆盖旧 schema 兼容、frontmatter roundtrip、execution metadata 归一、create/update patch）
  - `npm run typecheck` ✅
- 下一最小项：继续核验 **Phase 2 任务 B：新增前端 durable task store / repository**，确认 `taskStore.ts` 已成为 Rust tasks 真相源的前端读取/更新入口，而 `taskQueueStore.ts` 仅保留 queue UI projection 职责。

#### 任务 B：新增前端 durable task store / repository

**建议新增文件**：

- `src/stores/taskStore.ts`
- 可选：`src/domain/tasks/taskViewSelectors.ts`
- 可选：`src/domain/tasks/taskMapper.ts`

**职责**：

- 从 `tasks.list(projectPath)` 读取 durable tasks
- 提供 refresh/create/update/delete/dispatch action
- 与 `sessionStatusStore` / `attentionStore` 合成 display model

**不要做成什么**：

- 不要再复制一份 `QueuedTask` 结构
- 不要把 queue 排序/展开态塞回 durable task store

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 2**
- 本轮对应计划项：**任务 B：新增前端 durable task store / repository**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - `src/stores/taskStore.ts` 已作为 Rust `tasks.rs` 真相源的前端 repository：主读写入口覆盖 `refresh/createTask/updateTask/deleteTask`，底层分别直连 `tasks.list/create/update/delete`，并以 `tasksByProject` 维护前端缓存，不再复制一份本地 `QueuedTask` 任务真相。
  - `useAutoExecutor.ts`、`useSessionStatusTracker.ts`、`MissionControlView.tsx`、`TaskQueuePanel.tsx`、`TaskQuickAdd.tsx` 已统一消费 `taskStore`；任务派发阶段的 durable 状态推进通过 `taskStore.updateTask(...)` 写回 `status/session_id/result_*`，说明前端主链已经以 durable task repository 为入口，而非旧 queue 本体。
  - `taskStore` 会在 refresh / create / update / delete 后同步 `taskQueueStore.syncQueueOrder(...)`，使 `taskQueueStore.ts` 退回排序/并发/UI 投影层；Mission Control 与 Task Queue 的任务视图都已基于 durable task + queue projection 组合显示，符合本项职责边界。
- 验证：
  - `npx vitest run src/stores/taskStore.test.ts src/components/task-queue/TaskQuickAdd.test.tsx src/components/task-queue/TaskQueuePanel.test.tsx src/components/overview/MissionControlView.test.tsx` ✅（4 files / 32 tests passed）
  - `npm run typecheck` ✅
- 下一最小项：继续核验 **Phase 2 任务 C：把 `taskQueueStore.ts` 降级为 queue UI state store**，确认本地 store 已只保留 `queueOrder/autoExecute/maxConcurrent` 等 UI projection 状态，主路径不再回写 durable task 本体。

#### 任务 C：把 `taskQueueStore.ts` 降级为 queue UI state store

**现状问题**：

- 当前 `QueuedTask` 既像任务本体，又像队列项，导致 source-of-truth 分裂。

**Phase 2 目标结构**：

- `queueOrder: string[]`
- `autoExecute: boolean`
- `maxConcurrent: number`
- `filters`
- `expandedTaskIds`
- `manualClaimsByTaskId`（如果需要）
- `lastErrorByTaskId`（仅 UI 使用）

**迁移方式**：

- 先保留旧 action 名称的兼容包装一版，但内部不再写任务本体字段
- 第二步再删除 `QueuedTask` 主体模型和本地持久化任务数据

**涉及文件**：

- `src/stores/taskQueueStore.ts`
- `src/stores/index.ts`
- 所有依赖 queue.count 的组件

**执行状态（2026-04-21 cron，本轮推进）**：

- 当前所在 phase：**Phase 2**
- 本轮对应计划项：**任务 C：把 `taskQueueStore.ts` 降级为 queue UI state store**
- 状态：**已完成（经本轮补测 + 核验）**
- 本轮实现 / 核验结论：
  - `src/stores/taskQueueStore.ts` 当前已只保留 `queueOrder`、`autoExecute`、`maxConcurrent` 三类 queue projection / UI 控制状态，以及 `syncQueueOrder`、`reorder`、`removeFromQueueOrder` 等排序辅助动作；本地 store 中已无 `QueuedTask` 任务本体字段或第二份 durable task 真相。
  - `src/stores/taskStore.ts` 继续承担 durable task 读写，并仅在 refresh/create/update/delete 后同步 `taskQueueStore.syncQueueOrder(...)`；说明 queue store 已退回排序投影层，而不是再回写任务本体。
  - 本轮新增 `src/stores/taskQueueStore.test.ts`，覆盖 persisted state 仅保存 queue projection 控制项、queue order 与 durable task id 同步、排序回退到 `created_at`、并发上限 clamp 不污染 queue order，补齐本项最小验证闭环。
- 验证：
  - `npx vitest run src/stores/taskQueueStore.test.ts src/stores/taskStore.test.ts src/components/task-queue/TaskQueuePanel.test.tsx src/hooks/useAutoExecutor.test.ts` ✅（4 files / 19 tests passed）
  - `npm run typecheck` ✅
- 下一最小项：继续推进 **Phase 2 任务 D：重写 `useAutoExecutor.ts` 为 dispatcher / scheduler hook**，重点核验其是否已经完全满足“runtime 事件驱动任务状态推进，而不是把 session completed 直接当作 task done”的计划约束。

#### 任务 D：重写 `useAutoExecutor.ts` 为 dispatcher / scheduler hook

**建议重命名/替换**：

- `src/hooks/useAutoExecutor.ts` → `src/hooks/useTaskDispatcher.ts`
- `src/App.tsx` 中的初始化点同步更新

**核心行为**：

1. 从 durable task 列表中找 `Queued` 任务
2. 检查 session capacity（可继续参考现有 `maxConcurrent`）
3. 启动 session
4. 写回 `task.status = Dispatched/InProgress`
5. 写回 `task.session_id`
6. provider/runtime 事件到达后更新为：
   - `PendingApproval`
   - `PendingReview`
   - `Done`
   - `Failed`

**关键约束**：

- 不允许再以“session completed = task done”作唯一判断
- 最少要结合：
  - task 是否仍绑定该 session
  - 是否进入 attention / approval / failed
  - 是否需要 review

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 2**
- 本轮对应计划项：**任务 D：重写 `useAutoExecutor.ts` 为 dispatcher / scheduler hook**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - `src/hooks/useAutoExecutor.ts` 当前已实际承担 Phase 2 dispatcher/scheduler 职责：它从 `taskStore` durable tasks 中挑选 `open/queued` 任务，结合 `taskQueueStore.maxConcurrent + queueOrder` 做容量与排序控制，并在派发前后显式写回 `task.status = dispatched/in_progress` 与 `task.session_id`。
  - runtime 状态推进已不再依赖“session completed = task done”的单一假设；当前实现会基于 `sessionStatusStore` 事件把任务分别推进到 `pending_approval`、`pending_review`、`done`、`failed`、`cancelled`，并结合 `review_required`、attention 原因、取消流与当前 `task.session_id` 绑定来决定 durable task 终态。
  - `src/App.tsx` 仍在应用初始化链路中挂载该 hook；虽然文件名暂未重命名为 `useTaskDispatcher.ts`，但运行语义已经符合计划中“dispatcher / scheduler hook”的边界，未把 `handoff.rs` / `loop_runner.rs` 推入主路径中心。
- 验证：
  - `npx vitest run src/hooks/useAutoExecutor.test.ts src/components/task-queue/TaskQueuePanel.test.tsx src/components/task-queue/TaskQuickAdd.test.tsx src/stores/taskStore.test.ts` ✅（4 files / 24 tests passed）
  - `npm run typecheck` ✅
- 下一最小项：继续核验 **Phase 2 任务 E：Task Queue UI 切换到 Rust tasks 数据源**，确认 `TaskQuickAdd/TaskQueuePanel/TaskQueueItem` 已完全以 durable task + queue projection 渲染和更新，不再依赖旧本地 queue task 模型。

#### 任务 E：Task Queue UI 切换到 Rust tasks 数据源

**涉及文件**：

- `src/components/task-queue/TaskQueuePanel.tsx`
- `src/components/task-queue/TaskQuickAdd.tsx`
- `src/components/task-queue/TaskQueueItem.tsx`
- `src/lib/tauri-bridge.ts`

**具体改造**：

- `TaskQuickAdd` 改为调用 `tasks.create(...)`，而不是 `useTaskQueueStore.addTask(...)`
- `TaskQueuePanel` 改为渲染 durable tasks + queue UI projection
- `TaskQueueItem` 显示 task.status，而不是本地 queue status
- `retry/cancel/remove` 改为 durable task update/delete

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 2**
- 本轮对应计划项：**任务 E：Task Queue UI 切换到 Rust tasks 数据源**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - `src/components/task-queue/TaskQuickAdd.tsx` 当前已通过 `useTaskStore.createTask(...)` 调用 `tasks.create(...)` 持久化 durable task；新增任务路径不再写入旧 `taskQueueStore` 本地任务模型，仅在需要时创建 worktree 并把 `provider/role/execution_strategy/session_id/review_required/status` 一并写入 Rust task API。
  - `src/components/task-queue/TaskQueuePanel.tsx` 当前直接从 `taskStore.tasksByProject` 读取项目任务，并仅使用 `taskQueueStore.queueOrder/autoExecute/maxConcurrent` 作为 queue projection；面板内统计、刷新、清理完成项与空状态渲染均建立在 durable task status 上，而非旧本地 queue task 数组。
  - `src/components/task-queue/TaskQueueItem.tsx` 已以 `Task.status`、`execution_strategy`、`session_id` 等 durable 字段渲染；`retry/cancel/remove` 也都回到 `taskStore.updateTask(...)` / session abort 流程，不再依赖旧 queue status/action。`src/lib/tauri-bridge.ts` 中 `tasks.create/update/list` 的 Task 类型与输入签名已覆盖本项所需字段，形成前后端一致的数据源契约。
- 验证：
  - `npx vitest run src/components/task-queue/TaskQueuePanel.test.tsx src/components/task-queue/TaskQuickAdd.test.tsx src/components/task-queue/TaskQueueItem.test.tsx src/stores/taskStore.test.ts src/stores/taskQueueStore.test.ts` ✅（5 files / 23 tests passed）
  - `npm run typecheck` ✅
  - `cargo check --lib` ✅
- 下一最小项：继续核验 **Phase 2 任务 F：迁移所有 queue badge / summary 依赖点**，确认 `BottomStatusStrip`、`ActivityBar`、`SidebarContent` 与 `MissionControl` 的 task summary 已全部基于 durable task selectors，而 `taskQueueStore` 仅保留排序与执行控制投影。

#### 任务 F：迁移所有 queue badge / summary 依赖点

当前依赖 `taskQueueStore.queue` 的组件至少包括：

- `src/components/status-strip/BottomStatusStrip.tsx`
- `src/components/workbench/ActivityBar.tsx`
- `src/components/sidebar/view/subcomponents/SidebarContent.tsx`
- `src/components/task-queue/TaskQueuePanel.tsx`

**Phase 2 目标**：

- 这些计数都改为基于 `taskStore.tasks` + status 选择器
- 仅 `autoExecute/maxConcurrent/order` 继续读 `taskQueueStore`

**执行状态（2026-04-21 cron，本轮推进）**：

- 当前所在 phase：**Phase 2**
- 本轮对应计划项：**任务 F：迁移所有 queue badge / summary 依赖点**
- 状态：**已完成（经本轮补测 + 核验）**
- 本轮实现 / 核验结论：
  - `src/components/status-strip/BottomStatusStrip.tsx` 已通过 `taskStore.tasksByProject` + `countRunningDurableTasks/countQueuedDurableTasks` 汇总可见项目任务，不再依赖旧 `taskQueueStore.queue` 计数；仅保留 session runtime 状态作为 attention/session chip 的补充显示。
  - `src/components/workbench/ActivityBar.tsx` 与 `src/components/sidebar/view/subcomponents/SidebarContent.tsx` 当前都基于 `countActiveDurableTasks(Object.values(tasksByProject).flatMap(...))` 计算 Queue badge；`SidebarContent` 打开 queue 视图时也会刷新 `taskStore`，说明徽标与入口状态已经绑定 durable task 真相源，而不是本地 queue task 数组。
  - `src/components/overview/MissionControlView.tsx` 的 task summary / backlog / running / review 统计已持续建立在 durable task + `queueOrder` 投影组合之上；其中 `queueOrder` 仅用于排序投影，不再承担任务数量真相。
  - 本轮新增 `BottomStatusStrip.test.tsx`、`ActivityBar.test.tsx`、`SidebarContent.test.tsx`，补齐此前缺失的 queue badge / summary 回归覆盖；结合既有 `MissionControlView.test.tsx`，当前 Phase 2 任务 F 的四个主要依赖点都已被代码路径与测试闭环核验。
- 验证：
  - `npx vitest run src/components/status-strip/BottomStatusStrip.test.tsx src/components/workbench/ActivityBar.test.tsx src/components/sidebar/view/subcomponents/SidebarContent.test.tsx src/components/overview/MissionControlView.test.tsx` ✅（4 files / 17 tests passed）
  - `npm run typecheck` ✅
- 下一最小项：**Phase 2 任务 A-F 已全部完成**；**phase 完成，Phase 0 / 1 / 2 主执行计划范围已收口完成**。

### 5.4 Phase 2 文件级改造地图

#### Rust / 后端

- `src-tauri/src/tasks.rs`
  - Phase 2 主战场
  - 扩字段、扩状态机、做旧 frontmatter 兼容
- `src-tauri/src/lib.rs`
  - 如果 `task_create/task_update` 参数变更多，更新 invoke handler 对应签名
- `src-tauri/src/ai.rs`
  - 与 dispatcher 的 task binding 对齐；必要时补最小辅助接口
- `src-tauri/src/pty.rs`
  - 保持 runtime source，不写任务业务；但其事件契约要足够让 dispatcher 做状态推进
- `src-tauri/src/git.rs`
  - 本阶段不做大量改造，只保留后续 worktree 兼容接口
- `src-tauri/src/http_server.rs`
  - 评估是否需要同步 task API 形状；若 web fallback 未覆盖 task 扩展字段，应补齐最小兼容

#### 前端主链

- `src/lib/tauri-bridge.ts`
  - Task 类型扩展
  - `tasks.create/update/list/delete` 签名更新
- `src/stores/taskStore.ts`
  - 新建 durable task store
- `src/stores/taskQueueStore.ts`
  - 从任务真相 store 降级为 queue UI state
- `src/hooks/useTaskDispatcher.ts`（或替换 `useAutoExecutor.ts`）
  - 新建/重写
- `src/components/task-queue/TaskQueuePanel.tsx`
  - 改数据源
- `src/components/task-queue/TaskQuickAdd.tsx`
  - 改新增动作
- `src/components/task-queue/TaskQueueItem.tsx`
  - 改渲染模型与操作动作
- `src/components/overview/MissionControlView.tsx`
  - 接入真实 task summary
- `src/App.tsx`
  - 初始化新的 task store / dispatcher
- `src/components/status-strip/BottomStatusStrip.tsx`
  - 改真实 task 计数
- `src/components/workbench/ActivityBar.tsx`
  - 改真实 task 计数
- `src/components/sidebar/view/subcomponents/SidebarContent.tsx`
  - 改真实 task 计数

### 5.5 Phase 2 测试 / 验证清单

#### Rust 侧验证

- [x] 旧 `.openwork/tasks/*.md` 文件可继续读出
- [x] 新字段 frontmatter 可正确 roundtrip
- [x] `task_create` 能写入 `prompt/provider/status` 等新增字段
- [x] `task_update` 支持 patch 更新，不会覆盖未传字段
- [x] `cargo test tasks` 或针对 `src-tauri/src/tasks.rs` 的单元测试覆盖旧/新 schema

#### 前端任务流验证

- [x] `TaskQuickAdd` 新建任务后，Rust tasks 列表能立即刷新显示
- [x] 任务进入 queue/dispatched/in_progress 时，Task Queue UI 状态正确
- [x] 启动 session 后，`task.session_id` 被写回 durable task
- [x] approval 出现时，task 可进入 `PendingApproval`
- [x] 需要 review 的任务可进入 `PendingReview`
- [x] session 失败时，task 可进入 `Failed`
- [x] 取消任务可进入 `Cancelled`

#### UI 聚合验证

- [x] Mission Control 的 task summary 不再依赖旧 `taskQueueStore.queue`
- [x] BottomStatusStrip / ActivityBar / Sidebar queue badge 均基于真实 task 状态
- [x] `taskQueueStore` 仍只控制排序、autoExecute、maxConcurrent 等 UI 行为

#### 命令验证

- [x] `npm run typecheck`
- [x] `cargo check --lib`
- [x] 若条件允许：关键前端测试 + 任务相关 Rust 单测全跑一遍

**执行状态（2026-04-21 cron，本轮核验）**：

- 当前所在 phase：**Phase 2**
- 本轮对应计划项：**Phase 2 测试 / 验证清单 → 命令验证：`cargo check --lib`**
- 状态：**已完成（经本轮核验）**
- 核验结论：
  - 在 `src-tauri/` 目录执行 `cargo check --lib` 已通过，说明当前 Phase 2 收口后的 Rust 任务 schema、Tauri bridge 相关后端接口与前端联动没有引入新的库级编译回归。
  - 本轮仅补做并回写 Phase 2 收口后的最小命令级核验，没有扩展到 Phase 3 / worktree / handoff / loop_runner 范围外改造，符合主执行计划边界。
- 验证：
  - `cargo check --lib` ✅
- 下一最小项：若继续在 **Phase 2 收尾核验** 内推进，下一项应是 **“若条件允许：关键前端测试 + 任务相关 Rust 单测全跑一遍”**；就主执行计划的 Phase 0 / 1 / 2 主线而言，当前仍保持 **phase 完成，Phase 0 / 1 / 2 主执行计划范围已收口完成**。

**执行状态（2026-04-21 cron，本轮推进）**：

- 当前所在 phase：**Phase 2**
- 本轮对应计划项：**Phase 2 测试 / 验证清单 → 若条件允许：关键前端测试 + 任务相关 Rust 单测全跑一遍**
- 状态：**已完成（经本轮核验）**
- 本轮实现 / 核验结论：
  - 已完成一轮 Phase 2 收尾级联合验证：前端关键 control-plane / durable-task 回归测试覆盖 `useSessionStatusTracker`、`taskStore`、`taskQueueStore`、`TaskQueuePanel`、`TaskQueueItem`、`TaskQuickAdd`、`MissionControlView`、`BottomStatusStrip`、`ActivityBar`、`SidebarContent`，确认任务真相源、Queue 投影、Mission Control 汇总与徽标入口在当前分支上仍保持一致。
  - Rust 侧再次执行 `cargo test tasks` 全通过，确认 `src-tauri/src/tasks.rs` 的 Phase 2 durable schema、旧 frontmatter 兼容、execution metadata 归一与 create/update patch 行为在本轮仓库状态下继续成立。
  - 结合本轮 `npm run typecheck` 通过，说明当前 Phase 0 / 1 / 2 收口后的主路径在前后端类型、任务状态机与 UI 聚合层面均完成了额外一轮回归核验；本次推进仅做计划内收尾验证，没有扩展到 Phase 3 或 `handoff.rs` / `loop_runner.rs` 范围外。
- 验证：
  - `npx vitest run src/hooks/useSessionStatusTracker.test.ts src/stores/taskStore.test.ts src/stores/taskQueueStore.test.ts src/components/task-queue/TaskQueuePanel.test.tsx src/components/task-queue/TaskQueueItem.test.tsx src/components/task-queue/TaskQuickAdd.test.tsx src/components/overview/MissionControlView.test.tsx src/components/status-strip/BottomStatusStrip.test.tsx src/components/workbench/ActivityBar.test.tsx src/components/sidebar/view/subcomponents/SidebarContent.test.tsx` ✅（10 files / 44 tests passed）
  - `cargo test tasks` ✅（16 passed）
  - `npm run typecheck` ✅
- 下一最小项：**Phase 2 收尾核验已补齐，phase 完成，Phase 0 / 1 / 2 主执行计划范围已收口完成**。

**执行状态（2026-04-21 cron，本轮推进）**：

- 当前所在 phase：**Phase 2**
- 本轮对应计划项：**Phase 2 测试 / 验证清单回写对齐（补记已完成 checklist）**
- 状态：**已完成（经本轮复核 + 回写）**
- 本轮实现 / 核验结论：
  - 基于本轮重新执行的 Phase 2 收尾联合验证，已将 `5.5 Phase 2 测试 / 验证清单` 中此前仍未勾选、但实际上已由主路径测试覆盖的条目补记为完成，避免“执行状态已写明完成，但 checklist 仍显示未完成”的文档断层。
  - Rust 侧 `cargo test tasks` 继续全通过，覆盖旧任务文件读取、新 frontmatter roundtrip、`task_create/task_update` 扩展字段与 patch 行为；前端关键 durable-task / Mission Control / Queue projection 回归测试与 `npm run typecheck` 也在本轮仓库状态下再次通过。
  - 本轮仅做主执行计划范围内的验证回写与状态收口，没有扩展到 Phase 3 或 `handoff.rs` / `loop_runner.rs` 范围外改造。
- 验证：
  - `npx vitest run src/hooks/useSessionStatusTracker.test.ts src/stores/taskStore.test.ts src/stores/taskQueueStore.test.ts src/components/task-queue/TaskQueuePanel.test.tsx src/components/task-queue/TaskQueueItem.test.tsx src/components/task-queue/TaskQuickAdd.test.tsx src/components/overview/MissionControlView.test.tsx src/components/status-strip/BottomStatusStrip.test.tsx src/components/workbench/ActivityBar.test.tsx src/components/sidebar/view/subcomponents/SidebarContent.test.tsx` ✅（10 files / 44 tests passed）
  - `cargo test tasks` ✅（16 passed）
  - `npm run typecheck` ✅
- 下一最小项：**Phase 2 收尾核验与 checklist 回写已对齐；phase 完成，Phase 0 / 1 / 2 主执行计划范围已收口完成**。

**执行状态（2026-04-21 cron，本轮复核）**：

- 当前所在 phase：**Phase 2（已完成态复核）**
- 本轮对应计划项：**Phase 2 收尾核验 → 最小命令复核（确认 Phase 0 / 1 / 2 无新增回归）**
- 状态：**已完成（经本轮复核）**
- 本轮实现 / 核验结论：
  - 本轮先按主执行计划边界重新检查仓库现状；计划文档顶部 `1.1 当前对齐结论` 与 Phase 0 / 1 / 2 各任务执行状态仍一致指向“本文覆盖范围内已无未完成主项”，未发现需要继续在本计划范围内推进的新子项。
  - 在当前分支仓库状态下再次执行最小必要命令验证：`npm run typecheck` 与 `cargo check --lib` 均通过，说明 Phase 0 / 1 / 2 收口后的 control-plane / durable-task 主路径目前没有新增的前端类型或 Rust 库级编译回归。
  - 由于本轮没有发现新的 Phase 0 / 1 / 2 差距，也没有出现主路径阻塞，因此本轮处理保持在“完成态复核 + 文档同步”范围内，不越界进入 Phase 3 / 4 或推动 `handoff.rs` / `loop_runner.rs` 主路径化。
- 验证：
  - `npm run typecheck` ✅
  - `cargo check --lib` ✅
- 下一最小项：**当前主执行计划范围内无新的未完成项；Phase 0 / 1 / 2 继续保持已收口完成状态。若后续仍需推进，应切换到本文范围外的 Phase 3 / 4 计划，而不是重复改动已完成阶段。**

**执行状态（2026-04-21 12:21 CST cron，本轮复核）**：

- 当前所在 phase：**Phase 2（已完成态复核）**
- 本轮对应计划项：**Phase 0 / 1 / 2 收口后最小命令复核（确认当前分支未对已完成主线引入新回归）**
- 状态：**已完成（经本轮复核）**
- 本轮实现 / 核验结论：
  - 本轮先检查仓库现状与主执行计划，当前分支虽已有较大规模未提交改动，但计划文档顶部 `1.1 当前对齐结论` 与 Phase 0 / 1 / 2 各子项执行状态仍一致指向“本文覆盖范围内已无未完成主项”，因此没有继续在本文范围内新增实现动作。
  - 针对当前工作树重新执行最小必要验证：`npm run typecheck` 与 `cargo check --lib` 继续通过，说明现有未提交改动尚未对 Phase 0 / 1 / 2 已收口的 control-plane / durable-task 主路径引入新的前端类型或 Rust 库级编译回归。
  - 本轮处理保持在主执行计划允许的“完成态复核 + 文档同步”范围内，没有越界进入 Phase 3 / 4，也没有把 `handoff.rs` / `loop_runner.rs` 推入主路径中心。
- 验证：
  - `npm run typecheck` ✅
  - `cargo check --lib` ✅
- 下一最小项：**当前主执行计划范围内仍无新的未完成项；Phase 0 / 1 / 2 继续保持已收口完成状态。若后续继续推进，应切换到本文范围外的 Phase 3 / 4 计划。**

**执行状态（2026-04-21 12:55 CST cron，本轮复核）**：

- 当前所在 phase：**Phase 2（已完成态复核）**
- 本轮对应计划项：**Phase 0 / 1 / 2 收口后最小命令复核（确认当前工作树未对已完成主线引入新回归）**
- 状态：**已完成（经本轮复核）**
- 本轮实现 / 核验结论：
  - 本轮先重新核对主执行计划与仓库现状；计划文档顶部 `1.1 当前对齐结论`、Phase 0 / 1 / 2 各任务执行状态与收尾 checklist 仍一致指向“本文覆盖范围内已无未完成主项”，因此没有在本文范围内新增实现动作。
  - 针对当前工作树再次执行最小必要命令验证：`npm run typecheck` 与 `cargo check --lib` 均继续通过，说明现有未提交改动尚未对已收口的 control-plane / durable-task 主路径引入新的 TypeScript 类型或 Rust 库级编译回归。
  - 本轮处理保持在主执行计划允许的“完成态复核 + 文档同步”范围内，没有越界进入 Phase 3 / 4，也没有把 `handoff.rs` / `loop_runner.rs` 推入主路径中心。
- 验证：
  - `npm run typecheck` ✅
  - `cargo check --lib` ✅
- 下一最小项：**当前主执行计划范围内仍无新的未完成项；Phase 0 / 1 / 2 继续保持已收口完成状态。若后续继续推进，应切换到本文范围外的 Phase 3 / 4 计划。**

**执行状态（2026-04-21 13:44 CST cron，本轮复核）**：

- 当前所在 phase：**Phase 2（已完成态复核）**
- 本轮对应计划项：**Phase 0 / 1 / 2 收口后最小命令复核（确认当前工作树未对已完成主线引入新回归）**
- 状态：**已完成（经本轮复核）**
- 本轮实现 / 核验结论：
  - 本轮先重新核对主执行计划、当前分支与工作树状态；计划文档顶部 `1.1 当前对齐结论`、Phase 0 / 1 / 2 各子项执行状态与收尾 checklist 仍一致指向“本文覆盖范围内已无未完成主项”，因此没有在本文范围内新增实现动作。
  - 针对当前工作树再次执行最小必要命令验证：`npm run typecheck` 与 `cargo check --lib` 均继续通过，说明现有未提交改动尚未对已收口的 control-plane / durable-task 主路径引入新的 TypeScript 类型或 Rust 库级编译回归。
  - 本轮处理保持在主执行计划允许的“完成态复核 + 文档同步”范围内，没有越界进入 Phase 3 / 4，也没有把 `handoff.rs` / `loop_runner.rs` 推入主路径中心。
- 验证：
  - `npm run typecheck` ✅
  - `cargo check --lib` ✅
- 下一最小项：**当前主执行计划范围内仍无新的未完成项；Phase 0 / 1 / 2 继续保持已收口完成状态。若后续继续推进，应切换到本文范围外的 Phase 3 / 4 计划。**

### 5.6 Phase 2 风险点

- `src-tauri/src/tasks.rs` 是最高风险 durable schema 文件：一旦兼容处理不稳，会直接影响已有项目内任务文件读取。
- `src/lib/tauri-bridge.ts` 是前后端模型耦合层：Task 类型变化后容易出现 TS 静态类型通过但运行 payload 不一致。
- `src/components/task-queue/TaskQueuePanel.tsx` 看似简单，但其上下游包含 quick add、retry、cancel、计数条、sidebar badge，迁移时最容易漏引用点。
- `src/hooks/useAutoExecutor.ts` 改 dispatcher 后，如果初始化时机不对，可能造成重复调度或在刷新后重复 claim。
- `src/components/status-strip/BottomStatusStrip.tsx`、`ActivityBar.tsx`、`SidebarContent.tsx` 都是“看起来只是徽标，实际是用户感知系统状态入口”的兼容层，不能漏改。

---

## 6. 分阶段文件变更总表

### 6.1 Phase 0

**主要修改**

- `src/hooks/useAutoExecutor.ts`
- `src/contexts/TauriEventContext.tsx`
- `src/components/main-content/view/subcomponents/MainContentTitle.tsx`
- `src/components/task-queue/TaskQueuePanel.tsx`
- `src/stores/taskQueueStore.ts`
- `src/stores/sessionStatusStore.ts`
- `src/types/app.ts`
- `src/i18n/locales/*/settings.json`（仅必要文案/标注）

**尽量不动**

- `src-tauri/src/pty.rs`
- `src-tauri/src/tasks.rs`
- `src-tauri/src/http_server.rs`

### 6.2 Phase 1

**主要修改**

- `src/stores/attentionStore.ts`（新建）
- `src/stores/sessionStatusStore.ts`
- `src/hooks/useSessionStatusTracker.ts`
- `src/hooks/useAttentionRouter.ts`
- `src/components/overview/MissionControlView.tsx`
- `src/components/live-grid/view/LiveGridView.tsx`
- `src/components/live-grid/view/LiveCard.tsx`
- `src/components/chat/hooks/useChatPanel.ts`
- `src/App.tsx`
- `src/lib/tauri-bridge.ts`（如需补 attention/approval 类型）

**尽量不动**

- `src-tauri/src/tasks.rs`（Phase 1 不做 schema 主改）
- `src-tauri/src/git.rs`
- `src-tauri/src/handoff.rs`
- `src-tauri/src/loop_runner.rs`

### 6.3 Phase 2

**主要修改**

- `src-tauri/src/tasks.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/ai.rs`
- `src/lib/tauri-bridge.ts`
- `src/stores/taskStore.ts`（新建）
- `src/stores/taskQueueStore.ts`
- `src/hooks/useTaskDispatcher.ts`（新建或替换 `useAutoExecutor.ts`）
- `src/components/task-queue/TaskQueuePanel.tsx`
- `src/components/task-queue/TaskQuickAdd.tsx`
- `src/components/task-queue/TaskQueueItem.tsx`
- `src/components/overview/MissionControlView.tsx`
- `src/components/status-strip/BottomStatusStrip.tsx`
- `src/components/workbench/ActivityBar.tsx`
- `src/components/sidebar/view/subcomponents/SidebarContent.tsx`
- `src/App.tsx`

**尽量不动**

- `src-tauri/src/pty.rs`（除事件契约微调外）
- `src-tauri/src/git.rs`（worktree 仅保留后续接口）
- `src-tauri/src/http_server.rs`（除 task API 兼容必要补丁外）
- `src/components/live-grid/view/LiveGridView.tsx`（本阶段不是主战场）

---

## 7. 风险、兼容层与回滚说明

### 7.1 高风险文件

1. `src/contexts/TauriEventContext.tsx`
   - provider dispatch、PTY 映射、消息归一化都在这里
2. `src/components/chat/hooks/useChatPanel.ts`
   - approval、session 切换、消息流、UI phase 全耦合
3. `src-tauri/src/tasks.rs`
   - durable schema 与旧任务文件兼容风险最高
4. `src/stores/taskQueueStore.ts`
   - 看似 store，实际被多个 badge / panel / hook 间接依赖
5. `src/hooks/useAutoExecutor.ts`
   - 当前 bug 根源所在，也是 Phase 2 dispatcher 迁移落点

### 7.2 关键兼容层

#### 兼容层 A：queue 兼容期

在 Phase 2 前后，需要允许以下过渡：

- UI 仍可读 `taskQueueStore.autoExecute/maxConcurrent/order`
- 但任务本体逐步全部改读 `taskStore` / Rust tasks

#### 兼容层 B：approval 兼容期

在 Phase 1 期间：

- `sessionStatusStore.pendingPermissions` 可保留短期镜像/桥接
- 但新写入口与主读入口必须迁到 `attentionStore`

#### 兼容层 C：旧任务文件兼容

在 `src-tauri/src/tasks.rs` 扩 schema 时：

- 必须兼容旧 frontmatter
- 不允许因为字段缺失导致旧任务文件整体不可读

### 7.3 回滚策略

#### Phase 0 回滚

- 如果 `useAutoExecutor.ts` 的 session 绑定修复引发 dispatch 回归：
  - 回滚到旧发送路径
  - 但保留 TaskMaster 文案清理
- 回滚成本低

#### Phase 1 回滚

- 如果新 `attentionStore` 引发 chat/live-grid 失配：
  - 保留新 Mission Control UI 壳
  - 回退 approval 实际数据源到 `sessionStatusStore.pendingPermissions` 镜像
- 不建议一次性删除旧字段，需至少保留一个版本的兼容桥

#### Phase 2 回滚

- 如果新 task schema 或 dispatcher 引发主链不稳定：
  - 先保留 Rust schema 扩展，但回退 Task Queue UI 到旧 `taskQueueStore` 渲染
  - 或让 `TaskQuickAdd` 暂时双写（仅短期应急，不作为正式方案）
- 不建议回滚 `.openwork/tasks/*.md` 文件格式；应优先通过兼容解析修复

---

## 8. 当前阶段明确保持不动 / 暂不推进的内容

### 8.1 暂不触碰

- `src-tauri/src/handoff.rs` 主路径化
- `src-tauri/src/loop_runner.rs` 主路径化
- PTY kernel 大改：`src-tauri/src/pty.rs`
- Git review/结果回收复杂逻辑：`src-tauri/src/git.rs`
- 数据库任务持久化迁移
- worktree-aware dispatcher 完整实现
- Mission Control / Live Grid 整体视觉大重构

### 8.2 暂不删除

- `AppTab = 'tasks'` 技术字段
- `taskQueueStore.ts` 文件本身
- `sessionStatusStore` 基础状态投影
- Live Grid 中的 inline permission 交互能力

### 8.3 暂不承诺

- Cursor provider 的完整 approval 对称支持
- review queue 完整闭环
- 远程/LAN 模式下 task/attention 所有接口一次性齐平

---

## 9. 建议的执行顺序

### Phase 0（1 个短迭代）

1. 修 `useAutoExecutor.ts` session 绑定 bug
2. 处理 `MainContentTitle.tsx` 等主路径 TaskMaster 文案
3. 给 queue/session store 补迁移注释和边界说明
4. 跑 typecheck + 关键回归

### Phase 1（1~2 个迭代）

1. 新建 `attentionStore.ts`
2. `useSessionStatusTracker.ts` 接 attention/approval 归一化
3. `sessionStatusStore.ts` 迁出 `pendingPermissions`
4. Mission Control 增加 Approval/Attention 区块
5. LiveCard / ChatPanel 改走新 approval action
6. 降级 `useAttentionRouter.ts`
7. 跑 attention/approval 回归

### Phase 2（2 个迭代，分两步）

**Step A：后端 schema + bridge**

1. 扩 `src-tauri/src/tasks.rs`
2. 补 `tauri-bridge.ts` Task 类型
3. 完成旧 task frontmatter 兼容测试

**Step B：前端迁移**

4. 新建 `taskStore.ts`
5. `TaskQuickAdd` 改写入 Rust tasks
6. `TaskQueuePanel` 改读取 durable tasks
7. `useAutoExecutor.ts` 重写为 dispatcher
8. 徽标/计数组件切到 taskStore
9. 清理 queue 兼容字段

---

## 10. 一句话执行建议

**先在 Phase 0 修掉 queue→session 断链和旧叙事污染；随后用 Phase 1 把 Attention/Approval 真正放进 Mission Control；最后在 Phase 2 以 `src-tauri/src/tasks.rs` 为唯一任务真相，完成前端 queue/store 的降级迁移。**

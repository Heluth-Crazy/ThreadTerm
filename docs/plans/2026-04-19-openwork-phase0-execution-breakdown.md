# OpenWork Phase 0 执行拆解（供后续 Codex 直接实施）

> 日期：2026-04-19  
> 适用范围：**仅 Phase 0**  
> 依据文档优先级：
> 1. `docs/plans/2026-04-19-openwork-control-plane-iteration-plan.md`
> 2. `docs/plans/2026-04-19-openwork-final-architecture-v2.md`
> 3. `docs/plans/2026-04-19-openwork-phase0-1-2-implementation-plan.md`
>
> 本文不是新的策略文档，而是**后续由 Codex 执行实现时的具体施工清单**。目标是先完成控制平面改造前的去噪和阻塞项清理，不提前进入 Phase 1 / 2 的结构性改造。

---

## 1. Phase 0 goal

Phase 0 的唯一目标是：**为 control-plane 主线清障，而不是开始实现 control plane 本身。**

结合当前代码现实，Phase 0 只做三件事：

1. **清理主线可见的旧叙事污染**，尤其是 TaskMaster 命名对当前 Tauri 控制平面方向的误导。
2. **修复当前 task queue auto-execute 的 session 绑定断链问题**，让“queue task → session → 完成回写”这条兼容链路至少可信。
3. **标注 Phase 1 / 2 的兼容层和冻结区**，避免后续 Codex 在错误文件上提前做大改。

当前代码复核后，Phase 0 的直接现实依据如下：

- `src/hooks/useAutoExecutor.ts` 当前在发送成功后只调用 `markRunning(task.id)`，**没有写入 `sessionId`**。
- 同文件后续又通过 `t.sessionId === sessionId` 查找 running task 并回写 done，导致链路天然失配。
- `src/contexts/TauriEventContext.tsx` 的 `sendMessage()` 目前只返回 `boolean`，内部异步生成/使用 session id，但**没有把可追踪的 session identity 返回给 auto executor**。
- `src/components/main-content/view/subcomponents/MainContentTitle.tsx` 在 `tasks` tab 上仍直接显示 `TaskMaster`。
- `src/App.tsx` 已经没有 `TaskMasterProvider` / `TasksSettingsProvider`，但 `CLAUDE.md` 仍保留旧说法，说明**文档和代码现实已经分叉**。
- `README.md`、`docs/current-version-defects-2026-04-12.md` 也确认仓库仍存在 TaskMaster / Node/Electron 旧叙事残留。

---

## 2. Success criteria

后续 Codex 完成 Phase 0 后，必须同时满足以下成功标准：

### 2.1 任务链路成功标准

- [ ] `Task Queue` 的手动触发和 `autoExecute` 仍可正常发起任务。
- [ ] 任一进入 `running` 的 queue item 都必须带有可追踪的 `sessionId`。
- [ ] 当 session 从 `processing` 转为 `completed` / `idle` 时，对应 queue item 能正确转为 `done`。
- [ ] 不再依赖“`sendMessage() === true` 就等于完整 dispatch 成功”的错误假设。

### 2.2 命名/语义成功标准

- [ ] 主界面标题不再出现 `TaskMaster` 作为当前主线能力名称。
- [ ] `AppTab = 'tasks'` 暂时保留，不做破坏性技术字段重命名。
- [ ] 面向用户和面向实现者最容易误导的文案，统一改为 `Task Queue` / `Tasks` / `legacy integration` 语义。

### 2.3 边界控制成功标准

- [ ] `src/stores/taskQueueStore.ts` 被明确标记为**过渡期 queue UI / runtime projection**，不是长期任务真相。
- [ ] `src/stores/sessionStatusStore.ts` 被明确标记 `pendingPermissions` 后续会迁出。
- [ ] `src/hooks/useAttentionRouter.ts` 被明确标记为会在 Phase 1 降级，不再被误当成最终注意力入口。
- [ ] `src-tauri/src/tasks.rs` 在 Phase 0 **不改 schema**，只允许补注释/边界说明。

---

## 3. Ordered execution tasks

> 下面顺序就是后续 Codex 应执行的顺序。不要并行乱改高风险文件。

### Task 0.1：先做基线确认，不写逻辑

**目的**：在动手前先确认当前断点与影响面，避免误改。

**Codex 执行动作**：

- [ ] 复读以下文件并确认现实没有偏差：
  - `src/hooks/useAutoExecutor.ts`
  - `src/contexts/TauriEventContext.tsx`
  - `src/stores/taskQueueStore.ts`
  - `src/stores/sessionStatusStore.ts`
  - `src/components/main-content/view/subcomponents/MainContentTitle.tsx`
  - `src/App.tsx`
- [ ] 记录当前 `sendMessage()` 的三类行为差异：
  - Claude 分支：内部生成 `claudeSid`
  - Codex 分支：内部生成 `codexSid`
  - 其它 provider 分支：依赖外部传入 `sid`
- [ ] 明确本阶段不能把 `sendMessage()` 全面重写成新 dispatcher；只允许补最小兼容能力。

**完成判断**：Codex 在开始改代码前，应能明确说明：Phase 0 只修补 session identity 传递，不引入新的任务系统。

---

### Task 0.2：先清掉主线最明显的 TaskMaster 命名误导

**目标**：先处理最显眼、最会误导后续实现的主线文案；不做全仓重命名。

**必须改的文件**：

- `src/components/main-content/view/subcomponents/MainContentTitle.tsx`
- `src/components/task-queue/TaskQueuePanel.tsx`（如需要补过渡说明）
- `src/components/workbench/ActivityBar.tsx`（仅检查，不一定需要改）
- `src/components/sidebar/view/subcomponents/SidebarContent.tsx`（仅检查，不一定需要改）
- `src/types/app.ts`（仅保留技术兼容，不做 tab id 重命名）

**Codex 执行清单**：

- [ ] 将 `MainContentTitle.tsx` 中 `TaskMaster` 改为 `Task Queue` 或 `Tasks`。
- [ ] 不修改 `AppTab` 中的 `'tasks'` 值；仅在注释中说明这是历史兼容 tab id。
- [ ] 检查 `ActivityBar.tsx` 与 `SidebarContent.tsx` 是否已有中性命名；若无误导则不改逻辑。
- [ ] 如 `TaskQueuePanel.tsx` 需要增加一行过渡说明，只允许说明“当前为 queue 兼容层”，不要引入 Phase 2 的新 UI 结构。

**不要做**：

- [ ] 不批量重命名所有 `tasks` / `TaskMaster` 类型名。
- [ ] 不删除 `src/components/main-content/types/types.ts` 中 legacy `TaskMaster*` 类型。
- [ ] 不调整 workbench 路由、tab 切换、sidebar 结构。

---

### Task 0.3：修复 auto-execute 的 session 绑定断链（本阶段核心任务）

**目标**：让 queue 兼容路径在“开始运行时”就拿到明确 `sessionId`，后续完成事件能回写到正确 task。

**直接问题定位**：

- `src/hooks/useAutoExecutor.ts:22-35`
  - 当前通过 `sendMessage({...})` 发消息
  - 发送成功后只 `markRunning(task.id)`
- `src/hooks/useAutoExecutor.ts:58-63`
  - 依赖 `t.sessionId === sessionId` 查找 running task
- `src/contexts/TauriEventContext.tsx:426-557`
  - `sendMessage()` 对 Claude/Codex 在内部生成 sid，但不返回 sid

**推荐实施方式（优先级从高到低）**：

#### 方案 A（Phase 0 首选）
在 `useAutoExecutor.ts` 中显式生成 `sessionId`，并把它塞进 `sendMessage(...options.sessionId)`。

**执行清单**：

- [ ] 在 `executeTask(task)` 内按 provider 生成稳定的过渡 session id：
  - Claude：`claude-...`
  - Codex：`codex-...`
  - 其它 provider：沿用 provider 前缀
- [ ] 调用 `sendMessage()` 时显式传入：
  - `options.sessionId`
  - `options.projectPath`
  - `options.provider`
- [ ] 在 `sendMessage()` 返回成功后，调用 `taskQueue.markRunning(task.id, generatedSessionId)`。
- [ ] 若发送失败，仍走 `markFailed(task.id, ...)`。
- [ ] 保持 `claimNext()` 当前机制不大改，只修通 identity 绑定。

#### 方案 B（仅在 A 行不通时采用）
给 `TauriEventContext.sendMessage()` 增加一个最小结构化返回，例如 `{ ok, sessionId }`，再让 `useAutoExecutor()` 消费它。

**限制**：

- [ ] 只有当方案 A 无法与现有调用方兼容时，才允许改 `sendMessage()` 签名。
- [ ] 一旦改签名，必须全局检查所有 `useWebSocket().sendMessage` 调用点，避免误伤 chat 主路径。

**Phase 0 推荐结论**：

优先采用 **方案 A**，因为它对 `TauriEventContext.tsx` 的侵入最小，且符合“只修兼容链路，不提前做 dispatcher 重构”的约束。

---

### Task 0.4：为 queue/store/status 层补迁移边界注释

**目标**：让后续 Codex 在 Phase 1 / 2 有明确施工边界，不再把过渡层当主架构。

**必须处理的文件**：

- `src/stores/taskQueueStore.ts`
- `src/stores/sessionStatusStore.ts`
- `src/hooks/useAttentionRouter.ts`
- `src-tauri/src/tasks.rs`
- 可选：`src/hooks/useAutoExecutor.ts`

**Codex 执行清单**：

- [ ] 在 `taskQueueStore.ts` 顶部补注释：说明该 store 是当前 queue UI / 兼容运行态，不是未来 durable task truth。
- [ ] 在 `sessionStatusStore.ts` 顶部或 `pendingPermissions` 定义附近补注释：说明该字段将在 Phase 1 迁出至 attention / approval store。
- [ ] 在 `useAttentionRouter.ts` 注释中标出：当前是“进入 needs_attention 时聚焦 Live Grid”的过渡实现，Phase 1 将降级为辅助跳转。
- [ ] 在 `src-tauri/src/tasks.rs` 顶部补注释：Phase 0 不扩 schema，后续 Phase 2 才提升为 control-plane 主任务真相。
- [ ] 如有必要，在 `useAutoExecutor.ts` 注释中标记：当前逻辑是 queue compatibility auto-runner，不是正式 dispatcher。

**不要做**：

- [ ] 不新增 `attentionStore.ts`
- [ ] 不迁移 `pendingPermissions`
- [ ] 不改 `tasks.rs` frontmatter 字段
- [ ] 不引入 `taskViewStore` / `sessionRegistryStore`

---

### Task 0.5：收口 README / CLAUDE / i18n 的处理范围

**目标**：只处理会继续误导本阶段实现的最小文档/文案，不把 Phase 0 扩张成文档清仓。

**建议处理方式**：

- [ ] **本次实现文件可只写执行拆解，不强制同步改 README/CLAUDE。**
- [ ] 如果 Codex 顺手改文档，优先级只允许：
  - 标注 `CLAUDE.md` 的 provider 树已过时
  - 标注 README 中 TaskMaster 为 legacy、非当前 Tauri 主线
- [ ] i18n 的 `settings.json` 中 TaskMaster 文案，本阶段仅建议标记 legacy，不要求完成完整多语言体验统一。

**推荐结论**：

除非命名误导直接影响当前 UI 可见路径，否则 README / CLAUDE / i18n 在 Phase 0 **只记录，不展开清理战线**。

---

### Task 0.6：补最小测试与回归验证

**目标**：证明 Phase 0 修复的是兼容链路，不是引入新的状态回归。

**Codex 执行清单**：

- [ ] 新增 `src/hooks/useAutoExecutor.test.ts`，至少覆盖：
  - claim 后 dispatch 成功会写入 `sessionId`
  - session 完成后能把对应 running task 标为 `done`
  - dispatch 失败会把 task 标为 `failed`
- [ ] 如 `useSessionStatusTracker` 或 `sessionStatusStore` 的现有测试因注释/轻微行为改动受影响，做最小必要更新：
  - `src/hooks/useSessionStatusTracker.test.ts`
  - `src/stores/sessionStatusStore.test.ts`
- [ ] 不为 Phase 0 新建 UI E2E；以 hook/store 单测 + typecheck 为主。

---

## 4. File-by-file change list

> 下面是后续 Codex 实施时可直接对照的文件级清单。

### 4.1 必改文件

#### `src/hooks/useAutoExecutor.ts`

**改动目标**：修复 queue task 与 session 的绑定断链。

**必须修改**：

- [ ] 在 dispatch 前生成或确定 session id。
- [ ] 把 session id 显式传入 `sendMessage(...options.sessionId)`。
- [ ] `markRunning(task.id, sessionId)` 必须写入 session id。
- [ ] 保持现有 `triggerNext()` / subscribe 框架，不做大重构。

**风险说明**：高风险。该文件通过 store 静态读取 + subscribe 驱动自动执行，容易引入重复 dispatch、状态竞争或完成态误判。

---

#### `src/components/main-content/view/subcomponents/MainContentTitle.tsx`

**改动目标**：去掉主路径 `TaskMaster` 文案污染。

**必须修改**：

- [ ] `tasks` tab 标题改为 `Task Queue` 或 `Tasks`。

**风险说明**：低风险。纯展示改动，但会影响 screenshot/视觉回归预期。

---

#### `src/stores/taskQueueStore.ts`

**改动目标**：补 Phase 0 迁移边界说明；必要时配合 `markRunning` 调整调用注释。

**允许修改**：

- [ ] 顶部注释说明该 store 是 runtime projection / queue compatibility。
- [ ] 如需要，补 `markRunning(id, sessionId?)` 的注释，强调 session id 不能再为空进入 running 主路径。

**不要修改**：

- [ ] 不改持久化 key
- [ ] 不改数据结构为 Rust tasks 投影
- [ ] 不新增 task 真相层字段

**风险说明**：中高风险。很多 badge / count / sidebar / queue 面板都依赖这个 store。

---

#### `src/stores/sessionStatusStore.ts`

**改动目标**：只补边界注释，不做 attention 架构迁移。

**允许修改**：

- [ ] 标注 `pendingPermissions` 为待迁出字段。
- [ ] 如需要，加注释说明当前 store 仍是 runtime session projection。

**不要修改**：

- [ ] 不拆出新 store
- [ ] 不改持久化行为
- [ ] 不重写状态机

**风险说明**：中高风险。`useSessionStatusTracker`、attention 标记、sidebar 红点、auto-executor 都依赖它。

---

#### `src/hooks/useAttentionRouter.ts`

**改动目标**：只补“过渡实现”注释。

**允许修改**：

- [ ] 注释说明该 hook 将在 Phase 1 降级为辅助导航，不是 control-plane 主入口。

**不要修改**：

- [ ] 不重写行为
- [ ] 不引入新的 attention center

**风险说明**：低风险，但容易被误改成 Phase 1 工作，必须收口。

---

#### `src/types/app.ts`

**改动目标**：明确技术兼容，不做结构重命名。

**允许修改**：

- [ ] 可加注释说明 `AppTab = 'tasks'` 目前为历史兼容 id。

**不要修改**：

- [ ] 不把 `'tasks'` 改成 `'queue'`
- [ ] 不改全局 tab 分发逻辑

**风险说明**：中风险。这里一旦改 enum/union，会触发跨组件联动。

---

### 4.2 谨慎可改文件

#### `src/contexts/TauriEventContext.tsx`

**改动目标**：仅在 `useAutoExecutor.ts` 无法靠显式 `sessionId` 方案修复时，提供最小兼容支持。

**允许修改**：

- [ ] 仅限补最小 session identity 传递辅助。
- [ ] 不得顺手重构整个 `sendMessage()` 接口。

**绝对不要做**：

- [ ] 不把它改成新的 dispatcher 中心
- [ ] 不重写 PTY 事件解析
- [ ] 不改 chat message buffer 行为
- [ ] 不改 Codex / Claude resume 逻辑

**风险说明**：最高风险。该文件同时承担 provider dispatch、PTY 输出归一、session 创建映射、通知与 loop 状态监听。

---

#### `src/components/task-queue/TaskQueuePanel.tsx`

**改动目标**：如需要，只做最小文案/提示层修正。

**允许修改**：

- [ ] 可补过渡说明文字
- [ ] 可微调标题措辞

**不要修改**：

- [ ] 不改 queue 面板结构
- [ ] 不接 Rust tasks
- [ ] 不实现 dispatch controls 重构

**风险说明**：低到中风险，主要是避免把 Phase 2 需求提前塞进来。

---

#### `src-tauri/src/tasks.rs`

**改动目标**：只补边界注释。

**允许修改**：

- [ ] 顶部注释说明：这是当前 durable task 雏形，Phase 2 才会扩 schema 并成为主任务真相。

**不要修改**：

- [ ] 不扩 `Task` 字段
- [ ] 不改 frontmatter 格式
- [ ] 不改 `task_list/task_create/task_update/task_delete` 行为

**风险说明**：高风险。它是未来任务统一的核心文件，但 Phase 0 不能抢跑。

---

### 4.3 只读参考文件

以下文件在 Phase 0 只用于理解现实，不建议进入实现改动：

- `src/App.tsx`
- `CLAUDE.md`
- `README.md`
- `docs/current-version-defects-2026-04-12.md`
- `docs/plans/2026-04-19-openwork-control-plane-iteration-plan.md`
- `docs/plans/2026-04-19-openwork-final-architecture-v2.md`
- `docs/plans/2026-04-19-openwork-phase0-1-2-implementation-plan.md`

---

## 5. Validation checklist

> 下面命令是后续 Codex 实施完成后应实际运行的验证项。

### 5.1 必跑命令

在仓库根目录 `/Users/demo6598qq.com/Desktop/project/OpenWork`：

```bash
npm run typecheck
npx vitest run src/hooks/useAutoExecutor.test.ts src/hooks/useSessionStatusTracker.test.ts src/stores/sessionStatusStore.test.ts
```

在 `src-tauri/` 目录：

```bash
cargo check --lib
```

### 5.2 手工验证

- [ ] 打开任意项目，在 Queue 中添加 1 个 Claude 任务，手动触发执行。
- [ ] 确认该 task 进入 `running` 后，store 中存在 `sessionId`。
- [ ] 等待该 session 完成，确认 queue item 转为 `done`。
- [ ] 对 Codex provider 重复一次相同验证。
- [ ] 打开主内容区 tasks tab，确认标题不再显示 `TaskMaster`。
- [ ] 检查 Sidebar / ActivityBar 的 queue 计数仍正常显示。

### 5.3 回归观察点

- [ ] Chat 正常发消息，不因 `sessionId` 兼容修改而失效。
- [ ] Claude session resume 不被破坏。
- [ ] Codex thread id 恢复逻辑不被破坏。
- [ ] `needs_attention` 红点与 queue 面板没有明显回归。

---

## 6. Do-not-touch-yet list

> 以下内容虽然与 control-plane 方向相关，但**不是 Phase 0 要做的事**。

- [ ] 不新建 `Attention Inbox` / `Approval Inbox`
- [ ] 不新增 `src/stores/attentionStore.ts`
- [ ] 不迁移 `pendingPermissions` 出 `sessionStatusStore.ts`
- [ ] 不改 `MissionControlView.tsx` 为三栏控制塔
- [ ] 不把 `taskQueueStore.ts` 接到 `src-tauri/src/tasks.rs`
- [ ] 不扩 `src-tauri/src/tasks.rs` schema
- [ ] 不实现 task/session/worktree 正式绑定模型
- [ ] 不产品化 `handoff.rs`
- [ ] 不把 `loop_runner.rs` 拉进主路径
- [ ] 不重构 `TauriEventContext.tsx` 为统一 orchestration layer
- [ ] 不做全仓 TaskMaster 清理
- [ ] 不启动 README / i18n / settings 全量叙事翻修

---

## 7. Suggested commit boundaries

> 建议后续 Codex 按下面边界提交，方便回滚与 review。

### Commit 1：`docs(phase0): annotate queue/session compatibility boundaries`

**包含内容**：

- `src/stores/taskQueueStore.ts`
- `src/stores/sessionStatusStore.ts`
- `src/hooks/useAttentionRouter.ts`
- `src-tauri/src/tasks.rs`
- 可选：`src/types/app.ts`

**目的**：先把边界写清楚，不混入行为改动。

---

### Commit 2：`fix(queue): bind auto-executed tasks to session ids`

**包含内容**：

- `src/hooks/useAutoExecutor.ts`
- 仅在必要时包含：`src/contexts/TauriEventContext.tsx`

**目的**：单独修复 session 绑定断链，便于独立回归。

---

### Commit 3：`chore(ui): remove visible TaskMaster naming from task queue path`

**包含内容**：

- `src/components/main-content/view/subcomponents/MainContentTitle.tsx`
- 可选：`src/components/task-queue/TaskQueuePanel.tsx`
- 可选：`src/types/app.ts`

**目的**：单独审查 UI 命名去噪，不与行为修复混在一起。

---

### Commit 4：`test(queue): cover auto executor session binding`

**包含内容**：

- `src/hooks/useAutoExecutor.test.ts`
- 如必要：
  - `src/hooks/useSessionStatusTracker.test.ts`
  - `src/stores/sessionStatusStore.test.ts`

**目的**：证明 Phase 0 修的是兼容链路，不是靠手工验证碰运气。

---

## 附：给后续 Codex 的执行提醒

1. **先做注释边界，再修行为，再改文案，再补测试。**
2. **`src/contexts/TauriEventContext.tsx` 没有必要就不要碰。**
3. **Phase 0 结束标准不是“看起来更整洁”，而是 queue → session → done 这条兼容链路可信。**
4. **任何会把工作带入 Attention Center、任务统一、Mission Control 重构的改动，都应推迟到 Phase 1 / 2。**

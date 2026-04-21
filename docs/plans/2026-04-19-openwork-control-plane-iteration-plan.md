# OpenWork 产品迭代方案（基于现有能力，不从 0 开始）

> **目标**：把 OpenWork 从“能管理和打开多个 AI 会话的桌面壳”迭代成“多 Agent AI 编程控制台 / Mission Control”。
>
> **原则**：不推翻现有 Tauri + Rust + React 主线；优先复用已经存在的 PTY、状态追踪、Live Grid、Worktree、Handoff、Loop、HTTP/WS 能力；先补控制层，再谈更重的自动编排。

---

## 一、这次看代码后的核心判断

OpenWork 不是从 0 开始，相反，它已经有一批很像“控制台前身”的东西：

### 已有基础能力（可直接复用）
1. **多 Provider 会话执行层已经有了**
   - Rust 后端可以拉起 Claude / Codex / Cursor CLI 会话
   - 入口：`src-tauri/src/ai.rs`
   - PTY 基础设施：`src-tauri/src/pty.rs`

2. **实时状态 / 注意力信号已经有了雏形**
   - `session-state-changed`
   - `attention-required`
   - 前端状态仓：`src/stores/sessionStatusStore.ts`
   - 状态追踪：`src/hooks/useSessionStatusTracker.ts`

3. **Mission Control / Live Grid 已经不是概念，而是现成入口**
   - 总览页：`src/components/overview/MissionControlView.tsx`
   - 多会话网格：`src/components/live-grid/view/LiveGridView.tsx`
   - 多会话派发：`src/hooks/useMultiSessionDispatcher.ts`

4. **Worktree 能力已经有相当基础**
   - Rust git worktree API：`src-tauri/src/git.rs`
   - bridge：`src/lib/tauri-bridge.ts`
   - Live Grid 已开始接 worktree：`src/components/live-grid/view/CardGrid.tsx`
   - Project overview 也有 worktree 语义：`src/components/workbench/projects/SelectedProjectOverviewPage.tsx`

5. **跨会话 handoff 已经存在**
   - `src-tauri/src/handoff.rs`
   - 说明产品已经不是单一 session 思维，而是开始往 agent 协作迁移

6. **Loop / worker-verifier 原型已经有了**
   - `src-tauri/src/loop_runner.rs`
   - 这很接近“调度 / 自动化执行”的前身

7. **HTTP/WS fallback 已经打底**
   - `src-tauri/src/http_server.rs`
   - 这意味着后续如果做本地 Web 控制台、移动审批面板，不需要重新造通信层

---

## 二、但现在最大的断点也很明确

### 断点 1：有“状态”，没有“统一处理入口”
现在能知道某个 session `needs_attention`，但还没有真正的：
- 全局审批收件箱
- Attention 队列
- 风险优先级
- 一键跳转到上下文

**结果**：状态是分散可见的，但不是集中可操作的。

---

### 断点 2：有“任务队列 UI”，没有“统一任务模型”
现在同时存在两套任务语义：

#### A. 前端本地 queue（当前真的在跑）
- `src/stores/taskQueueStore.ts`
- `src/components/task-queue/TaskQueuePanel.tsx`
- `src/hooks/useAutoExecutor.ts`

特点：
- Zustand 本地持久化
- 更像 prompt 队列 / execution queue
- UI 已经接上了
- 但只是前端本地状态，不是系统级任务模型

#### B. Rust 后端 tasks（更像正式任务系统）
- `src-tauri/src/tasks.rs`
- `tauri-bridge.ts` 已有 `task_list/task_create/task_update/task_delete`

特点：
- 已有持久化任务文件模型
- 但前端主路径几乎没真正接起来
- 跟当前 queue 是割裂的

**这是当前最重要的产品/架构分叉点。**

---

### 断点 3：Mission Control 更像“会话总览”，还不是“控制塔”
当前 `MissionControlView.tsx` 做的是：
- flatten sessions
- 按 `needs_attention / processing / completed / idle` 排序
- 显示 session card

这很好，但它现在还是：
> “会话列表页”

还不是：
> “统一审批 + 任务调度 + 结果回收”的控制中心

---

### 断点 4：状态语义还偏“推测”，不是严格工作流状态机
在 `pty.rs` 里，waiting / attention 目前很多是通过：
- 正则匹配 `permission / approve / allow / press enter`
- 错误关键字匹配
- PTY 输出 heuristics

这在 MVP 阶段合理，但如果 OpenWork 要变成真正的控制台，这套状态必须逐步升级为：
- provider-aware
- action-aware
- request-aware
- durable

否则审批、通知、统计、自动调度都会越来越不准。

---

### 断点 5：仓库里确实还有旧叙事 / 旧壳 / 半迁移状态
这次看下来，确实有你说的“代码里可能有旧代码”这个问题，而且不是一点点：

1. **文档层旧叙事还很多**
   - `README.md` / 多语言 README 还大量写 TaskMaster
   - 但 README 自己又说 Tauri 版不包含 TaskMaster

2. **CLAUDE.md 已经过时**
   - 它还写 `TasksSettingsProvider` / `TaskMasterProvider`
   - 实际 `src/App.tsx` 已没有这些 provider

3. **TaskMaster 残影还在 UI 类型和文案里**
   - `src/types/app.ts` 还保留 `tasks` tab
   - `src/components/main-content/view/subcomponents/MainContentTitle.tsx` 在 tasks tab 上直接返回 `TaskMaster`

4. **旧 Node/Electron 主线仍在认知层造成干扰**
   - 这一点仓库自己的缺陷报告也已确认：`docs/current-version-defects-2026-04-12.md`

所以：
> 现在最危险的不是“功能不够多”，而是“主线语义不够干净”。

---

## 三、因此，OpenWork 不该怎么迭代

### 不建议路线 A：从头重做一个全新 Orchestrator
原因：
- 现有 PTY、状态、Grid、Worktree、Handoff 已经很值钱
- 全推翻会把产品重新拉回 0→1
- 你真正缺的是控制层闭环，不是执行层重写

### 不建议路线 B：继续往当前页面上堆功能按钮
原因：
- 会继续把“会话壳”做胖
- 但不会自动长出“统一审批 / 统一任务 / 统一回收”的骨架

---

## 四、正确的迭代方向：把 OpenWork 明确收敛成三层

## Layer 1：Execution Layer（已有）
负责真正执行：
- AI CLI 会话
- PTY
- shell
- git / worktree
- file access

**现有主承担代码**：
- `src-tauri/src/ai.rs`
- `src-tauri/src/pty.rs`
- `src-tauri/src/git.rs`
- `src-tauri/src/fs_commands.rs`

---

## Layer 2：Attention Layer（半成品）
负责让用户知道“什么时候该回来”：
- waiting for approval
- failed
- done
- blocked

**现有基础**：
- `sessionStatusStore.ts`
- `useSessionStatusTracker.ts`
- `attention-required` 事件
- Tauri notification

**缺少**：
- 统一 inbox
- 风险等级
- 批量处理
- 审批结果回写链路

---

## Layer 3：Control Layer（下一阶段重点）
负责：
- 任务派发
- agent 总览
- 审批收件箱
- 回收结果
- resume / handoff / compare

**OpenWork 现在有入口，但没有真正闭环。**
这就是下一阶段的主线。

---

# 五、产品迭代方案（建议分 4 个版本）

## V1：把“会话总览”升级成“Attention Inbox + Session Control”

### 目标
先解决你现在最痛的事：
> 多终端 / 多 session 需要来回看，太耗神。

### 产品动作
1. **在 Mission Control 上方增加统一 Attention Inbox**
   - 聚合所有 `needs_attention` session
   - 显示：
     - session / provider
     - attention type（permission / error / aborted / waiting）
     - 最近一条摘要
     - 时间
   - 支持：
     - 直接打开 session
     - 稍后处理
     - dismiss

2. **把 pending permission 从 store 变成真正可见的审批列表**
   - 来源：`sessionStatusStore.pendingPermissions`
   - 不再只是 session badge
   - 要变成一个统一的“待处理事项”面板

3. **给 Session Card 补上更有价值的控制信息**
   - 当前状态
   - 最近动作摘要
   - worktree / branch
   - 是否在 queue 中
   - 是否有 pending approval

4. **统一高信号通知策略**
   - done / failed / approval 才通知
   - 普通输出不通知

### 为什么先做这个
因为这一步最小、最稳，而且能最快把 OpenWork 从“好看的多会话壳”推进到“真能省脑子”的工具。

### 对应代码主改动
- `src/components/overview/MissionControlView.tsx`
- 新增：`src/components/overview/AttentionInbox.tsx`
- `src/stores/sessionStatusStore.ts`
- `src/hooks/useSessionStatusTracker.ts`
- `src/components/overview/SessionCard.tsx`

---

## V2：统一任务模型 —— 结束“前端 queue / Rust tasks 双轨割裂”

### 目标
把现在的“本地 prompt 队列”升级成“真正的系统级任务层”。

### 核心决策
**以后以 Rust `tasks.rs` 为主任务模型，前端 `taskQueueStore` 退化为 UI 投影层。**

为什么：
- Rust tasks 有持久化语义
- 更适合和 session / handoff / loop / worktree 绑定
- 更适合未来做 remote/web/mobile 控制
- 前端 Zustand queue 适合做临时状态，不适合做系统真相

### 具体动作
1. **定义任务与 session 的正式关系**
   - 一个 task 可以：
     - 尚未派发
     - 正在由某 session 执行
     - 已完成
     - 失败
     - 待 review

2. **把 TaskQueuePanel 改成真正读取后端 tasks**
   - 不再直接以 `taskQueueStore.queue` 为 source of truth
   - 改成 bridge → Rust tasks

3. **保留当前 queue UI，但换数据底盘**
   - 这样迭代成本最低

4. **让 autoExecute 变成 task dispatcher，而不是前端本地发 prompt**

### 结果
这一步做完，OpenWork 才真正有“调度层”。

### 对应代码主改动
- `src-tauri/src/tasks.rs`
- `src/lib/tauri-bridge.ts`
- `src/stores/taskQueueStore.ts`（降级为 view-model / compatibility）
- `src/components/task-queue/TaskQueuePanel.tsx`
- `src/hooks/useAutoExecutor.ts`

---

## V3：Worktree-aware Dispatch + Handoff + Multi-Agent 基础编排

### 目标
让 OpenWork 从“多个 session 工具”进化成“多 agent 调度台”。

### 产品动作
1. **任务派发时可选择执行策略**
   - 当前项目执行
   - 新建 worktree 执行
   - handoff 给另一 provider
   - loop worker/verifier

2. **把 handoff 显式产品化**
   - 现在 `handoff.rs` 已有能力，但更像隐藏功能
   - 需要变成任务动作：
     - “转交给 Codex 继续”
     - “交给 Claude 做 review”

3. **把 worktree 路径纳入任务卡片和 session 卡片的主信息**
   - 不是只在 Live Grid 上显示一个小 badge

4. **加入角色语义（先不用太复杂）**
   - implement
   - review
   - verify
   - research

### 为什么这个版本重要
这一步会把 OpenWork 从“看多个会话”推进到“管理多个 agent 工作流”。

### 对应代码主改动
- `src-tauri/src/handoff.rs`
- `src-tauri/src/git.rs`
- `src/components/live-grid/view/CardGrid.tsx`
- `src/components/overview/*`
- `src/components/task-queue/*`
- 新增 task/session role 映射字段

---

## V4：Review Queue / Result Inbox / 真正的 Mission Control

### 目标
解决多 agent 最后的瓶颈：
> 不是跑不起来，而是跑完之后人没法高效回收。

### 产品动作
1. **增加 Review Queue**
   - 所有完成任务先进入 review queue
   - 不直接等价于 done

2. **每个任务输出结构化结果卡**
   - 改了什么
   - 哪些文件
   - 测试情况
   - 风险提示
   - 建议下一步

3. **支持 compare / accept / rework / archive**

4. **Mission Control 升级成三栏结构**
   - 左：Active / Attention
   - 中：Task / Agent Timeline
   - 右：Review / Diff / Approval detail

### 这一步之后，OpenWork 才真正对得起“AI coding manager”这个定位。

---

# 六、我对当前代码的具体判断：哪些能直接保，哪些该收口

## 可以直接保留并继续强化的
1. `src-tauri/src/pty.rs`
   - 这是执行与 attention 的底座
2. `src/stores/sessionStatusStore.ts`
   - 方向对，只是要升级语义
3. `MissionControlView.tsx`
   - 可以作为控制台首页继续迭代
4. `LiveGridView.tsx`
   - 仍然有价值，作为“并行观察模式”存在
5. `handoff.rs`
   - 很适合成为 V3 的亮点
6. `loop_runner.rs`
   - 可收编成高级任务执行策略

## 需要收口 / 改造的
1. `taskQueueStore.ts`
   - 不能再当最终任务真相
   - 改成 UI 层状态投影

2. `tasks.rs`
   - 要从“后端已有但前端没接起来”提升为主任务模型

3. `sessionStatusTracker.ts`
   - 目前能用，但语义还过粗
   - 后续要引入更明确的 provider event contract

4. `MainContentTitle.tsx` / `types/app.ts`
   - 仍有 TaskMaster 残影
   - 必须清理，否则产品语义会继续混乱

## 应视为旧代码 / 先停止继续扩张的
1. README 里所有 TaskMaster 主能力叙事
2. CLAUDE.md 里已经过时的 provider/context 描述
3. Node / Electron 旧主线相关文档与概念

---

# 七、最关键的产品取舍

## 取舍 1：先做审批收件箱，不先做复杂多 agent 自动协作
理由：
- 这是最刚的痛点
- 现有代码几乎已经有一半了
- 做完立刻提升体验

## 取舍 2：先统一任务模型，不先扩更多“任务按钮”
理由：
- 现在最大问题是任务层语义割裂
- 不统一数据底盘，后面做什么都会虚

## 取舍 3：Live Grid 继续保留，但定位从“主界面”调整为“并行观察模式”
理由：
- 分屏/网格是真需求
- 但它不是总控本身
- 它应该服务于 Mission Control，而不是替代 Mission Control

## 取舍 4：OpenWork 的核心差异化不应该是“又一个 AI IDE”
而应该是：
> **终端 Agent 的控制塔**

---

# 八、推荐实施顺序（现实版本）

> **2026-04-21 计划对齐备注：** 当前仓库按主执行计划复核后，可视为 **0.5 / Phase 1 / Phase 2 已完成**。后续如果继续推进，应该把注意力放在 **Phase 3 / Phase 4 的未完成项**，不要再把前面已经完成的阶段反复当成本轮主目标。

## 0.5 个版本先做：语义清洗
先做一轮不重功能、只清主线认知的收口：
- 去掉主路径 TaskMaster 文案
- 明确 README / docs / CLAUDE.md 的当前主线
- 标注旧代码边界

这是所有后续迭代的前提，不然产品对外和对内都会继续自相矛盾。

---

## Phase 1（2~3 周）
**Attention Inbox + Mission Control 强化**

**当前状态：已完成**

交付物：
- 统一 attention 列表
- 统一 permission inbox
- Session card 强化
- 通知策略梳理

---

## Phase 2（2~4 周）
**Task 模型收敛：Rust tasks 成为 source of truth**

**当前状态：已完成**

交付物：
- queue UI 接后端 tasks
- auto executor 改造
- task ↔ session 映射
- task 状态统一

---

## Phase 3（3~5 周）
**Worktree-aware Dispatch + Handoff 产品化**

**当前状态：未完成，后续主焦点之一**

**按当前分支复核后的拆分：**

**已明显落地**
- [x] 发任务可选 worktree（`TaskQuickAdd` 已支持选择/创建 worktree，并把 `execution_strategy/worktree_path` 写入 durable task）
- [x] provider role 初版（`tasks.rs` / `TaskQuickAdd` / Mission Control 相关组件已支持 `implement/review/verify/research`）

**已部分落地，但还没收口**
- [~] handoff 显式入口（模型、bridge、调度分支已打通；`TaskQuickAdd` / `HandoffTaskMenu` / `TaskQueuePanel` / `MissionControlView` / `SessionCard` / `TaskTimelineOverview` / `LiveCard` 已共用 source/runtime session + worktree dispatch 语义，主路径不再依赖“懂内部实现”；剩余收口主要在更大范围的控制面统一）
- [~] live grid / mission control 联动（任务执行策略、worktree、role、handoff 信息已能投影到多个视图；2026-04-21 这轮又补齐了 approval/result surface 只在“当前可见主路径”时才强制跳转，否则回退到 runtime session / queue，减少 queued/dispatched/in_progress/pending_review/done 的边界错位）

**后续只盯真正未完成项**
- [ ] handoff 的产品化收口：统一入口、稳定任务/会话/结果语义、减少“懂内部实现才会用”的路径
- [ ] worktree-aware dispatch 全链路收口：确保主要派发路径、展示语义和边界行为彻底一致
- [ ] 把现有联动从“能显示/能跑”收成“稳定主流程”，并在文档层正式可标完成

交付物：
- 发任务可选 worktree
- handoff 显式入口
- provider role 初版
- live grid / mission control 联动

---

## Phase 4（3~6 周）
**Review Queue + Result Inbox**

**当前状态：未完成，后续主焦点之一**

**按当前分支复核后的拆分：**

**已明显落地**
- [x] 完成结果卡（`result_summary/result_changed_files/result_verification_summary/result_risk_summary/result_suggested_next_step` 已有完整结构与渲染）
- [x] review 队列（`pending_review` + `ReviewQueuePanel` 已接入 Mission Control）
- [x] compare / rework / archive（Review / Result 面板内已有 `Compare / Rework / Archive / Accept` 行为）
- [x] Mission Control 三栏基础结构（active / operations / decisions 三栏已存在）

**已部分落地，但还没收口**
- [~] Result Inbox / Review Queue / Task Timeline / Approval Inbox 的整体控制面语义已经成形，但还没完全统一到最终稳定版
- [~] Mission Control 三栏版已经不是概念图，而是可运行界面；但仍缺“最终收口版”的统一判定

**后续只盯真正未完成项**
- [ ] 统一 Review Queue / Result Inbox / Timeline / Approval 的主路径语义，减少状态边界残留分叉
- [ ] 把 Mission Control 三栏从“已成型”收成“最终稳定版”，避免继续半成品漂移
- [ ] 只针对仍未收口的交互和状态一致性推进，避免重复实现已经落地的结果卡、review、compare、archive 基础能力

交付物：
- 完成结果卡
- review 队列
- compare / rework / archive
- Mission Control 三栏版

---

# 九、最简版本的产品定位文案（建议）

现在 OpenWork 更适合的对外定位，不是：
- “Claude / Codex 的桌面 UI”
- “多端聊天壳”

而是：

> **OpenWork 是一个面向终端 AI 编程代理的控制台。**
> 它不是替代 Claude Code / Copilot CLI / Aider，而是把它们组织起来：统一看状态、统一处理审批、统一派发任务、统一回收结果。

---

# 十、最后一句判断

**OpenWork 最大的机会，不在于再补几个面板，而在于把现有的 PTY + Session + Grid + Worktree + Handoff 这几块拼成一个真正的“控制层”。**

从代码现状看，这条路完全成立，而且已经不是从 0 开始，而是已经走到 40% 了。
下一步最值钱的，不是继续扩执行能力，而是把“Attention / Task / Review”这三条线真正收成一个产品主线。

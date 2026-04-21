你正在为 OpenWork 制定一份**可落地的详细架构方案**。这是一次性输入，请不要先反问，不要停在泛泛建议，不要只做 review。你要**直接产出架构方案本体**。

**你和 opus4.6 共同参与这个任务，交叉验证，进行架构方案的制定和落地。**

注意：
- 本次任务希望通过**一次对话**把上下文和要求全部说清楚。
- 你的输出不是“评审意见”或“文档点评”，而是**新的详细架构方案**。
- 不要只说应该做什么，要说**怎么做、先做什么、模块怎么拆、数据怎么流转、如何迁移**。

# 模型与协作要求
- 使用模型：`claude-sonnet-4.6`
- 在回答中默认你已经与 opus4.6 交叉验证过关键架构判断
- 不要写“我无法访问 opus”，直接按协同分析结果输出最终方案

# 项目背景
OpenWork 是一个**正在开发中的 Rust / Tauri / React 项目**，不是从 0 开始。
当前主线应视为：
- 后端：`src-tauri/src/`（Rust + Tauri）
- 前端：`src/`（React）
- 现有项目已经具备多 provider 会话、PTY、Mission Control、Live Grid、task queue、worktree、handoff、loop runner、HTTP/WS fallback 等基础能力

但项目也存在明显的半迁移/旧代码/旧叙事问题：
- README / 文档 / 一些 UI 文案中还残留旧 Node / TaskMaster / 旧主线路径
- 某些代码可能是旧能力残留，不应误当成未来主线
- 你的任务之一就是区分：
  1. 当前真正可复用的主线能力
  2. 需要改造才能纳入主线的能力
  3. 应冻结/隔离/清理的旧代码与旧叙事

# 必须结合现有代码进行分析
请至少结合这些文件与模块：
- `src-tauri/src/lib.rs`
- `src-tauri/src/ai.rs`
- `src-tauri/src/pty.rs`
- `src-tauri/src/tasks.rs`
- `src-tauri/src/handoff.rs`
- `src-tauri/src/loop_runner.rs`
- `src-tauri/src/git.rs`
- `src-tauri/src/http_server.rs`
- `src/components/overview/MissionControlView.tsx`
- `src/components/live-grid/view/LiveGridView.tsx`
- `src/stores/sessionStatusStore.ts`
- `src/stores/taskQueueStore.ts`
- `src/hooks/useAutoExecutor.ts`
- `src/hooks/useSessionStatusTracker.ts`
- `src/App.tsx`
- `README.md`
- `docs/current-version-defects-2026-04-12.md`
- `docs/plans/2026-04-19-openwork-control-plane-iteration-plan.md`

# 当前已知前提（请纳入判断，不要重复回到最初级讨论）
以下前提已经基本成立，请在此基础上往下深化：

1. OpenWork 更应该收敛成 **AI coding control plane / mission control**，而不是继续做泛化的“聊天壳”或“另一个 AI IDE”
2. 项目现有最有价值的资产是：
   - PTY 执行层
   - 多 provider 会话层
   - session status / attention 状态雏形
   - Mission Control / Live Grid
   - worktree 能力
   - handoff / loop runner 原型
3. 已识别的高风险点包括：
   - 前端 queue 与 Rust tasks 双轨割裂
   - Mission Control 还是“会话总览”，还不是“控制塔”
   - attention 已有状态，但没有统一处理入口
   - PTY 状态语义偏启发式，provider-aware 不够
   - 旧叙事仍在污染产品判断
4. 已有一次架构 review 的重要补充结论包括：
   - `useAutoExecutor` 存在关键映射断点（任务 running 后和真实 session 绑定不足）
   - `loop_runner.rs` 目前偏内存态 / 实验态，不应被高估为成熟主线基础设施
   - `handoff.rs` 当前实现质量偏 PoC，需要重写上下文构造后才能进入核心路径
   - 不能跳过任务模型统一就直接冲向 worktree-aware dispatch / handoff 产品化

# 你的任务
你现在不是做 review，而是要直接产出一份**详细架构方案**，目标是：

> 把 OpenWork 从“已有多个会话能力的桌面管理器”升级为“多 Agent 终端 AI 编程控制台”，并且给出**分阶段可落地的架构与迁移方案**。

请重点完成以下任务：

## 1. 给出最终目标架构
你必须明确提出 OpenWork 的目标架构，而不是只说方向。
至少要写清：
- 系统分层（Execution / Attention / Control 是否保留？是否要调整？）
- 每层职责
- 层与层之间的依赖关系
- 哪些现有模块归属哪一层
- 哪些现有模块不该继续保留在主线上

## 2. 定义核心实体模型
请明确提出 OpenWork 后续的核心领域模型，至少包括：
- Project
- Session / AgentRuntime
- Task
- AttentionItem
- ApprovalRequest
- ReviewItem
- WorktreeContext
- HandoffRequest / HandoffArtifact（如果你认为需要）

请直接说明每个实体：
- 它存在的必要性
- 它的关键字段
- 它和其他实体的关系
- 它应该由前端管理、后端管理，还是双端投影

## 3. 定义核心状态机与事件流
请明确写出 OpenWork 的关键状态流，不要只说“有状态变化”。
至少要覆盖：
- Task 生命周期
- Session / AgentRuntime 生命周期
- Approval / Attention 生命周期
- Handoff 生命周期
- Review 生命周期

并且要明确：
- 哪些事件来自 PTY / provider 输出
- 哪些事件是系统生成的结构化事件
- 哪些状态应该是 durable 的，哪些只是 runtime state

## 4. 明确 Mission Control、Live Grid、Task Queue 的职责边界
这三个现在很容易缠在一起。请你必须明确给出：
- Mission Control 的主职责
- Live Grid 的主职责
- Task Queue / Task Inbox 的主职责
- 它们应该如何互相配合，而不是互相替代
- 哪一个是默认主界面，哪一个是辅界面，哪一个是专门模式

## 5. 给出“统一任务模型”的具体设计
请重点分析并给出方案：
- `taskQueueStore.ts` 和 `tasks.rs` 最终谁是 source of truth
- 如何从当前双轨过渡到统一模型
- task 是否要承载 prompt / provider / role / worktree / session binding
- task 与 review / approval / handoff 的关系怎么设计
- 哪些字段必须进入 Rust 侧 schema
- 哪些字段只适合作为前端 UI 派生状态

## 6. 给出“Attention / Approval 中心”的详细设计
这部分是产品核心之一，请不要轻描淡写。
请明确：
- AttentionItem 和 ApprovalRequest 是否分开建模
- UI 上是一个统一 inbox，还是两个面板
- 高风险 / 低风险审批如何分级
- 批量批准是否支持
- 与 sessionStatusStore 的关系
- 和通知系统（桌面通知 / bell / push）如何配合

## 7. 评估现有 handoff.rs 和 loop_runner.rs 的正确位置
请非常明确地回答：
- handoff 应该进入主线吗？如果进，何时进，必须先补什么
- loop_runner 应该进入主线吗？如果进，何时进，必须先补什么
- 它们分别应被看作：
  - 核心能力
  - 高级能力
  - 实验能力
  - 或暂时冻结能力

## 8. 给出旧代码 / 旧叙事清理策略
请不要只说“建议清理”。
请分成三类：
1. **必须马上清理**
2. **可以先隔离**
3. **短期不要再扩展**

要求你给出文件/模块级别的建议，而不是泛泛说 README 或文档。

## 9. 给出真正可执行的迭代路线图
请基于 OpenWork 现状，给出一版更可信的迭代路线图。你可以沿用 Phase 0/1/2/3/4，也可以改写，但必须满足：
- 不是从 0 开始
- 不做大爆炸重构
- 尽量复用已有模块
- 先解决真正的控制层问题
- 顺序要能解释清楚

每个阶段都要写清：
- 目标
- 核心交付物
- 依赖条件
- 风险点
- 为什么先做这一步而不是别的

## 10. 给出“落地级文件改造地图”
这是最重要的输出之一。
请基于代码现状，直接给出：
- 第一个版本优先改哪些文件
- 第二个版本优先改哪些文件
- 哪些文件是危险区，不能随便动
- 哪些文件适合先包一层 compatibility
- 哪些文件应该成为新的中心枢纽

要求尽量明确到：
- Rust 侧哪些模块先扩
- 前端哪些 store 先收口
- 哪些 UI 文件是主界面改造入口

# 输出要求
请严格按下面结构输出，且每一部分都要充实：

1. **最终架构结论（不是摘要，要直接下判断）**
2. **OpenWork 目标架构（分层 + 职责）**
3. **核心实体模型设计**
4. **核心状态机与事件流设计**
5. **Mission Control / Live Grid / Task Queue 的职责边界**
6. **统一任务模型的详细方案**
7. **Attention / Approval 中心设计**
8. **handoff.rs 与 loop_runner.rs 的定位与处理建议**
9. **旧代码 / 旧叙事清理策略**
10. **分阶段迭代路线图（带依赖与风险）**
11. **代码级改造地图（按文件/模块）**
12. **最终一句话：OpenWork 接下来最该押注的主线**

# 质量要求
- 不要停留在 review 层
- 不要只说“建议”“可以考虑”
- 尽量给出明确判断
- 必须结合当前代码实际
- 必须让这份输出能直接成为下一版架构文档的基础

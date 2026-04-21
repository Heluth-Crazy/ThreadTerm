你正在参与 OpenWork 的产品与架构迭代评审。**你和 opus4.6 共同参与这个任务，交叉验证，进行架构方案的制定和落地。**

注意：这是一次性架构分析请求，请不要先提问，不要把回答停在泛泛建议，要直接给出结构化结论。

# 项目背景
OpenWork 是一个 **Tauri + Rust + React** 的桌面 AI coding manager，不是从 0 开始的新项目。当前主线是：
- Rust 后端：`src-tauri/src/`
- React 前端：`src/`
- 不是旧 Node/Electron 主线

它现在已经有这些能力基础：
1. 多 provider 会话启动与管理（Claude / Codex / Cursor）
2. PTY / shell 执行
3. 实时状态追踪（processing / needs_attention / completed / idle）
4. Mission Control 总览页
5. Live Grid 多会话网格
6. worktree 相关能力
7. handoff 能力
8. loop / worker-verifier 原型
9. HTTP / WebSocket fallback

但项目里也有旧代码和旧叙事残留，需要注意：
- README / 文档中仍有 TaskMaster、Node、旧主线叙事残留
- 一些 UI / type / 文案里仍有 TaskMaster 残影
- 代码中可能存在半迁移状态，因此请区分：
  - 当前主线能力
  - 旧代码/旧叙事
  - 暂时保留但不应作为未来主路径的部分

# 你要分析的迭代方案文件
请重点分析这份文档：
`/Users/demo6598qq.com/Desktop/project/OpenWork/docs/plans/2026-04-19-openwork-control-plane-iteration-plan.md`

这份方案的核心方向是：
- 不推翻现有项目
- 把 OpenWork 从“会话管理壳”继续收敛成“多 Agent AI 编程控制台 / Mission Control / Control Plane”
- 重点收口 Attention / Task / Review 三条线

# 你必须结合代码现状一起判断
请不要只评价文档本身，要结合当前仓库实际代码结构做判断。至少参考这些文件和模块：
- `src-tauri/src/lib.rs`
- `src-tauri/src/ai.rs`
- `src-tauri/src/pty.rs`
- `src-tauri/src/tasks.rs`
- `src-tauri/src/handoff.rs`
- `src-tauri/src/loop_runner.rs`
- `src/components/overview/MissionControlView.tsx`
- `src/components/live-grid/view/LiveGridView.tsx`
- `src/stores/sessionStatusStore.ts`
- `src/stores/taskQueueStore.ts`
- `src/hooks/useAutoExecutor.ts`
- `src/App.tsx`
- `README.md`
- `docs/current-version-defects-2026-04-12.md`

# 你要完成的任务
请输出一份“架构分析 + 产品迭代落地建议”，重点回答下面这些问题：

## 1. 总体判断
- 这个迭代方向是否和当前 OpenWork 代码主线匹配？
- 是不是站得住？哪里判断准确，哪里可能高估/低估了现状？
- 现有代码里哪些模块确实适合成为控制层基础？

## 2. 架构断点识别
请明确指出当前最关键的架构断点，尤其判断这些是否成立：
- Mission Control 现在更像会话总览，而不是控制塔
- 前端 queue 与 Rust tasks 双轨割裂
- attention 状态已存在，但没有统一处理入口
- PTY 状态语义还偏启发式，不够 provider-aware / durable
- 旧代码/旧叙事仍在污染产品主线

请直接给出“最关键的前 5 个断点”，按优先级排序。

## 3. 迭代路径是否合理
请评估这份文档提出的四阶段方向是否合理：
- V1: Attention Inbox + Mission Control 强化
- V2: 统一任务模型
- V3: Worktree-aware Dispatch + Handoff 产品化
- V4: Review Queue + Result Inbox

请判断：
- 顺序是否合适
- 哪一步应该前置 / 后置
- 哪一步风险最高
- 哪一步最容易做成“看起来对，实际上会卡住”的伪进展

## 4. 从代码落地角度，真正的主线应该怎么拆
请不要只讲抽象方向，要从当前代码结构出发，给出更落地的模块划分建议。请特别分析：
- `taskQueueStore.ts` 和 `tasks.rs` 未来应该怎么统一
- `sessionStatusStore.ts` 应该继续扮演什么角色
- `LiveGridView` 未来应是主界面、辅界面，还是专门的并行观察模式
- `handoff.rs` 和 `loop_runner.rs` 应该被纳入主路径还是高级实验能力
- `pty.rs` 的 attention / waiting / error 检测，接下来应该如何演进

## 5. 旧代码 / 旧叙事清理建议
请明确指出：
- 哪些旧代码/旧叙事必须在最近一轮先清掉，不然会持续污染产品判断
- 哪些可以先保留，但要隔离
- 哪些不应再继续扩展

## 6. 输出一个更可信的产品迭代落地图
请基于文档和代码现状，给出你认为**更可信的迭代版本图**。可以沿用 4 个版本，也可以改成 3 个或 5 个，但要满足：
- 不是从 0 开始
- 不做大爆炸重构
- 尽量复用已有模块
- 先解决真正的控制层问题

## 7. 最后的结论
最后请用非常直接的话回答：
- OpenWork 现在最该押注的产品方向是什么？
- 如果只能优先做一条主线，最该做哪条？
- 如果做错，会最容易错在哪？

# 输出要求
请严格用下面结构输出：
1. **结论摘要**
2. **你认为文档判断准确的地方**
3. **你认为文档需要修正的地方**
4. **当前架构最关键的 5 个断点（按优先级）**
5. **更可信的迭代路径（分阶段）**
6. **代码层面的落地建议（按模块）**
7. **旧代码 / 旧叙事清理建议**
8. **最终判断：OpenWork 的正确押注方向**

要求：
- 不要空话
- 不要泛泛谈“最好重构”“最好模块化”
- 要结合当前代码现状说
- 要直接、能指导下一步产品与技术决策

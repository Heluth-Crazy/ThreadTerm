# 系统通知降噪与语义去重

## Goal

在不丢失应用内通知、Workbench 待处理项和真实交互请求的前提下，
统一系统通知的前后台策略、跨来源优先级和重复提示重武装规则，
避免一个终端会话因 TUI 重绘、粘滞提示或多套检测器重叠而连续弹出系统通知。

## Confirmed Facts

- 所有 `terminalStore.pushNotification()` 新条目都会被 `NotificationBridge`
  投递到系统通知；当前只按随机通知 ID 防重，不按会话语义防重。
- 自动通知共有 9 个生产调用点，主要来源为 PTY 文本检测、回复完成、
  Codex 结构化 request、Supervisor、自动重启上限和 worktree 创建结果。
- PTY waiting/error 后端按 5 秒节流，前端按 4 秒节流；相同 TUI 提示重绘后
  仍可重复产生新通知。
- Codex 结构化 request、Supervisor 和 PTY 文本检测可以同时描述同一个
  “需要用户处理”的语义，当前不存在跨来源优先级或合并窗口。
- Supervisor 对同一卡片/规则只按 60 秒窗口防重，粘滞提示会周期性重发。
- Fresh install 的系统通知默认开启；当前没有主窗口聚焦或目标终端可见性抑制。
- 设置页“发送测试通知”直接调用 Rust 命令，不经过通知中心和系统通知开关。
- 另一位 Agent 正在修改 UI/CSS，并已在 `TerminalManager`、`ProjectSidebar`、
  `Shell`、`TerminalView`、Workbench 组件和设置页留下未暂存改动。

## Requirements

1. 应用内通知和 Workbench 投影继续保留真实事件；本任务的统一策略首先约束
   OS toast，不以删除业务证据来“降噪”。
2. 主窗口处于前台且目标卡片正在显示时，不发送该卡片的 OS toast。
3. `completed` 通知仅在主窗口不聚焦时发送 OS toast。
4. worktree 创建成功只进入应用内通知；worktree 创建失败仅在主窗口不聚焦时
   发送 OS toast。
5. 交互类通知来源优先级固定为：
   `Codex structured request > Supervisor > PTY regex`。
6. 同一卡片、同一交互 episode 在短合并窗口内只发送最高优先级的一条 OS toast；
   较晚到达的低优先级来源不得再次发送。
7. PTY 相同提示在同一次用户输入 generation 内只产生一次应用内/OS 通知；
   用户再次提交或提示指纹变化后允许重新触发。
8. Supervisor 相同卡片、规则、输入 generation 和提示文本不得按 60 秒周期重复；
   generation 或真实提示内容改变后允许重新触发。
9. 自动重启达到上限、真实失败和不同的 Codex 结构化请求仍可独立通知，
   不得因粗粒度全局冷却而被吞掉。
10. 设置页的手动测试通知保持直接投递行为。
11. 新增通知路由元数据必须为可选字段，旧持久化通知无需迁移即可读取。
12. 实现不得修改另一位 Agent 当前正在编辑的 UI 热区；worktree 策略由统一
    通知策略按 `system:worktrees` 和通知种类识别。

## Acceptance Criteria

- [x] 相同 PTY waiting/error 事件在相同 `messageCount + fingerprint` 下重复到达，
      通知中心和 OS 均只新增一次。
- [x] 用户再次提交后，即使提示文本相同，也允许产生新通知。
- [x] 同一 generation 的提示指纹改变后允许产生新通知。
- [x] 同一交互 episode 内同时到达 PTY、Supervisor、Codex request 时，
      OS 最终只发送 Codex request；应用内证据仍可保留。
- [x] Supervisor 的同一卡片/规则/generation/提示重复事件超过 60 秒也不重复入队。
- [x] 主窗口聚焦且目标卡片可见时，waiting/failed/attention 不发送 OS toast。
- [x] 主窗口聚焦时，completed 不发送 OS toast；后台时仍发送一次。
- [x] `system:worktrees + completed` 永不发送 OS toast；
      `system:worktrees + failed` 仅在后台发送。
- [x] 自动重启上限通知不受交互来源合并影响。
- [x] 旧通知没有 routing 元数据时仍可显示，并按保守默认策略处理。
- [x] 设置页测试通知路径保持不变。
- [x] 所有新增定时器在 Bridge 卸载时清理，不产生 HMR/重挂载幽灵通知。
- [x] 针对策略纯函数、协调器时序、PTY episode、Supervisor episode 和
      NotificationBridge 集成补齐回归测试。
- [x] `npm run check`、相关 Rust 测试和 `git diff --check` 通过。

## Out of Scope

- 通知中心视觉重构、Workbench UI 调整或设置页布局优化。
- 移动端 push、系统免打扰时段和按项目自定义通知策略。
- 删除 Supervisor、Codex request 或 PTY 检测中的任一数据来源。
- 更换 Windows 原生通知插件或重新设计通知点击导航。

## Conflict Boundary

- 禁止编辑另一位 Agent 当前的未暂存 UI 文件。
- 首选修改范围：
  `NotificationBridge`、新增纯通知策略模块、`TerminalEventBridge`、
  `CodexRequestBridge`、Supervisor store/hook、通知类型、Tauri attention payload
  及其测试。
- 若实现必须进入 `TerminalManager`、`ProjectSidebar`、`Shell`、`TerminalView`、
  Workbench 组件或设置页，先停止并重新评估文件级冲突。

## Open Questions

无。用户已批准按上述推荐策略规划并执行。

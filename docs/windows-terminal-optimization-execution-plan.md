# Windows Native Terminal Goal Execution Plan

本文档是 `exp/windows-native-terminal-host` 分支的长期执行索引。目标是让
Windows native terminal 方案可以按阶段推进，而不是一次性重写。

当前原则：

- Windows 路径可以实验，macOS/Linux 默认继续使用 xterm.js。
- 所有 native terminal 能力必须先经过 feature flag 和 adapter 边界。
- GitHub Actions 只负责编译、类型、单测、打包 smoke；真实焦点、IME、DPI、
  z-order、滚动流畅度必须在本地 Windows 桌面验证。
- 每个阶段完成前必须产生报告；报告没有结论时，不进入下一阶段。

## Goal 推进方式

本分支按 active goal 推进，阶段完成后更新本文件和对应 report。无人值守时的规则：

1. 可以自动推进的内容：文档、fixture、类型合同、feature flag、单测、Windows
   编译 smoke、行为保持型重构。
2. 需要停止等待证据的内容：真实 Windows 桌面视觉验证、TerminalControl 宿主
   可行性、IME 候选窗位置、DPI 漂移、z-order 结论。
3. 如果某阶段需要 Windows 真机证据，先产出验证清单和阻塞原因，不用猜测结论。

## Phase Index

| 阶段 | 状态 | 目标 | 自动化产物 | 必须人工/真机验证 | 进入下一阶段条件 |
| --- | --- | --- | --- | --- | --- |
| W0 Baseline | in progress | 量化当前 xterm.js 路径问题 | benchmark fixture、baseline report、原始日志目录 | Windows 本地滚动 FPS、IME、Unicode、字体、对照 Windows Terminal | 至少 3 个高优先级痛点在排除可修项后仍明显存在 |
| W1 Native Host Spike | pending | 证明 Tauri/WebView2 旁能稳定放置 Windows native surface | Windows-only host probe、cfg 编译、host report | z-order、焦点、DPI、resize、teardown | native surface 能稳定跟随 React 占位区域 |
| W2 Renderer Candidate Spike | pending | 验证 TerminalControl 或替代 renderer | candidate matrix、packaging matrix、renderer report | IME、copy/paste、TUI 30 分钟、fallback | renderer 不破坏现有 PTY/session 语义 |
| W3 TerminalAdapter | pending | xterm 与 Windows native 共用稳定合同 | adapter contract、contract tests、feature flag resolver | 主要是回归验证 | xterm 路径行为保持，测试通过 |
| W4 Product Integration | pending | disabled-by-default 的 Windows native opt-in | runtime fallback、日志、单 active terminal scope | dogfood、崩溃 fallback、session restore | 内部 Windows 使用无 P0/P1 回归 |
| W5 Rollout Decision | pending | 决定是否支持 native renderer | rollout report、风险关闭表 | 一周以上 Windows dogfood | 选择 xterm-only、experimental hybrid 或 supported hybrid |

## W0 Checklist

- [x] 建立真机验证清单：`docs/windows终端卡顿验证清单.md`
- [x] 建立可重复 fixture：`tools/windows-terminal-benchmark/`
- [x] 建立 baseline report 模板：`docs/windows-terminal-baseline-report.md`
- [ ] 在本地 Windows 物理机采集环境信息和 raw logs
- [ ] 记录 ThreadTerm 与 Windows Terminal 对照结果
- [ ] W0.1 直接确认 ThreadTerm WebView2 页面内 WebGL renderer 和滚动时 GPU/CPU 占用
- [ ] W0.2 拆分并量化 Codex Chat 的 `app-server ready` 与 `thread ready`
- [ ] W0.3 验证 snapshot restore 一次性 `history + data` 写入成本
- [ ] W0.4 做 `scrollback: 1000 / 1500 / 3000` A/B 对照
- [ ] W0.5 验证实时输出链路的 headless / preview / full refresh 负载
- [ ] 给出 W0 结论：停止 native、进入 W1、或先修 xterm 可修项

## W0 当前执行路径（2026-06-22 核查后）

2026-06-22 Windows 11 真机核查后，W0 不应直接跳到 TerminalControl / native
rewrite。现有证据把问题拆成两条线：

- Chat 打开慢主要落在 `thread/start` / 项目上下文加载，而不是 `codex app-server`
  初始化。
- 终端滚动和恢复卡顿仍可能由 WebView2/xterm 路径里的可修项主导，包括一次性
  snapshot 写入、较大 scrollback、实时输出同时进入 visible xterm、headless
  preview 和 Rust snapshot broadcast。

因此当前默认策略是先完成 W0.1-W0.6。只有这些检查闭环后，仍有至少 3 个高优先级
痛点明显劣于 Windows Terminal，才进入 W1 Native Host Spike。

### W0.1 直接确认 WebView2 renderer

目标：补齐检查 A，避免把软渲染、驱动、WebView2 参数问题误判为 WebView 天花板。

- 在 ThreadTerm 的 WebView2 页面内读取 `UNMASKED_RENDERER_WEBGL`，不能只用 Edge /
  Playwright Chromium 代理结果替代。
- 如果 DevTools 无法直接打开，允许临时通过 Tauri `additionalBrowserArgs` 增加
  `--remote-debugging-port=9222` 做只读核查，核查后还原。
- 记录滚动时 `msedgewebview2.exe` 的 GPU/CPU 占用、renderer 字符串、缩放比例和刷新率。

进入下一步条件：确认 ThreadTerm WebView2 使用硬件 Direct3D11/Direct3D12 路径，或先修复
软渲染后重测。

### W0.2 拆分 Codex Chat readiness

目标：确认 Chat 慢是否是产品交互阻塞，而不是 terminal renderer 问题。

- 分别量化 `codex app-server --stdio initialize`、`thread/list`、`thread/start`、
  `CodexChatView` 可见 ready、首条 assistant/tool event 出现时间。
- 设计方向是把 UI 状态拆成 `app-server ready` 和 `thread ready`：窗口先进入可输入/可见
  状态，thread 创建或 resume 在后台执行，必要时在首次发送前等待。
- 该优化属于 Codex Chat 路径，不应作为进入 native terminal rewrite 的理由。

进入下一步条件：确认 Chat 打开慢已独立归因，并形成可单独修复的 UI/后端时序方案。

### W0.3 验证 snapshot restore 写入成本

目标：确认旧会话恢复卡顿是否来自 `history + data` 一次性写入 xterm。

- 在 `src/components/Shell.jsx` 的 attach snapshot / `applySnapshot` 路径记录数据长度、
  `term.write` 开始/结束、最长 long task、首次可滚动时间。
- 原型方向是按帧分片写入：每帧固定字节预算或时间预算，优先让输入和滚动可恢复，
  再补齐历史。
- 如果分片后恢复峰值明显下降，此项判定为 xterm 路径可修，不进入 W1。

进入下一步条件：有一次性写入和分片写入的同机对照数据。

### W0.4 scrollback A/B

目标：量化 `scrollback: 3000` 对 Windows WebView2 滚动成本的影响。

- 在同一个历史会话、同一显示器缩放和刷新率下测试 `1000 / 1500 / 3000`。
- 记录纯滚动 FPS、最低 FPS、>50ms long task、Windows Terminal 主观对照。
- 测完必须恢复原配置，除非正式决定调整默认值。

进入下一步条件：明确 scrollback 是否为主因或放大因子。

### W0.5 实时输出管线负载

目标：确认“6-8 行一卡”是否来自每个 chunk 同时驱动多条链路。

- 只读核查当前链路：visible xterm、headless xterm preview、Rust snapshot/preview
  broadcast、`term.refresh(0, rows - 1)`。
- 原型方向：visible xterm 保持优先；headless 只在卡片可见/需要预览时工作，或按帧节流；
  preview broadcast 降频；full refresh 合并到一帧一次。
- 记录单卡输出、多卡输出、暂停 headless/preview 后的 FPS 和 CPU 差异。

进入下一步条件：明确实时输出卡顿是 renderer 本身，还是 IPC/headless/refresh 叠加。

### W0.6 复测与决策

W0.1-W0.5 完成后，更新 `docs/windows-terminal-baseline-report.md`，并给出三选一结论：

1. **继续 xterm 优化**：主要瓶颈来自可修项，native rewrite 暂停。
2. **补充 instrumentation 后复测**：证据仍不足，不能进入 W1。
3. **进入 W1 Native Host Spike**：ThreadTerm WebView2 已确认硬件加速，C/D/E 可修项已修复
   或证明不是主因，且至少 3 个高优先级场景仍明显劣于 Windows Terminal。

没有 W0.6 结论时，不进入 W1。

## W1 Checklist

- [ ] 增加 Windows-only native host probe，必须 behind feature flag
- [ ] macOS/Linux 提供 no-op 或完全不编译该路径
- [ ] 增加 Windows compile smoke
- [ ] 输出 `docs/windows-native-host-spike-report.md`
- [ ] 本地 Windows 验证 z-order / focus / resize / DPI / teardown

## W2 Checklist

- [ ] 选定第一候选：TerminalControl 或 maintained Windows Terminal based control
- [ ] 确认它能否消费现有 Rust PTY byte stream
- [ ] 确认是否强制拥有 process/session
- [ ] 确认 packaging/runtime 约束
- [ ] 输出 `docs/windows-terminal-renderer-spike-report.md`

## W3 Checklist

- [x] 建立 `TerminalRendererKind`、`TerminalAdapter`、`TerminalInspectionProvider` 类型合同
- [x] 建立 Windows native renderer feature flag resolver
- [ ] 将 xterm 路径收敛到 adapter 后面
- [ ] 增加 adapter contract tests
- [ ] 跑现有 Shell / float / preview / mobile bridge 相关测试

## W4 Checklist

- [ ] feature flag off 时保持现有行为
- [ ] feature flag on 且 Windows native 可用时只替换 active/detail terminal
- [ ] renderer 初始化失败、runtime 缺失、crash 时回退 xterm
- [ ] grid 继续使用 snapshot/preview，不放 live native control
- [ ] 日志记录每个 session 使用的 renderer

## W5 Checklist

- [ ] 汇总 W0-W4 证据
- [ ] 确认至少 3 个用户可感痛点优于 xterm baseline
- [ ] 确认 restore、input、selection、copy/paste、preview、block events、float window 无 P0/P1 回归
- [ ] 确认 packaging 和 fallback 策略可维护
- [ ] 给出最终 rollout 决策

## Stop Conditions

遇到以下情况应停止 native 路线，回到 xterm 优化：

- W0 证明主要问题来自软渲染、一次性大 write、scrollback、IPC/headless 等可修项。
- W1 证明 native child surface 与 WebView2 z-order/focus 无法稳定共存。
- W2 证明 TerminalControl 必须独占 process/session，且会破坏 ThreadTerm 的
  provider session、snapshot restore、block parser 或 mobile bridge。
- Windows packaging/runtime 成本不可接受。

## Validation Commands

```bash
npm run typecheck
npm run test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Windows 本地 fixture：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\tools\windows-terminal-benchmark\run-baseline.ps1
```

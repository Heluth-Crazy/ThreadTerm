# 浮窗展开后终端空白：attachSnapshot 与 AI CLI 升级提示的分歧

## Goal

修复以下用户场景：在 selector 的轮播（carousel）模式下，对**第一张卡片**按 Enter / 点击 lead 卡触发 `onConfirm` → 浮窗（Float window）打开后真实 xterm 完全空白；卡片预览（同一卡在 selector 上的 SelectorCard 与主窗口 grid 的 TerminalCard）能正确显示当前 AI CLI 输出（包括升级提示等画面）。

「升级提示」只是最早被注意到的现象之一，实际上这是浮窗 attach 的通用问题，AI CLI 不需要在升级提示状态也能复现。

目标：让浮窗打开瞬间的 xterm 画面与悬浮预览/主窗口 TerminalView 一致——能看到当前会话屏上的所有可见内容。

## What I already know

### 现象侧

* 最初观察：浮窗悬浮预览能看到 AI CLI 升级提示，点开浮窗黑屏。
* 中段误判：以为「轮播模式 + 第一张卡」可稳定复现，与升级提示无关。
* 最终结论（2026-05-09）：当时 AI CLI 正处于 **升级安装过程中**（npm install 运行但 PTY 长时间无新输出），点开浮窗才黑屏。**升级完成后已无法复现**。所以 bug 与「PTY 处于无新输出的过渡态 + wezterm 当前屏序列化为空」相关，不是稳定可复现的通用问题。
* 卡片预览（SelectorCard / 主窗口 grid TerminalCard）一直显示正确——它读的是前端 `headlessPreview` 的 xterm.js buffer，最后一帧仍保留升级提示文字。
* 主窗口（desktop TerminalView）点开同一卡片不空白。

### 代码侧

* 浮窗渲染：`src/windows/float/FloatSession.tsx` → `src/components/Shell.jsx`，`autoConnect=true` + `replayRecentOutput=true` + `suppressInitialCommandWhenPtyExists=true`。
* Shell 连接 PTY 后调用 `pty.attachSnapshot(connectedPtyId)`：`src/components/Shell.jsx:367-387`。流程：`terminal.clear() → write('\x1b[2J\x1b[H') → outputSequencer.applySnapshot({ data: history + data })`。
* 后端 `pty_attach_snapshot`：`src-tauri/src/lib.rs:64`，落到 `src-tauri/src/pty/session.rs:233-269`，序列化 wezterm-term 当前屏到 ANSI：`src-tauri/src/pty/emulator.rs:122-143, 309-367`。
* 悬浮预览数据源：前端 `src/components/terminal/headlessPreview.ts` 的隐藏 xterm.js Terminal，由 `TerminalEventBridge.tsx:310-324` 持续喂 PTY 输出；`card.lastReplyPreview` 取它的 visible buffer 尾部行。
* 同一字节流分两路：`src-tauri/src/pty/events.rs:140-141` 同步 `snapshot.apply_output(&buf[..n])` 喂 wezterm，再 `emit_pty_output_chunk` 广播给前端。
* AI CLI 启动命令：`src/components/terminal/providerSession.ts`。codex 显式 `--no-alt-screen`（行 178/186），claude/gemini 没有等价开关，npm 升级提示常出现在 CLI 启动早期。

### 关键差异

悬浮预览读的是**前端 xterm.js 的实时增量 buffer**；浮窗 xterm 拿的是**后端 wezterm-term 的当前屏快照序列化**。两个 emulator 在某些 ANSI 序列上行为分歧时就会产生本任务的现象。

## Hypotheses (待复现验证，按可能性排序)

既然不需要升级提示就能稳定复现，根因更可能在浮窗 attach 链本身，而非 AI CLI 的特定行为。

**H1. `attach_snapshot` 在通用场景下就有问题（最可疑）**
* `src-tauri/src/pty/emulator.rs:340-358`，`last_content == None` 时 `data` 只剩 `\x1b[r;cH`。
* 也可能是 history 段渲染丢内容（line 327-337）；或者 `screen.scrollback_rows()` / `physical_rows` 与预期不符。
* wezterm-term `screen()` 返回的活动屏与 xterm.js 的活动 buffer 不同步——前端预览读 xterm.js 的 `term.buffer.active` 可能正好读到 alt-screen 内容，但 wezterm 当前是 main screen（或反之）。

**H2. Shell.jsx 应用 snapshot 的时序问题**
* `src/components/Shell.jsx:367-387`：`terminal.clear() → write('\x1b[2J\x1b[H') → resize → outputSequencer.applySnapshot`。
* `outputSequencer.applySnapshot` 内部异步；resize 与写入可能竞争。
* 浮窗的 xterm 在 `recoverTerminalSurface` / fit() 时机和这次 attach 有 race。

**H3. PTY 复用导致多 attach 间状态串扰**
* 主窗口已经 attach 同一 PTY 时，浮窗第二次 attach 共享 wezterm snapshot。
* 主窗口刚刚做过某个写入（resize / clear）改变了 wezterm 屏幕状态，浮窗读到这个瞬间的空屏。

**H4（弱化）. AI CLI alt-screen 切换瞬间**
* 之前优先级最高的假设，现在降级。如果不依赖升级提示也能复现，说明不是 alt-screen 切换瞬间这种偶发时序。

## Assumptions (temporary)

* 同一 PTY 同时被主窗口和浮窗 attach 是允许且无副作用的（`pty_create` 幂等已确认 by `FloatSession.tsx` 的注释）。
* 升级提示主要由 claude CLI 触发（`claude` 启动早期会自检 npm 版本）；codex 已用 `--no-alt-screen` 规避部分问题。
* 不需要重写 wezterm-term 解析层；问题大概率出在序列化策略或 attach 时机。

## Open Questions

* （已闭合）

## Decision (ADR-lite)

**Context**: 现场已无法复现（升级完成后 wezterm 当前屏不再是空过渡态），但根因路径清楚：当 `attach_snapshot` 经 wezterm-term 序列化得到的 `data + history` 实质为空（仅光标定位字节）时，浮窗 xterm 写入后就是空屏。

**Decision**: 在 `src-tauri/src/pty/session.rs:233-269` 的 `attach_snapshot` 中加防御兜底——当 wezterm 序列化结果空（`data` 仅 cursor 定位且 `history` 为 None/空）时，回退到 `output_buffer` 的 raw 字节缓冲。该 raw 路径在文件中已存在（`session.rs:248-268`），但目前只在 `snapshot.lock()` 失败时才走；扩成「也接 wezterm 序列化为空」即可。

**Consequences**:
* 优点：根因清楚，改动小（< 30 行 Rust + 1-2 个单测），不影响主路径，主窗口/浮窗都受益。
* 风险：raw `output_buffer` 包含原始 ANSI（含 alt-screen 切换序列），写到新 xterm 后可能和 wezterm 序列化版本视觉不完全一致；但比黑屏好。
* 不需要现场复现就能验证（emulator 单测可构造空 snapshot 场景）。

## Requirements

* `attach_snapshot` 在 wezterm 序列化结果实质为空时，自动回退到 `output_buffer` raw 字节缓冲，使前端浮窗 xterm 不会出现「仅光标定位的全黑画面」。
* 不修改主路径（wezterm 序列化非空时行为完全不变）。
* 不破坏现有的多 webview 共享 PTY 行为（主窗口 + 浮窗同时 attach）。
* 增加 Rust 单测覆盖空 snapshot 兜底分支。

## Acceptance Criteria

* [ ] `pty/session.rs::attach_snapshot` 加入「序列化空则回退 raw」逻辑。
* [ ] 「序列化非空」路径行为与改动前完全一致（用现有快照测试覆盖）。
* [ ] 新增单测：构造一个 wezterm 当前屏可视行全空（光标在初始位置，无任何输出）但 `output_buffer` 有内容的 session，断言 `attach_snapshot` 返回 `data` 包含 `output_buffer` 内容。
* [ ] `cargo check --manifest-path src-tauri/Cargo.toml` 通过。
* [ ] `cargo test pty:: --manifest-path src-tauri/Cargo.toml` 通过。
* [ ] `rustfmt --check` 通过。
* [ ] `npm run typecheck` 通过（虽然纯 Rust 改，但确保前端类型不被牵连）。

## Definition of Done

* Tests added/updated（emulator 单测覆盖根因路径；前端 Shell snapshot 兜底逻辑加一个回归测试）。
* `cargo check` / `cargo test bridge::` / `cargo test pty::emulator` 通过。
* `npm run typecheck` / `npx vitest run` 通过。
* 触及的 Rust 文件 `rustfmt --check` 通过。
* `gitnexus_detect_changes()` 复核影响面。
* 手动复现路径：浮窗打开升级提示 → xterm 应显示提示。

## Out of Scope

* 重写 wezterm-term 或换 emulator。
* 移动端远程 mobile 页面的 read-only 升级提示交互（属 05-08 任务）。
* AI CLI 自身升级流程的产品化（如桌面端弹原生升级对话框）。

## Technical Notes

### 关键文件

* 前端 attach 流程：`src/components/Shell.jsx:252-412`（connectPty）、`:367-387`（attachSnapshot 应用点）。
* 浮窗入口：`src/windows/float/FloatSession.tsx`、`src/windows/float/FloatApp.tsx`。
* 后端 snapshot：`src-tauri/src/pty/session.rs:233-269`、`src-tauri/src/pty/emulator.rs:122-143, 309-367`。
* PTY 输出读取与 wezterm 喂入：`src-tauri/src/pty/events.rs:137-178`。
* 启动命令构造：`src/components/terminal/providerSession.ts:142-194`。

### 复现工具

* 在 `attach_snapshot`（`session.rs:233`）插入 trace：`payload.data.len()`、`payload.history.as_ref().map(|h| h.len())`、`cursor_row`、`cursor_col`。
* 可考虑把 wezterm `screen()` 的 alt-screen flag / scrollback_rows / physical_rows 一并打印。
* 前端 Shell 收到 snapshot 后打印长度与首字节 hex（用一次性临时 console.debug）。

### 潜在修复方向（待复现后选）

1. wezterm 序列化层：alt-screen 时合并主屏 + alt-screen 内容、或在 `last_content == None` 时回退发送原始 raw history（`output_buffer` 而非 wezterm 序列化）。
2. Shell 端兜底：snapshot.data 长度过短时再 query 一次或对 PTY 发 `\x1b[?25h` 等无副作用序列触发重绘。
3. 后端 `attach_snapshot` 为空时直接走老路径（已有的 `output_buffer` raw 回放）。

## Research References

* （待生成）`research/wezterm-term-altscreen.md` — wezterm-term 的 alt-screen 与 scrollback 行为。
* （待生成）`research/claude-cli-upgrade-prompt.md` — claude/codex CLI 升级提示的 ANSI 序列样本。

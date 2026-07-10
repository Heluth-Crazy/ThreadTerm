# ThreadTerm main 分支深度审查报告

## 总体结论

基于对 `main` 分支当前代码的静态深审，我认为这条分支**不适合直接进入发布**，但**适合在受控环境继续测试**，前提是先处理我在下文列出的第一阶段问题。原因不是代码风格，而是存在几类会在真实用户场景中暴露出来的系统级缺陷：一类会造成桌面端与移动端状态不一致；一类会在持续输出场景下引发明显性能退化；另一类会在 Windows / Linux 上让 overlay、hotkey、窗口焦点行为退化为“不可靠”甚至“基本不可用”。这些问题大多不是 happy path 测试能发现的，而是“本地看起来能跑、真实用户高频使用就出事”的类型。 fileciteturn52file0L1-L3 fileciteturn62file0L1-L3 fileciteturn68file0L1-L3 fileciteturn71file0L1-L3

当前代码最大的风险，我建议优先按下面五项理解：

- **输出驱动的全量状态同步风暴**：终端每个输出 chunk 会驱动 store 更新，而 store 又被持久化到 `localStorage`，`TerminalManager` 还会把全量 `cards` 重新 `syncCards` 到 mobile bridge；后端 `sync_cards` 又会广播全量 `snapshot` 和所有 live card 的 `terminal_snapshot`。这条链路会把“终端正常输出”放大成“本地存储写风暴 + React render 风暴 + bridge 消息风暴”。 fileciteturn52file0L1-L3 fileciteturn42file0L1-L3 fileciteturn43file0L1-L3 fileciteturn81file0L1-L3
- **移动端退出状态映射与桌面端不一致**：后端把 `None` / `null` 退出码当成 `Idle`，桌面端也按 `idle` 处理；但移动端 reducer 却把 `null` 退出码映射为 `completed`。这会直接制造跨端状态错乱。 fileciteturn91file0L1-L3 fileciteturn53file0L1-L3 fileciteturn62file0L1-L3
- **非 macOS 的 overlay/hotkey 前台化能力基本未实现**：`platform.rs` 在非 macOS 上把窗口前置、激活、焦点相关函数全部做成 no-op，而命令层又依赖这些函数来拉起 selector/float。Windows / Linux 下这会直接表现成热键触发后窗口不抢前台、不拿焦点、浮窗不可靠。 fileciteturn66file0L1-L3 fileciteturn68file0L1-L3 fileciteturn71file0L1-L3
- **隐藏终端长期常驻，访问过的卡片会持续占用 xterm / listener / scrollback 内存**：`TerminalManager` 会把访问过的 `TerminalView` 永久保留到删除卡片为止；`Shell` 即使在 `active = false` 时仍保持连接并写入隐藏 xterm。会出现“看不见但一直在渲染”的隐性内存和 CPU 消耗。 fileciteturn43file0L1-L3 fileciteturn94file0L1-L3 fileciteturn48file0L1-L3 fileciteturn49file0L1-L3
- **移动端 transcript 数据结构和重放路径在高频输出场景下会退化**：`appendTerminalMessage` 每条消息都在全数组上做 filter / rebuild，`MainTerminal` 每次更新又会扫描整个保留 transcript；关闭卡片后 transcript 也没有按 `card_removed` / `close_result` 做内存回收。这在“多会话 + 长时间连接”的真实场景里很容易演化成滚动卡顿和 heap 增长。 fileciteturn57file0L1-L3 fileciteturn63file0L1-L3 fileciteturn64file0L1-L3

我的发布判断是：**不建议直接合并到准备发布的分支；建议先做第一阶段修复，再进入回归测试；目前更适合作为“修复前的内部验证版”而不是“可对外稳定版”。** fileciteturn75file0L1-L3 fileciteturn76file0L1-L3

## 严重问题列表

**问题一｜Critical｜确定缺陷**

**类型：** 性能 / 生命周期 / 回归风险

**位置：** `src/components/terminal/TerminalEventBridge.tsx`、`src/stores/terminalStore.ts`、`src/components/terminal/TerminalManager.tsx`、`src-tauri/src/bridge/mod.rs`。`TerminalEventBridge` 在每个 `pty-output` 到达时调用 `updateCardOutput` 与 `updateCardReplyPreview`；`terminalStore` 通过 Zustand persist 把 `cards` 等状态写入 `localStorage`；`TerminalManager` 在 `cards` 变化后把整批 `CardMeta[]` 重新 `syncCards` 到后端；后端 `sync_cards` 又广播全量 `snapshot` 并给所有 live card 再发 `terminal_snapshot`。 fileciteturn52file0L1-L3 fileciteturn53file0L1-L3 fileciteturn42file0L1-L3 fileciteturn43file0L1-L3 fileciteturn81file0L1-L3

**现象：** 用户一旦打开会持续刷新的 AI CLI 或 TUI，会看到桌面端输入/滚动渐卡、移动端偶发 `backpressure` 恢复、bridge 消息暴增、设置页甚至无关 UI 也跟着频繁 render。移动端如果连着，网络层和 UI 层的负担会被进一步放大。 fileciteturn52file0L1-L3 fileciteturn81file0L1-L3

**根因：** 这里把“易变的终端输出/预览状态”错误地放进了“持久化 store + 全量跨端同步”的路径里。终端输出不是低频业务状态，但当前实现把每个输出 chunk 都当成了需要持久化、需要全量镜像、需要广播 snapshot 的事件。 fileciteturn42file0L1-L3 fileciteturn43file0L1-L3 fileciteturn81file0L1-L3

**复现方式：**  
在桌面端开 2 到 3 个会持续输出的会话，例如持续刷日志、不断生成 token 的 AI CLI，保持移动端已连接。然后观察：

1. DevTools Performance 中主线程会出现密集的 `setState` / `localStorage` / JSON 序列化热点。  
2. WebSocket 消息里会看到高频 `snapshot` / `terminal_snapshot`，而不只是必要的 `terminal_output` / `preview`。  
3. 移动端容易出现恢复性 snapshot、滚动不稳或“明明只是输出，整页都在刷新”的观感。 fileciteturn43file0L1-L3 fileciteturn81file0L1-L3

**影响范围：** 桌面端终端页、卡片概览、底部栏、移动端会话总览、移动端终端详情、bridge 后端广播、回归测试稳定性，都会被这个问题牵连。它既是性能问题，也是状态架构问题。 fileciteturn43file0L1-L3 fileciteturn57file0L1-L3

**建议修复：**  
先把状态拆层：

- 将 `lastOutput`、`lastReplyPreview`、`recentOutputBytes`、实时 transcript 等高频变化数据从持久化 store 中拆走，至少不要按 chunk 写入 `localStorage`。  
- `mobileBridge.syncCards` 不能再跟随整个 `cards` 数组变化自动触发。应只在创建/删除/显著元数据变化时发 `card_added` / `card_updated` / `card_removed`，实时内容继续走已有的 `preview`、`terminal_output`、`state` 增量流。  
- `bridge::sync_cards` 不应在每次镜像更新后额外广播全部 live card 的 `terminal_snapshot`；`terminal_snapshot` 应保留给初次附着、重连恢复或明确 backpressure recovery 场景。 fileciteturn81file0L1-L3

**建议测试：**  
做一个“输出压力回归”：

- 10 秒内向单会话写入 10k 小 chunk；  
- 统计 `localStorage` 写入次数、`bridge_sync_cards` 调用次数、WS 消息数、移动端 `snapshot` 次数；  
- 断言这些指标在修复后显著下降。  

这条测试应该进入回归基线，而不是只做人眼体验验证。 fileciteturn43file0L1-L3 fileciteturn81file0L1-L3

**问题二｜High｜确定缺陷**

**类型：** 隐含缺陷 / 生命周期 / 跨端状态不一致

**位置：** `src-tauri/src/pty/events.rs`、`src/components/terminal/TerminalEventBridge.tsx`、`mobile-app/src/bridge/messages.ts`。后端把 `None` 退出码视作 `Idle`；桌面端注释明确说明 `null/undefined` 代表“人为 kill / remount / 非真实失败”，因此不应变成失败；但移动端 reducer 却把 `null` 也映射成 `completed`。 fileciteturn91file0L1-L3 fileciteturn53file0L1-L3 fileciteturn62file0L1-L3

**现象：** 同一个会话在桌面端可能显示 `idle`，移动端却显示 `completed`。更糟的是，移动端会基于这个错误状态决定是否显示“恢复”入口、是否允许发送输入、列表状态徽标是什么。这个故障非常用户可见，而且是“同一会话跨设备说法不一致”。 fileciteturn62file0L1-L3

**根因：** 移动端 `exit` 分支单独做了一份状态推导逻辑，但它没有与桌面端 / 后端的状态语义对齐。这里不是显示层偏差，而是状态机分叉。 fileciteturn62file0L1-L3 fileciteturn53file0L1-L3

**复现方式：**  
造一个 `exit` 消息：`{ kind: 'exit', card_id, code: null }`。桌面端会把这种退出当作 `idle` 类处理；移动端会把它显示为 `completed`。如果再触发返回后重入，移动端会稳定保持这个错误状态，直到后续 snapshot 或 card 更新把它覆盖。 fileciteturn53file0L1-L3 fileciteturn62file0L1-L3

**影响范围：** 移动端会话列表、详情页恢复条、跨端状态同步、断线重连后一致性。它还会污染人工测试判断，因为测试者可能误以为“桌面是 idle、手机是 completed”只是时序延迟，实际上是逻辑矛盾。 fileciteturn58file0L1-L3 fileciteturn62file0L1-L3

**建议修复：**  
移动端 `exit` 逻辑必须与后端统一：`code === null` 时应回到 `idle`，或者更保守一些，根本不要在 reducer 里重复推导退出状态，而是只等待后端 `state` / `card_updated` / `snapshot` 的权威状态。后者更稳。 fileciteturn62file0L1-L3

**建议测试：**  
至少补三条：

- reducer 单元测试：`exit(null)` 必须是 `idle`；  
- bridge 集成测试：同一卡片收到 `exit(null)` 后，桌面和移动最终状态一致；  
- E2E：移动端返回再进入后，状态不能从 `idle` 漂移成 `completed`。 fileciteturn62file0L1-L3

**问题三｜High｜确定缺陷**

**类型：** Windows 适配 / 窗口焦点 / 热键

**位置：** `src-tauri/src/overlay/hotkey.rs`、`src-tauri/src/overlay/commands.rs`、`src-tauri/src/overlay/platform.rs`。`hotkey.rs` 明确把“热键后必须由 Rust 直接做 OS 级 show/focus/front”写成了设计要求；但 `commands.rs` 在非 macOS 路径只做 `show()` 加一个 `order_overlay_window_front()`；而 `platform.rs` 对非 macOS 的 `order_overlay_window_front`、`activate_float_window_for_keyboard` 全部是空实现。 fileciteturn66file0L1-L3 fileciteturn68file0L1-L3 fileciteturn71file0L1-L3

**现象：** 在 Windows / Linux 上，用户从别的应用里按全局热键时，selector/float 可能显示在后台、不抢前台、不接收键盘焦点，或者需要再额外点击一次才能输入。对 overlay 来说，这等于核心交互链路不可靠。 fileciteturn68file0L1-L3 fileciteturn71file0L1-L3

**根因：** 架构上把 macOS 的窗口前置、激活、跨 Space 行为做了完整实现，但 non-macOS 分支基本只有“把窗口创建出来”，没有把真正的前台化和焦点拿到手。也就是说，代码路径存在，但系统行为没有闭环。 fileciteturn67file0L1-L3 fileciteturn71file0L1-L3

**复现方式：**  
在 Windows 上打开另一个前台程序，把 ThreadTerm 放后台。按 Hotkey A/B：

1. 观察 selector / float 是否稳定跑到最前；  
2. 观察是否无需鼠标点击就能接受键盘；  
3. 再测试 float 中终端输入是否直接生效。  

按当前实现，我会把它判为高概率失败或不稳定。 fileciteturn66file0L1-L3 fileciteturn68file0L1-L3 fileciteturn71file0L1-L3

**影响范围：** Windows / Linux 的 overlay、selector、float、全局热键、窗口焦点、终端输入可用性。尤其是用户预期“我在别的应用里按热键，浮层立刻到前面”时，这会直接破坏产品承诺。 fileciteturn66file0L1-L3

**建议修复：**  
不要把 non-macOS 当成“show 一下就够了”。必须补齐：

- selector / float 的 `show + unminimize + focus` 链路；  
- Windows 下必要时采用更明确的前台化策略，而不是依赖 `show()` 的隐式行为；  
- float 打开后要确保终端可立即输入，而不是等待二次点击。 fileciteturn68file0L1-L3 fileciteturn71file0L1-L3

**建议测试：**  
这条一定要做真实 Windows 手工验证和自动化冒烟，不要只看 macOS。测试矩阵至少覆盖：

- 前台是其它 app 时触发热键；  
- selector 打开、关闭、再次打开；  
- 从 selector 进入 float 后立即输入；  
- Hotkey B 回收回主窗口。  

当前仓库里的 Playwright 配置只覆盖 `mobile-app/e2e`，不覆盖任何桌面 overlay / hotkey / Windows 场景。 fileciteturn75file0L1-L3

**问题四｜High｜高风险缺陷**

**类型：** 性能 / 生命周期 / 内存增长

**位置：** `src/components/terminal/TerminalManager.tsx` 与 `src/components/Shell.jsx`。`TerminalManager` 的 `mountedIdsRef` 会把访问过的卡片长期保留，只有删除卡片时才清理；而 `Shell` 在隐藏时并不会断开 PTY，也不会停止对 `pty-output` 的写入。 fileciteturn43file0L1-L3 fileciteturn94file0L1-L3 fileciteturn48file0L1-L3 fileciteturn49file0L1-L3

**现象：** 用户如果依次打开很多卡片，再回到 grid，这些“已访问过”的终端其实还都活着：xterm、scrollback、ResizeObserver、focus/visibility listener、PTY 订阅都在。会出现内存持续涨、CPU 维持偏高、切卡越久越重的问题。真实用户往往不是只开一个终端，所以这个问题迟早会遇到。 fileciteturn94file0L1-L3 fileciteturn49file0L1-L3

**根因：** 当前设计是“用常驻挂载来避免 PTY 重新初始化”。这能规避重连问题，但代价是把所有访问过的终端都变成长期常驻渲染对象，而且是 hidden 但仍处理输出的对象。它解决了一个问题，同时引入了另一个更隐蔽的性能问题。 fileciteturn94file0L1-L3 fileciteturn48file0L1-L3

**复现方式：**  
连续创建并访问 8 到 10 个持续输出的会话，然后回到 grid，不关闭卡片。此时：

- `document.querySelectorAll('.xterm').length` 会接近访问过的卡片数；  
- CPU 不会回到单卡水平；  
- 内存会随着每个卡片的 scrollback 和 DOM 继续增长。  

如果再加 float window，同一 PTY 还会有额外 xterm 实例参与渲染。 fileciteturn46file0L1-L3 fileciteturn94file0L1-L3

**影响范围：** 桌面端所有高并发终端场景，尤其是多 AI session、日志监控、工作流批量运行时。问题初期表现像“偶发卡”，但根因是架构性的。 fileciteturn46file0L1-L3 fileciteturn48file0L1-L3

**建议修复：**  
把“PTY 生命周期”和“xterm 渲染生命周期”分离：

- PTY 仍可保活，但 hidden `TerminalView` 不应长期维持完整 xterm 实例；  
- 只保留当前聚焦卡与必要的 overlay 卡；其余会话用 backend snapshot + lazy attach 恢复；  
- 若短期不重构，至少引入 hidden card 上限和 LRU 淘汰策略。 fileciteturn89file0L1-L3 fileciteturn94file0L1-L3

**建议测试：**  
做“多卡压力测试”：

- 打开 10 个 busy session；  
- 依次访问后回到 grid；  
- 记录 JS heap、DOM 节点数、`.xterm` 数量、CPU 占用、首帧恢复时间；  
- 断言 hidden 会话数量和内存都被控制在阈值内。  

**问题五｜Medium｜确定缺陷**

**类型：** 性能 / 移动端 / 内存泄漏

**位置：** `mobile-app/src/terminalTranscript.ts`、`mobile-app/src/MainTerminal.tsx`、`mobile-app/src/App.tsx`。移动端 transcript 追加逻辑对每条消息都重建数组；`MainTerminal` 对每次更新都会重新扫描保留消息；`App` 里的 `terminalMessages` 只在收到 `terminal_output` / `terminal_snapshot` 时更新，却没有在 `card_removed` / `close_result` 时按卡片清理 transcript。 fileciteturn57file0L1-L3 fileciteturn63file0L1-L3 fileciteturn64file0L1-L3

**现象：** 长时间连接移动端、跨很多会话来回切换后，移动端 detail / preview 会越来越重。即使卡片已经被桌面删除，其 transcript 也可能仍驻留在前端内存里，直到页面整次刷新。 fileciteturn57file0L1-L3 fileciteturn64file0L1-L3

**根因：** transcript 设计成一个全局数组，并不是按 `cardId` 做真正的数据分桶；同时不存在删除卡片后的显式回收。再叠加 `MainTerminal` 的“每次都遍历 retained messages”策略，复杂度会随着使用时长上升。 fileciteturn63file0L1-L3 fileciteturn64file0L1-L3

**复现方式：**  
保持移动端在线，桌面端创建/删除大量卡片，并让多个卡片产生输出。然后反复“返回列表 → 重新进入详情”，观察切入详情的迟滞和 heap 变化。极端情况下，旧卡片 transcript 仍会占着内存。 fileciteturn57file0L1-L3 fileciteturn64file0L1-L3

**影响范围：** 移动端会话列表、详情页、返回再进入、长连接使用场景。这个问题短期未必报错，但会让滚动和重进体验越来越差。 fileciteturn58file0L1-L3

**建议修复：**  
把 transcript 改成按 `cardId` 存储的 ring buffer / map，并在 `card_removed`、`close_result`、明确换卡时及时裁剪；`MainTerminal` 也应从“扫描全局数组”改为“只处理当前卡片的增量队列”。 fileciteturn63file0L1-L3 fileciteturn64file0L1-L3

**建议测试：**  
补一个“100 次卡片创建/关闭循环”的移动端内存回归测试，在每 20 次后取 heap snapshot，断言旧 transcript 对象数量不会线性增长。  

## Windows 专项审查

Windows 路径里，我认为有三类问题最值得单独拎出来：**窗口/热键行为、shell/PTY 假设、网络与恢复细节**。

首先是**窗口与热键**。代码把 overlay 热键的目标写得很清楚：需要在别的 app 当前台时，也能把 ThreadTerm 的 overlay 拉到最前并获得键盘焦点；但 non-macOS 分支的窗口前置和焦点函数全是空实现，命令层既没有补 `set_focus()`，也没有补 Windows 特有的前台化兜底。因此，Windows 下最容易出问题的不是热键“能不能注册”，而是“注册成功后窗口是否真的可用”。这是我在整个 Windows 审查里最确定、也最危险的一条。 fileciteturn66file0L1-L3 fileciteturn68file0L1-L3 fileciteturn71file0L1-L3

其次是**shell 和 PTY 假设**。`default_shell()` 在 Windows 只在 `powershell.exe` 和 `cmd.exe` 之间二选一，没有遵循 `COMSPEC`，也没有优先考虑很多开发者真实在用的 `pwsh.exe`。这不一定立刻崩，但会在用户依赖 PowerShell Core、自定义 shell、企业镜像环境时产生“明明系统里 shell 可用、ThreadTerm 却起不对”的兼容问题。再结合 `portable_pty` 的 Windows 路径和 Ctrl-C / Enter / Esc 的差异，真实风险点不在“能否 spawn”，而在**交互细节是否一致**。这条我判定为**高风险疑点**，建议真实 Windows 机器验证，而不是凭单机猜。 fileciteturn87file0L1-L3 fileciteturn88file0L1-L3

再次是**路径、网络地址与恢复**。新建会话时后端直接拿前端传入的 `working_dir` 去 `cmd.cwd()`；如果移动端或者桌面端录入的是不适合当前平台的路径，spawn 会直接失败。这个问题本身不“神秘”，但在 Windows 上更容易被触发，因为路径格式和分隔符与 macOS/Linux 完全不同。同时，bridge 的 `public_host_for_url()` 只有 macOS 才会尝试从默认路由命令读网卡；Windows / Linux 默认只能走 UDP 探测到 `8.8.8.8` 的办法。企业 VPN、离线网段或安全策略较严的环境里，这个推断可能并不稳定。这里我建议列为**需要验证的疑点**。 fileciteturn82file0L1-L3 fileciteturn83file0L1-L3 fileciteturn86file0L1-L3

如果我要给出 Windows 下最可能不兼容的代码路径清单，会是下面这些：

- `src-tauri/src/overlay/platform.rs` 的 non-macOS 空实现：热键、selector、float 前置焦点。 fileciteturn71file0L1-L3
- `src-tauri/src/overlay/commands.rs` 的 `overlay_show_selector` / `overlay_show_float`：show 了但没真正保证前台和键盘焦点。 fileciteturn68file0L1-L3
- `src-tauri/src/pty/shell.rs` 的 `default_shell()`：只认 `powershell.exe` / `cmd.exe`。 fileciteturn87file0L1-L3
- `src-tauri/src/pty/mod.rs` 的 `pty_create()`：直接吃 `working_dir`，没有平台层路径校验和更友好的错误归类。 fileciteturn88file0L1-L3
- `src-tauri/src/bridge/mod.rs` 的 `public_host_for_url()` / `udp_route_ipv4_for_url()`：在非 macOS 环境对 LAN 地址推断依赖更脆弱。 fileciteturn82file0L1-L3 fileciteturn83file0L1-L3

## 性能专项审查

从性能角度看，这个仓库当前最危险的，不是某一个 `useMemo` 没写好，而是**终端输出驱动的全链路放大**。

桌面端的第一条热点是：**输出 chunk → store 变更 → persist → React render → mobile sync → bridge snapshot 广播**。这会把原本应该局限在“终端内容变化”的事件，扩散到“主线程 I/O、跨端协议、状态镜像、移动端重放”四套系统。对 AI CLI 这种高频流式输出尤其致命，因为它们最喜欢一小段一小段地刷。 fileciteturn52file0L1-L3 fileciteturn42file0L1-L3 fileciteturn43file0L1-L3 fileciteturn81file0L1-L3

桌面端第二条热点是：**访问过的终端长期常驻**。这意味着你不能只看“当前视图的 xterm 渲染成本”，而要看“所有访问过的 hidden xterm 的总成本”。如果一个用户在半天内访问过 12 个 busy card，这 12 个 card 的 xterm 和 scrollback 都还在。这个模式对于少量低频卡片问题不大，但对多 agent / 多日志流场景会迅速恶化。 fileciteturn94file0L1-L3 fileciteturn48file0L1-L3

移动端的第一条热点是：**transcript 数据结构不适合长会话**。当前实现不是“按卡增量消费”，而是“全局数组 + 每次 filter / rebuild + xterm 再扫一遍”。这在小样本里不明显，但一旦接入真实 bridge、多个会话长期在线，滚动和返回再进入自然会被拖慢。 fileciteturn63file0L1-L3 fileciteturn64file0L1-L3

移动端的第二条热点是：**mock 场景比真实 bridge 平滑得多**。现有 E2E 里 `MockWebSocket` 和固定 snapshot 很适合验证功能，但它们不会暴露出真实网络抖动、长时间连接、多个 card 并发输出、桌面/移动双端同时在线时的节奏问题。所以移动端已经有一些不错的 happy path 与恢复路径覆盖，但对“压力下是否还顺”仍然偏乐观。 fileciteturn76file0L1-L3 fileciteturn77file0L1-L3

我建议把性能验证方法做成明确的“可测量指标”，而不是只看主观卡不卡：

- **桌面端主线程指标**：统计每秒 `localStorage` 写入次数、每秒 `bridge_sync_cards` 次数、每秒状态序列化耗时。  
- **bridge 指标**：统计 WS 每秒消息数，分别看 `snapshot`、`terminal_snapshot`、`preview`、`terminal_output` 的配比。  
- **xterm 指标**：统计页面中 `.xterm` 实例数、hidden xterm 数、每个实例 scrollback 行数。  
- **移动端指标**：记录 detail 页 FPS、列表切回详情首帧耗时、不同使用时长下 heap 增长斜率。  
- **压力脚本方向**：单会话 10k 小 chunk、3 会话并发流式输出、50 卡创建/关闭循环、返回后台再恢复、删除会话同时仍有消息流入。  

这些指标完全可以从当前代码路径上挂点拿到，而且非常适合作为回归阈值。 fileciteturn43file0L1-L3 fileciteturn57file0L1-L3 fileciteturn64file0L1-L3

## 回归测试建议

当前仓库并不是“没有测试”。相反，移动端已经有一套覆盖预览、详情、backpressure 恢复、reconnect snapshot、增量 `card_added` / `card_removed` 的 Playwright 测试；但它们主要运行在 `mobile-app/e2e`，并使用 `MockWebSocket` 和 route mock，属于**相当好的前端协议层 happy path / 半集成测试**，还不能替代真实桌面 bridge、真实 PTY、真实 Windows 窗口系统的回归。 fileciteturn75file0L1-L3 fileciteturn76file0L1-L3 fileciteturn77file0L1-L3 fileciteturn78file0L1-L3

我建议把“最小但有效”的测试清单拆成四层。

**单元测试**

- `mobile-app/src/bridge/messages.ts`：补 `exit(null) => idle`，并覆盖 `close_result` / `card_removed` 后 transcript 需要裁剪的逻辑。 fileciteturn62file0L1-L3
- `src-tauri/src/bridge/mod.rs`：补“预览更新不应触发全量 snapshot storm”的设计测试，至少先把行为定下来。 fileciteturn81file0L1-L3
- `src/components/terminal/TerminalManager.tsx`：补 hidden mount 策略测试，防止 mounted card 无限增长。 fileciteturn43file0L1-L3 fileciteturn94file0L1-L3
- `src-tauri/src/overlay`：补 non-macOS 路径的窗口前置/聚焦 helper 测试，不要让它继续是“空实现默认通过”。 fileciteturn71file0L1-L3

**集成测试**

- 桌面端真 bridge + 真 PTY：持续输出时，验证不会每 100ms 广播全量 `snapshot + terminal_snapshot`。 fileciteturn81file0L1-L3
- 桌面端删除会话时仍有残余消息流入，验证移动端最终状态不反弹。  
- 同一卡片同时被桌面主窗口、float、移动端观察时，验证不会出现状态翻转或 transcript 覆盖。 fileciteturn46file0L1-L3 fileciteturn68file0L1-L3

**E2E**

- **移动端发送消息后返回再进入**：这条必须用真实 bridge，而不是只用 mock WS，因为当前最危险的问题就在状态同步和消息密度。  
- **卡片概览同步**：桌面端输出、移动端会话列表 summary、删除/恢复后的列表一致性。  
- **桌面端设置页**：启动 / 关闭 mobile bridge、切换 bind host、pair QR 后 host 是否合理。 fileciteturn86file0L1-L3
- **Windows 启动和终端交互**：应用启动、热键、overlay 前置、在 float 中直接输入、Ctrl-C / Enter / Esc 行为。 fileciteturn66file0L1-L3 fileciteturn68file0L1-L3 fileciteturn87file0L1-L3

**手工验证**

- iPhone Safari / Android Chrome 真机：后台切换、返回再进入、弱网恢复。  
- Windows 11：PowerShell、cmd、路径包含空格、快捷键冲突、前台其他 app 时热键拉起。  
- 多会话压力：至少 5 个持续输出会话，观察内存、hidden xterm 数、移动端 scrolling。  
- 删除会话时仍在输出、bridge 断开后重连、应用重启后恢复。  

如果只能先做一条最有价值的回归，我会选：**“桌面端开 3 个持续输出 session + 手机连着 + 返回后台再回来 + 删除其中一个 session + 再激活另一个 attachable session”**。这一条能同时覆盖状态同步、生命周期、性能和回归风险。  

## 优先修复路线

我建议把修复分成三个阶段推进，而不是一把梭把所有东西一起动掉。

**第一阶段**

先修**确定缺陷和消息风暴**。

要改的模块主要是：

- `mobile-app/src/bridge/messages.ts`
- `src/components/terminal/TerminalEventBridge.tsx`
- `src/stores/terminalStore.ts`
- `src/components/terminal/TerminalManager.tsx`
- `src-tauri/src/bridge/mod.rs`

目标非常明确：

- 修掉 `exit(null)` 的跨端状态错误；  
- 停止“终端输出驱动全量 persist + 全量 sync_cards + 全量 terminal_snapshot”；  
- 给实时预览和实时输出单独建立低成本通道。 fileciteturn52file0L1-L3 fileciteturn62file0L1-L3 fileciteturn81file0L1-L3

这一阶段的风险在于：你会触碰 store、bridge、移动端 reducer 三个核心同步点，比较容易引入“某一端不更新”类回归。所以验证方式要以**协议级日志**和**消息计数**为主，而不是只看 UI 大致能不能用。  

**第二阶段**

再修**Windows / Linux 的窗口与 shell 适配**。

要改的模块主要是：

- `src-tauri/src/overlay/platform.rs`
- `src-tauri/src/overlay/commands.rs`
- `src-tauri/src/overlay/hotkey.rs`
- `src-tauri/src/pty/shell.rs`

目标是：

- 让 non-macOS 的 selector / float 真正具备前台化和焦点可用性；  
- 明确 Windows 默认 shell 策略，不再只在 `powershell.exe` / `cmd.exe` 之间拍脑袋；  
- 补上真实 Windows 手工验证脚本。 fileciteturn66file0L1-L3 fileciteturn68file0L1-L3 fileciteturn71file0L1-L3 fileciteturn87file0L1-L3

这一阶段的主要风险是窗口焦点修复很容易反伤 macOS 现有行为，所以要严格做平台分支验证，不要为了 Windows 把 macOS 现有 overlay 行为改坏。  

**第三阶段**

最后做**终端渲染与资源生命周期重构**。

要改的模块主要是：

- `src/components/terminal/TerminalManager.tsx`
- `src/components/Shell.jsx`
- `mobile-app/src/terminalTranscript.ts`
- `mobile-app/src/MainTerminal.tsx`
- 以及必要的 backend snapshot 逻辑。 fileciteturn94file0L1-L3 fileciteturn48file0L1-L3 fileciteturn63file0L1-L3 fileciteturn64file0L1-L3

目标是：

- 把 PTY 常驻和 xterm 常驻解耦；  
- hidden card 不再长期持有完整渲染栈；  
- transcript 换成 per-card 增量 ring buffer；  
- 建立真正有压力门槛的回归测试。  

这一阶段风险最高，因为它最接近架构调整；但如果不做，后面会长期被“会卡、会涨、越用越重”困住。  

## 开放问题与局限

这份报告是基于当前 `main` 分支源码做的深度静态审查，不是基于真实 Windows / iOS / Android 设备跑出来的动态 trace。因此，下面几项我会明说为**需要现场验证**，而不是把它们伪装成 100% 已复现的结论：

- Windows 下默认 shell 是否需要从 `powershell.exe` 切到 `pwsh.exe` 或尊重 `COMSPEC`，这要结合目标用户环境来定。 fileciteturn87file0L1-L3
- 非 macOS 的 bridge 发布地址推断在 VPN / 企业网环境下是否稳定，需要真实网络环境验证。 fileciteturn82file0L1-L3 fileciteturn83file0L1-L3
- 多桌面实例并行启动带来的端口、热键和状态目录冲突，我在当前代码里没有看到明确的单实例防护证据，但这部分最好再做一次专门验证。 fileciteturn26file0L1-L3 fileciteturn99file0L1-L3

即便带着这些局限，我对前文列出的前四项风险判断仍然是高置信度的：它们已经在代码路径本身上形成了闭环证据，不需要等待线上事故才成立。
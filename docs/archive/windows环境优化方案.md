# ThreadTerm 在 Windows 上从 xterm.js 迁移到 TerminalControl 或 ConPTY-native 的深度研究

> 执行路线、验证门禁和后续方案选择规则见：
> [Windows Terminal Optimization Roadmap](./windows-terminal-optimization-roadmap.md)。

## 来源与结论摘要

基于 ThreadTerm 仓库现状、Microsoft 官方文档、Windows Terminal 官方架构说明、WinUI/XAML Islands/WebView2/Tauri 官方资料，可以先下一个很明确的判断：**你们现在在 Windows 上要讨论的，不是“要不要切到 ConPTY”，而是“要不要替换前端终端 renderer 与 UI host”**。原因很直接：ThreadTerm 的后端已经在 `src-tauri` 中依赖 `portable-pty = "0.8"`，并且 `pty_create` 里明确使用了 `portable_pty::NativePtySystem::default()`、`openpty()`、`spawn_command()`；与此同时，ConPTY 官方文档说明，pseudoconsole 负责的是把字符模式程序暴露给外部宿主，**宿主自己负责显示输出、采集输入**。换句话说，ConPTY 是 PTY/协议层，不是 UI renderer。citeturn22view0turn28view0turn31search5turn31search7

ThreadTerm 当前并不只是“xterm.js 直接写屏”这么简单。仓库里已经有一层比较重的 Rust 终端状态基础设施：后端维护 `TerminalSnapshot`、`history`、`cursor_row/cursor_col`、recent output、attach snapshot、session state、block parser、以及 output ack/backpressure；同时还通过 `tattoy-wezterm-term` 做终端仿真与快照序列化。这意味着无论 Windows 是否换成 native renderer，**你们仍然需要一层跨平台 TerminalAdapter / PtyEngine 抽象来保住 attachSnapshot、overlay、AI 会话恢复、移动端 bridge、浮窗与卡片预览这些上层能力**。citeturn22view0turn20view3turn27view5turn37view3turn37view4turn36view2

我给出的总建议是：**短期不要做“重写为 ConPTY-native stack”的大跃迁；最推荐的路线是先把问题定义为“Windows-only native renderer spike”，并保持 Rust portable-pty/ConPTY backend 不动**。也就是说，先做一个很小的、可回滚的 Windows spike 来验证 TerminalControl 或其他 native host 是否真的能在 Tauri 2 + WebView2 中稳定嵌入、正确处理 focus/IME/resize/copy/paste，并且不破坏卡片网格、浮窗、叠层与多实例布局。只有这个 spike 过线，才值得进入 Windows-only 的混合架构；如果 spike 失败，就回到方案 A，继续优化 xterm.js 管线，而不是误以为“改成 ConPTY”就能自动解决渲染、字体、IME 和无障碍问题。citeturn28view0turn32view0turn10view0turn9view0turn8search0

## 概念澄清

先把最容易混淆的四件事分开。

**ConPTY 是什么。** ConPTY 是 Windows 的 pseudoconsole 能力。官方定义是：它允许应用成为 character-mode 应用的 host；与传统 console session 不同，系统**不会**为 character-mode 应用创建宿主窗口，宿主应用必须自己负责显示图形输出和采集用户输入。ConPTY 的输入输出流是 UTF-8 与 Virtual Terminal Sequences。它解决的是 shell/CLI 子进程与宿主之间的 PTY 桥接问题。citeturn31search5turn31search7turn31search0

**TerminalControl 是什么。** 从 Microsoft 官方对 Windows Terminal 架构的说明看，Windows Terminal 被拆成 Win32 外壳、`TerminalApp`、以及单独的 `TerminalControl` 项目。官方 2020 年文章明确说过：`TerminalControl` 是 Windows Terminal 解决方案中的独立项目，`TerminalApp` 负责 tabs/panes/settings 等应用逻辑，而 `TerminalControl` 是它的 terminal widget；Windows Terminal 之所以性能高，是因为它没有走普通 XAML 文本元素，而是把自定义 DirectX 文本 renderer 接到 XAML 的 `SwapChainPanel` 上。citeturn32view0

**Windows Terminal 本身是不是 TerminalControl + ConPTY。** 结论是：**可以这么理解，但要谨慎**。官方文章说，Terminal 团队当时先把 ConPTY 做到“足以作为 console 与 terminal app 之间的 translation layer”，再用它去驱动新的终端体验；官方又把 Windows Terminal 描述为 “modern host application”，并强调其多标签、多窗格、Unicode/UTF-8、GPU accelerated text rendering。也就是说，Windows Terminal 里至少同时有两个层面：其一是 ConPTY/console plumbing，其二是 `TerminalControl`/renderer/UI 层。前者解决 shell I/O，后者解决显示、交互、选择、GPU 文本渲染与应用 UI。citeturn32view0turn38view0turn31search5

**ThreadTerm 现在在 Windows 上是不是已经用了 ConPTY。** 按你给出的项目背景，再结合 ThreadTerm 仓库当前实现，答案应视为“是，至少已经在用 Windows native PTY path，而不是从零开始的 pseudo-terminal 方案”。仓库里 `pty_create` 明确通过 `NativePtySystem::default()` 打开 PTY，并把 shell 挂上去。考虑到 ConPTY 官方职责正是“让第三方 terminal host 成为 character-mode app 的宿主”，所以现在真正待决策的空间主要不在 PTY API 这一层，而在**renderer、输入法、selection、scrollback、buffer inspection、native host** 这一层。citeturn28view0turn31search5turn31search7

因此，**“切到 ConPTY”这个提法在 ThreadTerm 语境下不准确**。更准确的说法是：
一是保留现有 Rust PTY backend，只换渲染/输入层；
二是把 Windows 的终端 UI 换成 Windows Terminal 的 native stack；
三是把你们当前依赖 xterm 内部 buffer 的上层功能改造成跨 renderer 的能力抽象。citeturn28view0turn32view0turn20view3turn37view4

## 方案对比

**方案 A：保留 Rust portable-pty/ConPTY backend，只优化 xterm.js 渲染和输出管线。**
这是成本最低、回滚最容易、对 macOS 几乎零扰动的方案。它直接匹配 ThreadTerm 现有架构：前端确实使用 `@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-webgl`、`@xterm/addon-web-links`；后端已经有 batch state、recent output、snapshot、ack/backpressure、block parser、多窗口 attach 能力，所以可以先从“减少 `term.write()` 频次、把 buffer inspection 尽量后移到 Rust snapshot 层、优化 ack 阈值、降低 React 与 terminal DOM 的耦合、对预览卡片改用 snapshot 而非 live xterm 实例”这些点下手。ThreadTerm 当前的 PTY 基础能力其实已经为这种优化准备了足够多的抓手。这个方案解决不了原生 DirectWrite 字体锐度、原生 IME、一部分复杂文字与 OS accessibility 上限，但它能显著降低你们进入 Windows-only 深水区之前的系统性风险。citeturn20view1turn28view0turn37view0turn37view1turn37view3turn36view2

**方案 B：Windows 平台引入 TerminalControl，替代 xterm.js renderer，但继续使用你们自己的 Rust PTY backend。**
这是最值得做 spike、但不应直接承诺量产的路线。它的吸引力在于：Windows Terminal 官方明确提供 Unicode/UTF-8、GPU accelerated text rendering、主题/配色/快捷键等终端体验；Windows Terminal 自己的架构也证明 `TerminalControl` 是为高性能 UI 呈现而存在。理论上，它正好瞄准你列出的痛点：大日志、TUI、字体锐度、IME、无障碍和 Windows 视觉系统集成。问题在于，**Microsoft 官方并没有把它作为一个稳定、公开、文档化的 embeddable control 提供给外部桌面框架**。官方在 2020 年仍然说“希望未来把 TerminalControl 单独 spin out 成 NuGet package”，而我在本次检索的官方 Learn / Windows Terminal 文档里也没有看到一个正式对外承诺的 public embedding API。换句话说，它在技术方向上很对，但在产品化可集成性上目前证据不足。citeturn32view0turn38view0

**方案 C：Windows 平台完全改为 Windows Terminal / ConPTY native stack，包括 renderer、输入、selection、scrollback、IME。**
这是技术上最激进、也是我最不建议直接投入主线的方案。原因不是它做不到，而是它会迫使你们重新定义 ThreadTerm 的边界：你们现在大量共享特性已经不只依赖 PTY 数据流，还依赖可读取的 buffer/snapshot 语义、attachSnapshot、recent output、block overlay parser、跨窗口 attach、移动端 bridge。一旦 Windows 走整套 native terminal stack，macOS/Linux 仍然保留 xterm.js，这些共享能力就会出现“双实现”或“最低共同能力”问题。尤其是 selection API、scrollback read、visible range、cursor introspection、marker/block overlay 这类能力，在公开资料中我没有看到 TerminalControl 对外提供稳定 API 的证据，因此你很可能还是要继续保留一套 Rust emulator/snapshot 层。那样一来，方案 C 带来的收益就没有想象中大，但复杂度会显著上升。citeturn37view3turn37view4turn26view8turn26view10turn36view2turn32view0

**方案 D：混合架构，Windows 使用 native renderer，macOS/Linux 继续 xterm.js。**
这是中长期最现实的目标状态。它承认一个事实：Windows 的原生文本渲染、IME、无障碍、Fluent/Mica/Acrylic 集成在宿主能力上确实比 WebView terminal 更有潜力；但同时又不要求你们为 macOS/Linux 推倒重来。前提是必须把当前“xterm 既是 renderer 又是能力源”的设计拆开，让 shared feature 面向 `TerminalAdapter` 与 `PtyEngine` 能力，而不是直接面向 xterm 实例。只要这一步做得干净，macOS 可以基本不动，Windows 可以增量替换。这个方案的主要成本不是 PTY，而是抽象层设计与 UI host 集成。citeturn20view3turn28view0turn8search0

**方案 E：改用 WezTerm/Alacritty/其他 GPU terminal renderer 作为嵌入核心。**
从产品能力上看，WezTerm 与 Alacritty 都是很强的终端：WezTerm 官方文档强调其跨平台、原生 scrollback、ligatures、color emoji、font fallback，并提供 OpenGL/WebGPU/Software 等前端；Alacritty 官方则直接把自己定义为“fast, cross-platform, OpenGL terminal emulator”。但从它们的官方文档呈现方式来看，它们是**终端应用**，不是“给 Tauri/React 内嵌的稳定 UI SDK”。WezTerm 甚至把功能暴露在配置、CLI、multiplexer、front_end 选择与 app 行为上；Alacritty 官方也主要是安装、配置与 app 特性。这意味着如果把它们当 ThreadTerm 内嵌核心，实际工程往往会落到“源码 vendor + 自己开接口”或者“把整个 native app 当子窗口/子进程来集成”，而不是“像换组件一样接入”。所以它们适合作为性能与渲染参考系，不适合作为你们当前项目的低风险嵌入替代。citeturn30search0turn30search1turn30search2turn30search9turn30search5turn30search10

如果把上述五项收敛成一句话：**最推荐的是“先做 A 的系统优化，同时做 B 的 Windows-only spike，并把目标架构设计成 D”；最不推荐的是直接跳到 C 或把 E 当作低成本嵌入替代。** citeturn20view1turn32view0turn30search0turn30search9

## TerminalControl 集成风险

这里先给结论：**从当前官方证据看，TerminalControl 不是一个我会称之为“稳定、推荐、可直接嵌入 Tauri 2 应用”的 public control。** 官方最接近“公开说明” 的材料，仍然是 Windows Terminal 团队 2020 年的架构博客；其中明确说明 Windows Terminal 的 UI 采用 Win32 外壳 + XAML Island + WinUI 2/UWP XAML 组件，`TerminalControl` 只是 Terminal 解决方案里的一个内部项目，而且团队当时只是“希望未来把它包装成 NuGet 包”。这对于研发 spike 足够有价值，但对产品级集成并不是一个强保证。citeturn32view0

从技术栈角度看，官方架构证据指向的是：**Windows Terminal 的 TerminalControl 历史上依赖 WinUI 2 / UWP XAML，并通过 XAML Islands 挂在 Win32 宿主里，而不是一个现成的 WinUI 3 官方控件。** 同时，Windows App SDK 官方说明的是 WinUI 3 与现代 Windows API 可以给现有 Win32/WPF/WinForms 应用增量引入能力；但 WebView2 官方又专门提醒，visual hosting 路径里的 `CreateCoreWebView2CompositionController` **不支持 WinAppSDK 的 `Microsoft.UI.Composition` visuals**。这意味着，如果你想在 Tauri + WebView2 的同一窗口里玩“Web 内容 + WinUI 3 composition 内容”的高度混排，官方路线本身就是有边界的。citeturn32view0turn34view3turn9view0

在 **Tauri 2 / WebView2** 里嵌入 TerminalControl，从“原则上能不能”看，不是绝对不可能。Tauri 官方 Rust API 允许你拿到平台 webview handle，也允许你拿到 window handle；WebView2 也明确说过它自己会在 parent HWND 下创建 child window，且 sibling z-order 会受到影响。XAML Islands 官方则说，C++ Win32 桌面应用可以用 UWP XAML hosting API，把 XAML 控件 host 到任何拥有 HWND 的 UI 元素里。这三个事实组合起来，说明你们**可以**在 Tauri 的 Rust 侧做原生宿主窗口/子窗口，然后把 native terminal content 放进去。问题在于，这个路径从一开始就不是 React DOM 那种“一个 `<div>` 里塞个组件”的体验，而是“让 Web 布局去协调一个原生 HWND/XAML Island/child window”的工程。citeturn10view1turn10view2turn10view3turn10view0turn33view0

这会直接带来你最关心的 UI 风险。首先，**React 的 z-index 不再是真正的唯一真相**。因为 WebView2 本身就是 child window，native terminal host 也很可能是另一个 child window；WebView2 官方已经提醒 sibling window order 会影响 z-order。第二，**滚动、拖拽、CSS transform、clip-path、透明背景、圆角、卡片网格过渡动画**，都不能再假定由浏览器排版系统自动帮你统一处理；你很可能要在 Rust 侧持续同步 native child window 的位置、大小、可见性和裁剪区域。第三，如果走 visual hosting 路线，WebView2 文档又明确要求宿主自己做 spatial input routing，并指出 WinAppSDK visuals 受限制；这会把输入、焦点、鼠标与触摸转发复杂化。citeturn10view0turn9view0turn33view0

多终端卡片场景尤其危险。Windows Terminal 官方文章说明 `TerminalApp` 确实支持同时 host 多个 terminal instance、标签和 panes，所以“多个控制同时存在”在产品内部不是概念性障碍。问题是，你们的 UI 不是传统 tab/pane，而是**卡片网格 + 预览 + 浮窗 + overlay + 选择器**。在这种模式下，如果你为每张 card 都挂一个 live native control，资源、焦点竞争、布局同步、预览缩略与遮挡管理都会明显重于“几个pane/tab”。因此我的工程判断是：**单卡 live native terminal 可行；多卡并发 live native terminal 作为主视图默认形态，不应先假定可行。** 更合理的做法是：grid 保持 snapshot/preview，真正 live 的 native terminal 只给当前激活卡片与浮窗。这个判断是基于 Windows Terminal 的多实例能力与 child-window host 模型做出的工程推论。citeturn32view0turn10view0turn33view0

关于 API 能力，要分成“产品内能力”和“外部可调用能力”两层看。产品层面，Windows Terminal 官方确认它支持 Unicode/UTF-8、GPU 文本渲染、主题与字体配置、多窗口/panes 等，因此你可以 reasonably 期待它在内部具备透明背景/主题同步/字体配置/selection/scrollback 这类终端交互能力。可是**外部 embedders 到底能拿到哪些 API**，官方并没有给出完整的 public reference。在我这次查到的公开资料里，没有看到一个文档化的 TerminalControl 外部 API 契约去保证 `read visible buffer`、`read scrollback range`、`get cursor position`、`selection range`、`marker`、`buffer inspection`、`programmatic write/input` 等接口对外稳定存在。因此，若你们要保住当前 `xtermRegistry` 那套能力，最稳妥的方案不是期待 TerminalControl 暴露它们，而是继续把这些能力沉到你们自己的 Rust emulator/snapshot 层。citeturn38view0turn32view0turn37view3turn26view8turn26view10

许可证与分发层面，**真正的阻碍不是“能不能商业分发”这个抽象问题，而是“你拿到的是不是一个官方支持的、打包路径清晰的可重用控件”**。Windows App SDK 官方资料说明，如果你引入它的能力，运行时无论 packaged 还是 unpackaged 都要考虑 runtime deployment；而 UWP XAML Islands 官方资料则指出，不打 MSIX 包时还需要 Visual C++ Runtime，且 C++ Win32 场景要直接用 hosting API。也就是说，只要你走 TerminalControl / WinUI / XAML Island 方向，安装、运行时、分发和升级链条都会更复杂。citeturn34view2turn34view3turn33view0

## 对 macOS 和共享能力的影响

如果你只在 Windows 上引入 native renderer，**macOS 功能上可以做到基本不受影响，但代码上不可能完全不动。** 真正要改的是抽象层：把“某个 React 组件内部直接持有 xterm 实例并向它读写”的模式，改成“上层功能依赖一个统一的 TerminalAdapter 能力接口”。只要这个边界做对，macOS 继续走 xterm.js 完全可行；如果边界做不对，Windows 的 native path 很快就会把 shared UI feature 撕成两套。citeturn20view3turn7search0

需要抽象出来的最小公共面至少包括三层。第一层是 **PtyEngine**：create/input/resize/kill/ack/attachSnapshot/recentOutput/sessionState，这部分你们其实已经有了。第二层是 **RendererAdapter**：attach/detach/focus/theme/font/copy/paste/selection。第三层是 **InspectionAdapter**：read visible buffer、read scrollback range、cursor position、searchable ranges、snapshot source。这第三层是关键，因为 ThreadTerm 当前很多“高级 UI”并不只是显示终端，而是在读终端状态。仓库里现成的证据是：后端已经维护 `PtyAttachSnapshot`、`LivePtySessionSnapshot`、`history`、`cursor_row/cursor_col`、以及 block parser 的 started/finished payload；这说明你们完全有条件把 inspection 能力从 xterm 内部迁出去。citeturn27view5turn37view3turn37view4turn36view2

你列出的共享功能里，受影响程度并不一样。

`terminal rendering component` 必改，而且是最先改。`pty bridge` 不一定大改，因为现有 backend 已经足够通用；Windows native path 仍可复用 `pty_create / pty_input / pty_resize / pty_ack / pty_attach_snapshot` 这批命令。`terminal snapshot` 反而应该提升到更核心的位置，因为它将成为 grid preview、second attach、float window attach、native/web 双 renderer 共享的真实状态源。`block parser / block overlay` 目前已经在 Rust 后端做了 OSC 133 / 6973 解析，天然适合继续做 shared feature，而不是绑在某个 renderer 上。citeturn27view5turn27view6turn36view2turn36view3

`xtermRegistry` 是最需要重构而不是机械移植的部分。它现在名字就已经暴露实现细节：如果 Windows 上不再用 xterm，这个 registry 应该退化成更中性的 `TerminalViewRegistry` 或 `TerminalAdapterRegistry`。里面只保留跨 renderer 的能力索引，比如当前挂载状态、focus 能力、复制粘贴能力、选择区能力、visible buffer 插槽、scrollback provider、snapshot source，而不是直接暴露 xterm 对象。这样 macOS 仍然映射到 xterm 实现，Windows 映射到 native 实现。citeturn20view3turn37view4

`headless preview`、`card preview`、`mobile bridge` 最好都不要依赖 live native control。ThreadTerm 现在已经有基于 Rust snapshot 的能力，继续沿这个方向做是对的：卡片预览要么用 ANSI snapshot，要么用后端序列化快照，要么用最后一帧位图，但不要让每个 preview 都需要一个真实 TerminalControl。这样既减少 Windows native path 的资源成本，也能保证移动端和 macOS 共用同一个“终端状态快照语义”。citeturn37view3turn26view8turn20view3

`floating terminal windows` 的改造成本中等偏高。好消息是 ThreadTerm 本来就有独立的 `float.html` / selector / main window 结构，README 也把 float window 作为独立 runtime entry 列出来，所以从窗口组织上你们已经有天然边界。坏消息是 Windows native terminal 如果走 child HWND/XAML Island，它更适合存在于“单一激活终端窗口”而不是卡片大网格中。因此浮窗其实是比较适合先试点 native renderer 的目标场景。citeturn20view3turn18view0

总体上，我对 macOS 的影响评级是：**低**。不是“无”，因为抽象层一定要改；但也不是“中高”，因为 macOS renderer 完全可以暂时维持 xterm.js，只要你不把 shared feature 写死在某个 renderer 私有 API 上。也因此，我非常建议**先做 Windows-only native renderer spike，而不是全平台重写。** citeturn7search0turn20view3turn28view0

## 分阶段迁移方案

**Phase 0：调研验证。**
目标是把问题从“是否重写”收敛成三个 yes/no：其一，Tauri 窗口里能否稳定挂一个原生 child host；其二，native host 能否跟随 React 布局正确 resize/reposition；其三，最小终端回显路径是否能跑通。代码范围主要在 `src-tauri` 新增 Windows-only 原生宿主实验代码，以及前端增加一个占位 `NativeTerminalHost`。风险在于你会很快暴露 HWND/z-order/focus 现实，而不是停留在概念层。对 macOS 无实质影响。验收标准是不要求 TerminalControl 真跑起来，只要求一个 native host 能在 Tauri 窗口中被正确创建、定位、显示与销毁，并拿到键盘焦点。测试需要一个 Windows-only smoke test、窗口尺寸变化测试、焦点切换测试。回滚方案就是删除实验模块，不触碰现有 xterm path。citeturn10view0turn10view1turn10view3turn33view0

**Phase 1：最小 Windows TerminalControl spike。**
目标是验证单卡片单终端会话：“打开 shell、输入文本、看到输出、resize 正确、copy/paste 基本可用”。代码范围包括 Windows-only host、与现有 `pty_create / pty_input / pty_resize` 对接的最小桥，以及一个仅单实例使用的 React wrapper。技术风险不在 shell，而在 control 的 hosting 与 public API 不明朗；如果 TerminalControl 本身无法以可维护方式嵌入，你会在这一阶段尽早失败。对 macOS 影响仍然很低。验收标准是不追求 block overlay、snapshot attach、多卡片，只要求单实例稳定运行 30 分钟、无明显焦点/IME 错乱。测试需要最小交互回归、窗口最小化/恢复、DPI 切换、复制粘贴、中文输入。回滚方案是保留接口壳子，Windows renderer 标记为 `experimentalNative=false`，默认退回 xterm。citeturn32view0turn10view0turn33view0turn34view3

**Phase 2：抽象 TerminalAdapter 接口。**
目标是把 renderer 与 shared feature 解耦，让上层不再直接碰 xterm 实例。代码范围最大，涉及前端 terminal component、registry、浮窗、选择器、卡片预览使用的能力入口；但这个阶段尽量不改变用户可见行为。技术风险是“抽象做浅了”，最后 native path 还是不得不回头改。对 macOS 的影响是低到中：功能不变，但需要把现有 xterm 逻辑包进 adapter。验收标准是现有 xterm 路径在抽象层之上仍然百分百可运行，并且所有核心测试不回退。测试需要 adapter contract tests、xterm adapter snapshot tests、跨窗口 attach tests、clipboard tests。回滚方案是保留新接口，旧组件仍可用 feature flag 临时直连 xterm。citeturn20view3turn27view5turn37view4

**Phase 3：替换单卡片终端渲染。**
目标是在 Windows 上让主视图中“当前激活的一张卡”走 native renderer，其他仍可继续走 xterm 或 snapshot preview。代码范围包括 card detail view、focus 管理、copy/paste/selection、font/theme 同步。风险是用户会开始真实感知 native/web 混合行为差异。对 macOS 影响低。验收标准是：Windows 激活卡片在大日志、TUI、中文输入、emoji、滚动时明显优于 xterm baseline；同时 attachSnapshot、recent output、session state 语义不变。测试需要性能基准、视觉对比截图、输入法回归、快捷键回归。回滚方案是 Windows 卡片 detail 退回 xterm adapter，抽象层保留。citeturn38view0turn37view3turn37view4turn28view0

**Phase 4：适配卡片网格、浮动窗口、preview、block overlay。**
目标是把 native path 接入你的真实产品结构，而不是 demo。我的建议不是给每张 card 都放 live native control，而是统一改成“grid 用 snapshot/preview，detail/float 用 live terminal”。这样可以最大程度控制资源与布局复杂度。代码范围涉及 overlay selector、floating terminal、preview 生成、block overlay 对齐、z-order 和命中测试。技术风险是 overlay 与 smoothing 动画的体验可能与 web 路径不同。对 macOS 的影响主要是共享 preview/snapshot 逻辑会上移，但渲染不变。验收标准是多窗口 attach 不丢状态、block start/finish 事件不回退、preview 与 live terminal 语义一致。测试需要 block parser 集成、float window attach、preview 一致性测试。回滚方案是 Windows 网格仍保留 web preview，不将 live native control 扩展到 grid。citeturn36view2turn36view3turn37view3turn20view3

**Phase 5：性能、IME、Unicode、字体、无障碍验收。**
目标是真正验证“为什么值得切”。代码范围以测试、仪表与修复为主。技术风险是你可能发现 native path 在某些场景确实更好，但在嵌入宿主、焦点、快捷键冲突、无障碍树或窗口切换上又引入新问题。对 macOS 无直接影响。验收标准不应是“感觉更顺”，而应是成体系的 benchmark 优势与零关键功能回退。测试需要大日志、10MB/100MB 输出、TUI、selection、CJK/emoji/bidi、IME 候选窗、小字号清晰度、多卡并发、CPU/GPU/内存采样。回滚方案是 renderer 保持实验开关，默认不开或仅对少量 Windows 用户开启。citeturn38view0turn34view1turn31search7

**Phase 6：决定保留还是移除 xterm.js fallback。**
我的建议是：**中期保留，长期再评估。** 因为 Windows native path 即使成功，macOS/Linux 仍需要 xterm；而且 Windows 上也可能需要 fallback 以覆盖旧机器、异常输入法环境、特定驱动或兼容性场景。代码范围是配置、实验开关、自动回退策略和异常 telemetry。技术风险最低，产品决策权重最高。对 macOS 无新增影响。验收标准是你们已经对 Windows native path 有足够置信度，且 adapter 层不会让 fallback 成本失控。测试需要 forced-fallback、upgrade/downgrade、老会话恢复。回滚方案天然存在：保留 xterm path 就是最好的回滚。citeturn7search0turn20view1

## TerminalAdapter 与边界设计

建议不要设计成“TerminalControlAdapter 直接接管一切”，而是拆成 **RendererAdapter + PtySessionHandle + InspectionProvider** 三段。原因是 ThreadTerm 当前不少能力不是 renderer 天生提供的，而是你们在 Rust 里自己维护的：recent output、attach snapshot、history、cursor、block events、session state、ack/backpressure。这个能力面其实已经天然适合做 shared core。citeturn27view5turn37view1turn37view3turn37view4turn36view2

下面是一份更可落地的 TypeScript 边界草案：

```ts
export type TerminalRendererKind = "xterm" | "windows-native";

export interface TerminalCapabilities {
  nativeIme: boolean;
  nativeSelection: boolean;
  nativeAccessibility: boolean;
  readVisibleBuffer: boolean;
  readScrollbackRange: boolean;
  getCursorPosition: boolean;
  snapshotRestore: boolean;
  transparentBackground: boolean;
  fontLigatures: boolean;
  bidiText: boolean;
}

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  ansi: string[];
  opacity?: number;
}

export interface TerminalFont {
  family: string;
  sizePx: number;
  lineHeight?: number;
  letterSpacing?: number;
  weight?: string | number;
}

export interface BufferCell {
  text: string;
  width: 1 | 2;
}

export interface BufferLine {
  row: number;
  cells: BufferCell[];
  wrapped?: boolean;
}

export interface BufferRange {
  startRow: number;
  endRow: number;
  lines: BufferLine[];
}

export interface CursorPosition {
  row: number;
  col: number;
}

export interface TerminalSnapshot {
  data: string;
  history?: string;
  rows: number;
  cols: number;
  cursorRow: number;
  cursorCol: number;
  seq: number;
}

export interface TerminalAdapter {
  readonly kind: TerminalRendererKind;
  readonly capabilities: TerminalCapabilities;

  create(sessionId: string): Promise<void>;
  destroy(): Promise<void>;

  attach(container: HTMLElement): Promise<void>;
  detach(): Promise<void>;

  focus(): Promise<void>;
  blur?(): Promise<void>;

  writeOutput(data: string, seq?: number): Promise<void>;
  sendInput(data: string): Promise<void>;
  resize(rows: number, cols: number): Promise<void>;

  copy(): Promise<void>;
  paste(text?: string): Promise<void>;
  clearSelection?(): Promise<void>;
  getSelectionText?(): Promise<string>;
  hasSelection?(): Promise<boolean>;

  updateTheme(theme: TerminalTheme): Promise<void>;
  updateFont(font: TerminalFont): Promise<void>;

  readVisibleBuffer?(): Promise<BufferRange>;
  readScrollbackRange?(startRow: number, endRow: number): Promise<BufferRange>;
  getCursorPosition?(): Promise<CursorPosition>;

  snapshot?(): Promise<TerminalSnapshot>;
  restoreSnapshot?(snapshot: TerminalSnapshot): Promise<void>;

  handleImeState?(enabled: boolean): Promise<void>;
}
```

与之对应，Rust/Tauri 边界建议不要再叫 `pty_*` 和 `xterm_*` 混在一起，而是明确分层：

```rust
#[derive(serde::Serialize, serde::Deserialize)]
pub struct RendererHostCreateRequest {
    pub renderer_kind: String,   // "xterm" | "windows-native"
    pub session_id: String,
    pub window_label: String,
    pub host_rect: HostRectPx,   // x, y, width, height in physical px
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct HostRectPx {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
async fn terminal_renderer_create(req: RendererHostCreateRequest) -> Result<(), String>;

#[tauri::command]
async fn terminal_renderer_destroy(session_id: String) -> Result<(), String>;

#[tauri::command]
async fn terminal_renderer_set_host_rect(
    session_id: String,
    rect: HostRectPx,
) -> Result<(), String>;

#[tauri::command]
async fn terminal_renderer_focus(session_id: String) -> Result<(), String>;

#[tauri::command]
async fn terminal_renderer_copy(session_id: String) -> Result<(), String>;

#[tauri::command]
async fn terminal_renderer_paste(session_id: String, text: Option<String>) -> Result<(), String>;

#[tauri::command]
async fn terminal_renderer_update_theme(
    session_id: String,
    theme: RendererThemePayload,
) -> Result<(), String>;

#[tauri::command]
async fn terminal_renderer_update_font(
    session_id: String,
    font: RendererFontPayload,
) -> Result<(), String>;
```

能力分配上，我建议这样定。

**可以直接由 native terminal renderer 负责的能力**，包括 focus、文本输入、copy/paste、selection、IME、字体与主题应用、窗口/视口 resize。这些本来就是 renderer/UI host 的自然职责，Windows 原生方案理应比 xterm 更接近系统行为。Windows App SDK 官方也把现代文本渲染、ClearType、硬件加速、语言支持、可访问且一致的原生 UI 作为核心能力卖点。citeturn34view1turn34view3

**建议继续放在你们自己的 Rust inspection/snapshot 层的能力**，包括 `readVisibleBuffer`、`readScrollbackRange`、`getCursorPosition`、`snapshot/restore`、以及 block overlay 所需的命令块状态。原因不是 native renderer 做不到，而是你们已经有后端终端快照语义，而且公开资料里没有我敢依赖的 TerminalControl 外部 API 去承诺这些 introspection 能力。现有仓库里 `PtyAttachSnapshot`、`history`、`cursor_row/cursor_col`、`terminal_output_snapshot` 与 OSC 133/6973 block parser，已经构成了一个合格的共享 inspection core。citeturn37view3turn37view4turn26view8turn26view10turn36view2turn36view3

**高风险或当前不应承诺的能力**，包括“对 TerminalControl 内部 buffer 做 xterm 同等级的按行/按列/marker 直接读取”、“完全复刻 xtermRegistry 对 internal buffer 的访问语义”、“在 grid 中为每张卡片提供 live native miniature terminal 并支持任意 CSS 层级交互”。这些不是理论上不可能，而是当前公开 API 与宿主模型都不支持你把它当成低风险承诺。citeturn32view0turn10view0turn33view0

## 性能验证与最终建议

性能验证必须比较 **同一个 PTY backend、同一套 shell/workload、不同 renderer**，否则结论会失真。你们的 baseline 应该至少包括三组：现有 xterm.js + WebGL；Windows native candidate；以及一个“参考终端”用于观察天花板，而不是直接照搬其架构。由于 ThreadTerm backend 已经统一在 Rust 并拥有 snapshot/ack/state 能力，所以 benchmark 最好固定走现有 `pty_create / pty_input / pty_resize` 管线，让 renderer 成为唯一变量。citeturn28view0turn27view5turn37view1

我建议的 benchmark 组合如下。

大日志连续输出可以用 PowerShell 直接生成，避免依赖外部工具。例如：

```powershell
# 约 10 MB
$line = "0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ 你好🙂 مرحبا"
1..120000 | ForEach-Object { $line }

# 约 100 MB
$line = "LOG $(Get-Date -Format o) lorem ipsum dolor sit amet 你好🙂"
1..1300000 | ForEach-Object { $line }
```

也可以在 WSL 下统一用：

```bash
python3 - <<'PY'
import sys
line = "0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ 你好🙂 مرحبا\n"
for _ in range(120000):
    sys.stdout.write(line)
PY
```

TUI 类测试建议至少覆盖：`vim`、`tmux`、`btop/htop`、`less -R`、`fzf`、`git log --graph --decorate --oneline --all`。如果 Windows 本机没有这些工具，直接在 WSL profile 里跑，避免把“工具缺失”误判成 renderer 问题。长文本 selection 建议准备一段 2 万行的混合文本，测试鼠标拖选、Shift+方向键选择、跨屏滚动时的帧率与复制结果一致性。CJK/emoji/bidi 单独准备固定文本夹具，覆盖宽字符、ZWJ emoji、阿拉伯语和英文混排。这个测试应同时比较显示正确性、光标移动位置与选择边界。相关比较之所以重要，是因为 Windows Terminal 官方公开强调其 Unicode/UTF-8 与 GPU 文本渲染能力，而 Windows App SDK 也强调现代文本渲染、ClearType 与 broad language support。citeturn38view0turn34view1

IME 测试必须单独拉出来，不要混在普通输入回归里。建议至少测微软拼音、日文 IME、韩文 IME 三类场景，分别覆盖：候选窗位置是否贴合光标、长 preedit 是否截断、切换窗口/浮窗后候选是否错位、鼠标选候选后是否重复提交。小字号字体清晰度则建议固定在 11px、12px、13px 做截图对比，同时在 100%、125%、150% DPI 下观察边缘锐度与字符对齐。这个维度 native renderer 的理论优势来自 Windows 的原生文本栈，而不是 ConPTY 本身。citeturn34view1turn31search7

多卡并发测试不要一上来就测“每卡一个 live native control”。更合理的分层是：
先测单 live terminal；
再测一个 live terminal + 多个 snapshot preview；
最后才测多个 live terminal。
因为你们的产品结构是 terminal cards、selector、floating window、preview，而不是纯 tab/pane；native host 在 child-window 模型下的布局与资源管理成本是会随 live 实例数急剧上升的。citeturn20view3turn10view0turn33view0

衡量指标建议明确写进验收单，而不是只做体感判断。至少记录：
渲染完成时间、滚动时平均 FPS、P95 输入到回显延迟、CPU 占用、GPU 占用、内存峰值、附加窗口/浮窗 attach 时间、复制结果一致性、IME 错误数、Unicode 渲染错误数。
最终判断标准我建议设成“**Windows native candidate 至少在你们最痛的三类场景里，稳定优于 xterm.js baseline；同时不引入任何 P0 功能回退**”。如果只是字体更好看、偶发更顺，但 grid/浮窗/overlay/attach 出现明显复杂度爆炸，那就不值得切。citeturn38view0turn37view3turn36view2

最后给出清晰结论。

**是否值得切到 TerminalControl？**
**值得做 spike，不值得直接全量切换。** 因为收益方向真实存在，但公开 embedding 路线与 API 稳定性证据不足。citeturn32view0turn38view0

**这件事是不是“切换 ConPTY”？**
**不是。** ThreadTerm 当前决策的本质是“替换前端 renderer / host / 输入与 inspection 边界”，不是“从零切到 ConPTY”。ConPTY 解决的是 pseudoconsole 宿主问题，而不是原生字体、IME 或 selection。citeturn31search5turn31search7turn28view0

**最推荐方案是什么？**
**推荐 A + B + D 的组合路线**：先保留现有 Rust portable-pty/ConPTY backend，先做 xterm.js 管线优化；并行开展 Windows-only native renderer spike；只有 spike 成功，再演进到 Windows native、macOS/Linux 继续 xterm 的混合架构。citeturn20view1turn28view0turn32view0

**不推荐方案是什么？**
**不推荐 C 和把 E 当低成本捷径。** 直接全面切到 Windows Terminal/ConPTY native stack，或把 WezTerm/Alacritty 当嵌入式控件，都很容易低估 embedding 与 shared feature 的复杂度。citeturn30search0turn30search9turn32view0

**最大技术风险是什么？**
最大风险不是 PTY，也不是 renderer 性能，而是：**在 Tauri 2 / WebView2 的窗口模型下，如何以可维护方式 host 一个 native terminal surface，同时不破坏 React 布局、卡片网格、浮窗、overlay、z-index、焦点和输入法。** 这是宿主架构风险，不是终端协议风险。citeturn10view0turn9view0turn33view0turn8search0

**对 macOS 的影响等级。**
**低。** 只要你把 shared feature 抽象成 TerminalAdapter / snapshot / inspection provider，macOS 可以继续走 xterm.js；真正受影响的是抽象层与共享逻辑，而不是 macOS renderer 本身。citeturn20view3turn7search0

**如果我是项目负责人，我会先做哪个最小 spike？**
我不会一上来就“把 TerminalControl 接进去”，而会先做一个更小、更诚实的 spike：
在 Tauri 的一个 Windows 窗口里，把一个 native child host 挂到 React 占位容器上，让它能随布局移动与 resize，能拿到焦点，并完成单 shell echo。
只有这个宿主级 spike 成功，再继续验证是否值得把 TerminalControl 放进去。因为如果 host 层都不稳定，后面的 terminal renderer 再强也没有意义。citeturn10view0turn10view1turn10view3turn33view0

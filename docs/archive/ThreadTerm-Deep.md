# ThreadTerm 深度体检报告

## Executive Summary

我对 `Heluth-Crazy/ThreadTerm` 做的是一次**静态、跨层、证据绑定的审查**，优先阅读了 `AGENTS.md`、`.trellis/workflow.md`、`.trellis/spec/frontend/*`、`package.json`、`src-tauri/Cargo.toml`、`src-tauri/src/**`、`src/**` 中与终端、桥接、移动端、AI explain、markdown export 直接相关的关键文件。整体判断是：**项目主路径已经成形，模块边界大体清晰，但在“移动桥接可用性、远程控制安全边界、终端并发一致性、退出码准确性、测试执行入口”这几个上线前硬问题上，仍有必须先修的缺口**。其中我没有看到足够证据支撑一个“已确认的 P0”，但看到多项足以列为 **P1** 的问题。fileciteturn84file0L1-L3 fileciteturn85file0L1-L3 fileciteturn82file0L1-L3 fileciteturn95file0L1-L3

本次审查里，最关键的五个风险是：**LAN 配对地址被错误归一化为 `127.0.0.1`，会直接破坏跨设备配对；PTY 退出码在 Rust 侧被折叠成 `0/1`，会污染前端状态和诊断；移动桥接使用明文 HTTP/WS、宽松 CORS、query token 和本地存储 token，安全边界明显偏松；主窗口与浮窗共享同一 PTY 时，`xtermRegistry` 只能保存一个终端实例，块定位/输出抓取会错绑；`provider_find_recent_session` 采用高频轮询 + 递归同步文件扫描，性能和 UI 流畅度存在真实风险。**这些结论都能绑定到明确的文件和调用链。fileciteturn98file0L1-L3 fileciteturn68file0L1-L3 fileciteturn99file0L1-L3 fileciteturn106file0L1-L3 fileciteturn103file0L1-L3 fileciteturn104file0L1-L3 fileciteturn59file0L1-L3 fileciteturn60file0L1-L3 fileciteturn71file0L1-L3 fileciteturn78file0L1-L3

优先修复顺序建议是：**先修移动桥接 P1（LAN 地址、明文链路/鉴权边界、审计明文摘要），再修 PTY/终端一致性 P1（真实退出码、双终端共享同一 PTY 的注册策略），随后做性能与测试补强（provider session 扫描、桥接预览、顶层脚本/回归测试）。**这能在尽量不改变现有功能语义和交互意图的前提下，最大化降低真实上线风险。fileciteturn95file0L1-L3 fileciteturn56file0L1-L3 fileciteturn58file0L1-L3

## Project Map

从入口看，前端由 `src/main.jsx` 加载 `App.tsx`，`App.tsx` 再挂载 `TerminalManager`、`TerminalEventBridge`、`NotificationBridge`、`KeyboardBridge`、`OverlayBridge` 与通知中心，这说明前端主架构是一个**“UI 视图层 + 多个 headless bridge”** 的组合，而不是把所有状态和副作用堆进单一页面组件。这个方向本身是对的，也与项目当前终端/通知/快捷键/覆盖层的复杂度相匹配。fileciteturn92file0L1-L3 fileciteturn93file0L1-L3

状态方面，核心前端状态由 `src/stores/terminalStore.ts` 管理，负责卡片、块、通知、焦点、AI Explain 默认 provider、自动重启、底部条等；AI explain 线程单独放在 `src/stores/aiThreadStore.ts`；终端事件通过 `TerminalEventBridge.tsx` 从 Tauri 事件桥接到 store；真实终端 UI 则由 `TerminalView.tsx` 组合 `Shell.jsx`、`BlockOverlay`、`BlockInspector`、底部快捷条等构成。换句话说，**数据流大致是：Rust PTY/bridge 事件 → Tauri event → TerminalEventBridge → Zustand store → TerminalView / CardGrid / NotificationCenter**。fileciteturn51file0L1-L3 fileciteturn52file0L1-L3 fileciteturn53file0L1-L3 fileciteturn63file0L1-L3 fileciteturn58file0L1-L3 fileciteturn56file0L1-L3 fileciteturn57file0L1-L3

终端相关主链路是：`TerminalView` 计算 launch command 和 `paneId`，再把它交给 `Shell.jsx`；`Shell.jsx` 负责 xterm 创建/销毁、`pty.create/input/resize/attachSnapshot`、输出排序器、终端注册；Rust 侧 `pty_create` 建 PTY、`stream_pty_output` 推送输出与状态，`TerminalEventBridge` 再把这些事件收集进 store，并给 block inspector、notification、auto restart 等子系统提供状态投影。这里最关键的是：**前端 Shell 与 Rust PTY 生命周期已经形成稳定调用链，但 float window 与主窗口共享同一 `ptyId`，把并发复杂度显著抬高了。**fileciteturn56file0L1-L3 fileciteturn55file0L1-L3 fileciteturn48file0L1-L3 fileciteturn105file0L1-L3 fileciteturn106file0L1-L3 fileciteturn60file0L1-L3

Tauri 后端入口在 `src-tauri/src/lib.rs`。它初始化 shell/dialog/notification/fs/http/global-shortcut 插件，`setup` 里初始化数据库、overlay、supervisor，然后暴露 PTY、AI explain、shell integration、provider session、bridge 等命令。移动桥接主逻辑在 `src-tauri/src/bridge/mod.rs`、`pairing.rs`、`server.rs`，客户端协议在 `src/mobile/bridge/protocol.ts` 与 `wsClient.ts`，设置入口在 `MobileAccessSettings.tsx`。AI explain/export 这条链路则是：`BlockInspector.tsx` → `src/lib/ai/aiExplain.ts` / `src/lib/ai/exportAiSession.ts` / `src/lib/ai/tauriAiSessionExport.ts` → Rust `src-tauri/src/ai_explain.rs`。fileciteturn95file0L1-L3 fileciteturn98file0L1-L3 fileciteturn99file0L1-L3 fileciteturn103file0L1-L3 fileciteturn24file0L1-L3 fileciteturn25file0L1-L3 fileciteturn68file0L1-L3 fileciteturn62file0L1-L3 fileciteturn64file0L1-L3 fileciteturn65file0L1-L3 fileciteturn66file0L1-L3 fileciteturn19file0L1-L3

## Findings

本轮**未发现证据足够扎实、可直接定为 P0** 的问题；但以下 **P1/P2** 已足够进入正式修复队列。

**[P1] LAN 配对 URL 被归一化为 `127.0.0.1`，会让 0.0.0.0 绑定几乎无法从手机完成配对**

- 类型：bug / mobile / bridge
- 位置：`src-tauri/src/bridge/mod.rs`、`src-tauri/src/bridge/pairing.rs`、`src/components/settings/MobileAccessSettings.tsx`
- 相关符号：`public_host_for_url`、`bridge_pair_qr`、`createPairQrForStatus`
- 证据：Rust 侧 `public_host_for_url` 把 `0.0.0.0` 和 `::` 强制映射为 `127.0.0.1`；`bridge_pair_qr` 用该值生成配对地址；设置页启动 bridge 后又把 `status.host` 直接传回 `pairQr`，因此当用户选择 LAN 绑定时，最终展示/复制的 `pairQr.url` 仍然是 loopback 地址。fileciteturn98file0L1-L3 fileciteturn99file0L1-L3 fileciteturn68file0L1-L3
- 触发条件：在 `MobileAccessSettings` 中选择 `0.0.0.0`，点击启动 bridge 并生成二维码/URL。fileciteturn68file0L1-L3
- 用户影响：桌面端会显示“启动成功”，但手机扫描/打开配对链接后会尝试访问手机自己的 `127.0.0.1`，导致跨设备配对失败。这是移动桥接主流程阻断。fileciteturn68file0L1-L3 fileciteturn99file0L1-L3
- 根因：把“监听地址”与“对外可达地址”混为一谈。对通配绑定地址做了 display 归一化，但又把该 display 地址用于实际配对 URL。fileciteturn98file0L1-L3
- 修复建议：把 `bridge_start` 的 bind host 与 `bridge_pair_qr` 的 publish host 分离。`bridge_pair_qr` 应要求前端显式传入“对外访问地址”，如果是 `0.0.0.0`，前端应提示用户输入局域网 IP、Tailscale 名称或 tunnel 域名，而不是默认回退到 `127.0.0.1`。  
- 最小改动方案：删除 `bridge_pair_qr` 中对 `0.0.0.0 -> 127.0.0.1` 的自动映射；当 host 仍为通配地址时，返回一个明确错误，让设置页弹出“请输入可达地址”的对话，而不是生成错误二维码。  
- 需要测试：需要。建议补 Rust 单测覆盖 `bridge_pair_qr(Some("0.0.0.0"))` 的行为，以及前端 `MobileAccessSettings` 组件测试覆盖 LAN 模式下的二维码生成分支。  
- 修复风险：低。只影响 bridge 配对 URL 生成，不改变 PTY 或主终端语义。  

**[P1] PTY 退出码被压扁成 `0/1`，前端会失去真实失败原因**

- 类型：bug / correctness
- 位置：`src-tauri/src/pty/events.rs`
- 相关符号：`stream_pty_output`
- 证据：Rust 侧在 reader 线程退出后调用 `child.wait()`，但不是返回真实 `status.code()`，而是用 `status.success() ? 0 : 1` 生成 `wait_code`。这会把 `2`、`126`、`127`、`130` 等所有非 0 退出码全部折叠成 `1`。前端 `TerminalEventBridge` 与 `BlockInspector` 又明确消费 `code/exitCode` 做状态、事件摘要和失败展示。fileciteturn106file0L1-L3 fileciteturn58file0L1-L3 fileciteturn62file0L1-L3
- 触发条件：任意非 0 退出；尤其是 shell 命令不存在、权限拒绝、SIGINT、中断、脚本参数错误等。fileciteturn106file0L1-L3
- 用户影响：失败诊断被弱化；auto-restart、事件摘要、block inspector 看到的退出码精度下降；后续如果你基于退出码做分类策略，也会被这层压扁。fileciteturn58file0L1-L3 fileciteturn62file0L1-L3
- 根因：事件桥只保留了“成功/失败”布尔语义，没有保留进程真实退出码。fileciteturn106file0L1-L3
- 修复建议：改为 `status.code()`，并为 signal/无 code 的情况单独处理成 `None`；前端继续保留 `undefined/null => aborted/unknown` 的既有语义。  
- 最小改动方案：仅调整 `wait_code` 的生成逻辑和 संबंधित测试，不改前端 API 形状。  
- 需要测试：需要。Rust 侧建议加针对真实退出码传播的测试；前端侧补 `TerminalEventBridge` / `BlockInspector` 对 `127`、`130` 等值的断言。  
- 修复风险：低。是精度修复，不会改变正常 0/非 0 的大逻辑。  

**[P1] 移动桥接安全边界偏松：明文 HTTP/WS、query token、宽松 CORS、无 origin 约束**

- 类型：security
- 位置：`src-tauri/src/bridge/server.rs`、`src-tauri/src/bridge/pairing.rs`、`src/components/settings/MobileAccessSettings.tsx`
- 相关符号：`CorsLayer::permissive`、`/snapshot?token=`、`/ws?token=`、`pair_page_html`、`create_pair_qr`
- 证据：bridge server 使用 `axum` 明文启动 HTTP 服务，没有 TLS；路由层使用 `CorsLayer::permissive()`；`snapshot` 和 websocket 的鉴权都把 token 放在 URL query；pair page 把 `deviceToken` 持久化到 `localStorage`；配对二维码 URL 本身也是 `http://.../pair?otp=...`。设置页还支持 `0.0.0.0` LAN 暴露。fileciteturn103file0L1-L3 fileciteturn104file0L1-L3 fileciteturn99file0L1-L3 fileciteturn68file0L1-L3
- 触发条件：用户开启移动桥接，特别是 LAN 模式；或者 token 泄露到浏览器历史、代理日志、截图、备份或网络抓包。fileciteturn68file0L1-L3 fileciteturn104file0L1-L3
- 用户影响：如果在不受信网络上使用，配对码和 session token 都可能被旁路窃取；而一旦 token 泄露，当前实现没有 origin 绑定或额外二次认证。对于“本地/家庭网络”用户这未必立刻变成 exploitable 漏洞，但它明显不够“默认安全”。fileciteturn103file0L1-L3 fileciteturn104file0L1-L3
- 根因：当前 Stage 1 bridge 更像“可信局域网工具”，但设置页已经把它包装成一般可用的移动远控能力。  
- 修复建议：第一步先**收紧默认面**，不要在默认 UX 上鼓励公网/LAN 直接暴露；第二步把 token 从 query string 挪到 `Authorization` header 或 websocket 首帧 auth message；第三步把 CORS 从 `permissive` 缩到最小；第四步在 UI 上明确标注“仅限可信网络/Tailscale/tunnel”。  
- 最小改动方案：不做 TLS 大改，先做到“默认仅 loopback + 明确高级用户手动指定 publish host + query token 改 header + CORS 非 permissive + 本地存储 token 改 sessionStorage/最短生存期”。  
- 需要测试：需要。Rust 侧补鉴权/头部授权/错误 token/跨 origin 的测试；前端补 wsClient 和 pair page 的 auth 行为测试。  
- 修复风险：中。会触及协议，但可以兼容旧 query token 一个版本后再移除。  

**[P1] 远程输入会把用户实际输入摘要落库到本地审计表，存在敏感信息泄露风险**

- 类型：security / privacy
- 位置：`src-tauri/src/bridge/server.rs`、`src-tauri/src/db.rs`
- 相关符号：`handle_client_message`、`summarize_input`、`insert_audit_log`
- 证据：当移动端发送 `ClientMessage::Input` 时，服务端会先对原始输入做 `summarize_input`，再把结果写入 `audit_log.summary`；数据库位于用户主目录下的 `~/.threadterm/threadterm.db`。摘要逻辑只做换行转义和 240 字符截断，不做秘密脱敏。fileciteturn103file0L1-L3 fileciteturn47file0L1-L3
- 触发条件：用户用手机远程输入命令、token、密码、贴板数据等。fileciteturn103file0L1-L3
- 用户影响：数据库会长期保存命令和输入片段；如果用户在远程控制里输入敏感 token、URL 凭证、脚本参数或私钥片段，当前审计表可能把它们明文保留。  
- 根因：审计设计只考虑“可追踪性”，没有区分“高风险输入内容”和“低风险操作记录”。  
- 修复建议：把 `input` 审计降级为**结构化元数据**，例如 `length`、`contains_newline`、`card_id`、`device_id`、`ts`，而不是明文摘要；若确实需要摘要，至少对长 token、URL 凭证、`Authorization:`、`AKIA` 风格 key、JWT、`-----BEGIN` 等模式做脱敏。  
- 最小改动方案：只改 `summarize_input` 和 `audit_log` 写入内容，不动 websocket 指令模型。  
- 需要测试：需要。Rust 侧单测输入中包含长 token、URL 凭证、换行命令时的脱敏结果。  
- 修复风险：低。只影响审计内容，不影响远控功能。  

**[P2] 主窗口与浮窗共享同一 PTY 时，`xtermRegistry` 只能记录一个终端实例，块锚点与缓冲区读取会错绑**

- 类型：bug / correctness / maintainability
- 位置：`src/components/terminal/xtermRegistry.ts`、`src/components/Shell.jsx`、`src/components/terminal/TerminalView.tsx`、`src/windows/float/FloatSession.tsx`
- 相关符号：`registerTerminal`、`getAbsoluteCursorRow`、`readBufferRange`
- 证据：`xtermRegistry` 用的是 `Map<string, Terminal>`，同一 `ptyId` 只能存一个 `Terminal`；而 `TerminalView` 和 `FloatSession` 都明确声明会复用同一个 `paneId`/`ptyId` 连接同一 PTY；`Shell.jsx` 在连接后按 `connectedPtyId` 调 `registerTerminal`。因此谁最后挂载，谁就覆盖之前的映射。后续 `BlockOverlay` 和 `TerminalEventBridge` 读取 cursor row / buffer range 时，只能拿到“最后注册的那个 xterm”，这与用户当前可见 terminal 不一定一致。fileciteturn59file0L1-L3 fileciteturn56file0L1-L3 fileciteturn60file0L1-L3 fileciteturn55file0L1-L3
- 触发条件：同一张卡同时在主窗口和浮窗打开，或者两者快速切换挂载顺序。  
- 用户影响：block 起止行、Inspector 输出抓取、块 overlay 定位可能漂移，甚至读取到不是当前视图的 buffer。  
- 根因：共享 PTY 被支持了，但 `xtermRegistry` 数据结构仍是假设“一 PTY 只对应一个 xterm”。  
- 修复建议：把 registry 升级为 `Map<ptyId, Set<TerminalRef>>` 或维护一个“primary terminal”概念；block/preview 相关读取要么面向前景视图，要么面向明确选定实例。  
- 最小改动方案：先引入“active terminal per pty”而不是全量重构，多视图时由前景视图显式 claim ownership。  
- 需要测试：需要。补一个并发挂载测试，验证主窗口和浮窗同时存在时，`readBufferRange` 与 `getAbsoluteCursorRow` 返回的实例符合预期。  
- 修复风险：中。触及终端共享模型，但可以控制在 registry 一层。  

**[P2] Provider session 自动发现使用高频轮询 + 递归同步文件扫描，存在真实性能风险**

- 类型：performance
- 位置：`src/components/terminal/useProviderSessionLifecycle.ts`、`src-tauri/src/provider_sessions.rs`
- 相关符号：`DISCOVERY_ATTEMPTS`、`DISCOVERY_INTERVAL_MS`、`provider_find_recent_session`
- 证据：前端在 provider session 尚未绑定时，最多用 **12 次、每 1.5 秒一次** 的节奏轮询 `provider_find_recent_session`；Rust 侧每次调用都会递归扫描 `~/.codex/sessions` 或 `~/.claude/projects` 下的 `.jsonl` 文件，按修改时间排序，并对文件做 `fs::read_to_string` 后解析前若干行。整个实现是同步文件 IO，只是包在 `async fn` 里。fileciteturn71file0L1-L3 fileciteturn78file0L1-L3
- 触发条件：打开 Claude/Codex 卡片并进入 session 自动发现流程；尤其当用户家目录下历史 session 很多时。  
- 可能表现：主线程/运行时抖动、focus/terminal 交互期间偶发卡顿、macOS/Windows 下家目录大时发现变慢。  
- 优先级：P2，若你的用户群历史 session 很多，可上调到 P1。  
- 低风险优化方案：先做**目录级 memo** 和更严格的 since 过滤，再把扫描下沉到 `spawn_blocking`；更进一步再做 provider 专属索引缓存。  
- 是否需要 benchmark/profile：需要。至少对 `100 / 1000 / 5000` 个 jsonl 文件做一次基准扫描。  

**[P2] 移动 bridge 的实时 preview 事件只基于“当前输出 chunk”而不是累计缓冲区，预览可能抖动或缺上下文**

- 类型：bug / performance / mobile
- 位置：`src-tauri/src/pty/events.rs`、`src-tauri/src/bridge/mod.rs`
- 相关符号：`emit_pty_output_chunk`、`broadcast_preview`、`preview_from_output`
- 证据：PTY 输出事件里调用的是 `bridge::broadcast_preview(id, data)`，传入的是**当前 chunk**；而 `broadcast_preview`/`preview_from_output` 对传入文本直接 strip ANSI、切行、截取最近若干行，并不会读取 PTY 的累计 `output_buffer`。这意味着 websocket 推送给移动端的 preview 只反映“这一个 chunk”，不是连续终端尾部的稳定视图。fileciteturn106file0L1-L3 fileciteturn98file0L1-L3
- 触发条件：长输出被拆成多个 chunk、行在 chunk 边界被切断、TUI/快节奏输出。  
- 用户影响：移动端卡片 preview 可能闪烁、缺半行、看不到连续上下文。  
- 根因：bridge preview 走的是“事件流快照”，不是“会话尾部快照”。  
- 修复建议：实时 preview 改为基于 session 的 recent output buffer 或 terminal snapshot，而不是裸 chunk。  
- 最小改动方案：在 `broadcast_preview` 前先从 registry/session 读取累计 recent output，再提取 preview。  
- 需要测试：需要。Rust 侧补分块输出测试，验证跨 chunk 的行不会被截断。  
- 修复风险：低。  

**[P2] 测试与验证入口不完整，当前无法按你要求的命令清单直接执行**

- 类型：test-gap / maintainability
- 位置：`package.json`、`vitest.config.ts`
- 相关符号：`scripts`
- 证据：`package.json` 里有 `build`、`typecheck`、`tauri:dev`、`tauri:build`，但**没有 `lint` 或 `test` 顶层脚本**；同时仓库确实已经配置了 `vitest.config.ts`，说明测试基础设施存在，只是验证入口没有收束成统一命令。fileciteturn82file0L1-L3 fileciteturn83file0L1-L3
- 触发条件：CI、本地上线前体检、外部审计者按惯例执行 `npm test` / `npm run lint`。  
- 用户影响：验证流程不一致、团队成员容易漏跑用例、你在本次要求中列出的命令集合无法原样落地。  
- 根因：项目已经进入“有相当多测试与规则”的阶段，但工程脚本层还停留在较轻量状态。  
- 修复建议：增加 `test`, `test:watch`, `lint`, `check` 脚本，至少把 `npx vitest run` 和 ESLint/TypeScript 检查纳入统一入口。  
- 最小改动方案：只补 npm scripts，不改现有代码组织。  
- 需要测试：这本身就是测试入口修复，不需要额外功能测试。  
- 修复风险：低。  

**[P3] Trellis 规范体系存在明显占位文档，无法对复杂前端状态流形成足够约束**

- 类型：maintainability
- 位置：`AGENTS.md`、`.trellis/workflow.md`、`.trellis/spec/frontend/index.md`、`.trellis/spec/frontend/state-management.md`、`.trellis/spec/frontend/quality-guidelines.md`
- 相关符号：无
- 证据：项目流程文档非常强调“先读 spec 再动手”，但 frontend index、state-management、quality-guidelines 仍大量保留 `To be filled` 占位，只在个别 feature doc（AI explain、本地导出、supervisor）里形成了有效契约。这会让“终端共享 PTY、多 store 状态投影、bridge 协议、不变量”这些真正复杂的内容没有统一项目级约束。fileciteturn84file0L1-L3 fileciteturn85file0L1-L3 fileciteturn87file0L1-L3 fileciteturn90file0L1-L3 fileciteturn86file0L1-L3
- 触发条件：后续再做终端/桥接/移动端功能迭代时。  
- 用户影响：不是立即 bug，但会提高回归概率。  
- 修复建议：优先补“终端共享 PTY 约束”“bridge 安全约束”“store 持久化与非持久化拆分约束”，不要追求把所有 spec 一次写满。  
- 最小改动方案：补三份 active spec，而不是大规模文档整治。  
- 需要测试：不需要功能测试，但建议把关键不变量写成回归测试与 spec 同步落地。  
- 修复风险：低。  

## Performance Review

从性能角度看，最值得立刻处理的不是 React 细枝末节，而是**跨层同步 IO 和多终端共享状态**。最重的一项是 provider session 自动发现：前端定时轮询、后端递归扫描历史 jsonl 文件，这在 session 很多时会直接放大为可感知卡顿。这里建议先做**结构性降本**，即 `spawn_blocking + cache + 更严格 since 过滤`，而不是先去做表层 debounce。fileciteturn71file0L1-L3 fileciteturn78file0L1-L3

第二个真实性能/一致性问题是移动 bridge preview 的生成方式。当前 preview 事件基于裸 chunk，会导致多余的预览计算和更差的用户感知，因为同样的数据既要写入 session buffer，又要单独做 chunk preview，而且 preview 质量并不稳定。把 preview 基于累计 recent output 或 terminal snapshot 重新计算，不仅更准，也更容易做后续节流。fileciteturn106file0L1-L3 fileciteturn98file0L1-L3

前端层面，`Shell.jsx` 已经做了一些好事：只在需要时 resize PTY、对 `ResizeObserver` 做了 150ms debounce、主题刷新和 terminal surface recovery 也都比较克制，所以我没有把“xterm 生命周期粗暴”列为主要性能问题。相反，当前更需要的是**benchmark 和 profile**：一组针对 provider session 文件扫描，一组针对 bridge preview 分块输出，一组针对主窗口 + 浮窗同时绑定同一 PTY 时 block inspector 的读取成本。fileciteturn55file0L1-L3 fileciteturn59file0L1-L3

低风险优化建议按顺序是：先修 provider session 发现逻辑；再修 bridge preview 数据源；最后才考虑对 `TerminalManager`/`TerminalView` 的 selector 和 memo 做小修。后者当然也有优化空间，例如某些 selector 在 store 每次更新时会做数组过滤，但相比前两个问题，它不是当前最划算的优化点。fileciteturn94file0L1-L3 fileciteturn56file0L1-L3

## Security Review

本轮最明确的安全问题，是**移动桥接当前更接近“可信网络调试工具”，而不是默认安全的远控能力**。证据包括：明文 HTTP/WS、query token、pair 页面把 token 放进 `localStorage`、`CorsLayer::permissive()`、设置页允许 `0.0.0.0` 暴露。就算你产品意图本来就是“先在本地网络跑起来”，也应该把这种假设写进 UX 和实现约束，而不是让默认表象看上去像“可以放心连手机”。fileciteturn103file0L1-L3 fileciteturn104file0L1-L3 fileciteturn68file0L1-L3

第二个安全问题是**远程输入审计明文摘要**。这不是传统 RCE，但属于非常真实的**隐私与秘密材料泄露面**：只要用户在手机远控中输入 token、私有 URL、脚本参数，当前数据库就可能把它们片段保留在 `audit_log.summary` 里。这个问题不需要等待“有人利用”，它本身就是不合适的数据落盘策略。fileciteturn103file0L1-L3 fileciteturn47file0L1-L3

第三个需要硬化的点是 Tauri 配置面。`tauri.conf.json` 把 `csp` 设为 `null`，能力文件又开放了 `shell:default`、`shell:allow-open`、`http:default`、较多 window 权限和较宽的 workflow fs scope。考虑到这是一款桌面终端管理器，这不等于“已经有漏洞”，但它**显著增加了未来 XSS/注入回路成立时的攻击面**。尤其是我在已审调用链里看到“本地目录打开”已走 `open_local_directory` 自定义命令，而不是 `shell.open(path)`，因此 `shell:allow-open` 至少应该被复核其必要性。fileciteturn79file0L1-L3 fileciteturn96file0L1-L3 fileciteturn46file0L1-L3 fileciteturn67file0L1-L3

### Security Findings

- **P1**：移动 bridge 采用明文 HTTP/WS + query token + permissive CORS；建议先改鉴权载体和默认暴露策略。fileciteturn103file0L1-L3 fileciteturn104file0L1-L3
- **P1**：远程输入审计把用户输入摘要持久化到本地 DB；建议改成结构化元数据或脱敏摘要。fileciteturn103file0L1-L3 fileciteturn47file0L1-L3
- **P2**：`csp: null`、`shell:allow-open`、较宽 capabilities 建议收敛到最小权限。fileciteturn79file0L1-L3 fileciteturn96file0L1-L3
- **需要验证的风险**：`paired_devices` 数据表已经创建，但本次审到的 `PairingStore` 仍是纯内存实现；如果你的产品意图是“跨重启保持配对”，那当前实现会在重启后丢失设备列表，且数据库 schema 呈现出未完成状态。这个点我认为**非常可疑**，但因为没看到完整产品约束，不把它直接列为确定 bug。fileciteturn47file0L1-L3 fileciteturn99file0L1-L3

## Testing Plan

当前仓库已经有一批不错的测试基础：Vitest 已配置，仓库搜索结果里可以看到 `terminalStore.test.ts`、`aiThreadStore.test.ts`、`aiExplain.test.ts`、`BlockInspector.test.tsx`、`TerminalEventBridge.test.tsx`、`TerminalView.aiExplain.test.tsx`，Rust 侧也有 `src-tauri/src/pty/tests.rs` 和 `src-tauri/tests/block_replay.rs`。问题不在“完全没测试”，而在于**最危险的新路径还没有形成完整闭环回归**。fileciteturn83file0L1-L3 fileciteturn44file37L1-L3 fileciteturn44file38L1-L3 fileciteturn44file39L1-L3 fileciteturn44file40L1-L3 fileciteturn44file42L1-L3 fileciteturn44file43L1-L3 fileciteturn44file44L1-L3

建议的补测优先级如下。

- **最高优先级**
  - `src/components/settings/MobileAccessSettings.test.tsx`：mock `mobileBridge.start/status/pairQr`，输入 `bindHost = "0.0.0.0"`，断言 UI 不会生成 `127.0.0.1` 配对 URL，或在最小修复方案下断言会弹出“需要手动输入可达地址”。  
  - `src-tauri/src/bridge/mod.rs` 新单测：覆盖 `bridge_pair_qr` 在 loopback、LAN、自定义外部 host 三类输入下的 `host/url` 结果。  
  - `src-tauri/src/pty/events.rs` 新单测：构造退出码 `127`、`130`、`1`、`0`，断言 `pty-exit` 与状态机保留真实 code。  
  - `src-tauri/src/bridge/server.rs` 新单测：断言 `summarize_input` 对 token/JWT/URL 凭证进行脱敏，或在策略调整后断言只记录结构化元数据。  

- **第二优先级**
  - `src/components/terminal/xtermRegistry.test.ts`：模拟两个 terminal 实例共享一个 `ptyId`，验证 registry 选择哪个实例，以及 block 读取不会错绑。  
  - `src/components/terminal/useProviderSessionLifecycle.test.tsx`：mock `providerSessions.findRecent`，断言 discovery 的次数上限、停止条件和绑定成功后的取消轮询。  
  - `src-tauri/src/provider_sessions.rs` 新测试：建立临时目录，生成大量 `.jsonl` 文件，覆盖 since filter、路径匹配、最近文件选择。  

- **第三优先级**
  - `src-tauri/src/bridge/server.rs` 协议测试：补 `Authorization` header / websocket 首帧鉴权（如果你采纳该修复）、错误 token、read-only device 无法 input/resize/close 的断言。  
  - `src/components/terminal/TerminalEventBridge.test.tsx` 回归补测：exitCode 精度、auto-restart 对非 1 失败码的处理。  
  - `src/lib/ai/tauriAiSessionExport.test.ts`：补“save dialog 取消”“writeTextFile 抛错”“不改变按钮文案”的回归。  

另外一个工程性问题是：**你要求的 `npm run lint`、`npm test` 目前并不存在**。我建议直接把以下命令收束进 `package.json`：`"test": "vitest run"`, `"lint": "eslint ."`（若已配置 ESLint），以及 `"check": "npm run typecheck && npm run test && npm run build"`。这样体检、CI 和开发者自查都能统一入口。fileciteturn82file0L1-L3 fileciteturn83file0L1-L3

## Refactor and Patch Plan

**低风险必要重构**

第一块值得做、而且改动可以控制得很小的，是把**移动 bridge 的“监听地址”和“发布地址”分离**。这不是大重构，只是把目前混在 `bridge_pair_qr` 里的职责拆开。Rust 侧只管理监听；前端设置页负责告知用户“对外你想让手机连哪个地址”。这样可以顺手解决 LAN URL bug 和安全提示缺失两个问题。fileciteturn98file0L1-L3 fileciteturn68file0L1-L3

第二块是把 `xtermRegistry` 从“一对一映射”升级为“每个 PTY 一个活动实例”或“多个实例集合”。这里不需要去重写 `Shell.jsx` 或 `TerminalView`，只要把 registry 的表达能力补上，再明确 block 读取应该取谁。这个重构小、可回滚，而且能直接消掉主窗/浮窗并发的隐患。fileciteturn59file0L1-L3 fileciteturn60file0L1-L3

第三块是把 provider session 发现逻辑向 `spawn_blocking` 和缓存推进。它的价值不是“代码更漂亮”，而是避免一个本来低频、后台性质的能力去反噬终端主线程体验。这个改动也很适合独立提交。fileciteturn71file0L1-L3 fileciteturn78file0L1-L3

**推荐 patch 顺序**

- **第一批：必须先修**
  - `bridge_pair_qr` / `MobileAccessSettings` 的 LAN 地址 bug。  
  - `pty/events.rs` 的真实退出码传播。  
  - `bridge/server.rs` 的远程输入审计脱敏或降级。  
  - 推荐 commit 粒度：3 个独立 commit，不要混在一起。  
  - 验证方式：对应 Rust/前端单测 + 手工 smoke test。  

- **第二批：安全与稳定性**
  - bridge 鉴权从 query token 迁移到 header/首帧；CORS 从 permissive 收紧；设置页加“仅可信网络”提示。  
  - `xtermRegistry` 支持多实例或 active instance。  
  - 推荐 commit 粒度：安全协议一组、registry 一组。  
  - 验证方式：协议测试 + 主窗/浮窗并发手测。  

- **第三批：性能与工程化**
  - provider session 扫描下沉到阻塞线程池并加缓存。  
  - bridge preview 改为基于累计输出。  
  - `package.json` 增补 `test/lint/check`。  
  - 推荐 commit 粒度：性能一组，npm scripts 一组。  
  - 验证方式：profile/benchmark + 全量测试。  

## Open Questions

本次报告是**静态审查**，不是可执行 checkout 上的运行时审查。我没有在本环境里执行 `npm run typecheck`、`npm test`、`cargo test`、`cargo check` 或 `cargo clippy`；此外，仓库当前也没有 `npm run lint` 和 `npm test` 顶层脚本，所以你在需求里列出的命令清单还不能原样执行。这个结论是确定的，但由此导致的“是否已有隐藏编译错误/警告”仍待你在本地或 CI 上补跑。fileciteturn82file0L1-L3 fileciteturn83file0L1-L3

我这次优先覆盖了你要求中的终端、xterm、bridge/pairing、移动端设置、AI explain/export、capabilities 与关键 store；**没有完整审完** `src-tauri/src/overlay/**`、更广泛的 workflow 模块、完整 CSS/theme 体系、以及 lockfile 级别的依赖 CVE 扫描。因此，关于“覆盖过宽 CSS 冲突”“依赖已知漏洞”“overlay 特有窗口状态 bug”的判断，我不会在这份报告里冒充已经确认。若你要我继续第二轮，我建议优先补：`src/contexts/ThemeContext.jsx`、`src/index.css`、`src-tauri/src/overlay/**`、`package-lock.json`、`src-tauri/Cargo.lock`。fileciteturn91file0L1-L3 fileciteturn79file0L1-L3

如果你只想先做上线前止血，这份报告里最值得立即动手的 patch 是：**LAN 配对地址、真实退出码、远程输入审计脱敏、bridge 鉴权边界、xtermRegistry 并发模型**。这些项都能在**不改变现有功能语义与正常交互意图**的前提下，明显降低主流程和安全风险。
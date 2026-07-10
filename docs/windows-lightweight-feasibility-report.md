# ThreadTerm Windows 轻量化可行性评估报告

> 生成日期：2026-07-02 ｜ **复审更新：2026-07-04**（基于 `exp/windows-native-terminal-host` @ b4721b9 已提交代码逐项核查）
> 调研方法：5 个仓库实证代理（ThreadTerm 本地工作区 + nezha/orca 浅克隆）+ 4 个官方文档代理（Tauri/WebView2/Rust/Vite 一手来源）→ 提取 5 条关键论断 → 3 视角对抗核查（官方文档 / 仓库实证 / 量级时效）。
>
> **重要修正声明**：对抗核查**反驳了一个直觉结论**——"关闭 sourcemap 省 7MB"实测被修正为"**省约 1.5–1.7MB**"（原因见正文 Brotli 机制），本报告所有收益数字均为修正后版本。
>
> 分析基准（复审后）：分支已提交代码；`dist/` 构建于 Jul 3 21:41（**2.2MB，已无 .map**）、release 二进制与 `.dmg` 构建于 Jul 2 23:12、`mobile-app/dist` 构建于 Jul 2 23:10。Windows NSIS 数字仍待 Windows 机器复测。

---

## 一、结论（2026-07-04 复审版）

**A 阶段（低风险项）已全部落地并通过代码核查；安装包方向的"无需动架构"收益已经吃完。**

- **安装包方向**：A1–A5 全部实施完毕（关 sourcemap、去 shell 插件、删 workflow + 去 http/TLS 链、bridge 早退、Windows 只出 NSIS）。macOS 代理指标实测：`.dmg` **-32.38%**（10,192,198 → 6,892,319 字节）、可执行文件 **-24.53%**（19,917,472 → 15,031,632 字节）。剩余体积收益只剩 B 阶段（mobile-bridge feature 化 -1~2MB、opt-level 实验 -5~10%），且都需要实测背书。ThreadTerm 仍到不了 nezha 的 7.4MB——差距根源是产品功能面（移动端 HTTP 服务、SQLite、后端终端模拟器），不是构建配置。**Windows NSIS 合理目标维持 10–14MB 级，待 Step 0 基线确认。**
- **空闲内存与 WebView2 进程数方向：优化已经超出原方案。**除已落地的 Windows overlay 懒创建（`window.rs`，prewarm 默认 off、`THREADTERM_OVERLAY_PREWARM=1` 可回退）外，新增了原方案没有的 **lightweight mode**（`overlay/commands.rs` `overlay_set_lightweight_mode`：一键注销全部热键、隐藏并抑制 selector/float 创建、持久化 `overlay.lightweight_mode`，prewarm 同样被其禁用）——Windows 用户可将 overlay 常驻成本压到严格为零。剩余优化只有 B4（空闲销毁 + MemoryUsageTargetLevel）。
- **冷启动方向**：仍无任何测量数据；理论最大杠杆不变——把 CodeMirror 从 main chunk 拆出（B3 仍有效：`WorkspaceContentViews.tsx:21` 静态引 `WorkspaceCodeEditor`，后者顶部静态 import `@uiw/react-codemirror`；main chunk 现为 **738KB**）。

### 收益汇总（已实施项为实测值）

| 指标 | 状态 / 收益 | 置信度 |
|---|---|---|
| 安装包体积 | **已落地**：macOS `.dmg` -3,299,879 B（-32.38%）；Windows NSIS 收益待 Step 0 复测（预期同量级比例） | 高（macOS 实测）/ 中（Windows 待测） |
| Rust 二进制 | **已落地**：-4,885,840 B（-24.53%，含去 reqwest/rustls/ring 整条 TLS 链） | 高（实测） |
| 冷启动 | 无基线数据，**仍需实测**；B3 拆 main chunk 后主窗口首屏 JS 可少约 30% | 低 |
| Windows 空闲内存 | 懒创建 + lightweight mode 已落地（~230MB 注释仍为**未实测的开发者估计**，`window.rs:31`）；追加项 B4 再省一个 renderer 级 | 中 |
| WebView2 进程数 | 常态已是最优（1 webview）；lightweight mode 下永久 1 webview；热键使用后可靠 B4 空闲销毁回收 | 高 |

### 最大风险（复审版）

1. **外链回归未验证（A2 的遗留验证项，当前唯一未闭环）**——移除 `tauri-plugin-shell` 后，代码里没有任何替代打开通道：`Shell.jsx:722` 的 `WebLinksAddon` 用默认 handler（内部 `window.open`）、`Shell.jsx:670` 的 auth URL 也走 `window.open`，Rust 侧零 opener 调用。Tauri v2 WebView 内 `window.open` 外部 URL 能否唤起系统浏览器**必须在 dev 构建里点一次确认**（macOS 即可验证，不用等 Windows）。若失效，补 `tauri-plugin-opener`（不含 TLS 栈，不会吞掉 A3 的收益）。
2. **收益错觉**（对 B 阶段仍然成立）——Tauri 默认 `compression` feature 用 Brotli q9 压缩资产后才嵌入，NSIS 再过 LZMA，"删掉 XMB 文件"从来不等于"安装包小 XMB"。B 阶段任何优化仍以"构建前后安装包字节数对比"为准。
3. **selector/float 窗口合并/overlay 化**维持**不建议做**——懒创建 + lightweight mode 后常驻成本已为零甚至严格为零，收益彻底消失（见 C1）。
4. **削减 wezterm-term 后端状态**维持"收益中等、回归面大"（见 C3）。

---

## 二、Windows 轻量化的真实来源（机制层）

1. **Tauri 复用系统 WebView2，不捆绑引擎**。Evergreen Runtime 是 Windows 11 系统组件、绝大多数 Windows 10 已由微软推送（[MS: Evergreen vs Fixed](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version)）。ThreadTerm 未配置 `webviewInstallMode`，即默认 `downloadBootstrapper`（**安装包 +0MB**；其他选项：embedBootstrapper +1.8MB / offlineInstaller +127MB / fixedRuntime +180MB，[Tauri: Windows Installer](https://v2.tauri.app/distribute/windows-installer/)）。**复审更新**：`tauri.windows.conf.json` 已从"仅覆盖 transparent"扩展为完整 Windows 窗口配置 + `bundle.targets: ["nsis"]`（A5 落地，Windows 不再产 MSI）。
2. **安装包构成** = Rust 二进制（内嵌 Brotli 压缩后的前端资产 + include_bytes! 的移动端资产）+ `resources/shell-integration`（16KB，是 shell 集成脚本，与已移除的 shell 插件无关）+ NSIS stub，整体再过 LZMA（Tauri `nsis.compression` 默认 lzma）。nezha 的数据显示 MSI 比 NSIS 大 25%（9.74MB vs 7.79MB）——**Windows 只发 NSIS 已实施**。
3. **Rust 二进制现存四大块**（`src-tauri/Cargo.toml`，无 `[features]` 段，全部无条件编译）：
   - tauri 2 + **6 个插件基座**（dialog/notification/global-shortcut/fs/single-instance/window-state；shell 与 http 已移除）
   - ~~`tauri-plugin-http` → reqwest → rustls + ring 整条 TLS 栈~~ **已随 workflow 删除移除**。验证：`cargo tree -i reqwest` 在 host 与 `x86_64-pc-windows-msvc` target 下均无输出；Cargo.lock 中残留的 `reqwest 0.13.2` 仅由 `tauri` 自身在非桌面 target（`--target all` 才可见，移动端）引入，不进桌面二进制；`ring`/`rustls`/`hyper-rustls` 已从 Cargo.lock 消失
   - `axum 0.7 (ws)` → hyper 1.9 / hyper-util / tower 0.5 / tokio-tungstenite 0.24 服务端栈（激进优化下参考值 ~618KB，[axum#864](https://github.com/tokio-rs/axum/discussions/864)）——B1 的目标
   - `tattoy-wezterm-term` fork 及约 15 个 termwiz 系 crate（核心 PTY 功能，不可拆）
   - `rusqlite bundled` 静态编译 SQLite（官方 footprint <900KiB，[sqlite.org/about](https://www.sqlite.org/about.html)）
4. **前端 dist（复审后）**：sourcemap 已关闭，dist 总量 **2.2MB、零 .map 文件**（原 9.3MB 中 7.0MB 是 .map）。Tauri 嵌入 frontendDist 时递归全量嵌入、无 .map 过滤规则的问题已因源头关闭而不再相关。
5. **多窗口内存**：MS 官方进程模型（[Process model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)）+ tauri-runtime-wry 2.10.1 源码证实：**Tauri 所有窗口默认共享同一 user data folder → 共享唯一 browser 进程和 GPU/helper 进程**；renderer 按站点隔离分配，同源多窗口可能共用 renderer。即多开一个隐藏窗口的代价是"0~1 个 renderer"。`window.rs:31` 注释的 ~230MB 仍未实测——Step 0 顺带裁决。

---

## 三、当前仍偏重的地方（复审后，file:line 实证）

**已解决（原表 #1/#2/#6/#7）**：生产 sourcemap（`vite.config.js:32`、`mobile-app/vite.config.ts:29` 已置 false）；workflow + `tauri-plugin-http`（功能删除、依赖清空）；bridge 无订阅拷贝（`bridge/mod.rs:515-517` `broadcast_preview`、`:533-535` `broadcast_terminal_output` 均以 `has_subscribers()` 在 card_id 查找与 `to_string()` 之前早退）；`tauri-plugin-shell`（Cargo.toml/lib.rs/capabilities/tauri.conf.json 四处清除，`package.json` 同步移除）。

| # | 剩余偏重点 | 证据 | 量级 |
|---|---|---|---|
| 1 | mobile bridge 栈无条件编译 | axum/tower-http/sha2/rand 仅 `src/bridge/*` 使用；`bridge/server.rs` include_bytes! 嵌入 5 个移动端文件 ≈589KB；`build.rs` verify_mobile_bundle 强制校验；接线点 `lib.rs:1,68-69,105-111` | 二进制 1–2MB 级（需 cargo bloat） |
| 2 | 每个 PTY session 无条件维护 wezterm-term 模拟器 | `pty/mod.rs` 构造 snapshot，`pty/events.rs` 每 chunk `apply_output`，与 bridge 是否开启无关 | CPU + scrollback 内存/session |
| 3 | PTY 输出 `app.emit` 全局广播到所有 webview | `pty/events.rs:543-550`；前端按 id/seq 过滤 | 多窗口时冗余 IPC（Windows 常态单 webview，影响小） |
| 4 | main chunk 738KB 静态含 CodeMirror 核心 | `src/components/files/WorkspaceContentViews.tsx:21` 静态引 `WorkspaceCodeEditor`，其顶部静态 import `@uiw/react-codemirror`/`@codemirror/state`/`view`/`merge`（语言包已是动态 import） | 首屏 JS |

**好消息（已经做对的部分，复审后追加）**：
- release profile 已激进：`opt-level=3 / lto="thin" / codegen-units=1 / strip="symbols" / panic="abort"`（Cargo.toml:67-71）
- bridge 服务器不是无条件启动（需用户开启或持久化恢复；未启用时零端口监听、零后台任务），且现在无订阅时连每 flush 的拷贝都没有了（A4）
- PTY 已有 16ms/64KB 合帧 + 200KB/20KB ack 流控（`session.rs:49` 另有 256KB raw ring buffer 供第二 webview 回放）——比 nezha 还完善
- codemirror 语言包已动态拆分；Windows overlay 懒创建 + lightweight mode 已落地；`webviewInstallMode` 默认即最优
- selector/float 关闭走 hide 复用不销毁；Windows 上创建 overlay 窗口的 IPC 命令已改 async 规避 WebView2 同步命令死锁（`overlay/commands.rs`，wry#583 / tauri#4121）

---

## 四、对比 Nezha：7.4MB 的真实成因

Release 实测（gh api）：**v0.4.4 NSIS = 7,793,605 字节（约 7.4MB）**，MSI 9,736,192 字节，macOS dmg 12.2MB——传闻属实。归因排序（全部基于其仓库文件）：

1. **依赖面小是唯一主因**：Cargo.lock 仅 **606 个 crate**、2 个插件（opener/dialog）、无 SQLite（`storage.rs:78-156` 纯 JSON 文件 + 临时文件 rename 原子写）、无任何 HTTP server（hyper 仅作为 reqwest 客户端依赖）、后端不维护终端 grid（原始字节 UTF-8 边界安全切分后直通前端，恢复靠 `@xterm/addon-serialize`）。
2. **反直觉发现**：nezha **完全没有 `[profile.release]` 调优**——没有 LTO、没有 strip 配置、没有 opt-level（仅 [profile.dev] debug=0），CI 也未注入 RUSTFLAGS。**编译参数不是差距来源；ThreadTerm 在这一项上反而领先。**
3. **前端并不轻**（15 个 @codemirror 包 + shiki + @xterm 全家桶 + react 19 + marked + lucide-react），照样 7.4MB——证明 JS 经压缩后对安装包的贡献有限，**前端依赖数量不是 Windows 安装包的主要敌人，sourcemap 和 Rust 依赖才是**（ThreadTerm 已把这两项处理完）。其 vite.config.ts 无 build 段（sourcemap 默认 false）、单 HTML 入口。
4. **依赖细节**：reqwest `default-features=false` + `[json, rustls]`；tokio 仅 sync/macros/rt/time/process/io-util 六个 feature；未配置 webviewInstallMode（默认 downloadBootstrapper）。
5. **PTY 链路（可直接借鉴）**：
   - 双通道模型：agent 任务用 `tauri::ipc::Channel<String>` 直投单一前端订阅者（跳过全局事件总线，pty.rs:257-279），shell 终端走 app.emit + 前端按 shell_id 过滤
   - 合帧：16ms flush + 64KB 批量上限 + 容量 32 有界 sync_channel，通道满时 reader 阻塞、背压传导到 OS 内核 PTY 缓冲区（pty.rs:16-20, 308-347）
6. **不可照搬**（产品定位差异）：砍 HTTP server（ThreadTerm 移动端依赖 axum）、砍 SQLite（AI 线程/审计日志是关系型需求）、砍多窗口（overlay 是核心卖点）。nezha 定位"AI 编程轻量级 IDE"，后端仅 11,226 行 Rust。
7. **参照 nezha 的一个可借鉴点已凸显**：nezha 用 `tauri-plugin-opener` 打开外链——若 A2 外链验证失败，这就是现成答案。

## 五、对比 Orca：不适合作轻量化参照

**Orca 是 Electron 应用**（electron ^42.3.3 + electron-vite + electron-builder），Windows 安装包实测 **188,928,648 字节（约 189MB）**（v1.4.117 orca-windows-setup.exe），自带 Chromium 与 sherpa-onnx（含 sherpa-onnx-win-x64 平台二进制）等重运行时——与"复用系统 WebView2"的 Tauri 模型不同构，**体积维度上不具参照价值**。

但有四个可迁移的工程实践：
1. **运行时/构建时依赖严格切分**：dependencies 仅 22 项（node-pty、ssh2 等主进程必需），monaco/tiptap/mermaid/react 等全部放 devDependencies 由 bundler 内联
2. **内建性能预算门禁**：`bench:idle-cpu`、`bench:startup`、`bench:daemon-coldstart`、终端性能 e2e 预算脚本（check-terminal-perf-report-budgets.mjs）——这正是 ThreadTerm 缺失的"冷启动/空闲内存可回归测量"
3. **编译期常量剔除遥测代码**（electron.vite.config.ts：无官方 CI 密钥时折叠为字面量 null 短路）——对应 Tauri 的 cargo feature 思路
4. **`@xterm/headless` + addon-serialize 的无头终端状态方案** + node-pty/xterm 补丁——可作为削减 wezterm-term 的备选参照（功能参照，非体积参照）

---

## 六、分阶段优化方案（复审后状态）

### A. 低风险项 —— **全部已落地**（b4721b9 及之前提交）

| 优化点 | 状态 | 落地位置 | 遗留事项 |
|---|---|---|---|
| A1 关闭生产 sourcemap | ✅ 完成 | `vite.config.js:32`、`mobile-app/vite.config.ts:29`；dist 已无 .map、总量 2.2MB | 无 |
| A2 移除 `tauri-plugin-shell` | ✅ 完成（**验证未闭环**） | Cargo.toml / lib.rs / capabilities/default.json / tauri.conf.json 四处清除；package.json 同步移除 | **外链回归验证未做**：`WebLinksAddon` 默认 handler 与 `Shell.jsx:670` 均依赖 `window.open`，Rust 侧无 opener——dev 构建点击终端内链接验证；失效则补 `tauri-plugin-opener` |
| A3 删除 workflow + 移除 `tauri-plugin-http` | ✅ 完成 | `src/lib/workflows/**`、`src/components/workflows/**` 已删；ring/rustls/hyper-rustls 已出 Cargo.lock；旧 settings bundle 的 `workflows` section 被 `parseSettingsBundle` 静默忽略 | 无（reqwest 锁文件残留属 tauri 移动端 target，不进桌面二进制，已核实） |
| A4 bridge 无订阅早退 | ✅ 完成 | `bridge/mod.rs:515-517`、`:533-535` `has_subscribers()` 早退（`receiver_count() > 0`） | 无 |
| A5 Windows 只发 NSIS | ✅ 完成 | `tauri.windows.conf.json` `bundle.targets: ["nsis"]` | 若未来有企业 GPO 部署需求再恢复 MSI |
| （超出原方案）overlay lightweight mode | ✅ 追加完成 | `overlay/commands.rs` `overlay_set_lightweight_mode`：注销全部热键、隐藏并抑制 selector/float、持久化设置；prewarm 同样被禁用 | 无 |

**A 阶段实测收益（macOS 代理指标）**：`.dmg` -32.38%、可执行文件 -24.53%（字节数见第八节表格）。

### B. 中风险，需要验证 —— **下一阶段主战场，均未开始**

| 优化点 | 文件/模块 | 原理 | 预期收益 | 风险 | 验证方式 |
|---|---|---|---|---|---|
| B1 `mobile-bridge` Cargo feature（默认 on，提供 lite 构建） | `Cargo.toml` 加 `[features]`；接线点 `lib.rs:1,68-69,105-111`、`build.rs` verify_mobile_bundle 条件化、axum/tower-http/sha2/rand 标 optional | 编译期整体剔除 axum 栈 + 589KB 嵌入资产 | lite 包二进制 **-1~2MB** | cfg 组合增多、CI 需双矩阵；invoke handler 缺失时前端需优雅降级 | `cargo build --release --no-default-features` 对比体积 + 冒烟测试 |
| B2 `opt-level="s"`（可试 lto="fat"） | `Cargo.toml [profile.release]`（现 :67-71） | .text 段典型 -8~15%（[rust#142164 实测](https://github.com/rust-lang/rust/issues/142164)）；fat LTO 不保证更小 | 二进制 -5~10% | opt-level=s/z 关闭部分向量化，PTY 解析吞吐可能受损 | 构建对比 + 大量滚动输出压测（vtebench 思路） |
| B3 CodeMirror 出 main chunk | `WorkspaceContentViews.tsx:21` 对 `WorkspaceCodeEditor` 改 `React.lazy`（codemirror 静态 import 集中在 `WorkspaceCodeEditor.tsx` 顶部，单点改造） | 738KB main chunk 是首屏解析大头 | 主窗口首屏 JS 约 -30%；**不减安装包**（chunk 仍进 dist） | 首次打开编辑器有加载延迟 | Lighthouse/Performance 面板对比首帧 |
| B4 overlay 空闲销毁 + `set_memory_usage_level(Low)` | `overlay/commands.rs` hide 路径；经 `with_webview` 调 wry `WebViewExtWindows::set_memory_usage_level`（wry 0.54.4 已暴露，Tauri 2.10.3 未封装） | hide 不释放 WebView2 内存（MS 文档明确）；Low 档可换出浏览器进程内存 | 热键使用后的驻留内存回收（lightweight mode 用户无需此项） | 空闲销毁使下次热键回到 300-800ms 冷路径；API 需 Runtime 114+ | Windows 上按 user data folder 聚合 msedgewebview2 Working Set 前后对比 |

### C. 高风险架构调整（结论不变，均不建议近期做）

| 优化点 | 判断 | 理由 |
|---|---|---|
| C1 selector/float 合并或 overlay 进主窗口 | **不做**（理由更充分了） | float 承载活跃 xterm 会话（导航即断，仅有 256KB raw 回放兜底 `session.rs:49`）；selector 必须能在任意应用之上被全局热键唤起，无法 DOM 化；Windows 懒创建 + lightweight mode 后常驻成本已为零甚至严格为零，收益彻底消失 |
| C2 替换/移除 rusqlite bundled | **不做** | Windows 无系统 SQLite 可链接，bundled 是唯一现实选项；SQLite 本体 <900KiB，收益 ~1MB 却要重写存储层或牺牲可移植性 |
| C3 wezterm-term 快照懒激活（仅 bridge/float 需要时构建，靠 256KB raw buffer 追赶） | **谨慎缓做** | 省每 session 的 grid+scrollback 内存与每 chunk 解析 CPU；但长会话下 raw buffer 截断会导致追赶后终端状态错乱——这正是当初引入模拟器的原因。若做，先实测 `SESSION_SCROLLBACK_LINES`（session.rs:50，3000 行）下单 session 实际内存 |
| C4 PTY 全面改 tauri ipc Channel | **降级为 emit_to** | ThreadTerm 是真·多消费者（main+float+bridge），与 Channel 单订阅模型不匹配。更便宜的 80% 收益：`events.rs:543` 改 `emit_to` 定向投递 main（float 存活时再投 float）。Windows 常态单 webview，全面重构收益小 |

---

## 七、九项专项判断（速查，复审后状态）

| # | 方案 | 判断 | 状态 / 要点 |
|---|---|---|---|
| 1 | 关闭生产 sourcemap | ✅ 做 | **已完成**；实际收益体现在 -32.38% 总降幅中 |
| 2 | desktop 默认不嵌 mobile-app | ⚠️ 并入 #3 | 未做；嵌入仅 589KB，单独做不值，随 B1 一起 |
| 3 | bridge/axum/ws 改 Cargo feature | ✅ 值得 | **未做（B1）**；Rust 侧剩余最大单项收益；默认 on + lite 构建 |
| 4 | selector/float 复用窗口/overlay 化 | ❌ 不做 | 懒创建 + lightweight mode 已把常驻成本清零，结论加强 |
| 5 | 减少 Tauri plugins | ✅ 部分 | **已完成**：shell + http 已移除（8→6）；其余 6 个均有真实消费，保留 |
| 6 | 替换/移除 rusqlite bundled | ❌ 保留 | 见 C2 |
| 7 | 减少 wezterm-term 状态维护 | ⚠️ 缓做 | 未做；先实测内存占比再决定（见 C3） |
| 8 | PTY 借鉴 nezha Channel 模型 | ⚠️ 降级 | 未做；只补 `emit_to` 定向投递即可拿走大部分收益（C4） |
| 9 | release profile 调整 | 保留为基线 | 未动（仍 opt-level=3）；`opt-level="s"` 值得开分支实验（B2） |

---

## 八、下一步路线（复审后：MVP 已完成，进入验证与 B 阶段）

原 MVP（Step 1–3 + A4/A5）已全部落地。接下来按优先级：

```text
Next 1 外链回归验证（半小时，macOS dev 构建即可，A 阶段唯一未闭环项）：
  npm run tauri dev → 终端内点击 addon-web-links 识别的 URL + 触发 codex 设备授权 URL
  能唤起系统浏览器 → A2 闭环
  不能 → 加 tauri-plugin-opener（nezha 同款，无 TLS 栈，不吞 A3 收益）

Next 2 建 Windows 基线（Windows 机器，半天）——裁决所有 Windows 侧数字：
  npm run tauri build
  记录：NSIS 字节数、安装后目录大小、threadterm.exe 大小
  cargo install cargo-bloat && cargo bloat --release --crates -n 40
  冷启动：Measure-Command { Start-Process ThreadTerm.exe } + 首帧时间戳日志
  内存：Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"
        | Measure-Object WorkingSetSize -Sum
  （对比 THREADTERM_OVERLAY_PREWARM=1 / 默认 / lightweight mode 三档，
   一次性裁决 window.rs:31 的 230MB 注释真伪）

Next 3（实验分支，1 行）：opt-level="s" → 体积对比 + 终端滚动压测（B2）
Next 4（中期）：feature "mobile-bridge" → lite 构建对比，决定是否进正式分发（B1）
Next 5（前端性能，单点改造）：WorkspaceCodeEditor 改 React.lazy（B3，收益是首屏不是体积）
Next 6（Windows 内存尾项）：overlay 空闲销毁 + MemoryUsageTargetLevel=Low（B4）
```

另建议借鉴 Orca 把 Next 2 脚本化成 `bench:size` / `bench:startup`，让轻量化成为可回归的 CI 指标而不是一次性运动。

### A 阶段实施后的本机字节数记录（macOS 代理指标，2026-07-04 复核通过）

当前机器不是 Windows，无法生成 NSIS；以下为同一工作区、同一 macOS arm64 打包链路下的安装包代理指标，Windows NSIS 仍需按 Next 2 复测。**复审已确认现存构建产物（Jul 2 23:12）与下表逐字节吻合。**

| 指标 | 原始基线 | 关闭 sourcemap + 去 shell 后 | 删除 workflow + 去 http + A4 后 | 相对原始节省 |
|---|---:|---:|---:|---:|
| `.dmg` 安装包字节数 | 10,192,198 | 8,265,400 | **6,892,319** | **3,299,879（32.38%）** |
| release 可执行文件字节数 | 19,917,472 | 17,814,560 | **15,031,632** | **4,885,840（24.53%）** |

验证补充（2026-07-04 复核）：`cargo tree -i reqwest` 在 host 与 `x86_64-pc-windows-msvc` 下均无输出；`cargo tree --target all -i reqwest` 显示锁文件中残留的 `reqwest 0.13.2` 仅由 `tauri` 在非桌面 target（移动端）引入；`ring` 在 Cargo.lock 中已无条目；`cargo-bloat` 本机未安装，crate 级 bloat 表留待 Next 2 在 Windows 上产出。

---

## 附录 A：关键论断对抗核查结果

| 论断 | 结果 |
|---|---|
| C1 关闭 sourcemap 省约 7MB（.map 1:1 进包） | **被反驳并修正**：tauri 默认 compression feature 以 Brotli q9 逐文件压缩后嵌入（tauri-codegen-2.5.5 embedded_assets.rs:288-303）；7,266,204 B 的 .map 实测压缩后 1,680,768 B，**实际收益 ≈1.5-1.7MB**（已实施，收益并入实测总降幅） |
| C2 Tauri 多窗口共享同一 WebView2 进程组 | 存活（官方文档 + tauri-runtime-wry 源码双重证实） |
| C3 Windows 预创建双 overlay ≈230MB 常驻 | 存活但**降级**：唯一来源是 window.rs:31 代码注释，全仓库无任何实测数据；考虑进程共享模型实际可能低于此值，Next 2 裁决 |
| C4 nezha 7.4MB 归因于依赖面而非编译配置 | 存活（release 字节数 + Cargo.toml/Cargo.lock 实证） |
| C5 plugin-http 与 bridge 栈可整体 feature-gate 且 MB 级收益 | **部分兑现**：plugin-http 已随 workflow 删除直接移除（无需 feature-gate），实测计入 -24.53% 二进制降幅；bridge 栈 feature 化（B1）待做，收益量级待 cargo bloat 实测 |

## 附录 B：主要来源

- 本地仓库 file:line（正文已标注；2026-07-04 复审基于 `exp/windows-native-terminal-host` @ b4721b9 已提交代码刷新）
- Tauri 官方：[Windows Installer](https://v2.tauri.app/distribute/windows-installer/)、[Config Reference](https://v2.tauri.app/reference/config/)、[App Size](https://v2.tauri.app/concept/size/)
- Microsoft：[WebView2 Process Model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)、[Distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)、[MemoryUsageTargetLevel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.memoryusagetargetlevel)
- [min-sized-rust](https://github.com/johnthagen/min-sized-rust)、[rust#142164 opt-level 实测](https://github.com/rust-lang/rust/issues/142164)、[Rust Performance Book: Build Configuration](https://nnethercote.github.io/perf-book/build-configuration.html)
- [axum#864 二进制体积讨论](https://github.com/tokio-rs/axum/discussions/864)、[sqlite.org/about](https://www.sqlite.org/about.html)、[Vite build options](https://vite.dev/config/build-options)
- nezha / orca GitHub releases（gh api 实测字节数）；tauri-2.10.3 / tauri-codegen-2.5.5 / tauri-runtime-wry-2.10.1 / wry-0.54.4 本机 cargo registry 源码

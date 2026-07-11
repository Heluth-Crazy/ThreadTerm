# ThreadTerm 全项目审查报告

> 审查日期：2026-07-11（Asia/Shanghai）<br>
> 审查基线：`825cf42bdb868c90d59951112cca86ca6e5a4002`<br>
> 分支：`exp/windows-native-terminal-host`<br>
> 整改复核日期：2026-07-11<br>
> 范围：代码、目录结构、隐含缺陷、安全、性能、测试、发布工程、软件版权与许可证、macOS / Windows 适配度<br>
> 约束：原始审查阶段未修改任何源码或配置，只新增本报告。<br>
> 声明：版权与许可证部分是工程合规初筛，不构成法律意见。

## 0. 首批整改进度（2026-07-11）

用户授权整改后，当前工作区已完成并验证首批 3 个工程 P0；以下状态是对审查基线的增量更新，尚未改变整份报告的发布 `BLOCK` 结论：

1. **RB-04 Mobile Bridge：已修复。** 32 字符高熵配对 secret 在服务端绑定权限上限，客户端只能降权；新 secret 会作废旧 secret。revoke、expiry、stop 通过 tombstone、授权 revision 和 active authorization lease 使既有连接失效；停止失败会保留 runtime handle，允许再次 stop，而不会把仍在运行的服务误报为已停止。新增 pairing、Axum、真实 WebSocket、并发 revoke / stop 回归。
2. **RB-05 PTY ACK：已修复。** 后端改为显式 renderer / background consumer 与 process-global `seq` 累计 ACK；credit 由所有活跃 renderer 的最小 watermark 控制，无 renderer 时由 background consumer 接管，并以 30 秒 TTL 回收失联 renderer。输出提交、snapshot barrier 与 replay buffer 已串行化，前端 ACK 在消费成功后合并重试，snapshot 与 live output 严格排队，LRU 卸载和 attach 失败均有回归覆盖。
3. **clean-clone 开发启动：已修复。** `beforeDevCommand` 先构建 mobile bundle，再启动 desktop Vite；npm scripts 使用仓库锁定的 Tauri CLI，不再依赖全局 `cargo-tauri`；`init.sh` 同步准备 mobile bundle。已在不包含 `mobile-app/dist` 的临时工作副本中完成首次构建、Vite ready 与 Cargo check。
4. **开发 / 发布文档：已补齐。** 新增首次运行、构建发布、Windows EXE、全局 overlay 手测文档；修正 README 架构路径、Windows shell 顺序、跨平台 release 命令，并调整 `.gitignore` 使 `.github/**` 与必要文档可被跟踪。

整改后验证：`npm run check` 通过（84 个文件、654 个 Vitest、Clippy），完整 Cargo 234 个测试通过，Bridge 定向 59 个、PTY 定向 51 个 Rust 测试通过，desktop E2E 4 个、mobile E2E 20 个通过，`--no-default-features` 编译、生产前端构建和 macOS `.app` 打包通过；`npm audit --omit=dev` 为 0 个漏洞。现有 31 个 ESLint warning 仍是既有技术债。

仍然阻断发布的主要事项：RB-01～RB-03 权利链 / 许可证边界、RB-06 CI 与签名公证、真实 Windows / macOS 分发验证，以及其余 P1/P2 缺陷。代码整改不能替代外部权属材料、签名凭据或物理 Windows 证据。

## 1. 结论摘要

**最终结论：`BLOCK`。当前版本适合继续开发与内部测试，但不满足公开稳定版或商业发布条件。**

审查基线的风险加权综合评分为 **4.9 / 10**。这不是简单算术平均；首批整改已消除授权绕过、PTY 永久停流和 clean-clone 失败 3 个工程阻断项，但未重新执行全量法律与双平台发布审查，因此不据此改写历史评分。权利链、签名/公证和真实 Windows 验证仍属于“一项未解决即可阻断发布”的门槛。

最重要的结论：

1. **版权权利链无法仅从仓库证明。** 初始提交是 `OpenWork v1.21.0`，当时为专有许可证和 `UNLICENSED`；后续同一 Git 身份将项目改为 MIT，但仓库没有 OpenWork 版权转让或再许可授权文件。当前 `src/**` 仍有保守统计 578 行可直接追溯到初始提交。
2. **源码仓库不能笼统声称“全部 MIT”。** 仓库跟踪了 Trellis 的 AGPL-3.0 生成文件，以及 GitNexus 的 PolyForm Noncommercial 模板副本；现有根 MIT 没有标注这些路径的独立许可证边界。
3. **Mobile Bridge 基线授权缺陷已在整改工作树修复。** 权限上限、连接期授权 lease、revoke / expiry / stop 失效及失败重试均已有服务端回归；剩余风险是明文 LAN transport、宽 CORS、query token 兼容路径和未做外部渗透测试。
4. **后台 PTY 永久停流已在整改工作树修复。** 显式 consumer、累计 ACK、renderer TTL、原子 snapshot barrier 和前端消费后 ACK 覆盖了 LRU、双消费者、attach 失败与高输出场景。
5. **全新克隆的标准开发启动链已在整改工作树修复。** desktop dev、`start.sh`、`start.ps1` 和 `init.sh` 均会在 Rust build 前准备 mobile bundle，并已用不含 `mobile-app/dist` 的临时副本验证。
6. **自动化测试数量可观，但发布门禁仍不成立。** 本轮整改后 654 个 Vitest、234 个 Cargo test、4 个 desktop browser E2E、20 个 mobile E2E 全部通过；然而没有 CI，desktop E2E 使用 Chromium + fake Tauri，不能证明 WKWebView / WebView2、真实 PTY、全局热键、通知和安装器正常。
7. **macOS 代码适配优于 Windows，但两端都未达到稳定发布成熟度。** macOS 代码适配评分约 68/100，Windows 约 57/100；Windows 当前只能称为“重点兼容”，不能称为“已验证的一等发布目标”。
8. **当前 macOS `.app` 不可作为公开发行物。** 本轮整改工作树的 `.app` 仅为 ad-hoc linker signature，严格签名校验失败，且没有 notarization ticket；仓库也没有 Windows Authenticode 签名流水线。

## 2. 分项评分（审查基线）

| 维度 | 评分 | 结论 |
|---|---:|---|
| 架构与目录结构 | 6.6 / 10 | 分层清楚，但核心 orchestration 文件过大，边界继续漂移 |
| 正确性与稳健性 | 5.0 / 10 | 多数日常路径稳定，但存在可导致串线、卡流、残留进程的确定缺陷 |
| 安全 | 3.5 / 10 | 基线的 Mobile Bridge 权限与撤销语义构成发布阻断；整改状态见第 0、4 节 |
| 可维护性 | 6.2 / 10 | 测试密度较好；核心 `Shell.jsx` 无静态类型且职责过多 |
| 性能与资源治理 | 5.4 / 10 | bundle 合理，但 PTY、重复解析、持久化和移动 bridge 有系统性放大 |
| 自动化测试资产 | 7.0 / 10 | 单测与 browser E2E 数量可观 |
| 发布质量门禁 | 4.0 / 10 | 无 CI、无真实平台 E2E、无有效 startup benchmark |
| macOS 代码适配 | 6.8 / 10 | AppKit / NSPanel 较深入，键盘、CLI PATH、多屏、分发仍有明显缺口 |
| Windows 代码适配 | 5.7 / 10 | 有 ConPTY 专项优化，但真机、安装器、IME、DPI、窗口原生感证据不足 |
| 版权与许可证 | 3.0 / 10 | 权利链、AGPL、PolyForm、第三方 NOTICE 均未闭环 |
| 发布成熟度 | 3.0 / 10 | 无签名/公证/Windows 发布矩阵/更新与崩溃治理 |

## 3. 审查方法与验证结果

### 3.1 审查基线的代码与架构范围

- `src/`：227 个文件，约 42,384 行。
- `src-tauri/`：44 个文本文件，约 15,595 行。
- `mobile-app/`：38 个文件，约 7,893 行。
- 前端生产文件约 154 个，审查基线单元测试文件 83 个，Rust 源文件 37 个。
- GitNexus 索引已刷新至审查基线 HEAD：6,374 个 nodes、11,979 个 edges、285 个 clusters、300 个 flows；未提交整改工作树不计入该索引统计。
- 对 241 个 TS / JS 模块、567 条内部 import edge 的静态检查未发现循环依赖。

### 3.2 本轮实际执行的验证

| 验证 | 结果 | 备注 |
|---|---|---|
| `npm run check` | PASS | ESLint 0 error、31 warning；TypeScript、84 个文件 / 654 个 Vitest、mobile build、Clippy 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | PASS | 234 passed，0 failed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | PASS | 无格式差异 |
| `cargo check --manifest-path src-tauri/Cargo.toml --no-default-features` | PASS | 0 error；19 个预期 `dead_code` warning |
| Bridge 定向 Rust 测试 | PASS | 59 passed，覆盖 pairing、active authorization、revoke、stop 与 WebSocket 生命周期 |
| PTY 定向 Rust 测试 | PASS | 51 passed，覆盖累计 ACK、consumer、TTL、snapshot barrier 与 shutdown |
| `npm run test:e2e:desktop` | PASS | 4 passed；Chromium + fake Tauri，不是真实桌面端 |
| `npm run test:e2e:mobile` | PASS | 20 passed；WebSocket / snapshot 存在 mock |
| `npm run build` | PASS | 2,358 个 modules；有 Tauri event 动静态 import 无法拆 chunk 的 warning |
| `npm run tauri:build -- --bundles app` | PASS | 仓库锁定的 Tauri CLI 成功构建 macOS `.app` |
| 缺失 `mobile-app/dist` 的临时副本 | PASS | `build:mobile`、desktop Vite ready、Cargo check 与本地 Tauri CLI 均通过 |
| `npm audit --omit=dev` | PASS | 0 vulnerabilities |
| `cargo audit` | 未执行 | 当前环境未安装，应列为发布门禁缺口 |

注意：ESLint 以 `--max-warnings=31` 放行，而当前正好有 31 个 warning。`CodexChatView.tsx:211`、`WorkspaceCodeEditor.tsx:998`、`MobileAccessSettings.tsx:211`、`Shell.jsx:1038` 等包含 Hook dependency warning；这属于“达到上限”，不是健康余量。

### 3.3 本轮未能证明的事项

- 未在物理 Windows 机器运行 NSIS、ConPTY、IME、WebView2、DPI、多屏和 GPU 测试。
- 未用真实 Tauri driver 自动化 WKWebView / WebView2；现有 desktop E2E 是浏览器模拟。
- 未获得有效的 cold / warm startup、首帧可见、可交互时间、RSS、idle CPU 或完整进程树资源数据。
- 未进行外部渗透测试、LAN 抓包或长期压力测试。
- 未看到仓库之外的 OpenWork 权属文件、CLA、雇佣成果协议或商业许可证。

## 4. 发布阻断项

### RB-01：OpenWork → ThreadTerm 的再许可权利链无法从仓库证明

**严重度：P0；置信度：仓库事实高，法律影响中。**

- 初始提交 `d5ccf824bdff02e498eb2e13a3d3e3395254519c` 标题为 `initial commit - OpenWork v1.21.0`。
- 该提交的 `LICENSE` 是 `OpenWork Proprietary License`，版权人为 OpenWork；`package.json` 为 `@openwork/openwork@1.21.0`、`UNLICENSED`。
- 提交 `47683c533a6f5ac89a7d809713b9c7c00f1689ff` 才将项目许可证改为 MIT。
- rename / copy-aware blame 的保守统计显示，当前 `src/**` 仍有 16 个文件、578 行直接追溯到初始专有提交；其中 `src/components/terminal/Shell.jsx` 339 行、`src/components/settings/Settings.tsx` 72 行。
- 同一 Git 身份执行初始提交与许可证切换，但 Git 身份本身不能证明其拥有 OpenWork 版权或获得再许可授权。

**结论：** 在继续以 MIT 公开或商业发布前，应归档版权转让、雇佣成果归属、OpenWork 书面再许可或其他足以证明权利链的材料；如果无法取得，需要对继承代码做专项法律审查或独立重写。不能据此直接断言存在侵权，但也不能从现仓库证明 MIT 再许可成立。

### RB-02：Trellis 的 AGPL-3.0 文件没有许可证边界

**严重度：P0（源码发行）；置信度：来源高，许可证对整个聚合仓库的扩张范围中。**

- `.trellis/.version:1` 为 `0.5.9`；`.trellis/.template-hashes.json` 明确记录生成/管理的 scripts、skills、agents 与 hooks。
- Git 跟踪 56 个 `.trellis/**`、30 个 `.agents/skills/trellis-*`、7 个 `.codex/**` 文件；`AGENTS.md` 也包含 Trellis 管理区块。
- 抽样文件与官方 `v0.5.9` template SHA-256 一致。
- Trellis `v0.5.9` 官方许可证为 [AGPL-3.0](https://github.com/mindfold-ai/Trellis/blob/v0.5.9/LICENSE)，未发现 template output exception。

这些文件不会进入当前 Tauri 二进制或 npm tarball，主要影响源码仓库 / source archive。不能仅因同仓库包含 AGPL 文件就断言独立桌面应用整体必须转为 AGPL；但 Trellis 文件自身不能被根 MIT 笼统再许可。公开源码发行应附 AGPL 文本、Mindfold 版权、修改说明和对应源码，或从发行源包排除这些文件，或取得明确输出例外 / 另行授权。

### RB-03：GitNexus 模板受 PolyForm Noncommercial 限制

**严重度：P0（商业源码发行）；置信度：高。**

- `.agents/skills/gitnexus/**` 有 6 个文件，其中 5 个与官方 `gitnexus@1.6.3` 模板逐字且 SHA-256 一致。
- 官方 package metadata 与仓库使用 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)。该许可证将许可用途限制为非商业目的，并要求复制件附许可证条款或 URL 以及提供的 `Required Notice`。
- 当前仓库没有 PolyForm 文本、URL 或 GitNexus Required Notice，根 MIT 不能替代它。

这些文件主要影响源码仓库，不进入桌面二进制。非商业公开分发仍需补 NOTICE；商业使用或商业源码发行应先取得 GitNexus 商业授权，或停止分发这些模板副本。

### RB-04：Mobile Bridge 授权生命周期失效

**严重度：P0；置信度：高，已通过反方复核。**

**整改状态：当前工作区已修复并通过 pairing、Axum、真实 WebSocket、并发 revoke / stop 生命周期回归；以下内容仅保留为审查基线证据。当前实现使用服务端权限上限、active authorization lease、tombstone / revision 失效和可重试 stop handle。**

1. 桌面端选择的 `read_only` 只写入 QR URL；服务端 pending OTP 不保存该授权上限。移动端 POST `/pair` 时可把 `permission` 改为 `full`，服务端直接采用请求值：`MobileAccessSettings.tsx:40-51`、`mobile-app/src/bridge/pairing.ts:47-63`、`src-tauri/src/bridge/pairing.rs:53-105`。
2. 已认证 WebSocket 把 `BridgeDevice` 克隆到 socket loop，后续控制消息不再检查 token、设备撤销、过期或 runtime generation：`src-tauri/src/bridge/server.rs:240-343`。
3. `bridge_stop` 只停止 listener；`bridge_revoke_device` 只删除 token 数据，均不会向已升级 socket 发 cancellation / close：`src-tauri/src/bridge/mod.rs:433-483`、`pairing.rs:235-258`。

审查基线的 `ensure_full_permission` 只检查“客户端配对时自行申请到的权限”，不能反证第一项。基线实现的撤销能阻止新认证，但不能终止旧连接；停止后不能接受新 TCP 连接，但已升级连接仍可继续控制终端。

### RB-05：PTY LRU 与 ACK 所有权不一致，可永久停流

**严重度：P0 / P1；置信度：高，已通过反方复核。**

**整改状态：当前工作区已改为显式 renderer / background consumer、process-global `seq` 累计幂等 ACK、renderer TTL 与原子 snapshot barrier，并通过 Rust ledger、常驻 consumer、Shell 与 E2E 回归；以下内容仅保留为审查基线证据。**

- Rust 对每个输出块累加 `unacked_bytes`，达到 200,000 B 后停止读取，直到降到 20,000 B：`src-tauri/src/pty/events.rs:275-302,547-562`、`src-tauri/src/pty/session.rs:64-66`。
- 唯一 ACK 来自挂载的 `Shell`：`src/components/terminal/Shell.jsx:432-503`。
- UI 最多保留 6 个 mounted terminal view；被 LRU 驱逐的 `Shell` 卸载，但 PTY 保活：`mountedViewsLru.ts:11-23`、`TerminalManager.tsx:252-280`、`Shell.jsx:899-907`。
- 常驻 `TerminalEventBridge` 继续消费输出但不 ACK：`TerminalEventBridge.tsx:350-366`。
- 重新挂载的 snapshot 不清除历史欠账；已经错过的事件也无法补 ACK。

触发条件不是“超过 6 个终端立即冻结”，而是被淘汰 PTY 在无匹配 `Shell` 时继续输出约 200 KB。反向风险是 main 与 float 同时挂载同一 PTY 时可能重复 ACK，同一个 credit 被提前释放。

### RB-06：发布流水线、签名和双平台证据不成立

**严重度：P0（公开发布）；置信度：高。**

- 仓库仍没有 `.github/workflows/`；整改工作树已修正 `.gitignore`，使后续 workflow 与 `.github/**` 可被正常跟踪。
- `npm run check` 不包含 desktop build、完整 Cargo tests、两套 E2E、Tauri packaging、license / dependency audit。
- `.release-it.json:8-16` 只做 npm publish、GitHub release 元数据和 `npm run build`；不构建、签名、公证或上传桌面安装包。
- 版本分别硬编码在 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`，没有同步脚本或一致性测试。
- 当前整改工作树构建出的 `.app` 仅为 `adhoc, linker-signed`，`codesign --verify --deep --strict` 失败；`stapler validate` 显示没有 ticket。
- Apple 的正式分发建议要求 Developer ID、有效签名、Hardened Runtime 与 notarization，见 [Apple notarization 文档](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)。
- Windows 没有当前 HEAD 的 NSIS 真机结果或 Authenticode 签名流水线；Microsoft 明确说明 unsigned public distribution 会受到强 SmartScreen 阻拦，见 [Microsoft code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)。

## 5. 代码与隐含缺陷

### 5.1 高严重度确定缺陷

| ID | 发现 | 影响与证据 |
|---|---|---|
| H-01 | PTY 关闭非原子，可能留下进程且无法重试 | 前端 fire-and-forget `pty.kill` 后立即删卡；后端先移出 registry，再忽略 `taskkill` / `child.kill` 结果。`cardsSlice.ts:178-245`、`pty/mod.rs:240-279` |
| H-02 | Provider session 可绑定到同 basename 的错误项目 | `path_matches` 在精确/父子路径失败后只比较 `file_name()`；错误绑定会在 resume、统计或导出时显现。`provider_sessions.rs:142-155,296-338` |
| H-03 | macOS 终端复制/粘贴破坏 Ctrl 语义 | `Ctrl` 与 `Meta` 被合并处理；有选区时 `Ctrl+C` 不再发送 SIGINT，`Ctrl+V` 被强制读剪贴板。`Shell.jsx:775-804` |
| H-04 | macOS `Cmd+W` 直接终止会话 | `KeyboardBridge.tsx:122-128` 调用 `removeCard`，随后 kill PTY；与标准“关闭窗口”语义冲突，可能中断长任务 |
| H-05 | macOS Codex Chat 可能找不到 CLI | `codex_app.rs:683-689` 直接启动裸 `codex`，没有复用 PTY 的 Finder / LaunchServices PATH 补全 |
| H-06 | Windows 后台命令可能闪控制台 | Git、shell 探测、bridge、Codex fallback 多处未统一设置 `CREATE_NO_WINDOW`；当前只有 `taskkill` 路径设置 |
| H-07 | 核心终端实现无静态类型保护 | 整改后 `Shell.jsx` 约 1,367 行，`allowJs=true` 但 `checkJs` 关闭；同时承担 PTY、ACK、snapshot、WebGL、resize、重连与剪贴板 |
| H-08 | Codex Chat 核心协议与审批链缺直接测试 | `CodexChatView.tsx` 1,370 行；现有 TerminalView 测试 mock 掉它，desktop E2E 只测 Chat / Terminal 切换 |
| H-09 | Headless xterm 有确定泄漏路径 | exit 时先查 card；卡片已删则直接返回，terminal map 无容量上限且 `discardCard` 无生产调用。`TerminalEventBridge.tsx:398-406`、`headlessPreview.ts:28` |
| H-10 | 每个 PTY 约 3 个 OS thread，且无会话资源上限 | idle watcher、stream worker、reader thread；200 个会话可接近 600 个线程，LRU 只限制 WebGL view |
| H-11 | 无障碍基础不达标 | xterm capability 明确 `nativeIme/nativeSelection/nativeAccessibility=false`；Selector 卡片是无 role / tabIndex / key handler 的 clickable `div` |

### 5.2 中严重度确定缺陷

| ID | 发现 | 影响与证据 |
|---|---|---|
| M-01 | 状态机可能制造假等待 / 假回复完成 | `permission/approve/allow` 等宽泛匹配；输入活动也改写输出时间，可能触发错误的 Running→Idle 通知。`pty/events.rs:22-34,570-635` |
| M-02 | 错误/等待检测不跨 chunk，前 2 秒强错误也被抑制 | regex 只检查当前 coalesced data，无 rolling tail；启动期真实 `command not found` / panic 可能漏报 |
| M-03 | Supervisor 的 60 秒静默判断未跟踪输出 | `last_output_ts` 只在 watcher 创建时设置；重新 enable 又重置 watcher / cooldown。`supervisor.rs:248-467` |
| M-04 | Codex Chat 会话与卡片路由可串线 | `_provider_session_id` 未使用，resume 失败会 fallback 到 cwd 最新 thread，`thread_id -> card_id` 后注册覆盖前者 |
| M-05 | Codex Chat 异步 listener 可泄漏 | 卸载发生在 `listen()` Promise resolve 前时，cleanup 拿不到 unlisten；resolve 后也未立即注销。`CodexChatView.tsx:174-210` |
| M-06 | PTY resize 失败后相同尺寸不再重试 | `last_size` 在 master resize 成功前已更新；下一次相同尺寸直接返回。`pty/mod.rs:203-235` |
| M-07 | Bridge 并发 start 可泄漏 listener | **整改工作树已修复。** start / stop / restore 由 async lifecycle gate 串行化；stop 保留可重试 handle 并等待连接 drain / task 退出。基线证据：`bridge/mod.rs:385-454` |
| M-08 | Workspace 目录树可经 symlink 枚举 root 外目录 | `read_directory` 没有 authoritative root / canonical containment。`files.rs:205-242` |
| M-09 | 文件保存非原子且存在 TOCTOU | `std::fs::write` 可能截断；canonicalize 与写入之间可被替换 symlink。`files.rs:100-140,170-203` |
| M-10 | DB 初始化错误直接 panic | Lazy pool 的 mkdir、open、WAL、pool build 全用 `expect`，外层 `Result` 捕获不到。`db.rs:7-24` |
| M-11 | Attach snapshot 的内容和 seq 非原子 | **整改工作树已修复。** 输出 commit 与 attach snapshot 共用同一互斥边界，snapshot 内容、seq 和 replay barrier 原子一致。基线证据：`pty/session.rs:233-245` |
| M-12 | Mobile spawn / close 过早报告成功 | UI 成功早于真实 PTY 创建或 kill 完成；失败时客户端已收到 ok |
| M-13 | 全局热键重绑失败会丢失旧热键 | 先 unregister 旧键再 register 新键；冲突失败没有回滚。`overlay/hotkey.rs:42-61` |
| M-14 | 多屏定位错误 | Selector 固定 `primary_monitor()`；float bounds 不与当前 monitor work area 求交，拔屏后可能离屏 |
| M-15 | always-on-top UI 与原生状态分裂 | 后端每次 show 强制置顶，React toggle 只是局部 state；重开后 UI 与行为可相反 |
| M-16 | macOS 设置展示实际 no-op 模式 | floating / maximized / fullscreen 均展示，但后端在 macOS 明确 no-op |

### 5.3 安全设计风险

以下不等同于已确认远程利用，但应作为纵深防御缺口：

- Mobile Bridge 默认绑定 `0.0.0.0`，使用 `http://` / `ws://`；整改后 pairing secret 为 32 字符高熵、5 分钟且单次消费，但仍无 rate limit、失败次数和连接数上限，CORS 为 Any。
- WebSocket query-token 兼容路径仍被允许，token 可能进入 URL、代理日志和浏览器历史：`server.rs:617-628`。
- mobile bearer token 存在 `localStorage`；一旦 mobile origin 出现 XSS，token 可被读取。
- 所有内部 Tauri webview 共用较宽 capability；workspace root、PTY cwd 等由 renderer 自报。当前 sandbox / CSP 降低可利用性，但后端仍缺 authoritative workspace registry 和按 window label 的危险命令限制。
- 终端预览和通知正文可能进入 WebView `localStorage` 与锁屏系统通知，缺少 secret redaction / privacy mode。
- macOS overlay 使用较高 window level 并允许 without login 可见，需要真机确认锁屏、屏保和快速用户切换期间不会泄露终端内容。

现有正向防护包括：token 使用高熵随机值且数据库只存 SHA-256 hash；pairing secret 高熵、单次消费且服务端绑定权限上限；active authorization lease 持续约束 read / full 操作；read-only 写命令有服务端检查；输入审计只记录长度等元数据；Git 参数使用数组和 `--`；文件内容读取会 canonicalize 并限制类型、编码和 1 MiB 大小；SQLite 使用参数化 SQL。

## 6. 架构与目录结构

### 6.1 优点

- React / Zustand / Tauri / Rust PTY 分层清楚，`pty`、`bridge`、`overlay`、`stats` 已形成后端域目录。
- Zustand 主 store 按 cards、autoRestart、notifications、navigation、project slices 拆分。
- `src/lib/tauri-bridge.ts` 作为统一 IPC façade，被约 40 个模块复用，避免 command name 散落。
- main / settings / selector / float 使用独立 Vite entry；Workspace editor 已 lazy load。
- Rust 的 Git 阻塞调用集中使用 `spawn_blocking`；PTY 有 coalescing、seq guard、有限 buffer 与 snapshot restore。
- 前端整改后有 84 个 co-located test 文件，对约 154 个生产文件的测试密度较好；37 个 Rust 源文件中约 25 个含 `#[cfg(test)]`。

### 6.2 结构问题

| 文件 | 行数 | 问题 |
|---|---:|---|
| `src-tauri/src/bridge/mod.rs` | 1,974 | runtime、commands、persistence、broadcast、preview、network 探测混合 |
| `src/components/terminal/TerminalManager.tsx` | 1,454 | 15 个 effect，混合主界面、provider、mobile bridge、workspace orchestration |
| `src/components/codex/CodexChatView.tsx` | 1,370 | 连接、协议、消息、审批、secret input、UI 混合 |
| `mobile-app/src/App.tsx` | 1,270 | 根状态与全部 screen / form / row 内嵌 |
| `src/components/files/WorkspaceCodeEditor.tsx` | 1,248 | preview、storage、普通 editor、merge editor 混合 |
| `src/components/terminal/Shell.jsx` | 1,367 | 关键并发状态机无 TS / JSDoc 类型保护 |

其他问题：

- Desktop / mobile 协议手写且已漂移：mobile terminal type selector 漏掉 `opencode`。
- `mobile-app` 直接别名依赖桌面 `src/`，但没有清晰的 workspace package 边界。
- README 架构路径已在整改工作树修正为 `pty/`、`bridge/`、`overlay/` 等实际目录；更完整的模块边界说明仍可继续补充。
- README / CONTRIBUTING 引用的首次运行、构建发布、Windows EXE 与 overlay 手测文档已在整改工作树补齐。
- `.gitignore` 已在整改工作树显式放行 `.github/**` 与本轮必要文档；CI workflow 本身仍待建立。
- 已删除 desktop pet 后仍保留旧命名、不可达翻译和根目录 `mobile-prototypes`，增加搜索噪声。
- 多个 path display helper 重复，Windows drive root / UNC / trailing separator 行为已有分歧风险。
- `src-tauri/target` 本地缓存约 31 GiB，不进入 Git 或发行包，但应纳入开发环境清理说明。

## 7. 性能与资源

### 7.1 整改工作树构建数据

| 项目 | 数据 |
|---|---:|
| Desktop `dist` | 2,739,734 B（2.61 MiB） |
| Mobile `dist` | 585,027 B（0.56 MiB） |
| 当前 release binary | 15,364,080 B（14.65 MiB） |
| 当前 `.app` | 约 15 MiB |
| 主窗口初始 preload | raw 约 1.24 MB；gzip 约 356.8 KB；Brotli 约 306.4 KB |
| 最大 chunk `WorkspaceCodeEditor` | 666.0 KB；gzip 约 216.9 KB；已动态加载 |
| `main` chunk | 297.38 KB；gzip 约 86.75 KB |
| `vendor-xterm` | 293.5 KB；gzip 约 72.9 KB |

仓库中的 6.53 MiB DMG 早于本轮整改构建，本轮只重建 `.app`，因此 DMG 数字不应作为当前工作树结论。

### 7.2 主要性能问题

1. `flush_preview` 在检查 bridge subscriber 前先序列化最多 3,000 行 snapshot；bridge 关闭时仍可能以 10 Hz / PTY 付出成本：`pty/events.rs:173-175`、`pty/session.rs:309-324`。
2. 同一输出最多被 Rust emulator、headless xterm、可见 Shell xterm、float xterm 解析 3～4 次。
3. 每 PTY 多线程且无活跃会话上限，idle watcher 还每 250 ms 唤醒。
4. Zustand 的“throttled storage”只节流 `localStorage.setItem`，不能阻止每次 state change 前的 `partialize + JSON.stringify`；高频 output 与 preview 还分两次 action。
5. `TerminalManager` 订阅整个 cards 数组，输出更新会扇出到 mobile meta、command palette、project grouping、workspace 和 card sort。
6. bridge cards sync 使用全量 JSON 和 snapshot enrichment；即使无订阅者也可能付出成本。
7. mobile subscribe filter 没有真正实现；feed 按消息数而不是字节限制，理论上单卡可保留约 128 MB 数据。
8. Codex 长会话每个 delta 遍历 items、拼接增长字符串并重渲染完整列表，没有 batching / virtualization。
9. provider session 扫描会对所有候选 JSONL `read_to_string`，最后才截到 200 条；它在 `spawn_blocking` 中，不同步阻塞 React 首屏，但本机样本 382 个文件约产生 365 MB 冷启动 I/O。
10. workspace / change / branch / worktree caches 缺统一字节预算、TTL 或 LRU。
11. mobile 静态资源无预压缩且统一 `Cache-Control: no-store`，xterm 也进入首屏资源。

### 7.3 性能基准失真

`npm run bench:startup` 本轮输出中位数 `0.31 ms`，但 `tools/bench-startup.mjs:53-79` 只等待 Node child 的 `spawn` 事件，随后立即 kill。它没有等待 Rust setup、DB、Tauri window、WebView、React、window visible 或 first interactive，因此该数据不是启动时间，应从所有性能结论中剔除。

当前缺少可执行的 startup / size budget、artifact freshness 检查、p50 / p95、RSS、idle CPU、线程数、PTY 10 / 100 MB 吞吐、WebSocket bytes/sec、慢客户端、React Profiler 和 heap snapshot 门禁。

## 8. macOS / Windows 适配度

| 平台 | 功能适配 | 原生体验 | 发布成熟度 | 综合 |
|---|---:|---:|---:|---:|
| macOS | 7.5 / 10 | 6.5 / 10 | 5.5 / 10 | **68 / 100** |
| Windows | 6.5 / 10 | 5.2 / 10 | 4.0 / 10 | **57 / 100** |

### 8.1 macOS

优点：

- 已使用 NSPanel、Spaces、FullScreenAuxiliary、Accessory activation policy 与 vibrancy。
- PTY 有 Finder / LaunchServices PATH 补全；系统主题监听和多处 reduced-motion 已实现。
- settings 为独立窗口，confirm 优先使用原生 dialog。

主要缺口：

- `Ctrl+C/V`、`Cmd+W`、`macOptionIsMeta=true` 破坏终端与非美式键盘肌肉记忆。
- Codex Chat 未复用 Finder PATH；打包版可能出现“terminal 模式可用、Chat 模式找不到 codex”。
- 默认 shell 固定优先 `/bin/zsh`，忽略用户登录 shell；`shell -l -c` PATH 探测无 timeout。
- Selector 固定主屏，float bounds 不做屏幕夹取。
- float 的 maximized / fullscreen 在 macOS 实际 no-op，却仍展示设置。
- `macOSPrivateApi=true` 与当前 NSPanel 路径使 Mac App Store 兼容性存疑，应明确采用 Developer ID 站外发行策略。
- 当前 `.app` 无有效 Developer ID 签名、公证和 stapled ticket。

### 8.2 Windows

优点：

- 已有 ConPTY 初始化锁、pwsh → Windows PowerShell → cmd 探测、cwd 分隔符处理。
- kill 路径尝试 `taskkill /F /T`；隐藏 WebView2 有 low-memory target 与 60 秒 renderer 回收。
- Windows 默认关闭透明材质、overlay prewarm 是合理的性能取舍；NSIS 配置明确。

主要缺口：

- 没有物理 Windows 真机结果；当前 checklist 的 Windows 版本、字节数仍为占位符。
- 没有当前 HEAD 的 NSIS、AuthentiCode、SmartScreen、标准用户安装/升级/卸载证据。
- 后台命令可能闪控制台。
- float 使用 borderless WebView chrome，缺少标准 Snap Layout、system menu、maximize / minimize 语义。
- Windows native terminal host 仍是 draft，`nativeHostAvailable` 默认 false；不能把它计为已实现能力。
- selector 首次不预热，代码注释预计 300–800 ms，且没有 first-frame ready gate。
- 125% / 150% / 200% DPI、混合 DPI、多屏、CJK IME、Narrator、High Contrast 均未验证。

### 8.3 双平台共同缺口

- xterm native IME / selection / accessibility 能力未满足；Selector 缺语义化 listbox / option 与键盘焦点。
- 通知判定仍在 WebView，后台 renderer throttling / 回收时可能延迟或丢失。
- OS 通知权限在组件 mount 时无条件申请，没有用户意图解释流程。
- float 的网页自绘标题栏、context menu、部分 motion 与平台惯例仍有差距。
- 没有 updater、crash reporter、deep link、file association、可复现签名构建和双平台 release matrix。

## 9. 软件版权、依赖许可证与素材

### 9.1 当前项目许可证状态

- 根 `LICENSE` 与 npm / Cargo manifest 均声明 MIT，文本本身正确；[OSI MIT 文本](https://opensource.org/license/mit) 要求复制件或软件的重要部分携带版权与许可声明。
- 但根 MIT 不能覆盖或替代 OpenWork、Trellis、GitNexus、cc-switch 和依赖各自的权利与通知义务。
- 当前只有一个根 LICENSE，没有 `NOTICE`、`THIRD_PARTY_NOTICES`、`COPYING`、`AUTHORS` 或 `LICENSES/`。

### 9.2 第三方来源缺口

- `src-tauri/src/stats/parse.rs`、`sync.rs` 与提交说明表明明显参考 / 改编 cc-switch 的 MIT 代码，但未保留 Jason Young 版权与完整 MIT NOTICE。
- `themePacks.ts` 内置 13 个第三方主题，README 只列出其中 5 个；Settings 只显示 source URL，不渲染已有 `licenseUrl`。
- shadcn/ui 来源可由 `components.json` 和提交历史证明，但组件文件与发行物没有上游 MIT notice。
- Inter 当前从 Google Fonts 在线加载，没有 self-host，因此当前包未直接再分发字体；如后续内置，需附 OFL-1.1。
- `tauri-nspanel` 通过可移动 branch 引入；Cargo metadata 的 license 为空。锁定 commit 内有 MIT / Apache-2.0 文本，但应改用 tag / rev 并建立人工 license override。

### 9.3 依赖扫描概览

**npm：**

- `package-lock.json` 有 660 个条目，均有 license metadata。
- 101 个 non-dev 条目全部为 MIT、Apache-2.0、ISC、BSD 或 0BSD，未发现生产依赖中的 copyleft、unknown 或 noncommercial。
- 宽松许可证不等于免 NOTICE；React、xterm、CodeMirror、Lucide、highlight.js、CVA 等仍需在发行物中保留相应声明。

**Cargo：**

- `cargo metadata --locked --all-features` 共 723 个 package，未发现强制 GPL / AGPL runtime dependency。
- 存在 MPL-2.0 组件：`cssparser`、`cssparser-macros`、`dtoa-short`、`selectors`、`option-ext`。MPL 是文件级弱 copyleft，发行时应提供许可证和组件源码获取说明。
- `terminfo@0.9.0` 为 WTFPL；需由项目许可证策略明确允许或替换。
- `tattoy-wezterm-term` 为 MIT，Wez Furlong 版权属于显著 NOTICE。
- `r-efi` 可在 MIT / Apache / LGPL alternatives 中明确选择 MIT / Apache，不构成强制 LGPL 风险。

### 9.4 发行物缺口

- 当前 `.app` 仅包含 executable、icon 与 `Info.plist`，无自身 MIT、第三方 NOTICE 或 Legal 入口。
- `tauri.conf.json` 没有 license file / copyright 配置。
- `dist/**` 未保留可识别的 legal comments；Vite 没有生成 license bundle 的配置。
- `npm pack --dry-run` 会包含根 LICENSE 与 README，但没有第三方 NOTICE。
- release 流程没有 license allowlist、SBOM 或 NOTICE generation gate。

### 9.5 贡献与权属记录

- 613 个 commit 中未检出 `Signed-off-by`；CONTRIBUTING 没有 CLA、DCO 或 inbound=outbound 条款。
- 同一姓名使用多组邮箱，其中包含公司域邮箱提交；应确认是否涉及职务作品或雇主 IP。
- AI co-author trailer 不能作为权属证明；实际提交人仍需确认拥有提交和再许可权，并保存相关服务条款 / 账户记录。
- Claude、Codex、Gemini、Warp、GitHub Primer 等当前多为兼容性描述，商标风险相对低；商业化前仍应做 `ThreadTerm` 正式商标检索并增加统一非背书声明。

## 10. 测试与质量门禁

### 10.1 已有优势

- 整改后 654 个 Vitest 与 234 个 Rust tests 全部通过；Bridge / PTY 定向分别为 59 / 51 个 Rust 测试。
- Mobile Bridge 有真实 Axum / TCP / WebSocket 集成测试，覆盖 bearer、query auth、first-frame auth 与 protocol version。
- desktop browser E2E 覆盖非零退出 / restart、snapshot reattach、scroll retention、Chat → Terminal output restore。
- mobile browser E2E 覆盖 20 个主要旅程。

### 10.2 为什么仍是 BLOCK

- 无 CI；所有结果依赖人工顺序执行。
- `npm run check` 漏 desktop build、Cargo tests、E2E、packaging、dependency / license audit。
- desktop E2E 的 fake `pty_kill` 永远成功，因此无法发现 kill failure、残留进程或 UI 误报。
- mobile browser E2E mock WebSocket / snapshot，不能证明浏览器到真实桌面 Bridge 的完整生命周期；Rust 侧已有真实 Axum / TCP / WebSocket 集成测试。
- Vitest 的 test discovery 只匹配 `ts/tsx`，但 `Shell.test.tsx` 已直接导入并覆盖 `Shell.jsx` 行为；`checkJs` 仍关闭，且无 coverage threshold。
- coverage 配置没有 threshold、script，且未安装 `@vitest/coverage-v8`；Rust 也无 coverage gate。
- query-token 风险仍被兼容测试固化为允许，而不是负面安全测试。
- DB 初始化 panic 与 remove/archive kill rejection 仍缺回归；PTY consumer flow-control、bridge stop/revoke active socket、snapshot attach failure 和 clean-clone 缺 bundle 已有回归或隔离验证。

## 11. 修复优先级建议

### P0：任何公开 / 商业发布前

1. 证明或清理 OpenWork → ThreadTerm 权利链；由专业律师确认再许可基础。
2. 为 Trellis / GitNexus 建立清晰的独立许可证边界；补全文本、版权与 notices，或排除 / 取得另行授权。
3. ~~让 OTP 在服务端绑定授权上限；stop / revoke / expiry 主动终止并持续重验已连接 socket。~~ **本批已完成。**
4. **PTY ACK ownership 核心整改本批已完成：**已有 Rust 多 consumer ledger 与 Chromium fake-Tauri 的 LRU >200 KB 回归；真实 Tauri 主窗 + 浮窗、真实 PTY 持续压力验证仍待补。
5. 让 PTY kill 成为可确认、可重试的异步 domain operation；Unix 使用 process group，Windows 使用可靠进程树 / Job Object 语义。
6. **开发启动链已在整改工作树修复并完成隔离副本验证；clean checkout CI 仍待建立。**
7. 建 macOS / Windows release matrix；完整 gate 后再构建、签名、公证、生成 checksum / SBOM / NOTICE 并上传 `.dmg` / NSIS。
8. 物理 Windows 机器完成 NSIS、WebView2、ConPTY、IME、DPI、多屏、通知、快捷键与 GPU 基线。

### P1：进入公开 beta 前

1. 去掉 provider basename 兜底或建立显式 worktree mapping。
2. 修复 macOS Ctrl / Cmd / Option / Cmd+W 语义和 Codex CLI PATH。
3. 为 Windows 后台 process 建统一 `CREATE_NO_WINDOW` helper。
4. 解决 headless xterm 生命周期、PTY 资源上限、bridge 无订阅热成本与高频 Zustand 持久化。
5. 将 `Shell.jsx` 迁移 TS 或启用 `checkJs`，拆出 typed PTY controller、renderer lifecycle、reconnect hooks。
6. 抽取 Codex protocol reducer / approval mapper，增加 fake app-server stdio integration 与审批 E2E。
7. 修复 DB 可恢复初始化、atomic save、symlink containment、snapshot consistency。
8. 补 VoiceOver / Narrator、IME、Selector 语义和纯键盘导航。
9. 生成 `THIRD_PARTY_NOTICES`、`LICENSES/` 与 CycloneDX / SPDX SBOM，建立 license allowlist gate。

### P2：稳定版持续治理

1. 将 startup benchmark 改为 backend-ready、window-visible、first-interactive markers，记录 cold / warm p50 / p95。
2. 为 bundle、preload、RSS、idle CPU、线程数、PTY throughput、WebSocket bytes、heap leak 建预算。
3. 分拆 god modules，明确 shared desktop / mobile package 边界并生成跨层 schema。
4. 修复多屏夹取、always-on-top 状态源、macOS no-op 设置、float 原生 chrome 和在线字体一致性。
5. 清理旧 pet / prototype；缺失文档链接与 `.github` / `docs` ignore policy 已在整改工作树修复。
6. 引入 updater、crash reporter、deep link / file association（如产品确有需求）。

## 12. 最终判定

ThreadTerm 已具备一个功能面丰富、分层基本成立、自动化测试数量可观的 Tauri 桌面应用基础。Rust PTY、移动 bridge、多窗口入口、Zustand slices、构建体积控制和 macOS NSPanel 适配均体现了实际工程投入。

但“测试通过”目前不能推出“可发布”：

- 权利链与源码许可证边界未闭环；
- Mobile Bridge 的基线授权 / 撤销缺陷已修复，但明文 LAN transport、宽 CORS 与 query-token 兼容风险仍需治理；
- PTY 的后台永久停流已修复，但进程 kill、线程上限和长期压力证据仍不足；
- clean clone 已修复；CI、签名、公证和真实 Windows 发布证据仍缺失；
- 关键终端输入、无障碍、进程生命周期与资源治理仍存在高风险缺口。

因此本次审查的正式结论是：

> **开发状态：可继续。内部测试：可继续；Mobile Bridge 仍建议只用于可信 LAN。公开 beta：暂缓。商业 / 稳定版发布：阻断。**

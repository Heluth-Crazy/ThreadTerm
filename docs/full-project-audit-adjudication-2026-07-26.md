# ThreadTerm 全面代码审查结论复核与处置建议

> 复核日期：2026-07-26
>
> 基准：`exp/windows-native-terminal-host` @ `6a36539`，当前工作区包含 188 个已暂存路径及未跟踪构建/代理目录
>
> 输入：用户提供的《ThreadTerm 全面代码审查报告》
>
> 文档性质：对审查结论做证据分级、修法校正和排期建议；不是“所有静态推断均已复现”的缺陷清单

本文是以下历史文档在当前大规模未提交工作区上的增量复核：

- `docs/project-structure-and-performance-review.md`：2026-07-04 的结构与性能基线。
- `docs/windows-performance-functional-impact-review-and-optimization-plan.md`：2026-07-12 的跨层契约、性能门禁与实施状态。

原报告的路径和行号对应审查当时的工作区快照。当前源码已继续移动和增长，例如
`TerminalManager.tsx`、`Shell.jsx` 均位于 `src/components/terminal/`，不能把原报告行号当作长期稳定链接。

---

## 一、裁定口径

| 标记 | 含义 | 能否直接排修 |
|---|---|---|
| A：源码确认 | 当前代码直接证明问题结构存在 | 可以进入设计/修复，但仍需保留既有契约 |
| B：高可信推断 | 触发链成立，但用户影响或频率尚未实测 | 先补定向复现或指标，再决定严重度 |
| C：待实测 | 依赖 Windows、WebView、网络、锁竞争或真实数据规模 | 不应以 P1 已确认缺陷名义直接修改 |
| D：需校正 | 问题方向部分成立，但原严重度、论证或建议修法不准确 | 采用校正后的结论，不照原建议实施 |

这里的“有营养”不是指结论写得尖锐，而是同时具备：

1. 明确的触发条件；
2. 可定位的数据流或调用链；
3. 可描述的功能/性能后果；
4. 不破坏既有跨层契约的修复边界；
5. 可验证的验收方式。

静态看到昂贵代码，不等于已经证明用户可感知的 P1 事故；反过来，缺少 TLS、seq
生命周期和 CI 这类设计事实，也不需要等线上事故才能成立。

---

## 二、总体判断

这份报告的发现质量整体较高，执行摘要中的十个方向都不是凭空捏造。但它有三个明显弱点：

1. **P1 使用过多。** 多个“静态推断”“待验证”条目与已复现正确性缺陷被放在同一严重度，削弱了排期区分度。
2. **诊断通常比修法可靠。** `stripAnsi` 先截原始尾部、审计写 fire-and-forget、后台队列直接丢最老项、按页面可见性停止移动同步，均可能破坏现有正确性或产品语义。
3. **报告快照内部有噪声。** 粘贴内容存在段落重复，Rust 测试数同时出现 246 与 279，未提交路径数也已从报告的 172 变成当前 190 个 status entry。测试是否通过应以对应提交/工作区的实际命令输出为准。

按处置价值划分：

- **应直接进入近期 backlog：** 移动桥同步饥饿与重复序列化、Windows 后台子进程、移动端
  seq epoch/心跳/撤销终态、terminalFeed 字节与生命周期、明文 LAN 风险、Sidebar memo
  正确性 bug、CI 缺失。
- **值得做，但先量化或修正设计：** TerminalView/Shell/Codex 行级 memo、headless
  preview 读屏合并、SQLite 审计写线程、PTY 输入阻塞、最小化背压、后台 consumer TTL。
- **结构性债务，不能冒充运行时 P1：** bridge/Shell/TerminalManager 文件体积、模块拆分、
  ANSI 工具去重、死参数和实验脚手架。
- **低信号或表述过度：** “iframe sandbox 等效失效”、`tauri-nspanel` 当前构建不可复现、
  单纯因为依赖落后一个 major 就升级、未经 Profiler 支持的“砍掉一半成本”等。

---

## 三、执行摘要十项逐条裁定

| # | 裁定 | 复核结论 | 建议处置 |
|---|---|---|---|
| 1 | A+B，高价值 | `TerminalManager.tsx:732-760` 在 effect 内先全量 `JSON.stringify`，再做纯 trailing 100ms debounce；持续输出会不断替换 cards/projection 引用，定时器确有被持续清除的条件。实际最长同步延迟尚未测量。 | 增加 `maxWait` 和同步延迟测试。不能简单按 `document.visibilityState` 停止：桌面隐藏、手机继续使用正是核心场景。若按 subscriber 门控，必须同时设计首个订阅者主动 resync 或低频 durable mirror。 |
| 2 | A，高价值 | `bridge/mod.rs:1060-1091` 的 wildcard host 显示地址会同步启动 PowerShell；`bridge_status` 和 `bridge_pair_qr` 是 async command，且后者在 wildcard 场景可能经 status URL 和 pair host 两次探测。无缓存、无 `CREATE_NO_WINDOW`。 | Windows 后台 flag、`spawn_blocking`、带 TTL 的 IP 缓存一起做；缓存需允许网卡变化后刷新。 |
| 3 | A，高价值 | `git.rs` 的 7 个生产 git 子进程均未设置 Windows 后台 flag；`pty/shell.rs:133-138` 的一次性 `where` 探测也未设置。项目已有 `pty/mod.rs:277`、`codex_app.rs:412` 的正确样板。 | 抽取统一 Windows background-command helper，覆盖 git、where、PowerShell，避免七处手工漂移。Release 真机补“无闪窗”验收。 |
| 4 | A+D，高价值 | `bridge/server.rs:806-825` 在 WS input handler 内同步执行 `insert_audit_log`；`db.rs:18` 的 busy timeout 为 5 秒。阻塞 tokio worker 的风险成立。 | **不采用无约束 fire-and-forget。** 审计有顺序和失败语义，应使用有界单写者/`spawn_blocking`，至少等待“可靠入队”；队列满时明确 fail-closed、backpressure 或降级策略。 |
| 5 | A+B，有价值 | `TerminalView` 与 `Shell` 当前没有 memo；`TerminalManager.tsx:1459-1485` 持久挂载最多 6 个 terminal view。未变化卡片保持对象引用，memo 很可能显著减少旁路重渲染；“约一半”没有 Profiler 证据。 | 先加 render-count/Profiler 基线，再用默认浅比较优先验证；慎用忽略回调/图标的自定义比较器，避免复制 Sidebar 的正确性 bug。 |
| 6 | A，最高价值之一 | bridge 明确使用 HTTP/WS（`bridge/mod.rs:378`、`server.rs:256`），没有 TLS。后端 fallback 虽是 loopback，但桌面设置页 `MobileAccessSettings.tsx:33,113` 默认预选 LAN，用户确认后即绑定 `0.0.0.0`；因此“默认 127.0.0.1”不足以覆盖真实产品路径。 | 立即把提示改成明确的“明文、终端内容和 full token 风险”；同时做 TLS/证书指纹钉扎或“loopback + 可信隧道”的产品方案。不能只依赖 OTP 和 token hash，它们不保护传输中的 bearer token。 |
| 7 | A，高价值但原修法不足 | `outputSequencer.ts` 对更大的 seq 直接推进 `lastAppliedSeq`，没有 gap 观测或恢复。后续累计 ACK 会释放缺口之前的 credit。 | 计数器只是第一步；发现 gap 后应停止盲目推进并触发 atomic snapshot resync，随后从 snapshot seq 继续。补 gap、重复、乱序、恢复失败测试。 |
| 8 | A，高价值，需拆成三项 | `terminalFeed.ts:36` 按 2000 条而非字节限制；只有 test reset，没有删除卡 bucket API；PTY seq 来自进程级 `GLOBAL_OUTPUT_SEQ`，桌面重启会回绕，而手机页可能仍保留旧 bucket/last seq。 | epoch/stream id 是 P1 正确性协议项；字节上限和删卡清理是 P2 内存项。snapshot 必须携带 epoch，epoch 改变时原子清 bucket 和 xterm 应用边界。 |
| 9 | A，高价值 | 当前没有 `.github/workflows`。大量门禁存在但不会自动阻止回归。 | 建最小 CI：前端 typecheck/lint/test/build，Rust fmt/clippy/test/`--locked`。Windows 专属门禁放 Windows runner，避免只在 Linux 上“绿”。 |
| 10 | A，但属于架构债务 | 当前行数与报告一致：bridge `2317/1614/1083/864`，pty session 1058，TerminalManager 1810，Shell 1475。2026-07-04 的 R2 拆分建议仍未执行。 | 先修跨层 P1/P2，再做纯移动拆分。LOC 是变更耦合的信号，不是独立性能缺陷；优先拆 preview 纯函数、commands、runtime、WS handler。 |

---

## 四、分领域结论：哪些真正有营养

### 4.1 终端输出与 React 热路径

| 原报告项 | 裁定 | 评价与修法校正 |
|---|---|---|
| 1.1 `stripAnsi` 扫描大 chunk | A+D | 无效扫描成立：joined chunk 全量正则后只保留 2000 字符。但“先截原始尾部再 strip”可能从 CSI/OSC 中间切开，造成控制序列泄漏或文本误删。应使用增量 ANSI parser、保留 parser state，或在可证明的安全边界裁剪。 |
| 1.2 headless 每 chunk 读屏 | A+B | `feedHeadless` 每个 write callback 调 `readPreview`，而 `outputBuffer` 同窗口只保留最后 preview，重复工作成立。可继续逐 chunk feed 保序，但把读屏合并到 flush 边缘；必须保留 xterm write-drain ACK 和 exit 最后一帧。 |
| 1.3 snapshot 重试队列无上限 | A+D | `pendingBackgroundOutput` 在 snapshot 一直失败时无限增长。直接丢最老项并不总安全：成功 snapshot 的 barrier 可能仍早于被丢 seq。队列溢出后应标记“必须重新 snapshot”，以新 barrier 覆盖丢弃区间。 |
| 1.4 最小化导致最慢 renderer | C | WebView2 timer/事件节流、5 秒 heartbeat 与 30 秒 renderer TTL 的组合值得真机测，但当前不能写成已确认卡死。测 `flow_wait`、最终 sentinel、renderer lease 和恢复时延。 |
| 1.5 background consumer 无 TTL | B/C | renderer 有 TTL，background watermark 没有。主 WebView 存活但 JS 永久停转时确有停摆结构；是否要 fail-open 涉及输出保留和恢复语义，先做故障注入。 |
| 1.6 mousedown 全 surface recovery | A+C | 每次 mouse down 会触发一次 fit/resize dedupe/full refresh，并保留 4 次 bounded focus retry。成本存在，但这些 timer 是 Windows 0-size/focus 恢复契约。应拆成“稳定 surface 仅 focus、失效 surface 才 recovery”，不能直接删除。 |
| 1.7 replayRecentOutput 死参数 | A，低收益 | 参数只在 `Shell` 解构并由两个调用点传入，零读取。可删，但只属于代码卫生。exit 最后一帧和 storage event 需另做目标测试，不能与死参数合并定性。 |
| 1.8 TerminalView/Shell memo | A+B | 是前端最值得验证的 quick win；准确收益必须由 commit 次数和耗时证明。默认浅比较优先，自定义 comparator 必须有 props 变更测试。 |
| 1.9 NotificationCenter 关闭仍计算 | A，次要 | 关闭时仍订阅 cards，并为每次 cards 变化重建来源标签和 i18n 映射。移入 open 分支/拆分 mounted shell 是安全小优化，但不是 P1。 |
| 1.10 Codex delta 整列表重渲染 | A，高价值 | `activeRef` 只写不读，`CodexItemRow` 未 memo；`appendDelta` 会保留未变化 item 引用，所以 memo row 有直接收益。隐藏时仍应摄取协议事件，降载应只减少渲染/派生工作，不能丢 delta、approval、disconnect。 |
| 1.11 Sidebar spinner 不更新 | A，已确认 bug | `auxActionsEqual` 只比较 key/title，loading 只改变 icon，因此刷新开始时 memo 会吞掉 spinner 更新。比较器还忽略主 icon 与回调，修复需覆盖这些 props 的语义。 |
| 1.12 All terminals 实时换位 | A，产品决策 | live 卡仍按 `lastActivity` 排序，两卡交替输出会换 DOM 位置。是否固定 live 卡顺序是交互选择，不是纯性能修复；应先确认“最近活动优先”是否仍是产品需求。 |
| 1.13 Workspace 重复 git status | A，有价值 | `loadChanges` 依赖 `selectedChangePath/updatePanelState`，选中 change 后 callback 身份变化，会让 changes tab effect 再加载。可用 ref/拆分 reconciliation 修正。FileTree 虚拟化是规模上限问题，另排。 |
| 1.14 comparator/partialize/RAF | D，低优先 | comparator 忽略回调只有在闭包稳定契约明确时才安全；不能以“当前没 bug”永久豁免。其余属于微优化，排在正确性和协议问题之后。 |

### 4.2 Rust 后端与并发

以下结论有较强工程价值：

- **Claude metadata 整文件读取成立。** `provider_sessions.rs:401-404` 读完整 jsonl 后只看前 40
  行；扫描虽已在 `spawn_blocking`，但没有文件数上限，结果 limit 是扫描/解析后才截断。
- **Gemini async 中同步遍历成立。** `agent_sessions/gemini.rs:12-50,114-184` 在 async 函数里
  同步 `read_dir/read_to_string`，且每个 chat JSON 整读。应整体移入 `spawn_blocking`，再考虑按
  metadata/分页减少扫描。
- **`pty_input` 阻塞写成立。** `pty/mod.rs:202-220` 在 async command 内持同步 Mutex 做
  `write_all + flush`。出现管道阻塞时会占 tokio worker；需要故障注入后决定专用 writer
  task、`spawn_blocking` 或有界输入队列。
- **subscriber 存在时全卡 enrich 成立。** `bridge/mod.rs:205-214` 会对每次 sync 构造
  enriched snapshot；每卡 live snapshot 会克隆带迟滞的 256–512 KiB raw buffer，并运行
  preview 正则。前端同步频率已具备到 10Hz 的条件，应与执行摘要 #1 合并治理。
- **Codex cmd fallback 孤儿进程值得实测。** `kill_on_drop` 只保证直接 child；`cmd.exe /c`
  fallback 是否遗留 `codex.exe` 需要 Windows PID 测试，不能仅靠静态代码判 P2 已发生。
- **clientUserMessageId 毫秒后缀确有碰撞窗口。** 改成 atomic counter + process nonce 或 UUID
  很便宜，但当前影响概率低，列 P3 即可。
- **每 input 两条 info 日志过密。** 原始 frame metadata 和解析后 metadata 可合并，至少一条
  降 debug；这属于可观测性噪声，不是性能主因。

低优先或需要谨慎的项：

- `unsafe impl Sync for PtySession` 很可能可由字段自动推导，但应以“删掉后全平台编译”为验证，
  不能靠目测直接删。
- git 不可用被映射为空列表是可诊断性问题，不是性能缺陷；产品应区分“仓库无变更”和“git
  不可用”。
- bridge notifications 缺后端截断是 defense-in-depth；正常前端 store 是否已经有上限也应一并
  核对，不能只在 Rust 末端盲截。

### 4.3 移动端连接与协议

这一组是报告中最有营养的部分，且与移动端作为产品能力直接相关：

1. protocol 有 ping/pong，但客户端从不发送 ping，也没有 pong deadline；Wi-Fi 静默断链可能长时间
   保持“open”。
2. `visibilitychange/online/pageshow` 会无条件销毁健康 socket、重连并拉 snapshot。移动键盘、后台
   返回等常见事件会制造连接 churn。应先判断现有 socket 健康度，不健康才重连。
3. 服务端已发送 `auth_revoked/auth_expired` 后关闭，但客户端只记录普通 error 并继续指数退避；
   应设 terminal auth state、停止重连、清除/隔离失效 token，并引导重新配对。
4. seq 缺 epoch 是桌面进程重启后的确定性协议缺口。建议使用 `streamId/bootId + seq`，而不是仅在
   手机端猜测 seq 回绕。
5. terminalFeed 应同时有：
   - 每卡字节预算，而非仅 2000 条；
   - `card_removed/close_result/snapshot replacement` 对应的 bucket 清理；
   - epoch 切换原子 reset；
   - 总卡数/总字节诊断。

### 4.4 测试与 CI

报告关于测试缺口的判断基本准确：

- 当前仓库没有 CI workflow，这是高价值治理缺口。
- `useBridgeConnection.ts` 没有直接单测；移动 E2E 使用 `MockWebSocket`。现有 E2E 虽覆盖 reconnect
  snapshot 和 backpressure frame 的 UI 语义，但没有跑真实的断线、退避、TCP/WS 重建和 resync。
- E2E fixture 中存在多张卡，不等于覆盖多卡并行输出、ACK/LRU/写入交错。
- headless preview 的 TUI 正确性仍主要依赖间接测试；新增读屏合并前必须补清屏、OSC、wrap、
  alternate-screen、exit-final-frame 用例。

需要校正的是：报告中的测试总数不一致，且“本地全部通过”只能证明已有用例，没有证明性能、
TLS、真实网络和 Windows GUI 子进程行为。CI 建成后，文档应记录命令和 runner，不再手写容易过时的
固定测试数。

---

## 五、安全结论的取舍与补充

### 5.1 应保留并提高优先级

**LAN 明文桥接是产品级风险，不只是代码卫生。** 终端输出、bearer token 与 full-control 输入均走
明文 HTTP/WS。UI 已有绑定 `0.0.0.0` 的确认，但文案只说“流量暴露给网络”，没有明确说明：

- 内容未加密；
- token 可被重放；
- full token 等价于向宿主 PTY 注入命令；
- 应仅在可信网络/可信加密隧道中使用。

短期提示不能替代中期传输加密，但应先阻止用户误判安全边界。

**CSP `connect-src https://*` 过宽的事实成立。** 当前生产源码未发现必须由主 renderer
`fetch` 任意 HTTPS 域的功能，AI 主链路走本地子进程；因此值得做 endpoint inventory 后收紧。
不过它依赖 renderer XSS 前提，严重度应低于明文 LAN bridge。

### 5.2 原报告对文件边界的正反结论都不完整

报告指出 `read_directory(path)` 可枚举任意绝对目录，这是事实；但它同时把
`workspace_read_file/workspace_write_file` 描述为“严格工作区限制”，这只能证明**文件不能逃出调用者
传入的 root**，不能证明该 root 是 ThreadTerm 已登记的项目/worktree：

- `canonical_workspace_root(root_path)` 接受任意存在的绝对目录；
- `root_path` 来自 renderer 调用参数；
- 后端未把它与已登记 project/worktree allowlist 对照；
- read 成功还会把该 root 递归加入 asset protocol scope。

因此，如果威胁模型包含 renderer XSS，目录、读文件、写文件和 asset scope 应作为同一个 trust
boundary 复核，而不是只修 `read_directory`。由于 renderer 同时具有 PTY 等高权限 command，这属于
P2 defense-in-depth/权限模型问题，不应夸大为无需前置条件的远程任意文件漏洞。

建议的正确边界是：

1. 后端维护已登记 project/worktree root；
2. `read_directory(rootPath, path)`、read/write、preview scope 都验证 root 属于 allowlist；
3. dialog 新增项目时由后端原子登记，而不是信任每次 renderer 自报 root；
4. 保留 symlink/canonicalize 和 size/binary/conflict 现有测试。

### 5.3 低信号或表述过度

- “`allow-scripts allow-same-origin` 等效解除 iframe sandbox”过于笼统。生产 Tauri 宿主与用户
  dev server 通常跨 origin，frame 不能因此访问/移除父页面 sandbox；只有与父页面同 origin 时才是
  经典逃逸条件。这里应描述为“dev server 脚本按其 origin 运行，是有意的高权限预览”，不是直接判定
  sandbox 已失效。
- localStorage token 是 XSS 后果放大器，但不是独立漏洞；优先级低于消除明文传输和收紧 renderer
  攻击面。
- query-token compatibility path 仍存在，服务端已有 deprecated 日志。可以删除，但需先确认旧移动端
  兼容窗口。

---

## 六、架构与依赖：有信号，但不要误排

### 6.1 有价值

- 2026-07-04 的 R2 没有过时：bridge 模块继续增长，说明 runtime、commands、preview、pairing、WS
  handler 的变更耦合正在上升。
- Shell 仍是唯一大型 JSX 文件；TS 化和拆连接/renderer/recovery 状态机仍有维护收益。
- ANSI regex 在 `stores/terminal/helpers.ts` 与 `cardPreview.ts` 重复，未来修 ANSI 边界时容易只修一份。
- `terminalRenderer.ts` 生产零引用，确认实验结束后可删。
- madge 无循环、生产 `any` 极少、terminalStore slice 化已落地，这些正面结论能说明依赖方向总体健康。

### 6.2 原严重度偏高或缺少行动依据

- `tauri-nspanel` 的 manifest 使用 branch 确实不理想，但 `src-tauri/Cargo.lock` 已锁到具体 commit
  `a3122e8...`；在 `cargo --locked` 下当前构建可复现。pin `rev` 是 lockfile 更新和供应链卫生改进，
  更接近 P3，不是现成 P2 构建故障。
- “React/Tailwind/Vite/axum 落后 major”本身没有营养。只有安全公告、支持期、已需要的新能力或明确
  迁移收益才能形成任务；否则 major upgrade 只会扩大回归面。
- 文件行数不能单独证明性能问题。拆分应以变更冲突、职责边界、测试隔离和 review 成本为依据。
- `@shared` 指向整个 `src/` 是边界偏宽，但目前应先用 lint/import rule 约束，再决定是否搬目录；机械
  移动会制造大量无功能 diff。

---

## 七、不能照原报告直接执行的四个修法

1. **不能把原始 ANSI chunk 直接截尾后再 strip。** 可能从 OSC/CSI 中间切断。
2. **不能把安全审计写改成无约束 fire-and-forget。** 会丢审计、乱序，进程退出时尤其明显。
3. **不能在 snapshot 失败队列超限后无条件丢最老 output。** 必须先建立更新的 atomic snapshot
   barrier 或触发明确 resync。
4. **不能按桌面页面可见性停移动桥同步。** 手机远程使用时桌面窗口经常隐藏；visibility gate 会直接
   破坏核心功能。subscriber gate 也必须配首订阅 resync。

---

## 八、建议排期

### P1：先处理正确性与安全边界

1. 移动协议加入 `streamId/epoch`、客户端 heartbeat/pong timeout、auth terminal state。
2. 修健康连接被 visibility/online/pageshow 无条件重建的问题。
3. bridge 状态同步加入 maxWait，并为 subscriber/no-subscriber 设计明确 durable mirror 契约。
4. 明确 LAN 明文风险；确定 TLS/指纹钉扎或可信隧道产品路线。
5. Windows 后台命令 helper：git、where、PowerShell；IP 探测移出 tokio worker并缓存。
6. terminalFeed 字节预算、删卡清理、epoch reset。
7. 建最小 CI，把已有门禁变成实际合入闸门。

### P2：定向量化后做性能修复

1. React Profiler 对比 TerminalView/Shell/CodexItemRow memo。
2. 合并 headless preview 读屏，但保持逐 chunk parser 顺序和 write-drain ACK。
3. audit DB 使用有界 writer；压测锁竞争下移动输入 p50/p95/p99。
4. `pty_input` 阻塞管道故障注入。
5. provider session：Claude 前 N 行流式读、扫描上限；Gemini 整体 `spawn_blocking`。
6. Sidebar comparator、Workspace changes 重复 IPC、NotificationCenter closed compute。
7. 文件 command 的 backend-owned workspace root allowlist。

### P3：结构与卫生

1. bridge 按 preview/runtime/commands/server handler 渐进拆分。
2. Shell TS 化后再拆连接、surface recovery、auth UI。
3. ANSI 工具去重、删 replayRecentOutput、terminalRenderer 实验脚手架。
4. pin `tauri-nspanel` rev、收紧 CSP、移除 query-token 兼容路径。
5. 依赖 major 升级按实际能力/安全需求单独立项，不打包“大爆炸升级”。

---

## 九、需要先做的六个验证

| 验证 | 场景 | 验收数据 |
|---|---|---|
| V1 bridge sync | 手机已订阅，1/6 卡持续输出 60 秒 | state 最大延迟、sync 次数、JSON bytes、Rust enrich 次数、renderer CPU |
| V2 Windows 子进程 | Release 下首次终端、git status/diff/worktree、刷新 QR | 零控制台闪窗；命令结果与退出码不变 |
| V3 DB 竞争 | 人为持有 SQLite 写锁，同时发送移动 input | input enqueue/执行 p50/p95/p99；审计不丢、不乱序 |
| V4 mobile lifecycle | Wi-Fi 静默断、桌面进程重启、token revoke/expire | deadline 内识别断线；epoch 后恢复输出；撤销后停止重连 |
| V5 React | 6 个持久 view，单卡和双卡持续输出 | 每组件 commit 次数、总 commit time、长任务、交互延迟 |
| V6 flow control | 主窗最小化/JS stall/renderer TTL 到期 | producer pause、flow_wait、最终 sentinel、恢复耗时、输出完整性 |

---

## 十、最终评价

这份报告值得保留，尤其是移动桥、Windows 子进程、seq 生命周期、React 热路径和 CI 五组发现；
它比单纯的 lint/大文件扫描更接近真实运行链路。它不适合被原样转换成任务列表：严重度需要重新排序，
四个建议修法需要改写，安全章节还需要把 renderer 传入的 workspace root 纳入同一 trust boundary。

最合理的使用方式是：把它当作**候选问题集 + 复现假设**，以本文裁定后的 P1/P2/P3 和 V1–V6
作为执行入口；历史文档中的 seq/snapshot/ACK/hidden-ingestion 等跨层不变量继续作为不可破坏的验收
底线。

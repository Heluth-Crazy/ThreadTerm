# ThreadTerm 深度审查报告 — 二次诊断（独立复核）

> **诊断对象**：`docs/deep-research-report-tt.md`（ThreadTerm main 分支深度审查报告）
> **复核方法**：逐条断言对照真实源码做行级实证（不依赖原报告引用），裁定每条结论为「确证 / 夸大 / 需修正 / 不成立」，并对严重度独立复评。
> **代码基准**：`e3c31a1`（2026-05-17 21:20:45 +0800，HEAD）。原报告文件 mtime 为同日 22:00 —— **与本次复核同一代码基准**，因此下文指出的偏差属于「分析精度问题」，不能归因于「快照过时」。
> **诊断日期**：2026-05-17

---

## 1. 执行摘要

原报告**整体方向可靠、问题选型有价值**：它点出的 5 大问题中 4 项在代码路径上确证成立，Windows 专项与「无单实例防护」的开放问题也均属实。这是一份比典型 happy-path 评审更深入的静态审查。

但作为发布门禁依据，它存在三类必须修正的瑕疵：

1. **一处核心论据显著夸大**：问题一把 `mobileBridge.syncCards` 描述为「每个输出 chunk 触发全量同步」，但当前代码（与报告同基准）已有 `100ms debounce + payload-diff 短路`双闸门，且 `card_added/card_removed` 已走独立后端增量路径。该环节并非「每 chunk 风暴」。这削弱了问题一 Critical 评级的论证严谨性（结论方向仍可接受，但落点错了一个）。
2. **三处机制描述不精确**：问题一的「localStorage 写风暴」、问题四的「持续写入隐藏 xterm」、问题五的「内存泄漏」，根因机制都需要更精确的表述才能正确指导修复（详见各节）。
3. **方法论硬伤**：原报告全部引用为 `fileciteturn..L1-L3` 占位符，**无精确行级锚点**，不可溯源、不可审计。本文档对每条裁定补齐 `file:line` 证据，正是为弥补这一缺陷。

### 裁定汇总

| 编号 | 原报告标题 | 原评级 | 复核裁定 | 复评严重度 |
|---|---|---|---|---|
| 问题一 | 输出驱动的全量状态同步风暴 | Critical | **部分确证 + 一处显著夸大** | High（环节 B/D 真实），论据需重组 |
| 问题二 | 移动端 `exit(null)` 跨端不一致 | High | **完全确证（精确到行）** | High（确认缺陷，维持） |
| 问题三 | 非 macOS overlay/hotkey 前台化未实现 | High | **完全确证** | High（维持） |
| 问题四 | 隐藏终端长期常驻 | High | **核心确证，一处机制需细化** | High（维持） |
| 问题五 | 移动端 transcript 高频退化 | Medium | **确证，根因表述需精确化** | Medium（维持，长会话下偏保守） |
| Windows-1 | overlay/焦点（同问题三） | — | 确证 | High |
| Windows-2 | `default_shell()` 仅 powershell/cmd | 高风险疑点 | **确证** | Medium-High |
| Windows-3 | `working_dir` 直吃 + 网络地址推断 | 待验证疑点 | **代码层确证**（行为风险待真机） | Medium |
| 开放-3 | 无单实例防护 | 待验证 | **代码层确证（确无防护）** | Medium |

**发布判断（复核后维持原结论方向）**：不建议直接合入待发布分支；适合作为「修复前内部验证版」。但**第一阶段修复清单应按本文档第 4 节重排** —— 原报告把精力分散到了一个已被防抖的环节上。

---

## 2. 逐项复核（行级实证）

### 问题一｜输出驱动的全量状态同步风暴

原报告把链路描述为四环放大：`chunk → updateCardOutput/Preview → ① Zustand persist 写 localStorage ② TerminalManager 全量 syncCards → 后端 sync_cards 广播全量 snapshot + 所有 live card terminal_snapshot`。逐环核实：

**环节 A — 每 chunk 触发 store 更新：✅ 确证**
`src/components/terminal/TerminalEventBridge.tsx:310-324`，`pty.onOutput` 回调内（仅按 `seq` 去重）对每个 chunk 直接调用 `store.updateCardOutput(card.id, data)` 与 `feedHeadless(...)→updateCardReplyPreview`，**无 throttle/debounce**。`feedHeadless`（`headlessPreview.ts:63-72`）对每 chunk 调 `term.write(data, cb)`，回调里再触发 `updateCardReplyPreview`。属实。

**环节 B — Zustand persist 每 chunk 全量序列化写 localStorage：✅ 确证，且为最硬证据**
`src/stores/terminalStore.ts:970-993`：`storage: createJSONStorage(() => localStorage)`、`partialize` 把 **`cards` 全量**（含每卡 `lastOutput`/`lastReplyPreview`/`events[]`）纳入持久化；`updateCardOutput`（`:403-416`）与 `updateCardReplyPreview`（`:539-546`）每 chunk 修改 `cards`。Zustand persist 默认在每次 `setState` 后同步写 storage，此处**未配置任何节流**。
→ 即「每个 chunk → 整个 `cards` 数组 `JSON.stringify` → 同步阻塞主线程写 `localStorage`」。这是真实的主线程同步 I/O + 序列化热点，**报告抓对了，且这是问题一最该修的一环**。
*精度补充（报告未提）*：`lastOutput` 经 `tailJoin(..., MAX_LAST_OUTPUT_LENGTH)` 截断（`:412`），故不是无界存储膨胀，而是**高频全量序列化频率**问题。修复应针对「把高频字段移出 persist 分区 / 给 storage 加节流」，而非「限制体积」。

**环节 C — `mobileBridge.syncCards` 跟随 `cards` 全量自动触发：⚠️ 显著夸大（核心修正点）**
`src/components/terminal/TerminalManager.tsx:266-281`：
- `mobileBridgeCards = useMemo(() => cards.map(cardToMobileMeta), [cards])`：cards 每变重算（这步确每 chunk 跑）；
- 但同步 effect 有**双闸门**：①`payload === lastMobileSyncPayloadRef.current` 则 `return`（payload-diff 短路）；②`window.setTimeout(..., MOBILE_SYNC_DEBOUNCE_MS)`，`MOBILE_SYNC_DEBOUNCE_MS = 100`（`:48`），cleanup 阶段 `clearTimeout`。
- `cardToMobileMeta`（`:87-110`）确含高频字段（`lastReplyPreview`/`recentOutputBytes`/`lastActivity`），故 payload-diff 闸门对持续输出无效；**但 100ms debounce 闸门有效**：持续刷屏（chunk 间隔 <100ms）时定时器被反复 `clearTimeout` 重置，`syncCards` **在输出期间几乎不触发**，仅在 ≥100ms 静默间隙发一次。
→ 真实行为是「最坏 ≤10 次/秒、持续输出时远低于此」，**不是报告所称「每 chunk 风暴」**。此外报告建议的「只在创建/删除时发 `card_added/card_removed`」——后端已有**独立增量路径** `broadcast_card_added`/`broadcast_card_removed`（`src-tauri/src/bridge/mod.rs:546-569`，对应 git log `52e466f`「D4 补播 card_added/card_removed」）。**报告该建议部分已落地，且未识别既有 debounce。** 鉴于报告与 HEAD 同基准，这属于**分析疏漏**，非时效错位。

**环节 D — 后端 `sync_cards` 广播全量 Snapshot + 所有 live card TerminalSnapshot：✅ 确证，且为最贵一环**
`src-tauri/src/bridge/mod.rs:134-144`：`sync_cards` 末尾 `self.broadcast(ServerMessage::from(snapshot.clone()))`（全量 Snapshot）+ `broadcast_terminal_snapshots_for_cards(&snapshot.cards)`。后者（`:615-624`）遍历所有 `pty_live` card，每个调 `terminal_snapshot_message`（`:599-613`，内部 `pty::attach_snapshot_for_bridge` 拉**完整屏幕 + history**）并广播。
→ 每次 `syncCards` 抵达后端 ⇒ `1 条全量 Snapshot + N 条完整 TerminalSnapshot`。**这是整条链路最重的放大**。报告修复建议「`terminal_snapshot` 仅保留给初次附着/重连/backpressure recovery」**精准且正确**。
*注*：实时增量通道已独立存在且不经 `sync_cards`：`broadcast_terminal_output`（`:496-507`）/`broadcast_preview`（`:481-494`），由 `pty/events.rs:254-256` 每 chunk 直接调用。问题纯在 `sync_cards` 这条**元数据路径**额外捎带全量重快照。

**问题一综合裁定**：报告把四环并列为「每 chunk 全链路风暴」，其中 **B、D 真实且严重，A 属实，C 被防抖钳制（夸大）**。Critical 评级方向可接受，但**论证落点应从「syncCards 风暴」改为「persist 全量同步写 + 后端 sync_cards 全量重快照」**。复评 **High**（B、D 在持续输出下确造成主线程 jank + WS 重消息，但非 C 所述的失控风暴）。

---

### 问题二｜移动端 `exit(null)` 跨端不一致 — ✅ 完全确证（精确到行）

- 后端 `src-tauri/src/pty/events.rs:187-197`：被 kill / signal-only 退出时 `code = None`（`exit_code_from_status:213-221` 对 `Terminated by` 返回 `None`），`None => SessionState::Idle`。
- 桌面端 `src/components/terminal/TerminalEventBridge.tsx:348-364`：注释明确「`code === null|undefined → idle`（人为 kill / remount，不应判失败）」，逻辑 `code===0→completed`，`number 且 ≠0→failed`，`null` 落入 idle 语义。
- 移动端 `mobile-app/src/bridge/messages.ts:145-157`：`const status = message.code === 0 || message.code === null ? 'completed' : 'failed';` ——**`code===null` 直接判 `completed`**。

三方语义对比：后端/桌面 = `idle`，移动端 = `completed`。**确认的状态机分叉缺陷**，与报告描述完全一致，精确到行。
*补充（报告未深究但应补测）*：移动端该错误状态可被后续 `state`/`card_updated`/`snapshot` 分支覆盖（`messages.ts:78-90,134-144`）。其「持久 vs 短暂」取决于后端 `set_session_state(Idle)` 是否补发 `state`；但 `broadcast_exit`（`bridge/mod.rs:534-540`）必发 `Exit`，移动端 `exit` 分支必先错一次。维持 **High**。报告修复方向（统一为 idle，或不在 reducer 重复推导、只信后端权威 `state`）正确，后者更稳。

---

### 问题三｜非 macOS overlay/hotkey 前台化未实现 — ✅ 完全确证

- `src-tauri/src/overlay/platform.rs:184-206`：`#[cfg(not(target_os = "macos"))]` 下 `configure_selector/float/pet_window_for_current_space`、`activate_float_window_for_keyboard`、`order_overlay_window_front`、`set_overlay_activation_policy` 等**全部为空函数体 `{}`**。
- `src-tauri/src/overlay/commands.rs`：非 macOS 路径 `overlay_show_selector`（`:74-77`）= `w.show()` + `order_overlay_window_front`（no-op）；`overlay_show_float`（`:152-155`）同样仅 `w.show()` + no-op；**均无 `set_focus()`**。
- `src-tauri/src/overlay/hotkey.rs:82-101`：CRITICAL 设计注释明确要求「必须由 Rust 直接做 OS 级 `show/set_focus/front`」「需要 `NSApp.activate(ignoringOtherApps:YES)`」，但实现仅 macOS 闭环。
- `tauri-plugin-global-shortcut`（`src-tauri/Cargo.toml:24`）已依赖 → 热键**能注册**，问题精确落在「注册成功后窗口不抢前台/不拿键盘焦点」，与报告判断一致。

裁定与报告一致，**维持 High**。Windows/Linux 上 overlay 核心交互链路确实不可靠。

---

### 问题四｜隐藏终端长期常驻 — ✅ 核心确证，一处机制需细化

- `src/components/terminal/TerminalManager.tsx:793-825`：所有 `mountedIdsRef.current.has(c.id)` 的卡片**持续渲染 `<TerminalView>`**，仅以 `visibility:hidden` + `opacity-0` + `pointer-events-none` 隐藏，DOM / xterm 实例不卸载。
- `mountedIdsRef` 仅在「卡片已不存在」时清理（`:382-395` 的 effect：`if (!ids.has(id)) delete`），**无 LRU、无上限**。报告「访问过即常驻，只删卡时清理」**精确属实**。
- **机制细化**：`src/components/Shell.jsx:333-349` 隐藏态下 `pty.onOutput` 仍订阅、`outputSequencer` 仍接收并排序数据；但 `:304` 存在 `if (!meta.render) { ackWritten(); return; }` 门控，隐藏（`active=false`）时大概率跳过 `term.write`/`refresh`。
→ 故报告「Shell 在隐藏时仍写入隐藏 xterm」**不完全准确**：xterm **paint 被 render 门控跳过**，但 xterm 实例 + 200 行 scrollback、DOM、`ResizeObserver`、focus/visibility listener、PTY 订阅、sequencer buffer **均不释放**，且后端仍对其 emit。报告核心结论（隐藏卡资源常驻、无回收、随访问数恶化）成立。

**维持 High**。准确表述应为：「隐藏卡保留完整 xterm 实例与订阅，渲染被门控但内存/监听器/订阅不回收，无 LRU 上限」。

---

### 问题五｜移动端 transcript 高频退化 — ✅ 确证，根因表述需精确化

- `mobile-app/src/terminalTranscript.ts:15-16`：`appendTerminalMessage` 每条消息对**整个数组** `current.filter()` 两次并重建。O(N) per message。属实。
- `mobile-app/src/MainTerminal.tsx:320-365`：每次 `messages` 变更 `for (const message of messages)` **遍历全部消息**（`:324`）。O(N) per render。属实。
- `mobile-app/src/App.tsx:88,113-114`：`terminalMessages` **仅**在 `terminal_output|terminal_snapshot` 时 `appendTerminalMessage` 更新；grep 全文件确认 `card_removed`/`close_result` 分支**无 transcript 裁剪**。报告「删卡后不回收 transcript」**属实**。
- 但 `terminalTranscript.ts:8,50-69` 有 `MAX_MESSAGES_PER_CARD = 2000` 单卡上限。

**精度修正**：这**不是无界内存泄漏**。准确根因是：①已删卡的 transcript 桶不回收（有界残留，每卡 ≤2000 条）；②`appendTerminalMessage`/`MainTerminal` 对**全局数组**做 O(总量) 重建/扫描 → **算法复杂度随历史卡片累计数线性退化**。体验劣化（滚动、返回再进入卡顿）主要来自 ②，而非堆无界增长。报告「内存泄漏」措辞偏重，会误导修复方向。报告建议（per-card ring buffer / map + `card_removed`/`close_result` 裁剪 + MainTerminal 改为「只消费当前卡增量」）方向正确。**维持 Medium**（长会话下偏保守，可视为 Medium 偏上）。

---

### Windows 专项

- **shell.rs：✅ 确证** `src-tauri/src/pty/shell.rs:9-26`，Windows 仅在 `powershell.exe`（经 `where` 探测，`:114-120`）与 `cmd.exe` 间二选一，**不读 `COMSPEC`、不优先 `pwsh.exe`**。补充观察：`powershell.exe` 在现代 Windows 几乎必然存在 → 实际**几乎永远选 Windows PowerShell 5.1，永不选 PowerShell 7 (`pwsh`)**，对依赖 pwsh 的开发者环境影响确定存在。复评 **Medium-High**（行为可预测，非随机疑点）。
- **pty/mod.rs：✅ 确证** `src-tauri/src/pty/mod.rs:68-101`，`cmd.cwd(&working_dir)`（`:95`）直吃前端传入路径，无平台层校验；spawn 失败仅返回笼统 `"Failed to spawn shell: {e}"`，无路径/平台归类。Windows 路径分隔符差异下更易触发。复评 **Medium**。
- **网络地址推断：✅ 确证** `src-tauri/src/bridge/mod.rs:807-853`，`default_route_ipv4_for_url` **仅 macOS 实现**（`:824-827` 非 macOS 恒返回 `None`），非 macOS 只能退回 `udp_route_ipv4_for_url`（`connect 8.8.8.8` 探测，`:843-853`）。VPN/企业网/离线网段下不稳。报告列为「待验证疑点」恰当，**代码层面确证**，真机行为待验。

### 开放问题 — 单实例防护：✅ 代码层确证「确无防护」

全仓 grep `single.instance / single_instance / SingleInstance` **零匹配**；`src-tauri/Cargo.toml:21-47` 插件列表**无 `tauri-plugin-single-instance`**；`bridge/mod.rs:358 already_running` 仅为 bridge **端口占用检查**，非应用级单实例防护。报告「未见明确单实例防护证据」可由「疑点」**升级为确证**：多桌面实例并行启动在端口 / 全局热键 / 状态目录上确无防护。复评 **Medium**。

---

## 3. 报告方法论评估

| 维度 | 评估 |
|---|---|
| 问题选型 | 优。聚焦「真实高频使用才暴露」的系统级缺陷，超出 happy-path 评审。 |
| 结论方向 | 4/5 核心问题 + Windows + 开放问题均确证，方向可靠。 |
| 论据精度 | 问题一 syncCards 环节夸大；问题一/四/五各有一处机制描述不精确，会误导修复落点。 |
| 可溯源性 | **差**。全部引用为 `fileciteturn..L1-L3` 占位符，行号恒定、不可审计。本复核已逐条补齐 `file:line`。 |
| 版本时效 | 报告与 HEAD `e3c31a1` 同基准，故偏差为分析疏漏（未识别既有 debounce/独立增量路径），非快照过时。 |
| 测试建议 | 合理且可落地（指标化回归、四层测试矩阵）。建议采纳，但需按修正后的根因调整断言对象（见第 4 节）。 |

---

## 4. 修订后的优先修复建议

> 原报告三阶段划分基本合理，仅需**重排第一阶段落点**，剔除已被防抖的工作、补上真正的热点。

**第一阶段（确定缺陷 + 真实热点，不含已防抖项）**
1. **问题二**：移动端 `messages.ts:146` `exit` 分支 —— `code===null` 归 `idle`，或更稳妥地移除 reducer 内退出推导、只信后端 `state`/`card_updated`/`snapshot`。补单测 `exit(null)=>idle`。**改动小、收益高、跨端可见，优先级最高。**
2. **问题一-D**：`src-tauri/src/bridge/mod.rs:134-144` `sync_cards` 不再无条件 `broadcast_terminal_snapshots_for_cards`；`terminal_snapshot` 仅保留给初次附着 / 重连 / backpressure recovery。**整条链路最重的放大点，单点收益最大。**
3. **问题一-B**：`terminalStore.ts` 把 `lastOutput`/`lastReplyPreview` 等高频字段移出 persist `partialize` 分区，或给 `createJSONStorage` 包一层节流（如 250–500ms 合并写）。消除主线程同步 I/O jank。
4. ~~原报告「修 syncCards 跟随 cards 全量」~~ —— **降级**：已有 100ms debounce + payload-diff + 独立 `card_added/removed` 路径；仅需评估「多卡交替输出时 debounce 抖动」，无需大改。

**第二阶段（Windows/Linux 适配）**：同原报告 —— `overlay/platform.rs` 补非 macOS `show + unminimize + focus`；`commands.rs` 补 `set_focus()`；`shell.rs` 引入 `COMSPEC`/`pwsh` 策略；补真机冒烟。注意勿反伤 macOS 现有 overlay 行为。

**第三阶段（渲染/资源生命周期重构）**：同原报告 —— PTY 保活与 xterm 渲染解耦、隐藏卡 LRU/上限、移动端 transcript 改 per-card ring buffer 并在 `card_removed`/`close_result` 裁剪、`MainTerminal` 改增量消费。

**回归测试落点修正**：原报告「断言 `bridge_sync_cards` 调用次数下降」应改为断言 **`ServerMessage::Snapshot` + `TerminalSnapshot` 广播条数**（环节 D）与 **`localStorage` 写次数 / 全量序列化耗时**（环节 B）；`syncCards` 调用次数因已被 debounce，不再是有效的劣化指标。

---

## 5. 证据索引（本复核可溯源锚点）

| 主张 | 文件:行 |
|---|---|
| 每 chunk 调 updateCardOutput/Preview，无节流 | `src/components/terminal/TerminalEventBridge.tsx:310-324`；`headlessPreview.ts:63-72` |
| persist 全量 cards、localStorage 无节流 | `src/stores/terminalStore.ts:970-993`；`:403-416`；`:539-546` |
| syncCards 双闸门（debounce 100ms + payload-diff） | `src/components/terminal/TerminalManager.tsx:48,266-281,87-110` |
| 后端 sync_cards 广播全量 Snapshot + 全部 TerminalSnapshot | `src-tauri/src/bridge/mod.rs:134-144,599-624` |
| 独立增量路径 card_added/removed | `src-tauri/src/bridge/mod.rs:546-569` |
| exit(null) 三方语义分叉 | `src-tauri/src/pty/events.rs:187-197`；`TerminalEventBridge.tsx:348-364`；`mobile-app/src/bridge/messages.ts:145-157` |
| 非 macOS overlay 全 no-op | `src-tauri/src/overlay/platform.rs:184-206` |
| 非 macOS show 无 set_focus | `src-tauri/src/overlay/commands.rs:74-77,152-155` |
| 热键 CRITICAL 设计仅 macOS 闭环 | `src-tauri/src/overlay/hotkey.rs:82-101` |
| 隐藏卡常驻 + 仅删卡清理 + 无 LRU | `src/components/terminal/TerminalManager.tsx:793-825,382-395`；`Shell.jsx:304,333-349` |
| transcript 全数组重建 / 无删卡回收 / 单卡上限 | `mobile-app/src/terminalTranscript.ts:8,15-16,50-69`；`MainTerminal.tsx:320-365`；`App.tsx:88,113-114` |
| Windows shell 仅 powershell/cmd | `src-tauri/src/pty/shell.rs:9-26,114-120` |
| working_dir 直吃无校验 | `src-tauri/src/pty/mod.rs:68-101` |
| 网络地址推断非 macOS 退化 | `src-tauri/src/bridge/mod.rs:807-853` |
| 无单实例防护 | grep 零匹配；`src-tauri/Cargo.toml:21-47` 无 single-instance 插件 |

---

*本二次诊断为对既有静态审查报告的独立复核，结论基于 `e3c31a1` 源码行级实证，不含动态/真机 trace。问题三的 Windows/Linux 实际窗口行为、Windows-2/3 的真机表现，仍需目标平台验证后最终确认。*

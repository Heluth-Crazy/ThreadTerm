# ThreadTerm 缺陷修复 — 详细实施计划

> **依据**：`docs/deep-research-report-tt-second-diagnosis.md`（二次诊断，已对照 `e3c31a1` 行级实证）
> **代码基准**：`e3c31a1`
> **计划日期**：2026-05-17
> **性质**：实施计划（规划交付物，本文档不改代码）。每个修复项给出根因锚点、改动规格（diff 级）、向后兼容性、为何安全、测试用例、验证方法、回滚预案。

---

## 0. 总原则与约束

1. **最小改动、不破坏向后兼容**：每项改动限定在二次诊断确证的根因点，不顺带重构。
2. **协议级验证优先**：第一阶段触碰 store / bridge / 移动端 reducer 三个同步点，验证以**消息计数 / 协议日志 / 单测**为准，不只看 UI。
3. **分阶段、可独立合入**：每个 FIX 是一个独立可回滚的提交；阶段内无强依赖的项可并行。
4. **macOS 行为零回归**：第二阶段窗口修复只动 `#[cfg(not(target_os = "macos"))]` 分支，macOS 分支一字不改。
5. **每项必须带回归测试**，且测试进入 CI 基线（不只做人眼验证）。

### 任务依赖与排期总览

```
阶段一（确定缺陷 + 真实热点，互相独立，可并行）
  ├─ FIX-1  问题二  移动端 exit(null) 跨端不一致      [S]  ★quick-win
  ├─ FIX-2  问题一-D sync_cards 全量重快照            [S]  ★quick-win 最高ROI
  └─ FIX-3  问题一-B persist 每chunk全量同步写         [M]

阶段二（Windows/Linux 适配，依赖真机验证，互相独立）
  ├─ FIX-4  问题三  非 macOS overlay 前台化/焦点       [M]
  ├─ FIX-5  Windows default_shell 策略                [S]
  └─ FIX-6  working_dir 校验 + spawn 错误归类          [S]

阶段三（渲染/资源生命周期，风险最高，FIX-7 与 FIX-8 独立）
  ├─ FIX-7  问题四  隐藏卡 LRU + lazy re-attach        [L]
  └─ FIX-8  问题五  transcript per-card 重构           [M]

附录-A  开放问题：单实例防护（建议，非阻塞）
```
工时标度：S≈0.5d、M≈1–2d、L≈3–5d（含测试）。
**若资源极紧，先做 FIX-2 + FIX-1**：两项合计 <1d，覆盖「最重的放大点」+「最用户可见的跨端缺陷」。

---

## 阶段一：确定缺陷与真实热点

### FIX-1 ｜问题二｜移动端 `exit(null)` 跨端状态不一致

**严重度**：High（确认缺陷，跨端用户可见）
**根因锚点**

- `src-tauri/src/pty/events.rs:187-197`：被 kill / signal-only 退出 → `code = None` → `SessionState::Idle`。
- `src-tauri/src/pty/session.rs:104-117`：`set_session_state` 状态变更时**会** `bridge::broadcast_state(id, Idle)`。
- 执行时序（`events.rs:193-206`）：先 `set_session_state(Idle)`（⇒ 广播 `state{status:idle}`）→ 紧接 `bridge::broadcast_exit(id, None)`（⇒ 广播 `exit{code:null}`）。
- 移动端 `src/.../bridge/messages.ts:145-157`：`exit` 分支 `code===null ? 'completed'` —— **把刚收到的权威 `idle` 覆盖成 `completed`**。
- 桌面端 `TerminalEventBridge.tsx:348-364` 与协议 `src/mobile/bridge/protocol.ts:109`（`code: number | null`）均按 `null→idle` 语义。

> 根因定性：不是显示偏差，是**移动端 reducer 重复推导退出态、且其推导与后端权威 `state` 矛盾，并在时序上后到、覆盖正确值**。

**改动规格（方案 A — 最小对齐，推荐落地）**

文件：`mobile-app/src/bridge/messages.ts`（与共享副本 `src/mobile/bridge/messages.ts` 若存在镜像需同步）

```diff
   case 'exit': {
-    const status = message.code === 0 || message.code === null ? 'completed' : 'failed';
+    // 与后端/桌面语义对齐：code===null 表示人为 kill / signal / remount，
+    // 后端已置 Idle 并通过权威 `state` 广播；此处必须回 idle，不得覆盖成 completed。
+    const status =
+      message.code === 0 ? 'completed'
+      : message.code === null ? 'idle'
+      : 'failed';
     return {
       ...state,
       cards: state.cards.map((card) =>
         card.id === message.card_id ? { ...card, status } : card,
       ),
       ptyStatusByCardId: { ...state.ptyStatusByCardId, [message.card_id]: status },
     };
   }
```

**方案 B（推荐作为阶段三技术债清理，不在本次落地）**：`exit` 分支不再推导 `status`，仅信后端 `state`/`card_updated`/`snapshot`。不本次做的原因：需先确认所有退出路径 `set_session_state` 都因状态实际变化而广播（`session.rs:106` 有 `if *state != new_state` 短路，理论上存在「已是 Idle 不再广播」的边界），方案 A 确定性最高、可单测、零边界风险。

**向后兼容**：仅改前端枚举映射，协议不变；旧桌面端 + 新移动端、新桌面端 + 旧移动端均不受影响（协议 `exit.code` 字段未变）。

**测试用例**（追加至现有 `mobile-app/src/bridge/messages.test.ts`）

1. `applyServerMessage(state, {kind:'exit', card_id:'c1', code:null})` ⇒ `cards[c1].status === 'idle'` 且 `ptyStatusByCardId.c1 === 'idle'`。
2. `code:0` ⇒ `'completed'`；`code:1` ⇒ `'failed'`；`code:137` ⇒ `'failed'`。
3. 时序回归：依次 apply `state{idle}` 再 `exit{null}` ⇒ 终态 `idle`（验证不再被覆盖）。
4. （集成，可选）bridge 集成测试：同一卡片 kill 后，桌面与移动最终 `status` 一致。

**验证方法**：`npm test -- messages` 全绿；手工：移动端连接 → 桌面 kill 一个会话 → 移动端列表/详情徽标显示 idle（非 completed），返回再进入不漂移。

**回滚**：单文件单 case，`git revert` 即可，无数据迁移。

---

### FIX-2 ｜问题一-D｜后端 `sync_cards` 重广播全量 Snapshot + 所有 live card TerminalSnapshot

**严重度**：High（整条同步链路最重的放大点，单点收益最大）
**根因锚点**

- `src-tauri/src/bridge/mod.rs:134-144` `sync_cards()` 末尾：
  `self.broadcast(Snapshot)` + `broadcast_terminal_snapshots_for_cards(&snapshot.cards)`。
- `broadcast_terminal_snapshots_for_cards`（`:615-624`）对每个 `pty_live` card 调 `terminal_snapshot_message`（`:599-613`，内部 `pty::attach_snapshot_for_bridge` 拉**完整屏幕 + history**）。
- 调用点仅两处：`mod.rs:143`（本次目标）与 `mod.rs:554`（`broadcast_card_added`，单卡新增，保留）。

**为何删除 `:143` 安全（关键论证）**：客户端获取 `terminal_snapshot` 的所有正当路径都**不经过** `sync_cards`：

- 首次连接：`server.rs:257 send_initial_messages` → `:375-394 initial_messages_for_client`（`:378-383` 独立产出全部 `TerminalSnapshot`）。
- 重连：`server.rs:310 send_initial_messages`（同上）。
- backpressure / Lagged recovery：`server.rs:274 RecvError::Lagged` → `:283 initial_messages_for_client`（同上）。
- 单卡新增：`mod.rs:554 broadcast_card_added` → `broadcast_terminal_snapshots_for_cards(&[card])`（保留）。

> 即 `sync_cards:143` 的全量重快照对「首连/重连/恢复/新增」**全部冗余**，删除不影响任何恢复语义，纯粹消除元数据镜像更新顺带的 `1 + N` 条重消息放大。

**改动规格**

文件：`src-tauri/src/bridge/mod.rs`

```diff
   pub fn sync_cards(&self, cards: Vec<CardMeta>) {
       if let Ok(mut mirror) = self.card_mirror.lock() { *mirror = cards; }
       if let Ok(mut initialized) = self.card_mirror_initialized.lock() { *initialized = true; }
       let snapshot = self.snapshot();
       self.broadcast(ServerMessage::from(snapshot.clone()));
-      broadcast_terminal_snapshots_for_cards(&snapshot.cards);
+      // terminal_snapshot 仅在首连/重连/Lagged-recovery（server.rs
+      // initial_messages_for_client）与单卡新增（broadcast_card_added）发送。
+      // 元数据镜像同步不再附带全量屏幕重快照——这是持续输出下 WS 消息
+      // 放大的主因（见二次诊断 问题一-D）。
   }
```

**向后兼容**：协议消息类型不变；移动端 `messages.ts` 的 `snapshot`/`card_*`/`terminal_*` 分支均不变。移动端仍在首连/重连/恢复时收到完整 `terminal_snapshot`，仅不再在每次桌面元数据同步时收到冗余重快照。

**风险**：低。唯一行为变化——若移动端**已连接**且桌面**新增以外**的元数据变化（如 status/preview）触发 `sync_cards`，移动端不再额外收到该卡完整屏幕重画；但实时屏幕内容本就由独立增量通道 `broadcast_terminal_output`（`mod.rs:496-507`，`pty/events.rs:254`）持续提供，不依赖此重快照。

**测试用例**

1. 现有 bridge 集成测试（`bridge/mod.rs` tests / `server.rs:747`）补：连接一个 client → 触发 N 次 `sync_cards` → 断言收到的 `TerminalSnapshot` 条数 == 0（仅元数据同步场景），`Snapshot` 条数 == N。
2. 回归保护：新客户端连接仍收到 `Theme + Snapshot + 每 live card 一条 TerminalSnapshot`（验 `initial_messages_for_client` 未受影响）。
3. 单卡新增仍发该卡 `CardAdded + TerminalSnapshot`（验 `broadcast_card_added` 未受影响）。

**验证方法**：`cargo test -p <crate> bridge`；手工：桌面 3 会话持续输出 + 移动端连接，抓 WS 帧，`terminal_snapshot` 占比应从「持续高频」降到「仅连接/恢复时出现」。

**回滚**：单行恢复。

---

### FIX-3 ｜问题一-B｜Zustand persist 每 chunk 全量序列化同步写 `localStorage`

**严重度**：High（持续输出下主线程同步 I/O + 全量 `JSON.stringify` jank）
**根因锚点**

- `src/stores/terminalStore.ts:970-993`：`storage: createJSONStorage(() => localStorage)`，`partialize` 持久化 `cards` 全量（含每卡 `lastOutput`/`lastReplyPreview`/`events[]`）。
- `:403-416 updateCardOutput` / `:539-546 updateCardReplyPreview` 每 chunk 改 `cards` → persist 默认每次 `setState` 后**同步**写 storage，无节流。
- `lastOutput` 已由 `tailJoin(..., MAX_LAST_OUTPUT_LENGTH)` 截断（`:412`），故是**写频率/序列化频率**问题，非存储膨胀。

**消费者影响评估**（决定方案选择）：`lastOutput`/`lastReplyPreview` 被 `TerminalView.tsx:105`、`TerminalCard.tsx:103-121`、`cardPreview.ts`、`providerSession.ts:58`、`pet/petState.ts:49`、`SelectorCard.tsx:55`、`TerminalManager.cardToMobileMeta:99-102` 等**运行时从 store 内存读取**——这些不受持久化影响。**唯一受影响的是 App 重启/刷新后的卡片预览初值**（持久化里若无 preview，重启后卡片预览短暂为空，直到该卡再产出输出）。

**方案对比**

| 方案 | 做法 | 重启后预览 | 改动面 | 风险 |
|---|---|---|---|---|
| **B（推荐）** | 自定义 storage adapter，`setItem` 加 trailing-debounce（合并写，~500ms），`getItem`/`removeItem` 透传；页面隐藏/卸载时 flush | 保留 | 小（仅 storage 适配层） | 低 |
| A | `partialize` 移除 `lastOutput`/`lastReplyPreview` | 丢失（重启后空白预览直到新输出） | 小 | 中（行为可见变化 + 需迁移） |
| C | partialize 时把 preview 截到极短（如 240 字符）再存 | 部分保留 | 中 | 中 |

**采用方案 B**。改动规格：

文件：`src/stores/terminalStore.ts`

```ts
// 新增：节流写 storage 适配器（trailing debounce，隐藏/卸载时立即 flush）
function createThrottledLocalStorage(delayMs = 500): StateStorage {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { name: string; value: string } | null = null;
  const flush = () => {
    if (pending) { localStorage.setItem(pending.name, pending.value); pending = null; }
    if (timer) { clearTimeout(timer); timer = null; }
  };
  if (typeof window !== 'undefined') {
    // 关键：不丢最后一次写
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
  return {
    getItem: (name) => localStorage.getItem(name),
    setItem: (name, value) => {
      pending = { name, value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    removeItem: (name) => { pending = null; localStorage.removeItem(name); },
  };
}
```
```diff
-      storage: createJSONStorage(() => localStorage),
+      storage: createJSONStorage(() => createThrottledLocalStorage(500)),
```

**向后兼容**：storage key (`threadterm-terminal-store`)、`version`(11)、`migrate` 全不变；旧持久化数据原样读取。仅写入时机从「每次 setState 同步」变为「≤500ms 合并 + 隐藏/卸载 flush」。崩溃丢失上限 = 最近 500ms 的元数据变更（可接受：cards 元数据非交易数据，且终端内容由后端 PTY 权威保存）。

**测试用例**

1. 单测（jsdom + fake timers）：连续 100 次 `setItem` 在 500ms 内 ⇒ `localStorage.setItem` 实际调用次数 == 1。
2. flush 正确性：`setItem` 后触发 `visibilitychange:hidden` ⇒ 立即落盘；`beforeunload` 同理。
3. 回归：`getItem`/`removeItem` 行为与原生一致；store rehydrate（重启模拟）正常。
4. 性能基线：脚本 10s 内单会话写 10k chunk，断言 `localStorage.setItem` 调用次数与全量 `JSON.stringify` 耗时较修复前显著下降（进 CI 阈值）。

**验证方法**：`npm test -- terminalStore`；DevTools Performance 录制持续输出，`localStorage`/序列化热点应消失。

**回滚**：还原 storage 一行 + 删 adapter，无迁移。

---

## 阶段二：Windows / Linux 适配

### FIX-4 ｜问题三｜非 macOS overlay/selector/float 前台化与键盘焦点缺失

**严重度**：High（Windows/Linux overlay 核心交互不可靠）
**根因锚点**

- `src-tauri/src/overlay/platform.rs:184-206`：非 macOS 下 `order_overlay_window_front`、`activate_float_window_for_keyboard` 等全为空体 `{}`。
- `src-tauri/src/overlay/commands.rs:74-77`（selector）、`:152-155`（float）：非 macOS 仅 `w.show()` + no-op，**无 `set_focus()`**。
- `hotkey.rs:82-101` CRITICAL 设计要求 OS 级 show/focus/front，仅 macOS 闭环。

**可用 API 依据**：`commands.rs:209-213 overlay_show_main` 已证明非 macOS 下 `WebviewWindow::show() / unminimize() / set_focus()` 均可用且正确（主窗口回收即用此组合）。selector/float 套用同一组合即可。

**改动规格**

文件：`src-tauri/src/overlay/commands.rs`

```diff
   // overlay_show_selector — 非 macOS 分支（约 :74-77）
   #[cfg(not(target_os = "macos"))]
   {
       let _ = w.show();
+      let _ = w.unminimize();
+      let _ = w.set_always_on_top(true);
+      let _ = w.set_focus();
       order_overlay_window_front(&w);
   }
```
```diff
   // overlay_show_float — 非 macOS 分支（约 :152-155）
   #[cfg(not(target_os = "macos"))]
   {
       let _ = w.show();
+      let _ = w.unminimize();
+      let _ = w.set_always_on_top(true);
+      let _ = w.set_focus();
       order_overlay_window_front(&w);
+      activate_float_window_for_keyboard(&w);
   }
```

文件：`src-tauri/src/overlay/platform.rs`（给非 macOS 真正实现，替换空体）

```diff
-#[cfg(not(target_os = "macos"))]
-pub(super) fn order_overlay_window_front(_window: &WebviewWindow) {}
+#[cfg(not(target_os = "macos"))]
+pub(super) fn order_overlay_window_front(window: &WebviewWindow) {
+    let _ = window.set_always_on_top(true);
+    let _ = window.set_focus();
+}
-#[cfg(not(target_os = "macos"))]
-pub(super) fn activate_float_window_for_keyboard(_window: &WebviewWindow) {}
+#[cfg(not(target_os = "macos"))]
+pub(super) fn activate_float_window_for_keyboard(window: &WebviewWindow) {
+    let _ = window.set_focus();
+}
```

> 设计取舍：`set_always_on_top(true)` 用于保证从他应用前台拉起时窗口在最前；若产品要求 overlay 关闭后不常驻置顶，需在 `overlay_hide_selector`/`overlay_show_main` 对应路径补 `set_always_on_top(false)`（纳入本 FIX 的子任务，避免置顶状态泄漏）。

**macOS 零回归保证**：以上 diff 只动 `#[cfg(not(target_os = "macos"))]` 分支与非 macOS `platform.rs` 实现；macOS `#[cfg(target_os = "macos")]` 分支与 NSPanel 路径**不改一字**。

**测试矩阵**（真机为主，无法纯自动化）

- 自动化：`platform.rs` 非 macOS helper 单测（断言函数被调用、不再是空 pass）；`commands.rs` 路径冒烟。
- Windows 11 手工：他应用前台 → Hotkey A → selector 是否到最前 + 无需点击即可键盘选择；selector → float 后立即输入是否生效；Hotkey B 回收主窗口；selector 反复开关。
- Linux（X11 + Wayland 各一）：同上（Wayland 焦点策略差异需单列结论）。

**回滚**：分支隔离，单独 revert 不影响 macOS。

---

### FIX-5 ｜Windows `default_shell()` 仅 powershell/cmd

**严重度**：Medium-High（行为确定：现代 Windows 几乎必选 PowerShell 5.1，永不选 pwsh 7）
**根因锚点**：`src-tauri/src/pty/shell.rs:9-26`（仅 `powershell.exe`/`cmd.exe`），`:114-120 which_exists` 用 `where`。

**改动规格**

文件：`src-tauri/src/pty/shell.rs`

```diff
   #[cfg(target_os = "windows")]
   {
-      if which_exists("powershell.exe") {
-          "powershell.exe".to_string()
-      } else {
-          "cmd.exe".to_string()
-      }
+      // 优先级：用户显式 SHELL → pwsh (PowerShell 7+) → Windows PowerShell 5.1 → COMSPEC → cmd.exe
+      if let Ok(s) = std::env::var("SHELL") {
+          if !s.trim().is_empty() && which_exists(&s) { return s; }
+      }
+      if which_exists("pwsh.exe") { return "pwsh.exe".to_string(); }
+      if which_exists("powershell.exe") { return "powershell.exe".to_string(); }
+      if let Ok(c) = std::env::var("COMSPEC") {
+          if !c.trim().is_empty() { return c; }
+      }
+      "cmd.exe".to_string()
   }
```

**向后兼容**：默认环境（无 `SHELL`、有 pwsh）行为变化 = 优先 pwsh —— 这是预期改进，但属**可感知行为变化**，需在 release note 注明，并提供设置项覆盖（若已有 shell 设置则透传，不在本 FIX 引入新设置）。

**测试**：`shell.rs` 单测以 `which_exists` 注入 mock，覆盖 5 条优先级分支；Windows 真机：装/不装 pwsh、设/不设 `SHELL`、设/不设 `COMSPEC` 组合验证。

**回滚**：单函数还原。

---

### FIX-6 ｜`pty_create` 直吃 `working_dir`，无平台校验与错误归类

**严重度**：Medium
**根因锚点**：`src-tauri/src/pty/mod.rs:68-101`，`:95 cmd.cwd(&working_dir)` 无校验，失败仅返回笼统 `"Failed to spawn shell: {e}"`。

**改动规格**

文件：`src-tauri/src/pty/mod.rs`（在 `:95` 前插入校验，`:101` 错误归类）

```diff
   let shell_path = shell::default_shell();
   let mut cmd = CommandBuilder::new(&shell_path);
+  // 前置校验：路径必须存在且为目录，避免在 spawn 处得到无法归因的失败。
+  let wd = std::path::Path::new(&working_dir);
+  if working_dir.trim().is_empty() {
+      return Err("working_dir_empty: working directory is required".into());
+  }
+  if !wd.exists() {
+      return Err(format!("working_dir_not_found: {working_dir}"));
+  }
+  if !wd.is_dir() {
+      return Err(format!("working_dir_not_a_directory: {working_dir}"));
+  }
   cmd.cwd(&working_dir);
   shell::configure_shell_command(&mut cmd, &shell_path);
   let child = pair.slave.spawn_command(cmd)
-      .map_err(|e| format!("Failed to spawn shell: {e}"))?;
+      .map_err(|e| format!("spawn_failed: shell={shell_path} cwd={working_dir}: {e}"))?;
```

**向后兼容**：成功路径不变；失败时返回**结构化错误码前缀**（`working_dir_not_found:` 等），前端可据此给友好提示。需同步前端错误展示映射（移动端 `spawn_result`/`activate_result` 已有 `error_code` 字段，桌面 createCard 错误路径需消费新前缀——列为本 FIX 子任务）。

**测试**：`pty/mod.rs` 单测覆盖 空/不存在/非目录/正常 四类；移动端 spawn 失败提示文案回归。

**回滚**：函数内还原。

---

## 阶段三：渲染与资源生命周期重构

### FIX-7 ｜问题四｜隐藏卡常驻 → LRU 上限 + lazy re-attach

**严重度**：High（多会话场景内存/CPU 随访问数恶化）
**根因锚点**

- `src/components/terminal/TerminalManager.tsx:793-825`：所有 `mountedIdsRef` 卡片持续渲染 `<TerminalView>`，仅 `visibility:hidden`；`:382-395` 仅删卡时清理，无 LRU/上限。
- `Shell.jsx`：隐藏态 `pty.onOutput`/sequencer 仍订阅（`:333-349`），xterm 实例/scrollback/DOM/listener 不释放（paint 被 `:304 meta.render` 门控）。

**风险下调依据（关键）**：「卸载-重连恢复」基础设施**已完整存在**：`Shell.jsx:252 connectPty` → `:285 pty.create`（`pty/mod.rs:75-78`：registry 已存在则复用同一 PTY，不重启进程）→ `:368 pty.attachSnapshot` 恢复完整屏幕 + history。因此本项**不需要新建恢复机制**，只需让 TerminalView 可被卸载、并在重聚焦时复用既有 connect 路径。

**改动规格（分步，每步可独立验证）**

1. **引入上限常量**（`TerminalManager.tsx`）：`const MAX_MOUNTED_HIDDEN = 3;`（聚焦卡 + overlay/float 必需卡不计入淘汰）。
2. **mountedIdsRef 升级为 LRU**：维护访问顺序（`Map<id, lastTouched>` 或有序数组）。`mountCardInBackground`/聚焦时 `touch(id)`。
3. **淘汰逻辑**（新增 effect，依赖 focusedCardId / mounted 集合变化）：
   - 计算「可淘汰集」= mounted − {focusedCardId} − {overlay/float 引用的卡}。
   - 若 `可淘汰集.size > MAX_MOUNTED_HIDDEN`，按 LRU 淘汰最旧者：从 `mountedIdsRef` 移除 → 触发其 `<TerminalView>` 卸载（render 列表已按 `:795 .filter(has(id))` 渲染，移除即卸载）。
   - **PTY 不 kill**（后端仍 live），仅卸载前端渲染栈。
4. **重聚焦恢复**：用户再次聚焦被淘汰卡 → `mountCardInBackground` 重新加入 → `<TerminalView>`/`Shell` 重新挂载 → `connectPty` 走 `pty.create`(复用) + `attachSnapshot`（既有路径，无需改）。
5. **Shell 隐藏态降载（可选增强）**：隐藏卡（`active=false`）确认 `meta.render=false` 已跳过 paint；评估是否进一步在隐藏超过阈值时主动 `disconnectFromShell()`（`Shell.jsx:420`）以释放 listener，重聚焦时 reconnect——作为 4 的兜底，按测得收益决定是否纳入。

**向后兼容 / 行为变化**：被淘汰卡重聚焦时有一次 `attachSnapshot` 恢复（与现有「重连」体验一致，已被现网验证路径）。聚焦卡、overlay/float 卡体验完全不变。

**风险**：中。主要风险=re-attach 时序抖动 / 滚动位置跳变。缓解：复用现有 `outputSequencer.applySnapshot`（`Shell.jsx:368-388`）路径，不另写恢复；LRU 上限设为 3 起步，可经压测调参。

**测试用例**

1. 单测：mock cards，连续访问 8 卡 → 断言 `mountedIdsRef` 大小 ≤ `MAX_MOUNTED_HIDDEN + 聚焦+overlay`；最旧卡被移出。
2. 压测脚本（进 CI 基线）：打开 10 个 busy session 依次访问后回 grid，记录 `document.querySelectorAll('.xterm').length`、JS heap、DOM 节点、CPU；断言均被上限钳制（修复前线性增长 → 修复后有界）。
3. 功能回归：被淘汰卡重聚焦后内容完整恢复（attachSnapshot 生效），无内容丢失/重复。
4. overlay/float 引用的卡**不被**淘汰（防止正在浮窗显示的卡被卸载）。

**验证方法**：多卡压测对比 heap/`.xterm` 计数曲线；功能手测淘汰-重入。

**回滚**：LRU 逻辑集中在 TerminalManager，移除淘汰 effect + 还原 `mountedIdsRef` 即恢复原「全常驻」行为。

---

### FIX-8 ｜问题五｜移动端 transcript 全局数组 → per-card 重构

**严重度**：Medium（长会话体验线性退化；非无界泄漏）
**根因锚点**

- `mobile-app/src/terminalTranscript.ts:15-16`：每条消息对全数组 `filter`×2 重建（O(N)/msg）。
- `mobile-app/src/MainTerminal.tsx:320-365`：每次 `messages` 变更 `for...of` 遍历全部（O(N)/render）。
- `mobile-app/src/App.tsx:88,113-114`：`terminalMessages` 仅 `terminal_output|terminal_snapshot` 更新，**无 `card_removed`/`close_result` 裁剪**（已删卡桶残留）。
- 有 `MAX_MESSAGES_PER_CARD=2000` 单卡上限（`terminalTranscript.ts:8`）。

**改动规格（分步）**

1. **数据结构改 per-card**（`terminalTranscript.ts`）：以 `Map<cardId, CardTranscript>` 替代全局 `ServerMessage[]`，每卡内部维护「latestSnapshot + 有界 ring buffer of terminal_output」。`appendTerminalMessage(map, message)` 只操作目标卡桶（O(1)~O(单卡上限)，不再扫全局）。保留 `MAX_MESSAGES_PER_CARD` 语义与既有 snapshot/seq 裁剪规则（迁移现有逻辑，不改协议语义）。
2. **新增显式回收 API**：`dropCardTranscript(map, cardId)`。
3. **App.tsx 接线**：`card_removed` / `close_result`（`ok && card_id`）分支调用 `dropCardTranscript`；`select-card` 切卡时无需删（保留以便返回），仅依赖 per-card 上限控制总量。
4. **MainTerminal.tsx 改增量消费**：从「遍历整个 `messages` prop」改为「只读当前 `activeCardId` 桶的、未应用过的增量」（沿用现有 `lastAppliedOutputSeqRef`/`appliedSnapshotSeqRef` seq 守卫，逻辑不变，只是数据源从全局过滤改为按卡直取）。
5. **prop 形态变化**：`App.tsx:292,313` 传入 `messages` 的两处消费组件改为按 `activeCardId` 取桶（提供 selector，如 `getCardTranscript(map, activeCardId)`）。

**向后兼容**：协议与消息语义不变；snapshot/seq 去重规则迁移自原 `terminalTranscript.ts`（行为等价）。仅前端内部数据结构与组件 prop 形态变化。

**风险**：中。主要风险=seq/snapshot 去重规则迁移出错导致历史丢失或重复。缓解：保留并扩展现有 `mobile-app/src/terminalTranscript.test.ts`，先以现网用例做等价性回归（重构前后对同一消息序列产出一致的「当前卡可见 transcript」），再切换数据结构。

**测试用例**

1. 等价性回归：对一组真实消息序列，重构前后 `当前卡 transcript` 逐字节一致（含 snapshot 重置、seq 乱序、跨卡交错）。
2. 回收：`card_removed`/`close_result` 后该卡桶被删；后续新消息的 append 复杂度不再受已删卡影响。
3. 内存基线（进 CI）：100 次「创建→输出→关闭」循环，每 20 次取 heap snapshot，断言 transcript 对象数不随循环次数线性增长。
4. MainTerminal 增量：切卡/返回再进入只消费当前卡增量，断言不重放他卡。

**验证方法**：`npm test -- terminalTranscript messages`；移动端长连接 + 多卡来回切，detail 首帧耗时与 heap 斜率对比修复前。

**回滚**：`terminalTranscript.ts` + 两处 prop 接线集中，按提交粒度 revert。

---

## 附录 A：开放问题 — 单实例防护（建议，非阻塞）

**现状**：全仓无 `single-instance` 相关代码；`src-tauri/Cargo.toml:21-47` 无 `tauri-plugin-single-instance`；`bridge/mod.rs:358 already_running` 仅 bridge 端口占用检查，非应用级。多实例并行启动在 bridge 端口 / 全局热键注册（`hotkey.rs`）/ 状态目录上无防护。

**建议**：引入 `tauri-plugin-single-instance`，第二实例聚焦已运行实例并退出。**列为独立技术债任务，不阻塞阶段一~三**（与缺陷修复正交，且需单独的多实例 UX 决策：是聚焦已有实例还是允许多开+隔离 profile）。

---

## 横切：回归测试基线与验收门禁

**可挂点的协议级指标**（建议做成压测脚本 + CI 阈值断言）：

| 指标 | 挂点 | 修复前→后预期 |
|---|---|---|
| `localStorage.setItem`/s | FIX-3 throttled adapter 计数 | 持续输出下从「每 chunk」→「≤2/s」 |
| 全量 `JSON.stringify(cards)` 耗时/s | persist 序列化 | 显著下降 |
| WS `TerminalSnapshot` 条数/s | bridge broadcast 计数 | 仅连接/恢复时出现（非持续） |
| WS `Snapshot` 条数/s | 同上 | 受 100ms debounce 钳制 |
| 页面 `.xterm` 实例数 / JS heap | FIX-7 压测 | 由线性增长 → 有界 |
| 移动端 transcript 对象数 | FIX-8 内存基线 | 100 循环不线性增长 |
| `messages.ts` exit 语义 | 单测 | `exit(null)`⇒`idle` |

**统一压测场景（采纳二次诊断「最有价值一条」并指标化）**：桌面 3 持续输出 session + 移动端连接 + 切后台再回 + 删除其一 + 再激活另一 attachable session；同时采集上表全部指标，作为发布回归基线。

**阶段验收门禁**：

- 阶段一合入条件：FIX-1/2/3 单测全绿 + 压测场景下 4 项 bridge/storage 指标达标 + 桌面/移动端 `exit(null)` 一致。
- 阶段二合入条件：Windows 11 + Linux(X11/Wayland) 真机手测矩阵通过；macOS overlay 全回归无差异。
- 阶段三合入条件：多卡压测 heap/`.xterm` 有界 + transcript 等价性回归逐字节一致 + 100 循环内存基线达标。

---

## 任务清单（可勾选）

- [ ] FIX-1 messages.ts `exit(null)→idle` + 3 单测（messages.test.ts）
- [ ] FIX-2 删 `bridge/mod.rs:143` + bridge 集成测试（snapshot 计数）
- [ ] FIX-3 throttled localStorage adapter + 单测 + 压测阈值
- [ ] FIX-4 commands.rs/platform.rs 非 macOS show+unminimize+set_focus + always-on-top 泄漏处理 + 真机矩阵
- [ ] FIX-5 default_shell 优先级（SHELL/pwsh/powershell/COMSPEC/cmd）+ 单测 + Win 真机
- [ ] FIX-6 pty_create working_dir 校验 + 结构化错误码 + 前端错误映射
- [ ] FIX-7 mountedIdsRef LRU + 上限 + 淘汰 effect + 压测基线
- [ ] FIX-8 terminalTranscript per-card Map/ring + App card_removed/close_result 回收 + MainTerminal 增量 + 等价性回归
- [ ] 横切：压测脚本 + CI 指标阈值接入
- [ ] 附录A（可选）：tauri-plugin-single-instance 技术债任务立项

---

*本计划基于 `e3c31a1` 行级实证编制。每个 FIX 的 diff 为规格示意，落地时以对应文件当前内容为准，并先跑既有测试基线再改。问题三 Windows/Linux、FIX-5/6 的真机行为以目标平台验证为最终判定。*

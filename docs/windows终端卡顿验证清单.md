# Windows 终端卡顿 — 真机验证清单

> 目的:在投入"自建原生终端"之前,用低成本验证把卡顿来源分成两类——
> **(a) 可修的实现问题**(软渲染 / 一次性灌入 / scrollback 过大 / 实时输出管线)与
> **(b) WebView 渲染天花板**(xterm.js 跑在 WebView2 里的结构性上限)。
> 只有确认 (a) 已排除、仍明显劣于原生,才值得上原生方案。

---

## 0. 环境前提(先读,否则结论会失真)

验证目标是 **GPU 渲染流畅度 / 硬件加速 / 滚动掉帧**,这些在无 GPU 或远程环境下必然失真:

| 环境 | 能否用 | 原因 |
|------|--------|------|
| 本地物理 Windows 机 + 物理显示器 | ✅ 唯一可信 | 真实 GPU + 真实合成 + 真实刷新率 |
| GitHub Actions Windows runner | ❌ | 无 GPU,WebGL 必然 fallback 软渲染 |
| GitHub Codespaces | ❌ | Linux 容器,无 WebView2 |
| 远程桌面(RDP) | ❌ | RDP 降级/改变渲染合成路径 |
| 普通虚拟机 | ❌ | 通常无 GPU 直通,软渲染 |

**开始前记录(均为非隐私的环境参数):**

- [ ] Windows 版本(`winver`)
- [ ] 显卡型号(任务管理器 → 性能 → GPU)
- [ ] WebView2 Runtime 版本(设置 → 应用 → Microsoft Edge WebView2)
- [ ] 显示器刷新率与缩放比例(显示设置,如 60Hz / 150%)

---

## 1. 准备

- [ ] 同机安装 **Windows Terminal**,作为"丝滑基线"对照(同样的滚动操作目测对比)
- [ ] 准备一个**历史很多**的会话(如 `codex resume`、或一段长日志输出后的会话)
- [ ] 用 `npm run tauri:dev` 启动(dev 模式可开 DevTools)
- [ ] 打开 DevTools:在终端区域右键 → Inspect,或快捷键 `F12` / `Ctrl+Shift+I`

---

## 2. 检查项

> 每项统一格式:**目的 / 操作 / 记录 / 判定 / 结论指向**。

### 检查 A — WebGL 是否硬件加速 【最关键开关】

- **目的**:区分"软渲染(可修)"与"WebView 天花板"。这是整份清单的分水岭。
- **操作**:DevTools Console 执行:
  ```js
  const gl = document.createElement('canvas').getContext('webgl');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  console.log(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
  ```
- **辅助验证**:任务管理器 → 进程/性能,找 `msedgewebview2.exe`;**滚动终端时**观察其 GPU 引擎占用。
- **记录**:renderer 字符串原文 / 滚动时 GPU 占用 % / CPU 占用 %。
- **判定**:
  - 含真实 GPU 名(如 `ANGLE (NVIDIA ... Direct3D11)`)且滚动时 GPU 有占用 → **硬件加速 ✅**
  - 含 `SwiftShader` / `Software` / `Microsoft Basic Render` / `ANGLE (... software)`,或滚动时 GPU≈0% 而单核 CPU 飙满 → **软渲染 ❌**
- **结论指向**:
  - 软渲染 → **头号真凶,优先修**(排查显卡驱动、WebView2 GPU 开关 / Chromium 启动参数),大概率无需上原生。
  - 硬件加速 → 继续 B/C/D 判断是否仍卡。

### 检查 B — 纯滚动流畅度(隔离变量)

- **目的**:只测渲染滚动,排除实时输出干扰。对应你说的"上下滑动看历史卡顿"。
- **操作**:加载满 scrollback 的历史会话,**不产生新输出**,用鼠标滚轮 + `PageUp`/`PageDown` 上下滚;
  DevTools → More tools → Rendering → 勾 **Frame Rendering Stats** 看实时 FPS;或 Performance 面板录制 5 秒滚动。
- **记录**:平均 FPS / 最低 FPS / 是否有 >50ms 长任务。
- **判定**:≥55 流畅 / 30–55 可感卡顿 / <30 明显卡。
- **对照**:同样操作在 Windows Terminal 里目测是否丝滑。
- **结论指向**:A=硬件加速但此处仍 <30,且明显劣于 Windows Terminal → 偏向**天花板**,记录差距幅度。

### 检查 C — 重启旧会话恢复峰值(一次性 write)

- **目的**:验证历史一次性灌入 xterm 的卡顿峰值。对应你说的"重启旧会话卡顿"。
- **代码位置(只读,定位用)**:`src/components/Shell.jsx` 的 `applySnapshot` 路径 —— `history + data` 一次性 `term.write`。
- **操作**:Performance 面板开始录制 → 触发重启 / 恢复旧会话 → 录到终端可交互为止。
- **记录**:从触发到首次可滚动/可输入的耗时(ms)/ 最长单帧(ms)。
- **判定**:<300ms 可接受 / 300ms–1s 可感 / >1s 明显卡。
- **结论指向**:峰值集中在一次大 write → **可修**(分帧 / 分批灌入),非天花板。

### 检查 D — scrollback 大小影响

- **目的**:确认 `scrollback` 是否是滚动成本来源。
- **代码位置**:`src/components/Shell.jsx` 中 `scrollback: 3000`。
- **操作**:临时改为 `1000`,重跑检查 B。
- **判定**:若 1000 明显更顺 → scrollback 是因素之一,可在"可回看历史长度"与"流畅度"间权衡。
- **结论指向**:**可修项**。

### 检查 E(可选)— 实时输出叠加(边输出边用)

- **目的**:针对"大量输出时"卡顿。对应后端逐 chunk 全局事件广播、每 chunk 全屏快照序列化、每个活跃卡片一个 headless 仿真。
- **代码位置(只读)**:后端 `src-tauri/src/pty/events.rs`(逐 ~8KB chunk emit `pty-output`;每 chunk 调 `terminal_output_snapshot` 全屏序列化);前端 `src/components/terminal/TerminalEventBridge.tsx`(每卡 `feedHeadless` 仿真)。
- **操作**:跑持续大日志输出,同时尝试滚动;Performance 录制看 JS / IPC 是否抢主线程;再多开几个有输出的卡片,看是否叠加恶化。
- **记录**:单卡 vs 多卡输出时的 FPS / CPU。
- **结论指向**:多卡显著恶化 → **实现层问题(IPC / headless),与 renderer 无关**,单独优化即可。

---

## 3. 结果汇总

| 检查项 | 结果 / 数值 | 判定 | 指向 |
|--------|-------------|------|------|
| A 硬件加速 | | 硬件 / 软渲染 | 修 GPU / 继续 |
| B 纯滚动 FPS | | 流畅 / 可感 / 明显卡 | 天花板? |
| C 重启恢复耗时 | | | 可修(分帧) |
| D scrollback 影响 | | | 可修 |
| E 实时输出叠加 | | | 可修(IPC/headless) |

---

## 4. 决策树

```
检查 A 软渲染?
├─ 是 → 先修 GPU 硬件加速 → 回到 B 复测 → 多半解决,无需上原生
└─ 否(硬件加速)
   └─ C/D/E 中存在可修项主导卡顿?
      ├─ 是 → 修这些(分帧 write / 降 scrollback / 优化 IPC 与 headless)→ 复测 → 多半解决
      └─ 否(都已优化,纯滚动仍明显劣于 Windows Terminal)
         └─ 确认为 WebView 渲染天花板 → 评估上原生:
            · 优先"浮窗 / 当前激活卡片"用 native,卡片网格保留 snapshot 预览
            · 先做"宿主 spike"(native child host 能否挂进 Tauri 窗口、跟随布局 resize、拿到焦点)
            · 宿主 spike 不过线就不碰渲染
```

**核心原则**:在 A 未排除软渲染、C/D/E 可修项未修复之前,**不要启动原生终端重写**——
这一步几乎零成本,却可能直接省掉一次以"人月"计的重写。

---

## 5. 本次核查记录(2026-06-22 / Windows 11)

### 5.1 用户现象

- Chat 模式打开后停留在"正在连接 Codex app-server..."，约 10 秒才进入可用状态。
- 终端模式执行 `codex resume ... --no-alt-screen` 后，约 5 秒才开始出现信息流。
- 恢复历史或信息流从上向下滚动时明显卡顿，体感为约 6-8 行一卡。
- 问题在 Windows 11 上明显，macOS 端未感受到同等慢。

### 5.2 当前环境记录

| 项目 | 本次记录 |
|------|----------|
| Windows 版本 | Microsoft Windows 11 家庭版 中文版，10.0.26200，64 位 |
| GPU | Intel(R) Graphics |
| GPU 驱动 | 32.0.101.8425 |
| 显示器 | 3840x2160 / 60Hz |
| WebView2 Runtime | ThreadTerm 进程使用 `149.0.4022.80` |
| WebView2 进程 | ThreadTerm 存在 `--type=gpu-process`，renderer 进程带 `--device-scale-factor=1.75`、`--num-raster-threads=4` |
| WebGL renderer 字符串 | WebView2 页面内 renderer 未直接取得；本机 Edge / Chromium 代理核验为 Intel Direct3D11，详见 5.6 |

### 5.3 Chat 连接慢核查结果

| 核查项 | 结果 | 判定 |
|--------|------|------|
| `codex app-server --stdio` 初始化 | 本机探针约 135-238ms 返回 initialize | app-server 进程启动本身不是 10 秒慢点 |
| `thread/list` | 本机探针约 100ms | 列表查询不是主慢点 |
| `thread/start` | 本机探针在 ThreadTerm cwd 约 7.6s，在 cdispatching 项目 cwd 约 12s | Chat 打开慢主要落在新建 thread / 项目上下文加载 |
| 前端等待点 | `CodexChatView` 当前等待 `codexApp.openCard()` 完成后才 ready | UI 把"连接 app-server"和"创建/恢复 thread"绑在一起 |
| 后端等待点 | `codex_app_open_card` 当前会同步 `resume_thread` / `latest_thread_for_cwd` / `thread/start` | 长耗时请求阻塞 Chat 打开体验 |

**结论**:Chat 慢不是 Windows 无法使用 Chat，也不是 app-server 初始化慢；当前实现把 `thread/start` 的 7-12 秒耗时放在打开窗口路径里，导致用户看到长时间 Connecting。修复指向是拆开"app-server 已连接"与"thread 已创建/恢复"，让 Chat UI 先 ready，thread 在后台或首次发送时创建。

### 5.4 终端卡顿核查结果

| 检查项 | 结果 / 事实 | 判定 | 指向 |
|--------|-------------|------|------|
| PTY 实现 | `src-tauri/src/pty/mod.rs` 使用 `portable_pty::NativePtySystem::default()`、`openpty()`、`spawn_command()` | Windows 下已走 native PTY / ConPTY 族路径 | 不是"没用 Windows PTY"导致 |
| PTY 创建耗时 | 日志显示 PTY session created 很快完成 | `pty_create` 本身不是 5 秒等待来源 | 首输出等待更像 Codex CLI resume / MCP / 项目上下文启动 |
| 恢复历史写入 | `Shell.jsx` 在 attach snapshot 后把 `history + data` 一次性 `term.write` | 一次性大 write 是可修项 | 对应检查 C，建议分帧/分批灌入 |
| scrollback | xterm 配置 `scrollback: 3000` | 大 scrollback 会放大 Windows WebView2 滚动成本 | 对应检查 D，需要复测 1000/1500 对比 |
| 实时输出链路 | 每个 PTY chunk 同时进入可见 xterm、headless xterm preview、Rust snapshot/preview broadcast | 6-8 行一卡更符合实时输出管线叠加 | 对应检查 E，建议节流/合并 |
| 全屏刷新 | 可见终端对包含 `\r` 或 cleanup 序列的 chunk 会调度 `term.refresh(0, rows - 1)` | 高频刷新可能造成主线程和渲染抖动 | 可修，建议按帧合并 |
| 硬件加速 | 已看到 ThreadTerm WebView2 GPU process；但未取得 WebGL renderer 字符串 | 不能最终排除 SwiftShader / software fallback | 需补检查 A |

**结论**:终端首输出慢和滚动卡顿不是同一个点。首输出慢更像 Codex CLI resume 阶段加载项目/MCP/上下文；恢复后滚动和信息流卡顿更像 xterm/WebView2 输出链路负载过高。当前证据不足以直接判定为 WebView 渲染天花板，也不足以支持立即重写原生终端；应先落地 C/D/E 的可修项并补齐 A 的 WebGL renderer 验证。

### 5.5 本次未完成项

- 未从 ThreadTerm WebView2 页面内读取 `UNMASKED_RENDERER_WEBGL`，因此检查 A 对 WebView2 仍未完全闭环。
- 未录制 Performance 面板 FPS / long task 数据，因此检查 B/C/E 仍缺量化 FPS 与长任务耗时。
- 未临时调低 `scrollback` 做 A/B 对照，因此检查 D 仍缺对比结论。

### 5.6 补充核验(2026-06-22)

| 核验项 | 结果 | 判定 |
|--------|------|------|
| CDP 端口 | 当前 ThreadTerm WebView2 未开放 `9222/9223`，进程命令行无 `remote-debugging-port` | 不能直接用 CDP 读取页面内 WebGL / Performance |
| WebView2 调试参数来源 | 本项目使用的 `wry-0.54.4` 只从 Tauri `additionalBrowserArgs` 配置设置 WebView2 参数，未发现读取 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | 不改配置/代码时，无法通过环境变量临时打开 CDP |
| Edge 代理 WebGL | `ANGLE (Intel, Intel(R) Graphics (0x00007DD1) Direct3D11 vs_5_0 ps_5_0, D3D11)` | 本机 Chromium/ANGLE 路径不是 SwiftShader |
| Playwright Chromium 代理 WebGL | `ANGLE (Intel, Intel(R) Graphics (0x00007DD1) Direct3D11 vs_5_0 ps_5_0, D3D11)` | 本机 GPU/驱动具备硬件 WebGL 能力 |

**补充结论**:当前证据显示这台 Windows 11 机器的 Chromium/ANGLE 能走 Intel Direct3D11，软渲染概率降低；但 ThreadTerm 的 WebView2 页面内 renderer 仍未直接取得。若要完全闭环检查 A，需要临时在 Tauri 配置或窗口构建处加 `--remote-debugging-port=9222` 后重启，或手工打开 DevTools Console 执行 WebGL renderer 脚本。

---

## 6. Codex 二次核实执行说明（Windows）

本节用于把当前思路交给 Windows 环境中的 Codex 二次核实。默认以只读核查和临时 instrumentation
为主，不直接推进 TerminalControl / native rewrite。

### 6.1 二次核实原则

- 先补齐 W0 证据，再决定是否进入 W1。
- 不把 Chat 打开慢和 terminal renderer 卡顿混为一个问题。
- 不用 Edge / Playwright Chromium 的 WebGL renderer 结果替代 ThreadTerm WebView2 页面内结果。
- 临时改配置或代码只用于采集数据，完成后必须说明是否已还原。
- 结论必须落到三选一：继续 xterm 优化、补充 instrumentation 后复测、进入 W1 Native Host Spike。

### 6.2 给 Windows Codex 的提示词

```text
你在 Windows 11 物理机上的 ThreadTerm 仓库中做二次核实。请以只读核查为主，不要直接开始
TerminalControl / ConPTY native rewrite。目标是验证 W0.1-W0.6，并把结果更新到 docs 中。

背景：
- 当前分支目标是评估 Windows terminal 性能优化。
- 现有实现的 PTY 后端已经使用 portable_pty::NativePtySystem，Windows 下应走 ConPTY 族路径。
- 2026-06-22 核查显示：
  1. codex app-server --stdio initialize 约 135-238ms；
  2. thread/list 约 100ms；
  3. thread/start 在项目 cwd 下约 7.6-12s；
  4. Chat UI 当前等待 openCard 完成后才 ready，因此“正在连接”很可能包含 thread/start；
  5. 终端恢复历史时 Shell.jsx 会把 history + data 一次性写入 xterm；
  6. xterm scrollback 当前为 3000；
  7. 实时输出同时进入 visible xterm、headless preview、Rust snapshot/preview broadcast；
  8. ThreadTerm WebView2 页面内 UNMASKED_RENDERER_WEBGL 还没有直接取得。

请按以下顺序执行：

1. 记录环境和仓库状态：
   - Windows 版本、GPU、驱动、显示器刷新率、缩放比例、WebView2 Runtime 版本。
   - `git status --short`、当前 branch、当前 commit。
   - 如果有未提交文件，不要覆盖；只记录与本次核查相关的文件。

2. W0.1：直接确认 ThreadTerm WebView2 renderer。
   - 优先在 ThreadTerm DevTools Console 执行：
     const gl = document.createElement('canvas').getContext('webgl');
     const dbg = gl.getExtension('WEBGL_debug_renderer_info');
     console.log(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
   - 同时记录滚动终端时 msedgewebview2.exe 的 GPU/CPU 占用。
   - 如果 DevTools 无法打开，可以临时通过 Tauri additionalBrowserArgs 增加
     --remote-debugging-port=9222 做核查；核查后说明是否已还原。

3. W0.2：拆分 Codex Chat readiness。
   - 分别测量 codex app-server initialize、thread/list、thread/start。
   - 在 ThreadTerm Chat 模式中记录：
     app-server 可用时间、UI ready 时间、thread ready 时间、首条消息/事件出现时间。
   - 判断 Chat 慢是否应该通过“UI 先 ready，thread 后台创建/首次发送前等待”修复。

4. W0.3：验证 snapshot restore 一次性写入成本。
   - 只读定位 `src/components/Shell.jsx` 中 attach snapshot / applySnapshot 路径。
   - 用 Performance 录制旧会话恢复，记录 snapshot 数据长度、首次可输入/可滚动时间、
     最长 long task。
   - 如需临时 instrumentation，只加最小日志，完成后说明是否保留或还原。

5. W0.4：做 scrollback A/B。
   - 在同一历史会话下对比 scrollback 1000 / 1500 / 3000。
   - 记录纯滚动平均 FPS、最低 FPS、>50ms long task。
   - 测完恢复原值，除非另有明确决定。

6. W0.5：验证实时输出管线负载。
   - 核查 visible xterm、headless preview、Rust snapshot/preview broadcast、
     full refresh 是否在高频输出时叠加。
   - 记录单卡输出、多卡输出、暂停或节流 headless/preview 后的 FPS/CPU 对比。
   - 判断“6-8 行一卡”是 renderer 天花板，还是 IPC/headless/refresh 叠加。

7. W0.6：输出结论。
   - 更新 `docs/windows-terminal-baseline-report.md` 或新增同目录核查报告。
   - 必须给出三选一：
     A. 继续 xterm 优化；
     B. 补充 instrumentation 后复测；
     C. 进入 W1 Native Host Spike。
   - 只有在 ThreadTerm WebView2 已确认硬件加速、C/D/E 可修项已修复或证明不是主因、
     且至少 3 个高优先级场景仍明显劣于 Windows Terminal 时，才能选择 C。

请不要把 TerminalControl / ConPTY native rewrite 作为默认结论。先用数据证明当前 xterm/WebView2
路径已经排除可修项。
```

### 6.3 建议输出格式

| 项目 | 结果 | 证据位置 | 判定 |
|------|------|----------|------|
| W0.1 WebView2 renderer | | DevTools / CDP / 截图 / 日志 | 硬件 / 软渲染 / 未闭环 |
| W0.2 Chat readiness | | app-server / thread timing | UI 时序可修 / 仍不明 |
| W0.3 snapshot restore | | Performance trace / 日志 | 可修 / 非主因 |
| W0.4 scrollback A/B | | FPS / long task | 可修 / 非主因 |
| W0.5 realtime pipeline | | FPS / CPU / trace | 可修 / renderer 天花板 |
| W0.6 结论 | | baseline report | xterm 优化 / 复测 / W1 |

### 6.4 进入 W1 的硬条件

同时满足以下条件，才进入 Windows native host / TerminalControl spike：

- ThreadTerm WebView2 页面内 renderer 已直接确认是硬件加速，不是 SwiftShader / software fallback。
- snapshot restore、scrollback、实时输出管线这三类可修项已修复，或用数据证明不是主因。
- 同机 Windows Terminal 对照明显更顺，且至少 3 个高优先级场景仍不可接受。
- 已确认问题不主要来自 Codex CLI resume / MCP / 项目上下文启动。
- 已更新 baseline report，并明确记录进入 W1 的理由和剩余风险。

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

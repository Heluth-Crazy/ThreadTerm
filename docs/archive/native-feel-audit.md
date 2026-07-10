# ThreadTerm 桌面端原生手感审计（ship-readiness）

> 评估框架：`native-feel-cross-platform-desktop` skill（基于 Raycast 2.0 公开技术拆解 + 逆向验证）
> 审计对象：桌面端（Tauri 2 + React + Rust 核心，3 层架构）
> 审计基线：分支 `audit/desktop-native-feel` @ commit `4ec4b86`（2026-05-31）
> 方法：静态代码分析为主。标 ◯ 的项需真机运行才能确认，本审计不臆断为通过。

## 图例

- ✅ PASS — 已观察到正确实现
- ❌ FAIL — 缺失或不符合
- 🟡 PARTIAL — 部分到位 / 代码正确但未真机验证
- 🎯 有意取舍（deliberate divergence）— 明知与原生约定不同但保留品牌/产品选择
- ◯ 需真机 / N/A — 静态无法判定，或本项目不适用

---

## 总览评分

| 区块 | PASS | FAIL | 部分/取舍 | 需真机/NA |
|---|---|---|---|---|
| A 冷启动（10） | 3 | 1 | 2 | 4 |
| B 窗口与焦点（10） | 4 | 2 | 2 | 2 |
| C 输入与光标（10） | 3 | 1 | 2 | 4 |
| D 视觉与材质（10） | 6 | 0 | 2🎯 | 2 |
| E 滚动（5） | 3 | 0 | 0 | 2 |
| F 性能（10） | 0 | 0 | 1 | 9 |
| G 系统集成（10） | 4 | 5 | 0 | 1 |
| H 无障碍（5） | 0 | 0 | 1 | 4 |
| I 跨端一致（5） | 2 | 0 | 2 | 1 |

**一句话**：用户能用眼睛直接感知的「视觉/材质/输入/滚动/窗口」区块（B–E）已基本到位；缺口集中在**深层工程**（G 系统集成的自动更新/崩溃上报/URL scheme，F 性能与 H 无障碍未实测），以及两处**有意保留的品牌取舍**（系统字体、系统强调色）。

---

## A. 冷启动（10）

| # | 项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 1 | 热启动 <200ms / 冷 <600ms 出窗 | ◯ | `lib.rs:48` `prewarm_windows` 预热在位，未实测耗时 |
| 2 | 出内容前无白/黑闪 | 🟡 | 材质开启路径用前端 initial 属性避免首帧白闪；普通启动闪烁未专门处理，需真机 |
| 3 | 出现在正确屏幕/上次位置 | ✅ | `tauri-plugin-window-state`（SIZE\|POSITION\|MAXIMIZED），建议真机重启确认 |
| 4 | 初始焦点在最可能的输入控件 | ◯ | 需真机 |
| 5 | 正常启动无 loading 占位 | ◯ | 需真机 |
| 6 | Dock/任务栏图标正确 | ✅ | `tauri.conf.json` 配置 icns/ico/png 全套 |
| 7 | 托盘图标单色/跟随主题 | ◯ | 未引入系统托盘，N/A |
| 8 | 全局热键首启即可用 | ✅ | `lib.rs:47` `register_default_shortcuts` |
| 9 | 登录项/开机启动按需开启 | ❌ | 未引入 autostart 插件（非当前目标） |
| 10 | 退出即真退出，无僵尸进程 | ◯ | 有 supervisor + pty kill，需真机确认 |

## B. 窗口与焦点（10）

| # | 项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 11 | ⌘W / Ctrl-W 关窗 | ✅ | 主窗口 `decorations:true` 原生标题栏，走系统默认 |
| 12 | ⌘M / Win-Down 最小化 | ✅ | 同上，原生装饰 |
| 13 | 绿灯 zoom 而非全屏 | ◯ | Tauri 默认行为，需真机 |
| 14 | 点窗外关闭启动器（如设计如此） | ◯ | overlay 用 NonactivatingPanel，需真机 |
| 15 | 记忆尺寸与位置 | ✅ | `tauri-plugin-window-state`，`denylist+filter` 仅作用 `main` |
| 16 | 多屏：开在活动屏 | 🟡 | overlay 按工作区算几何；主窗口首启 center、之后恢复 |
| 17 | 全屏用原生全屏 | ◯ | N/A |
| 18 | 设置开在独立原生窗口 | ❌ | `Settings.jsx:63` 仍是 DOM 模态（`modal-backdrop fixed inset-0`） |
| 19 | 无 DOM 覆盖层假对话框 | ❌ | 设置 + workflow 系列对话框均为 DOM 覆盖层 |
| 20 | 失焦时启动器可预期地隐藏 | 🟡 | overlay 焦点行为已跨端补齐（`platform.rs`），需真机 |

## C. 输入与光标（10）

| # | 项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 21 | 行/按钮/标签无 `cursor:pointer` | ✅ | 全仓仅剩 `petAnimations.css:68`（宠物精灵，可点击/拖拽，语义成立） |
| 22 | 标签/标题/按钮文字禁止选中 | 🟡 | 未见全局 `user-select` 策略，chrome 文本可能可选 |
| 23 | 原生右键菜单 / 移除浏览器菜单 | ✅ | `nativeDesktop.ts` capture 阶段拦截，白名单放行 input/textarea/contenteditable/xterm |
| 24 | force-touch/长按无链接预览 | ◯ | 未显式禁 `-webkit-touch-callout`，影响小 |
| 25 | chrome 上无拼写红线 | 🟡 | 未全局关 spellcheck |
| 26 | 输入法（拼音/假名/谚文）正确 | ◯ | 需真机实测（WebView IME 常见坑） |
| 27 | 全键盘可达 | 🟡 | 有 KeyboardBridge / 命令面板，覆盖度需真机 |
| 28 | 焦点环平台风格 | ◯ | 自绘样式，需真机 |
| 29 | Escape 总有意义 | ✅ | 多处 Escape 处理（popover/设置/终端） |
| 30 | 列表 type-ahead 跳转 | ◯ | 未见明确实现，需真机 |

## D. 视觉与材质（10）

| # | 项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 31 | 窗口背景用平台材质 | ✅ | `platform_material.rs`：macOS vibrancy（UnderWindowBackground）/ Windows mica→acrylic，**默认开启** |
| 32 | 暗色跟随系统、切换不闪 | ✅ | `applyTheme.ts:45` `matchMedia('(prefers-color-scheme: dark)')`，闪烁需真机 |
| 33 | 强调色跟随系统 | 🎯 | `accent-color` 绑品牌 `--primary`（有意保留品牌） |
| 34 | chrome 用系统字体 | 🎯 | `index.css:184` 主字体 Inter/Geist（有意保留品牌） |
| 35 | 窗口阴影不用 CSS box-shadow | ✅ | overlay `.shadow(false)` + OS 阴影；主窗口原生 |
| 36 | 窗口圆角不用 CSS border-radius | ◯ | 主窗口原生装饰由 OS 画圆角 |
| 37 | 半透明：透出背后模糊 | ✅ | macOS 真机已验证（透明窗口 + vibrancy） |
| 38 | 无 `cursor:pointer`（重复项） | ✅ | 同 #21，仅宠物精灵 |
| 39 | 动画尊重 prefers-reduced-motion | ✅ | `index.css` 全局守卫 + 组件 `useReducedMotion` |
| 40 | 无页面切换/路由淡入 | 🟡 | framer-motion 仍有入场动画，已收敛为短 ease |

## E. 滚动（5）

| # | 项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 41 | macOS overlay 滚动条（淡出） | ✅ | 自绘滚动条用 `:where([data-platform=windows/linux/unknown])` 门控，mac 恢复原生 |
| 42 | Win11 细滚动条 | ✅ | `scrollbar-width:thin` 仅在 win/linux/unknown 生效 |
| 43 | 程序滚动无 `behavior:smooth` | ✅ | 全仓 0 处 |
| 44 | 滚动惯性原生 | ◯ | 需真机 |
| 45 | 同窗导航保留滚动位置 | ◯ | 需真机 |

## F. 性能（10）

| # | 项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 46 | 空闲常驻内存 <500MB | ◯ | Tauri 系统 WebView 基线有利，未实测 |
| 47 | 展开/收起结果无卡顿 | ◯ | 需真机 |
| 48 | 快速输入实时结果不掉帧 | ◯ | 需真机 |
| 49 | 隐藏/最小化时后台 CPU <0.5% | ◯ | 需真机 |
| 50 | 1 小时空闲电池影响“低” | ◯ | 需真机 |
| 51 | 隐藏窗口不被 WebKit 节流 | 🟡 | 未应用 skill reference 03 的两个 WKWebView 反节流 flag |
| 52 | 索引器不占满核心 | ◯ | 无重型索引器，N/A |
| 53 | 插件崩溃不拖垮 App | ◯ | 无第三方插件系统，N/A |
| 54 | 网络超时 10s 内反馈 | ◯ | bridge/http 路径，需真机 |
| 55 | >200ms 操作有 loading | ◯ | 需真机 |

## G. 系统集成（10）

| # | 项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 56 | URL scheme 全局可用 | ❌ | 未注册 deep-link |
| 57 | 文件关联可双击打开 | ❌ | 未配置 |
| 58 | 真实 file URL 拖放 | ❌ | 未见拖放处理 |
| 59 | 复制写入多种剪贴板类型 | ◯ | 大概率仅纯文本，需真机 |
| 60 | 原生保存对话框 | ✅ | `tauri-plugin-dialog` |
| 61 | 原生系统通知 | ✅ | `tauri-plugin-notification` + `notification.rs` |
| 62 | 真自动更新（非“去下新版”） | ❌ | 未引入 updater |
| 63 | 崩溃上报到真实平台 | ❌ | 未引入 Sentry/崩溃上报 |
| 64 | Windows 单实例 | ✅ | `tauri-plugin-single-instance`（二次启动聚焦 main） |
| 65 | Bundle/清单正确 | ✅ | identifier `com.Heluth-Crazy.threadterm`、version、全套图标 |

## H. 无障碍（5）

| # | 项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 66 | VoiceOver/Narrator 可导航 | ◯ | 需真机（部分 `role="dialog"` 已有） |
| 67 | 焦点移动时播报 | ◯ | 需真机 |
| 68 | 对比度达 WCAG AA | 🟡 | 材质开启后背景透明度下调，暗色文字对比度需复核 |
| 69 | 放大系统字号不破版 | ◯ | 可能存在固定 px，需真机 |
| 70 | 所有操作可纯键盘完成 | ◯ | 需真机 |

## I. 跨端一致（5）

| # | 项 | 判定 | 证据 / 说明 |
|---|---|---|---|
| 71 | mac/win 功能一致 | 🟡 | overlay 焦点已跨端补齐、材质双端默认开；**Windows 材质观感未真机验证** |
| 72 | 双端命中同一 IPC schema | ✅ | 单 Rust 核心，无双壳漂移 |
| 73 | 第三方扩展双端一致 | ◯ | 无扩展系统，N/A |
| 74 | 视觉差异符合各平台约定 | 🟡 | 材质各自采用本平台（vibrancy/mica），其余样式共用 |
| 75 | 修复可由单次改动传播双端 | ✅ | 单 Rust+React 代码库 |

---

## 按「感知收益」排序的剩余修复清单

> 依 T4（性能是感知属性）排序，不是按工作量。

1. **设置 / 对话框改真原生窗口或原生 sheet**（#18 #19）— 当前是网页弹窗，是最显眼的「web 味」残留之一，但改造较大。
2. **Windows 材质真机验证**（#71）— 安全回退已就位，只差实机看一眼观感。
3. **自动更新 + 崩溃上报**（#62 #63）— 偏健壮性，不影响「手感」但影响产品成熟度。
4. **隐藏窗口反节流 flag**（#51）— skill reference 03 的两个 WKWebView flag，低成本。
5. **chrome 文本禁选 / 关 spellcheck**（#22 #25）— 廉价的去 web 味。
6. **无障碍与对比度复核**（H 区 + #68）— 材质降透明度后尤其要复核暗色文字。
7. **URL scheme / 文件关联 / 文件拖放**（#56 #57 #58）— 系统集成深度，按需。

## 有意保留的取舍（非缺陷）

- **系统字体（#34）/ 系统强调色（#33）**：保留 Inter/Geist 与品牌 `--primary`，是产品/品牌选择，非遗漏。
- **`macOSPrivateApi: true`**：为 macOS 透明材质启用，代价是无法上架 Mac App Store；经 GitHub Release 分发，已确认接受。

## 材质开关（当前语义：默认开启）

- **默认：开。** 不设任何环境变量即在 macOS/Windows 启用平台材质。
- **手动关闭：** 启动前设 `THREADTERM_PLATFORM_MATERIAL=0`（或 `false/off/no`）；前端构建期可用 `VITE_THREADTERM_PLATFORM_MATERIAL=0`。禁用优先。
- **Linux/unknown：** no-op，运行时报告材质 disabled，CSS 维持不透明路径，不 panic。
- **Windows：** mica→acrylic→CSS 安全回退；native 全失败时 `MATERIAL_APPLIED=false`，退回当前观感。

## 已在本轮完成（对照）

平台材质（默认开）、右键菜单拦截、macOS 原生滚动条、动画 spring→ease + reduced-motion、窗口状态记忆、Windows 单实例、跨端 overlay 焦点、列表 cursor 清理。

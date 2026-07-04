# ThreadTerm 项目结构与性能审查报告

> 审查日期：2026-07-04
> 审查范围：`exp/windows-native-terminal-host` @ b4721b9 全仓库（前端 `src/`、后端 `src-tauri/`、`mobile-app/`、构建工具链、仓库卫生）
> 审查方法：主会话串行逐文件核查，全部结论附 file:line 证据；与 `docs/windows-lightweight-feasibility-report.md`（体积/内存专项）互补，本文聚焦**目录结构、代码结构、运行时性能效率**三个维度。

---

## 〇、总体评价

这个代码库的工程质量**高于典型同规模项目**，大量常见性能坑已经被此前的审计轮次修掉了。审查发现的问题集中在三类：**(1) 少数"上帝文件"超出项目自身的 800 行规范；(2) 前端渲染层的宽订阅 + 零 memo 组合；(3) 若干热路径上的 O(n) 小额税**。没有发现架构级错误。

**已经做对的部分**（后续优化不要破坏这些）：

| 领域 | 已有的正确实践 | 证据 |
|---|---|---|
| PTY 输出合帧 | 后端 16ms/64KB 合帧 + 200KB/20KB ack 流控 | `pty/events.rs`（COALESCE_*）、`session.rs:63-65` |
| 前端写入节流 | 每卡 100ms 合并写 store（审计 P0-2）、persist 500ms 节流（FIX-3） | `TerminalEventBridge.tsx:77-79`、`terminalStore.ts:1333-1334` |
| WebGL 上下文管理 | 最多 6 个常驻 TerminalView 的 LRU 驱逐，防 WebGL 上下文耗尽 | `mountedViewsLru.ts:1-24` |
| 预览提取 | 无头 xterm 读真实渲染行（~60KB/卡），替代了不可行的 ANSI-strip 方案 | `headlessPreview.ts:23,39-42` |
| Rust 正则 | WAITING/ERROR/ANSI_STRIP 全部 `once_cell::Lazy` 编译一次 | `pty/events.rs:19,39,55` |
| Rust 预览 | 快照+预览按间隔合并，仅状态变化强制刷新 | `pty/events.rs:634-637` |
| SQLite | r2d2 连接池 + WAL + busy_timeout=5000 + foreign_keys | `db.rs:7-18` |
| git 操作 | 全部子进程调用包在 `tokio::task::spawn_blocking`，不阻塞 runtime | `git.rs:690-724` |
| 协议共享 | mobile-app 经 `@shared` alias 复用桌面端协议类型，TS↔Rust 有契约测试守护 | `mobile-app/src/bridge/messages.ts:1`、`src/mobile/bridge/protocol.contract.test.ts:10-19` |
| bridge 空转 | 无订阅者时 broadcast 早退，bridge 未启用时零端口监听 | `bridge/mod.rs:515-517,533-535` |
| 后台任务 | supervisor 5s tick + 60s 冷却；provider_sessions 扫描带 2.5s TTL 缓存 | `supervisor.rs:37-41,394`、`provider_sessions.rs:10` |
| 窗口内存 | Windows overlay 懒创建 + lightweight mode；WebView2 同步命令死锁已规避（async 命令） | `overlay/window.rs:38-72`、`overlay/commands.rs:14-33` |

---

## 一、目录结构优化

### 1.1 前端 `src/`

**F1. 空目录残留（琐碎，立即可清）**
- 【问题】workflow 功能删除后留下两个空目录。
- 【证据】`src/components/workflows/`、`src/lib/workflows/` 均为空（git 不跟踪空目录，属工作区残留）。
- 【建议】`rmdir src/components/workflows src/lib/workflows`。代码内已无 workflow 残留引用——仅存的两处是**故意保留的回归测试**（`settingsBundle.test.ts:138` 验证旧 bundle 的 workflows 段被忽略、`tauriAiSessionExportCapabilities.test.ts:28` 验证 capability 无 http scope 残留），i18n 文案已清干净。

**F2. `src/components/` 根层平铺文件与子目录混放**
- 【问题】组件目录已按 feature 分子目录（codex/files/palette/settings/stats/terminal/ui/overlays），但根层还平铺着 4 个业务组件：`Shell.jsx`、`Settings.jsx`、`LanguageSelector.jsx`、`SettingsSyncBridge.tsx`。
- 【建议】`Shell.jsx` → `terminal/`（它是 TerminalView 的宿主，1233 行、被 terminal 域独占）；`Settings.jsx`、`SettingsSyncBridge.tsx`、`LanguageSelector.jsx` → `settings/`。顺带完成 TS 迁移（见 C4）。

**F3. `src/utils/` 只剩一个 16 行文件**
- 【问题】`src/utils/logger.ts`（16 行）是该目录唯一内容，与 `src/lib/`（34 个文件、职责相同的通用模块层）职责重叠。
- 【建议】把 `logger.ts` 挪进 `src/lib/`，删除 `src/utils/`，消除"lib 还是 utils"的决策成本。同理 `src/contexts/` 只有 `ThemeContext.jsx`（273 行）一个文件——可挪到 `src/theme/` 与 `applyTheme`、`themePacks` 同域。

**F4. `src/lib/` 平铺 34 个文件，域已可见但未分组（中期）**
- 【观察】`lib/` 已有 ai/、codexApp/、settings/、supervisor/ 四个子域目录，但根层还平铺约 20 个模块，其中 overlay 相关（`overlayPreferenceSync`）、settings 相关（`settingsSync`、`settingsWindow`）、卡片相关（`cardSearch`、`cardSort`）各自成簇。
- 【建议】非紧急。若继续增长，按簇归入 `lib/settings/`、`lib/cards/`；不要为分组而分组——每次移动都会制造 import 变更噪音，建议搭其他改动的车。

**F5. 依赖方向健康**
- 【核实】`src/windows/{float,selector,settings}` 三个副窗口入口单向依赖 `src/components`/`src/stores`，未发现反向依赖;`src/mobile/bridge/` 是桌面↔移动共享协议层（`protocol.ts` 159 行 + `wsClient.ts` 130 行），被 `mobile-app` 经 `@shared` alias 引用，方向清晰。无需调整。

### 1.2 Rust `src-tauri/src/`

**R1. 根层平铺 8 个大文件，`lib.rs` 依赖一张 69 项的注册表**
- 【问题】`git.rs`(1002)、`codex_app.rs`(864)、`supervisor.rs`(714)、`provider_sessions.rs`(513)、`files.rs`(440)、`platform_material.rs`(288)、`db.rs`(157) 全部平铺在根层；`lib.rs:77` 的 `invoke_handler` 一次性注册 69 个 command。pty/、overlay/、bridge/、stats/ 已是目录模块，平铺文件与之并存造成两套组织方式。
- 【建议】低成本方案：保持文件位置不动，只在每个文件内把 `#[tauri::command]` 函数聚到文件尾部统一区块，并在 `lib.rs` 里按域分行注册（git 类、files 类、stats 类…）加注释分节。中期方案：`git.rs` → `git/`（commands.rs + worktree.rs + diff.rs，1002 行里 status/diff/worktree/branch 四个域清晰可分）；`codex_app.rs`、`provider_sessions.rs`、`supervisor.rs` 归入 `ai/` 目录（三者都是 AI 会话域）。
- 【注意】每次模块移动都会打散 git blame,建议在功能改动间隙单独提交。

**R2. `bridge/mod.rs` 1669 行承担五种职责（最值得拆的 Rust 文件）**
- 【证据】职责块界线清楚：`BridgeRuntime` 状态与广播基础设施（:27-260）、启动恢复与 app handle（:261-301）、11 个 `#[tauri::command]`（:302-494）、broadcast_* 公开 API（:495-607）、CardMeta 富化 + 移动端预览提取启发式（:608-870+，含 AI composer 区域剥离、预览去重、噪声行判定等纯函数群）。
- 【建议】拆为 `bridge/runtime.rs`（BridgeRuntime + 持久化）、`bridge/commands.rs`、`bridge/broadcast.rs`、`bridge/preview.rs`（纯函数群，最易先拆——它们已有独立单测），`mod.rs` 只留 re-export 与常量。预览启发式是将来最常被调参的部分，独立成文件后回归测试的定位也更清晰。

**R3. `pty/`、`stats/`、`overlay/` 模块边界健康**
- 【核实】pty/ 五文件各司其职（mod=命令入口、session=状态与流控、events=读线程与合帧、emulator=快照、shell=spawn 环境）;stats/ 的 sync(783)/parse(668)/aggregate(538) 是"扫描→解析→聚合"流水线,`sync.rs:110` 的 `rebuild_now` 由命令触发而非后台常驻轮询。无需动。

**R4. 错误处理模式统一但原始**
- 【观察】119 处 `Result<_, String>`——Tauri command 的惯用形态，一致性好；生产代码 `unwrap()` 集中在测试模块内（如 `files.rs` 38 处 unwrap 中仅约 6 处位于 `mod tests`(:273) 之前），风险可控。
- 【建议】非紧急。若要提升,引入一个 `thiserror` 错误枚举 + `impl From<...> for String` 即可渐进迁移,不必一次性重写。

### 1.3 仓库根与 docs/

**H1. `IMPLEMENTATION_PLAN.md`（27KB，May 4）已过期**——项目自身的 CLAUDE.md 规范要求"所有阶段完成后删除该文件"。建议删除或归档进 `docs/plans/`。

**H2. `docs/` 混有 5 份 May 期的一次性研究报告**（`deep-research-report*.md` 4 份 + `ThreadTerm-Deep.md`,合计约 137KB）与现行文档混放。建议建 `docs/archive/` 归档,现行文档（windows 系列、native-feel-audit）留根层。

**H3. `.gitignore` 覆盖完整**（dist、src-tauri/target、mobile-app/dist、e2e-artifacts、.tmp 均已忽略,.DS_Store 未被跟踪）——无需修改。`src-tauri/target` 当前占 28GB,纯本地构建缓存,可随时 `cargo clean` 回收（不影响仓库）。

**H4. 4 个 HTML 入口平铺仓库根**（index/float/selector/settings.html）——Vite 多页应用的常规做法（`vite.config.js:38-43` 直接引用),移动会牵连 Tauri devUrl 路径,**不建议动**。

---

## 二、代码结构（超大文件拆分）

项目规范为单文件 <800 行（用户 CLAUDE.md）。现有 6 个显著超标文件，按拆分收益排序：

### C1. `src/stores/terminalStore.ts`（1420 行）——收益最高

- 【问题】单一 store 接口（:173-287+）承载 60+ action，横跨 7 个域：卡片 CRUD、输出/预览热路径、自动重启状态机、事件/未读、通知中心、置顶/最近浏览、项目/worktree 选择、焦点导航。任何域的改动都要进同一个 1420 行文件；类型推断与测试文件也随之膨胀。
- 【建议】用 zustand 官方 slice 模式拆分（保持**单 store 单 persist key 不变**，避免迁移用户数据）：`cardsSlice`（CRUD + 输出）、`autoRestartSlice`、`notificationsSlice`、`navigationSlice`（焦点/置顶/最近浏览）、`projectSlice`。`create()` 处组合。拆分是纯移动,不改行为,可先给 `partialize`（:1335-1360）补一个"持久化形状"快照测试再动手。
- 【注意】`updateCardOutput`/`updateCardReplyPreview` 热路径留在 cardsSlice,与 `throttledStorage.ts` 的注释引用（:7）同步更新。

### C2. `src/components/terminal/TerminalManager.tsx`（1522 行）

- 【问题】顶层组件混合了四类内容：① 12 个模块级纯函数（:95-215,其中 `cardToMobileMeta`/`toMobileStatus`/`summaryLineFromCard` 是移动端桥接映射,与 UI 无关）；② 右侧面板 surface 栈状态机（:293,:366-454）；③ workspace 内容状态（per-card file/diff tab,:294-298）；④ 布局/palette/移动端适配杂项状态（10+ 个 useState）。
- 【建议】三步拆：(a) :95-215 的纯函数移出——移动端映射三件套挪到 `src/mobile/bridge/cardMeta.ts`（与协议同域）,workspace tab id helpers 挪到 `components/files/`;(b) 右侧 surface 栈抽成 `useRightSurfaceStack()` hook（含 push/remove/resolve 纯函数,已有清晰边界）;(c) workspace content 状态抽成 `useWorkspaceContent()`。拆完主组件应能回到 ~600 行。

### C3. `src/components/codex/CodexChatView.tsx`（1370 行）与 `src/components/Shell.jsx`（1233 行）

- CodexChatView：会话事件流解析 + 消息渲染 + 输入区混合。建议把事件→视图模型的 normalize 逻辑下沉到已存在的 `src/lib/codexApp/normalize.ts`（307 行,同域）,渲染层拆 MessageList/Composer 两个子组件。
- Shell.jsx：PTY 连接状态机（connect/reconnect/detach 世代守卫,:306-360,:387-)、xterm 装配（addon/resize/fit）、auth URL 面板、退出横幅四块。**先做 C4 的 TS 迁移再拆**,否则拆分产生的新文件又是 .jsx。连接状态机可抽 `usePtyConnection()` hook——它已经通过 `connectGenerationRef` 世代计数做了自我隔离,边界现成。

### C4. TS 迁移残留（7 个文件）

- 【证据】`src/main.jsx`、`src/contexts/ThemeContext.jsx`、`src/components/{LanguageSelector,Shell,Settings}.jsx`、`src/i18n/{config,languages}.js`。
- 【建议】除 Shell.jsx 外都是小文件,机械迁移即可;Shell.jsx 是唯一"大 + 无类型 + 热路径"三重叠加的文件,类型化时最容易暴露隐藏 bug（如 `ptyIdRef`/`connectedPtyId` 的 string|null 流转）,值得优先。

### C5. `src/theme/themePacks.ts`（1409 行）——**可以不拆**

- 【核实】:63-1158 是 28 套主题经 `mode()`/`terminal()` 工厂构造的**纯静态数据**,逻辑仅占 ~60 行。数据即代码的声明式写法本身无害,拆成 28 个文件反而碎。
- 【可选】若要动,唯一有意义的方向是"每主题一个懒加载 chunk"减首屏——但每套主题只是几十个色值,全部打包也只有 ~50KB,**收益不值得复杂度**。维持现状,加注释标明"数据区勿加逻辑"即可。

### C6. `mobile-app/src/App.tsx`（1270 行）

- 【证据】单文件含 App 根组件 + 8 个 screen/组件函数（`PairingScreen`:381、`TerminalHome`:429、`InstancesScreen`:574、`SettingsScreen`:661、`TerminalDetail`:772、`ScannerScreen`:856、`IosHeader`:892、`SearchField`:901、`NewSessionForm`:916）。
- 【建议】机械拆分：`mobile-app/src/screens/` 一屏一文件,App.tsx 只留路由(tab)状态与 bridge 装配,~200 行。零逻辑改动。

### C7. 基建缺口：**整个仓库没有 ESLint**

- 【证据】无 `.eslintrc*`/`eslint.config.*`,package.json 无 eslint 依赖与 lint script;`npm run check` 链（typecheck+test+build:mobile+cargo check）也不含 lint。
- 【建议】补 `eslint.config.js`（flat config）+ `typescript-eslint` + `eslint-plugin-react-hooks`——**react-hooks/exhaustive-deps 规则对本项目尤其有价值**（大量手写 useEffect/useCallback 依赖数组,如 Shell.jsx、TerminalManager）。首次引入建议只开 error 级规则,存量告警用 `--max-warnings` 渐进收敛。Rust 侧顺带在 CI 加 `cargo clippy -- -D warnings`。

---

## 三、性能效率优化

### 3.1 前端热路径（PTY 输出到达时,每 100ms/卡 一次）

先明确现状链路：Rust 合帧(16ms/64KB) → `pty-output` 事件 → `TerminalEventBridge` 直写 xterm + 无头预览(每 chunk) → `outputBuffer` 100ms 合并 → `updateCardOutput`(store 写) → 订阅者重渲染。前两级已优化到位,**瓶颈在第三级的扇出**。

**P1.（影响：高）9 处宽订阅 `s.cards` × 终端组件零 `React.memo` = 每次 flush 全 UI 重渲染**
- 【证据】订阅整个 cards 数组的组件：`SessionDock.tsx:81`、`NotificationCenter.tsx:61`、`CardGrid.tsx:62`、`useProjectGroups.ts:54`、`TerminalManager.tsx:219`、`ProjectSidebar.tsx:69`、`SelectorApp.tsx:63,138`、`FloatApp.tsx:30`。同时 `grep React.memo src/components/terminal/*.tsx` 结果为零。`updateCardOutput`（`terminalStore.ts:748-761`）每次替换 cards 数组引用,并把目标卡的 `lastActivity` 置为 `Date.now()`——任何活跃会话都让这 9 个组件树以 10Hz 重渲染,其中 CardGrid 含 framer-motion 节点（`CardGrid.tsx:29`）、ProjectSidebar 764 行、TerminalManager 1522 行。多卡并行输出时该成本按卡数叠加。
- 【建议修法】两层,按性价比排序：
  1. **给卡片级子组件加 `React.memo`**（CardCompact、CardHeader、CardFooter、CardActions、SessionDock 的 item 等）：cards 数组引用变了,但未变化卡片的对象引用不变,memo 能精确跳过 N-1 张卡的重渲染。这是一行级改动、收益最大。注意配套检查父组件传下去的内联对象/回调 props（CardGrid.tsx:106-206 的 useCallback 已基本就位）。
  2. **窄化订阅**：`lastActivity` 每 flush 变化是多数订阅者不关心的字段。把"排序/分组用途"的订阅改为 `useShallow` 选择器（如 `useTerminalStore(useShallow(s => s.cards.map(c => c.id + c.status)))` 形态的投影）,或把 `lastActivity` 从 card 对象拆到独立的 `activityById: Record<string, number>` 状态域,让 cards 数组在纯输出场景下引用不变。后者是根治,但改动面大——先做 memo,量化后再决定。
- 【验证】React DevTools Profiler,单卡满速输出 10 秒,对比 commit 次数与耗时。

**P2.（影响：中）`updateCardOutput` 每次 flush 的固定成本**
- 【证据】`terminalStore.ts:748-761`：`findIndex` O(卡数) + `stripAnsi(chunk)` 正则 + `[...state.cards]` 全数组浅拷贝 + `tailJoin` 字符串拼接截断。每卡 10Hz、多卡叠加。
- 【建议修法】成本本身可接受（浅拷贝只是引用拷贝）,不必重写;唯一值得做的是 **`stripAnsi` 延迟化**——`lastOutput` 的消费方只有通知 snippet 兜底（`TerminalEventBridge.tsx:59-60` 注释）,可以存原始 chunk、在读取处（低频）再 strip。若做 P1-2 的 `activityById` 拆分,顺带把 `lastOutput` 也移出 card 对象,persist 的 `partialize`（:1335）就不再每 500ms 序列化所有卡的输出缓冲。
- 【注意】`partialize` 当前每次持久化都 map 全量 cards + archivedCards 并 JSON.stringify（含 lastOutput 字符串）——500ms 节流下这是 localStorage 的主要写放大来源。

**P3.（影响：中）i18n 四语言全量打进每个入口**
- 【证据】`src/i18n/config.js:6-25` 静态 import 4 语言 × 5 命名空间 = 20 个 JSON（原始 ~168KB,`du` locales 合计）,`main.jsx:10` 同步加载;float/selector/settings 入口同样经由共享模块背上全部语言。任何时刻只有 1 种语言在用。
- 【建议修法】i18next 惯用方案：保留当前语言同步(从 localStorage `userLanguage` 已可同步得知,config.js:27-40),其余语言改 `import()` 动态注册（自写 8 行 lazy backend 或用 `i18next-resources-to-backend`）。首屏 JS 估计省 ~120KB 原始/~30KB gzip,对 selector 这类要求"热键即现"的窗口最有意义。
- 【注意】切语言瞬间会有一次异步加载,需在 LanguageSelector 处 await 后再 `changeLanguage`。

**P4.（影响：中,仅编辑器用户）CodeMirror 静态驻留 main chunk**
- 已在可行性报告 B3 立项：`WorkspaceContentViews.tsx:21` → `WorkspaceCodeEditor.tsx:1-13` 静态 import codemirror 核心,main chunk 738KB（`dist/assets/main-CoB7Ohmc.js`）。改 `React.lazy(() => import('./WorkspaceCodeEditor'))` 单点生效,首屏 JS 约 -30%。语言包已是动态 import（`WorkspaceCodeEditor.tsx:404`）,无需再动。

**P5.（影响：低）manualChunks 仅两条,副窗口拖着不需要的代码**
- 【证据】`vite.config.js:45-48` 只拆了 vendor-react 与 vendor-xterm;`nativeDesktop-*.js`（239KB）被 4 入口共享是 Rollup 自动提取的结果。selector 入口本身很小（selector-*.js 462B + 共享 chunk）,现状可接受。
- 【建议】做完 P3/P4 后重新审视 chunk 图（`npx vite-bundle-visualizer`）再决定,不要盲目加 manualChunks——手动 chunk 配错会造成瀑布加载。优先级最低。

**P6.（核实,无需改）xterm 生命周期**：LRU 上限 6 个挂载视图（`mountedViewsLru.ts:24`）、隐藏卡跳过 fit（Shell.jsx resize observer 内 `visibility === 'hidden'` 早退）、被驱逐卡走 `attachSnapshot` 恢复——链路完整,不要在优化 P1 时误伤。

### 3.2 Rust 热路径

**P7.（影响：中）`trim_recent_output_buffer` 的两处 O(n)**
- 【证据】`pty/session.rs:166-178`：① `buffer.char_indices().map().find(...)` 从字符串**头部**线性扫描到 `target_start` 才找到裁剪点——只为找一个 UTF-8 边界,O(256KB) 次迭代;② `buffer.drain(..start)` 每次 flush 把剩余 256KB memmove 到头部。缓冲一旦写满,活跃会话每 100ms 付一次这两笔钱（调用点 `pty/events.rs:562-565` 每 flush 执行）。
- 【建议修法】① 边界查找改为从 `target_start` 起 `while !buffer.is_char_boundary(i) { i += 1 }`——O(≤3);② 加迟滞：仅当 `len > 2 × OUTPUT_BUFFER_MAX_BYTES` 时一次性裁回 cap,把 memmove 频率摊薄 256K 倍字节数。两处合计 ~10 行,行为不变（buffer 上限从"精确 256KB"变为"256~512KB",回放语义不受影响）。
- 【验证】现有 `session.rs` 单测覆盖 trim 语义;可用 `yes` 命令满速输出对比 CPU。

**P8.（影响：中,取决于会话数）wezterm-term 模拟器每原始 chunk 无条件 apply**
- 【证据】`pty/events.rs:314-318`：`snapshot.apply_output(&bytes)` 在合帧**之前**、对每个原始 read 执行,与 float/bridge 是否需要快照无关;每 session 常驻 grid + 3000 行 scrollback（`session.rs:50`）。
- 【判断】这就是可行性报告 C3"谨慎缓做"项——raw buffer 只有 256KB,长会话截断后追赶会导致状态错乱,这是当初引入模拟器的原因。**不要贸然懒激活**;正确的第一步是量化：内置的 profiling 计数器已在（`prof_apply`,events.rs:313-319）,把它随 stats 暴露出来,实测 apply 占比后再决策。
- 【替代小步】`TerminalSnapshot::new(rows, cols, scrollback_limit)` 的 scrollback 3000 行若仅服务快照回放,可评估降到 1000（内存 -2/3）——需先确认 float attach 的回放体验。

**P9.(影响:低-中,多窗口时) `pty-output` 全局 emit 广播**
- 【证据】`pty/events.rs:543-550` `app_handle.emit` 向所有 webview 序列化投递,前端按 id 过滤;可行性报告 C4 已裁决为"降级为 emit_to"。Windows 常态单 webview,收益仅在 float/selector 存活时显现。
- 【建议】保持 C4 结论:改 `emit_to(MAIN_LABEL, ...)` + float 存活时补投,~20 行。与本报告 P1 无耦合,可独立做。

**P10.（核实,无需改）其余后端热点均已达标**：db 连接池化+WAL（`db.rs:7-18`）、git 全量 spawn_blocking（`git.rs:690+`）、stats 同步命令触发非常驻（`stats/sync.rs:110`）、bridge 无订阅早退、supervisor 低频 tick。**没有发现 async 上下文里的同步 IO**。

### 3.3 启动路径

**P11.（影响：低）`main.jsx` 启动序基本干净**
- 【证据】`main.jsx:12-24`：installNativeDesktopBehavior + applySavedTheme 同步（必要,防主题闪烁）,service worker 清理已是异步。真正的首屏重量在 P3（i18n）与 P4（codemirror）,两项做完后 main chunk 预计 738KB → ~450KB。
- 【顺带】`getSavedLanguage` 的 try/catch 里 `console.error`（`i18n/config.js:39`）应换 `logger`,与项目自身规范一致。

---

## 四、优先级路线图

**P0（一次会话内可完成,先做——低风险高确定性）**

| # | 事项 | 改动量 | 预期效果 |
|---|---|---|---|
| 1 | F1 清空目录 + H1 删过期 IMPLEMENTATION_PLAN.md + H2 归档旧研究报告 | 纯删除/移动 | 仓库卫生 |
| 2 | P7 trim buffer 边界查找 + 迟滞裁剪 | ~10 行 Rust | 满速输出 CPU 降低,量化见 prof 计数器 |
| 3 | P1-1 终端卡片子组件加 React.memo | ~6 个组件各 1 行 | 活跃输出时 UI 重渲染从 O(全部) 降到 O(1) 卡 |
| 4 | P4 WorkspaceCodeEditor 改 React.lazy | 1 处 | main chunk -~290KB 原始 |

**P1（1-2 天级,做前先建量化基线）**

| # | 事项 | 前置 |
|---|---|---|
| 5 | C7 引入 ESLint（含 react-hooks 规则）+ CI clippy | 无 |
| 6 | P3 i18n 非活跃语言懒加载 | 无 |
| 7 | C4 七个 .jsx/.js 迁 TS（Shell.jsx 最后、单独 PR） | ESLint 先行 |
| 8 | C1 terminalStore slice 化 | partialize 快照测试先行 |
| 9 | P9 emit → emit_to 定向投递 | 无 |

**P2（结构性,搭功能改动的车渐进做）**

| # | 事项 |
|---|---|
| 10 | C2 TerminalManager 三步拆（纯函数外移 → surface hook → workspace hook） |
| 11 | R2 bridge/mod.rs 四分（preview.rs 先行） |
| 12 | C3 CodexChatView / Shell 拆分（Shell 依赖 #7 完成） |
| 13 | C6 mobile App.tsx 按 screen 拆分 |
| 14 | P1-2 lastActivity/lastOutput 移出 card 对象（先看 #3 的 Profiler 数据再决定） |
| 15 | R1 Rust 根层文件分组（git/ 与 ai/） |
| 16 | P8 模拟器成本量化（暴露 prof_apply 指标）→ 决策 C3 缓做项 |

**明确不做**：C5 themePacks 拆分（静态数据,拆了变碎）;H4 HTML 入口移动（牵连 Tauri 配置）;P5 手工 manualChunks（等 P3/P4 落地后看 bundle 图再说）;wezterm-term 懒激活(未量化前,见 P8)。

---

## 附录：本次审查未覆盖 / 交叉引用

- 安装包体积与 Windows 内存专项 → `docs/windows-lightweight-feasibility-report.md`（2026-07-04 复审版）,其 Next 1（外链回归验证）与 Next 2（Windows 基线）仍是全项目最高优先级的**验证**事项,先于本报告全部 P1。
- 测试基建现状良好（vitest + happy-dom,测试与源码同目录 co-located,约定一致;Playwright 双配置分桌面/移动 e2e),未发现需要动的点,故未开专节。
- 本报告全部行号基于 b4721b9;拆分类改动落地后行号会漂移,以符号名为准。

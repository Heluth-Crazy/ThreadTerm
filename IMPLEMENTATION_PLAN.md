# ThreadTerm 增量优化与新功能 v2 — Warp-Inspired Block Model

**起草日期:** 2026-04-30 （v1 失效，v2 为权威版本）
**适用版本基线:** v0.3.0
**总体方向:** 引入完整的 Warp 风格 **Command Block 模型**，把 ThreadTerm 从「会话管理器」推进到「块感知的会话工作台」。

## 设计原则

1. **不打破现有功能** — 所有改动以叠加为主；Block 层默认关闭，需 shell 集成才生效，未启用时行为与 v0.3 完全一致。
2. **小步快跑、阶段独立可发布** — 每个阶段独立可上线、可回滚，禁止跨阶段并发分支。
3. **不把 Warp 抄过来** — Warp 目前已有公开仓库，但 ThreadTerm 不移植其 Rust 自研 UI / GPU 渲染路线；我们只借鉴 **Command Block 模型 / OSC 133 协议 / Workflows YAML schema / 块级操作粒度**，渲染层继续用 `xterm.js`。
4. **每个阶段必须跑完 ROADMAP 验证基线** — `npm run typecheck` / `npx vitest run` / `npm run build` / `cargo check` / `cargo test`，并补齐当阶段新增模块的回归用例。
5. **不引入新运行时依赖** — 复用已有 React 18 + Tauri 2 + xterm + zustand + i18next + vitest + cargo 体系，除非该阶段说明里显式声明（少数 Rust crate 例外，比如 OSC 解析器）。

### Warp 参考边界

- Warp 官方当前说明：其 viewport 是 ordered list of typed blocks，而不是传统单一字符网格；ThreadTerm 只参考这个块模型与块级操作概念。
- Warp 早期工程路线采用 Rust 自研 UI framework + GPU rendering primitives；ThreadTerm 不复制这条路线，继续使用现有 Tauri + React + xterm.js 渲染器。
- Warp 公开仓库显示 client codebase 已开源，`warpui_core` / `warpui` 为 MIT，其余仓库代码为 AGPL v3；这只影响参考边界，不改变 ThreadTerm 技术栈。
- Warp Drive Workflows / YAML Workflows 可作为 Stage 7 schema 参考，但必须排在 Stage 6 之后实现，不能提前塞进 Stage 3。

参考链接：<https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment>、<https://dev.to/warpdotdev/how-warp-works-1ji7>、<https://github.com/warpdotdev/warp>、<https://docs.warp.dev/knowledge-and-collaboration/warp-drive/workflows>

---

## 阶段总览

| Stage | 主题 | 核心收益 | 风险 | 工作量 |
| --- | --- | --- | --- | --- |
| 1 | 代码健康度尾巴 | 完成 `TerminalCard.tsx` 拆分；为 Block 层落地腾出整洁起点 | 低 | 小 |
| 2 | Mobile Bridge 加固 | 在外部协议固化前补齐安全与版本字段 | 中 | 小 |
| 3 | Block Layer 基座 | OSC 133 解析 + 块数据模型 + 默认关闭的 opt-in 集成 | **高** | 大 |
| 4 | Block-aware 交互 | 折叠 / 复制 / 重跑 / 失败块跳转 / Block Inspector | 中 | 中 |
| 5 | 跨会话块搜索 + 命令面板 + 书签 | Cmd+F / Cmd+K / 块级书签 | 中 | 中 |
| 6 | AI Inline + 底部动作栏 | AI 直接对块发问；底部 chip 操作集中区 | 中 | 中 |
| 7 | Workflows（Warp schema 兼容） | 项目预设 / 一键命令 / 可导入社区 workflows | 低 | 小 |
| 8 | 数据 IO 与自动恢复 | 设置导入导出 / 自动重启 / AI 会话导出 | 中 | 中 |
| 9 | 体验长尾 | Token 面板 / AI 富预览 / DND / Linux 兼容矩阵 | 中 | 中 |

**依赖图**：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9（严格线性，禁止跨阶段并发）。
Stage 7 在数据上不依赖 Block 层，但工程顺序仍排在 Stage 6 之后，保证命令面板已经就位。

---

## Stage 1 · 代码健康度（收尾）

**已完成（v1 沿用）：**
- `src-tauri/src/pty.rs`（866 行）已拆为 `pty/{mod, session, registry, shell, events, tests}.rs`，所有外部签名 / 7 个原 `pty::tests` 100% 保留，`bridge/server.rs` 与 `lib.rs` 调用路径未变。
- `src-tauri/src/overlay.rs`（886 行）已拆为 `overlay/{mod, state, platform, window, hotkey, commands}.rs`；macOS NSPanel 宏定义集中在 `mod.rs`；新增 `__cmd__*` 宏 re-export 保证 `tauri::generate_handler!` 不需要改 `lib.rs` 路径。新增 5 个回归用例（registry 3 + state 2）全部通过。

**已完成（当前代码确认）：**
- `src/components/terminal/TerminalCard.tsx` 当前约 191 行，已降到 ≤ 200 行目标内，仅保留主容器布局与事件转发职责。
- `CardActions.tsx` 与 `CardActions.test.tsx` 已存在，覆盖 pin / unpin / copy-path / reveal / 关闭按钮点击行为。
- `CardStatusBadge.tsx` 与 `CardPreviewPanel.tsx` 已存在，继续复用 `statusMeta.tsx`、`headlessPreview.ts` 与 `cardPreview.ts`，未重写预览算法；组件文件避免与 `cardPreview.ts` 在 Windows 上发生大小写路径冲突。

**Success Criteria**
- 所有现有 props / store action / 父组件接入点 **签名完全不变**；
- 既有 vitest 用例（10 个文件 / 91 个 case）零改动通过；
- 新增 `CardActions.test.tsx`：pin / unpin / copy-path / reveal / 关闭按钮的点击行为单元测试（之前耦合在 `TerminalCard` 里测不到）。

**Verification**
```bash
npm run typecheck
npx vitest run
npm run build
cargo check  --manifest-path src-tauri/Cargo.toml
cargo test   --manifest-path src-tauri/Cargo.toml
```
+ 手动跑 `tauri dev`，验证浮动 / selector / 热键 / 通知点击回流路径未变。

**Status**: Complete

---

## Stage 2 · Mobile Bridge 加固

**Goal**: 在 `src-tauri/src/bridge/` 协议被外部客户端固化前补齐安全与版本兼容字段。**与 v1 Stage 2 等价**，单列在前是因为它是时间敏感的：移动端公开发布前必须完成。

**Success Criteria**
- `bridge/protocol.rs` 顶层消息加 `protocol_version: u16`（首版 = 1），版本不匹配返回 `protocol_version_mismatch` 而非静默失败。
- `bridge/pairing.rs` 配对 token：默认 TTL ≤ 24h；`single_use` token 第一次握手成功后立即作废；并发握手只允许一次。
- 桥接默认 **不开机自启**；用户在 `MobileAccessSettings.tsx` 里显式开启。
- 默认监听 `127.0.0.1`，放开 `0.0.0.0` 需要二级确认 + 显示当前监听地址 + 推荐 Tailscale / Cloudflare Tunnel 文档链接。

**Tests**
- `bridge/pairing.rs`：TTL 过期、single_use 消费、并发握手互斥；
- `bridge/protocol.rs`：version mismatch 序列化结果快照；
- `MobileAccessSettings.test.tsx`：默认 `127.0.0.1`、开放 `0.0.0.0` 触发二级确认；
- 集成：本机 wscat 模拟客户端，错误版本被拒绝。

**Verification**: 本机走完整配对流程 → 关闭桥接后 `lsof -i :5174` 端口确实释放 + ROADMAP 基线全过。

**Status**: In Progress（协议版本、默认 loopback、token hash/过期、LAN 二次确认已落地；wscat 手动验证待跑）

---

## Stage 3 · Block Layer 基座（Warp-inspired 核心）

**Goal**: 建立完整的 Command Block 数据流。**默认关闭**；用户在设置里点 "Enable command blocks" 后，引导式地把 shell 集成脚本写进 `~/.zshrc` / `~/.bashrc` / `config.fish` / PowerShell `$PROFILE`，并对当前会话热加载。

### 3.1 Shell 集成（OSC 133 + ThreadTerm 扩展）

**协议**
- 标准 `OSC 133 ; A/B/C/D ST`：
  - `A` = 新 prompt 开始；
  - `B` = 命令输入开始（prompt 结束）；
  - `C` = 命令输出开始（用户按 Enter）；
  - `D ; <exit_code> ST` = 命令结束。
- ThreadTerm 私有扩展（兼容 OSC 133，仅追加字段）：
  - `OSC 6973 ; cmd_id=<uuid> ; cwd=<base64>` — 命令稳定 id + 切片当时的 cwd（用于跨会话搜索时还原工作目录）；
  - `OSC 6973 ; duration=<ms>` — 命令执行时长（D 之后立即发送）。
- 私有码点 `6973` = "thrt" 的简化映射，避免与现有终端扩展冲突；解析器对未知 OSC 静默丢弃。

**集成脚本**
- `src-tauri/resources/shell-integration/{zsh,bash,fish,pwsh}.sh` — 体积 ≤ 50 行 / 文件，无外部依赖；
- 安装器 = 一次性 Tauri command `install_shell_integration(shell)`，把单行 `source <path>` 追加到用户 rc 文件，并在前后加哨兵注释 `# >>> threadterm shell integration` / `# <<<`，便于之后干净卸载；
- 永远 **不会** 直接修改 rc 文件之外的任何用户文件；安装前显示 diff、要求用户确认。

**Rust 解析层**
- 新增 `src-tauri/src/pty/blocks.rs`（≤ 250 行）：增量状态机消费 PTY 字节流，识别 OSC 133/6973，发出新事件：
  - `pty://block-started` payload `{ session_id, block_id, command, cwd, started_at }`；
  - `pty://block-finished` payload `{ session_id, block_id, exit_code, finished_at, duration_ms }`。
- 解析器对原 PTY 数据流 **零修改**：所有 OSC 字节继续转发到 xterm，仅旁路嗅探。
- 必须包含 fuzz 用例：随机 OSC + ANSI 流不应让解析器 panic。

**前端数据模型**
- `terminalStore` 新增 `blocks: Record<cardId, Block[]>`；
  ```ts
  type Block = {
    id: string;
    cardId: string;
    cwd: string;
    command: string;
    startedAt: number;
    finishedAt?: number;
    exitCode?: number;
    durationMs?: number;
    bufferStart: number;  // 起始行号在 xterm 滚动缓冲里的 absolute index
    bufferEnd?: number;
    state: 'running' | 'success' | 'failed' | 'aborted';
  };
  ```
- 旧用户加载新 store 时 `blocks` 默认 `{}`，无需迁移函数。

**Success Criteria**
- 启用集成后，在 zsh 下连续敲 5 条命令（含失败、含管道、含交互式 `vim` / `top`），ThreadTerm 准确识别全部 5 个块；
- 未启用集成 / 集成失败 / shell 不在白名单时，PTY 行为与 v0.3 完全一致；
- 卸载（`uninstall_shell_integration`）能干净移除哨兵注释包围的代码段；
- xterm 渲染输出的视觉与 v0.3 像素级一致（OSC 不可见）。

**Tests**
- `pty/blocks.rs` 单元 + fuzz；
- `terminalStore.test.ts` 扩展：`pty://block-*` 事件 → store 状态机；
- `shellIntegration.test.ts`：rc 文件 diff 计算、卸载幂等性；
- 集成：mock PTY 流回放真实 zsh 录像（asciinema 文件），断言识别出的块数 / 退出码。

**Risk & Mitigation**
- **风险**：用户自己的 shell 集成（Starship、p10k 等）已经发了 OSC 133 → 我们重复嗅探 → 块边界翻倍。**缓解**：`A` 出现在 `C` 之后视为「重启 prompt」，状态机吞掉重复 `A`。
- **风险**：`tmux` / `screen` 吞 OSC → 块识别在 multiplexer 下失效。**缓解**：明确文档化为已知限制，不修；FAQ 提示用户使用 ThreadTerm 自身的多会话能力代替 tmux。
- **风险**：用户 rc 文件里有自定义 PROMPT_COMMAND / precmd hook 与我们的脚本冲突。**缓解**：脚本只追加（`add-zsh-hook -Uz precmd ...`），不覆盖；卸载脚本严格按哨兵移除。

**Verification**
- 全量 ROADMAP baseline；
- 手动：mac + Linux + Windows（Powershell 7）三平台各跑一次 5 条命令场景；
- 性能：连续 1000 条命令的会话，内存增量 < 50MB（块数据 ≈ 200 字节 / 块）。

**Status**: In Progress（OSC 133/6973 旁路解析、Tauri block 事件、前端 store 写入与 shell 集成安装器已落地；跨 shell 手动场景待跑）

---

## Stage 4 · Block-aware 交互层

**Goal**: 让块从「数据」变成「可操作的 UI 单元」。

### 4.1 块边界视觉
- xterm 顶层 overlay 一条细横线 + 命令文本作为粘性 header（用 xterm `decoration` API，无需替换渲染层）；
- 失败块左侧加一条红色细条；运行中块加 pulse 指示。

### 4.2 块级动作
- 鼠标悬停块 header 出现 inline 工具条：`Copy command` / `Copy output` / `Copy both` / `Re-run` / `Share` / `Explain (AI)`；
- 折叠：点击 header 把输出折起来，只剩一行命令 + exit code 摘要；
- 失败块快捷跳转：`Cmd+Shift+\` → 上一个失败块，`Cmd+Shift+/` → 下一个。

### 4.3 Block Inspector 面板
- 卡片右侧可拉出 `BlockInspector.tsx`：当前选中块的 metadata（cwd / 时长 / 退出码 / ANSI strip 后的纯文本输出 / AI explain 占位入口）；
- 复用现有 `headlessPreview.ts` 的纯文本提取，不重写。

**Success Criteria**
- 所有交互在禁用 Block 层时**完全不显示**，UI 与 v0.3 等价；
- 启用后所有动作均可通过键盘到达；
- "Re-run" 写入 PTY 的字节流与原命令字节级一致（不能因为 shell quoting 错位）。

**Tests**
- `BlockActions.test.tsx`：复制 / 折叠 / 重跑 行为；
- `failedBlockNav.test.ts`：跳转算法（边界 / 空集 / 单一块）；
- `BlockInspector.test.tsx`：metadata 渲染快照。

**Verification**: ROADMAP baseline + 手动手感（折叠 / 重跑 / 跳转响应 < 50ms）。

**Status**: Not Started

---

## Stage 5 · 跨会话块搜索 + 命令面板 + 书签

**Goal**: 把「会话」级别的查找升级到「块」级别。

### 5.1 跨会话搜索（`Cmd+F`，可配置）
- Scope = 当前所有卡片的 `blocks[]`（命令、输出、cwd、时间戳）；
- 结果列表：卡片名 / 项目 / 命令片段 / 命中行 / 时间戳；
- 大量块场景（> 5000 块）走 web worker；
- 不持久化搜索历史；关闭面板即清空。

### 5.2 命令面板（`Cmd+K`）
- 单一面板，按类型分组：
  - Jump to card（fuzzy）；
  - Jump to block（fuzzy on command + cwd）；
  - Switch project；
  - Run workflow（占位，Stage 7 真正注入）；
  - Change card intent；
  - Toggle overlay；
  - Open settings panes。
- 仅复用现有 store action，不新增可执行项；
- 关闭后焦点回到原卡片。

### 5.3 书签（块级别）
- 任意块都可加 `★`；存 `terminalStore.bookmarks: Bookmark[]`，schema 与现有 zustand persist 兼容（缺省 `[]`）；
- 侧栏 `Bookmarks` 视图；点击跳转到对应卡片 + 对应块。

**Tests**
- `searchAcrossBlocks.test.ts`：fuzzy 命中、特殊字符转义、worker 取消、5000 块 < 200ms；
- `commandPalette.test.tsx`：键盘导航、命令分组、关闭归还焦点；
- `terminalStore.test.ts` 扩展：bookmarks CRUD、persist round-trip 兼容旧数据。

**i18n**: 新文案补全 `en / zh-CN / ja / ko`。

**Status**: Not Started

---

## Stage 6 · AI Inline + 底部动作栏

**Goal**: 把 AI 从「独立卡片」拉进「块的旁边」，并集中所有上下文动作。

### 6.1 AI 对块发问
- Block Inspector / 块 inline 工具条「Explain (AI)」入口；
- 选中模型与 v0.3 Claude / Codex / Gemini 一致；
- AI 回答以 **虚拟块** 形式插入到该块下方（不写入 PTY 流），可一键标记为「Run as command」把建议命令注入命令行。

### 6.2 底部动作 chip 栏（截图同款）
- `BottomActionBar.tsx`，固定在卡片底部，按上下文显示 chip：
  - 通知开关 / `/remote-control` / `File explorer` / `Rich Input` / `Workflows` / `Bookmarks`；
  - 不新增功能 — 全部把现有能力集中入口；
  - 默认显示，可在卡片设置里关闭。

**Success Criteria**
- AI 回答与 PTY 输出**绝不混淆**：虚拟块独立颜色 + 标签「AI · Claude」之类；
- "Run as command" 注入前必须弹二级确认（即使快速场景下默认 1.5s 倒计时取消）；
- chip 栏键盘可达；屏幕宽度不足时收纳进溢出菜单。

**Tests**
- `aiInlineBlock.test.tsx`：插入位置、删除、Run-as-command 二级确认；
- `bottomActionBar.test.tsx`：键盘导航、宽度自适应。

**Status**: Not Started

---

## Stage 7 · Workflows（Warp schema 兼容）

**Goal**: 「每开一个项目就建好一组卡片 / 命令」的重复劳动消失。

**协议对齐**
- 直接使用 [warpdotdev/workflows](https://github.com/warpdotdev/workflows) 的 YAML schema：`name / command / tags / description / arguments[]`；
- ThreadTerm 仅追加 `intent`（AI 卡片用）和 `cwd`（可选）字段；
- 解析器明确忽略未知字段，便于未来反向兼容。

**功能**
- 项目侧栏右键「Edit project preset…」= 一组 workflow YAML 文件；
- "Apply preset" 一键创建对应卡片；按 cwd + 命令去重，绝不覆盖现有卡片；
- 命令面板 `Run workflow` 列出 ~/.threadterm/workflows + 项目内 workflows；
- 一键导入：从 URL（限 https://）拉取单个 YAML 文件，导入前展示 diff。

**Tests**
- `workflowParse.test.ts`：合法 / 非法 / 未知字段 / 多语言（YAML 锚点等）；
- `applyPreset.test.ts`：去重逻辑、缺省字段；
- `workflowImport.test.ts`：URL 校验、http 拒绝、超时。

**Status**: Not Started

---

## Stage 8 · 数据 IO 与自动恢复

### 8.1 设置 / 主题导入导出
- 复用 `theme/themePacks.ts` 思路扩展到全局 settings：通知 / 热键 / overlay / project presets / workflows；
- 单 JSON 文件；导入支持选择性覆盖（diff 视图）；
- 永远不导出敏感字段（桥接 token、配对历史、AI provider key）—— 序列化层白名单。

### 8.2 卡片自动重启（opt-in）
- 默认关闭；启用后可设最大重试（默认 3）+ 指数退避（最长 30s）；
- 仅对显式标记的卡片生效；
- 重试历史在卡片状态栏；达到上限通过通知中心告知。

### 8.3 AI 会话 Markdown 导出
- AI 卡片右键 / 块 inline 都可触发；
- 输出 Markdown 含元数据（intent / provider / session id / 起止时间）+ 时序 prompt/reply + fenced code；
- 不发送任何网络请求，落盘走 Tauri `dialog.save`；
- 复用 `providerSession.ts` 切分逻辑，不重写。

**Tests**
- `settingsImportExport.test.ts`：白名单字段、导入 diff 渲染、敏感字段绝不外泄；
- `autoRestart.test.ts`：退避计算、上限触发、用户手动停止能打断重试；
- `exportAiSession.test.ts`：providerSession → markdown 渲染快照。

**Status**: Not Started

---

## Stage 9 · 体验长尾

### 9.1 Token / 成本面板
- 新增 `provider_usage.rs`（与 `provider_sessions.rs` 同级）：白名单正则从 Claude / Codex / Gemini CLI 输出抓 tokens / cost；解析失败永远静默；
- 卡片状态栏 + 项目侧栏底部聚合显示；可一键关，关闭后零开销。

### 9.2 AI Reply 富预览
- `headlessPreview.ts` 之上加轻量行级正则：识别 ```fenced``` 代码块、`diff` 头，分别上色（用现有 theme tokens）；
- 不引入 markdown 解析库；
- 卡片设置里可关，回到现有纯文本预览。

### 9.3 DND / 通知静默时段
- `NotificationSettings.tsx` 新增：时间窗（HH:mm - HH:mm，可跨午夜）、按项目静音、按 intent 静音；
- 静默期间：桌面 OS 通知抑制；通知中心仍记录，标记 "Silenced"；
- 配置项默认全部关闭，行为与现状一致。

### 9.4 Linux 兼容性矩阵
- `docs/linux-compatibility.md`：列已验证 desktop env / 已知限制（全局热键 / overlay / shell 集成）；
- Issue 模板加 Linux self-check（DE 名、`xdotool` 是否可用、shell 类型等）；
- 不承诺修复，文档化现状，方便贡献者补 PR。

**Tests**
- `providerUsage.test.ts`：每个 provider ≥ 3 个真实输出样本（masked），含解析失败 case；
- `headlessPreview.test.ts` 扩展：fenced / diff 检测，非匹配输入零变化；
- `notificationDND.test.ts`：跨午夜窗口、项目级静音优先级。

**Status**: Not Started

---

## 全局风险与缓解

| 风险 | 缓解 |
| --- | --- |
| Stage 3 的 OSC 嗅探在 multiplexer / 远程 ssh 下失效 | 文档化已知限制 + 在「未识别到任何块」的会话上显示一次性提示「Block layer inactive — likely tmux/screen wrapping?」 |
| Stage 3 修改用户 rc 文件 | 哨兵注释 + 安装前 diff 强制确认 + 一键卸载；CI 用临时 rc 文件验证幂等 |
| Block 数据模型未来改字段 | 所有新字段必须有 default；禁止迁移函数；旧数据加载零警告 |
| Bridge 协议被外部客户端依赖 | Stage 2 是 Stage 3 之前的硬门槛；`protocol_version` 一旦发布只能加不能改 |
| Warp Workflows YAML schema 未来变化 | 解析器忽略未知字段；版本号可选，默认按 v0 处理；引入新字段时单测扩充 |
| AI Inline 和 PTY 输出混淆 | 虚拟块视觉 + 标签强差异化；"Run as command" 强制二次确认 |
| 跨会话搜索性能 | Web worker + 块级索引 + 增量更新；性能预算写进 vitest |
| 新增 i18n key 漏译 | 每阶段结束前用脚本 diff `en` 与其他三语言 key 集合，缺失阻断发布 |

## 阶段完成定义（统一）

- [ ] 代码改动符合该阶段 Success Criteria；
- [ ] 阶段新增测试全过；既有测试无修改全过；
- [ ] ROADMAP 验证基线命令全过；
- [ ] 涉及 UI 的改动至少在 macOS + Windows 各跑一次手动 smoke；
- [ ] CHANGELOG 增补条目；
- [ ] 所有新增文案 4 语言齐全；
- [ ] 该阶段在本文件状态由 `Not Started` → `In Progress` → `Complete`；
- [ ] 全部阶段 Complete 后删除本文件，并把保留下来的方向（如未做的子项）回写到 `ROADMAP.md`。

## 与 v1 的关系

- v1 Stage 1（代码健康）→ v2 Stage 1（仅剩 TerminalCard 拆分尾巴）；
- v1 Stage 2（Bridge）→ v2 Stage 2（不变，仍是时间敏感前置项）；
- v1 Stage 3.1（跨会话搜索）→ v2 Stage 5.1（升级为块级搜索）；
- v1 Stage 3.2（AI 导出）→ v2 Stage 8.3（沉到长尾，不再是核心增强）；
- v1 Stage 3.3（命令面板）→ v2 Stage 5.2（同步增加 Run workflow 项）；
- v1 Stage 3.4（书签）→ v2 Stage 5.3（升级到块级）；
- v1 Stage 4.1（Quick Commands）→ v2 Stage 7（升级到 Warp Workflows schema）；
- v1 Stage 4.2 / 4.3（设置 IO / 自动重启）→ v2 Stage 8；
- v1 Stage 5（AI 深度 / DND / Linux）→ v2 Stage 9；
- v2 全新增：**Stage 3 Block Layer 基座** + **Stage 4 Block-aware 交互** + **Stage 6 AI Inline + 底部动作栏**。

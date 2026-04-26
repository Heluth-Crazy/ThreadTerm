<div align="center">
  <img src="public/logo.svg" alt="ThreadTerm" width="64" height="64">
  <h1>ThreadTerm</h1>
  <p>简体中文 | <a href="README.md">English</a></p>
</div>

ThreadTerm 是一个桌面端终端管理器，用于管理绑定到项目目录的 Shell 和 AI CLI 会话。它可以把多个终端会话以卡片形式常驻展示，支持将重要会话固定到全局选择器，并能把选中的会话打开为置顶浮动终端。

## 预览

![ThreadTerm 终端网格](./docs/media/threadterm-grid.png)

![ThreadTerm 使用演示](./docs/media/threadterm-usage-demo.gif)

[下载 MP4 演示视频](./docs/media/threadterm-usage-demo.mp4)

| 新建终端 | 全局选择器 |
| --- | --- |
| ![创建新终端](./docs/media/threadterm-create-terminal.png) | ![固定会话选择器](./docs/media/threadterm-selector.png) |

| 通知中心 | 外观设置 |
| --- | --- |
| ![通知中心](./docs/media/threadterm-notifications.png) | ![主题设置](./docs/media/threadterm-settings.png) |

## 当前范围

ThreadTerm 当前聚焦于 Tauri 桌面应用：

- **终端卡片**：创建绑定到项目目录的终端，运行 Shell、Claude、Codex、Gemini、Python、Node、Docker 或自定义命令。
- **项目侧边栏**：按项目路径分组会话卡片，并在不打断终端工作流的情况下过滤卡片网格。
- **聚焦终端视图**：双击卡片进入完整终端视图，同时保持卡片和会话状态存活。
- **全局选择器**：按 `Cmd/Ctrl + Shift + Space` 在当前应用上方显示已固定会话。
- **浮动终端**：选择一个已固定卡片后，在始终置顶的浮动终端窗口中继续输入。
- **通知**：ThreadTerm 跟踪 PTY 状态变化，并在等待输入、错误或回复完成时显示通知。
- **跨平台桌面支持**：macOS 和 Windows 是一等支持目标；Linux 取决于具体桌面环境对全局快捷键的支持情况。

## 环境要求

- Node.js 22 LTS 和 npm 10+
- Rust 工具链：<https://rustup.rs>
- Tauri CLI：`cargo install tauri-cli`
- 可选 AI CLI 已加入 `PATH`：`claude`、`codex`、`gemini` 等

## 开发

安装依赖：

```bash
npm install
```

启动桌面应用：

```bash
npm run tauri:dev
```

仅启动前端 Vite 预览：

```bash
npm run client
```

构建桌面应用：

```bash
npm run tauri:build
```

## 验证

当前分支使用的核心检查：

```bash
npm run typecheck
npx vitest run src/components/terminal/TerminalEventBridge.test.tsx src/components/terminal/providerSession.test.ts src/components/terminal/useProjectGroups.test.ts src/stores/overlayStore.test.ts src/stores/terminalStore.test.ts src/theme/themePacks.test.ts
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml pty::tests
```

全局浮窗的手动回归步骤见 [docs/global-overlay-manual-test.md](docs/global-overlay-manual-test.md)。

## 架构

运行入口：

- `index.html` -> 主终端管理窗口。
- `selector.html` -> 全局选择器浮窗。
- `float.html` -> 浮动终端窗口。

保留的后端模块：

- `src-tauri/src/pty.rs`：本地 PTY 生命周期、输出事件、会话状态、最近输出回放。
- `src-tauri/src/overlay.rs`：全局快捷键、选择器/浮动终端窗口、macOS 全屏 Space 处理、非 macOS 窗口回退。
- `src-tauri/src/db.rs`：用于浮窗快捷键和浮动终端位置的小型 SQLite 设置表。
- `src-tauri/src/notification.rs`：正式桌面包中的系统通知分发。
- `src-tauri/src/provider_sessions.rs`：Claude/Codex 原生会话的轻量发现，用于懒恢复。

## Windows 说明

Windows 支持已保留：

- Release 构建保留 `windows_subsystem = "windows"`，避免额外控制台窗口。
- PTY 启动优先使用 `powershell.exe`，不可用时回退到 `cmd.exe`。
- Windows 图标和 Tauri 打包配置保留在 `src-tauri/icons/` 和 `src-tauri/tauri.conf.json`。

## 主题来源

ThreadTerm 包含原创主题和受第三方主题启发的主题包。第三方主题会在应用的外观设置中标明来源，这里也同步列出：

- **ThreadTerm Default**：ThreadTerm 原创主题。
- **Catppuccin**：基于 [Catppuccin](https://catppuccin.com/palette/)（[许可证](https://github.com/catppuccin/catppuccin/blob/main/LICENSE)）。
- **Tokyo Night**：基于 [tokyonight.nvim](https://github.com/folke/tokyonight.nvim)（[许可证](https://github.com/folke/tokyonight.nvim/blob/main/LICENSE)）。
- **Gruvbox**：基于 [gruvbox](https://github.com/morhetz/gruvbox)（[许可证](https://github.com/morhetz/gruvbox#license)）。
- **Everforest**：基于 [everforest](https://github.com/sainnhe/everforest)（[许可证](https://github.com/sainnhe/everforest/blob/master/LICENSE)）。
- **Dracula**：基于 [Dracula Theme](https://draculatheme.com/spec)（[许可证](https://github.com/dracula/dracula-theme/blob/main/LICENSE)）。

上述上游项目并不为 ThreadTerm 背书；这里保留署名是为了尊重原主题作者和对应许可证。

## 许可证

ThreadTerm 是专有软件。内部使用和分发遵循你所在组织的相关条款。

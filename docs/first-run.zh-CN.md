# 首次使用

本指南面向 Tauri 桌面应用。仅启动前端预览（`npm run client`）适合界面开发，
但不能验证 PTY、全局快捷键、浮动窗口或系统通知。

## 1. 准备仓库

请先在目标电脑安装：

- Node.js 22 LTS 和 npm 10 或更高版本；
- 从 <https://rustup.rs> 安装的 Rust 工具链；
- Windows 还需要 Visual Studio Build Tools 2022，并勾选 **Desktop
  development with C++** 工作负载；
- 如需使用 `claude`、`codex`、`gemini` 等可选 AI CLI，请自行安装并确保它们
  位于 `PATH` 中。

在全新检出的仓库根目录运行：

```bash
npm install
npm run tauri:dev
```

`npm run tauri:dev` 会使用仓库固定版本的 `@tauri-apps/cli`，无需全局安装
`cargo-tauri`。启动 Rust 应用前，Tauri 会执行 `npm run dev:desktop`；该脚本先
构建内嵌移动端客户端，再启动 Vite，因此全新检出不要求预先存在
`mobile-app/dist` 目录。

macOS/Linux 也可运行 `./start.sh`，Windows PowerShell 可运行
`.\start.ps1`。这两个脚本会先检查平台依赖，再调用同一个 npm 启动命令。

## 2. 创建终端卡片

1. 点击 **新建终端**，或按 `Cmd/Ctrl + N`；
2. 选择一个已存在的项目目录。项目名称会根据路径自动填写，也可手动修改；
3. 首次验证建议选择 **Shell**。将 **初始命令** 留空即可使用默认命令，也可
   输入一个你熟悉且无副作用的命令；
4. 点击 **创建**；
5. 确认终端出现 shell 提示符或命令输出，并能正常接收键盘输入。

如果 AI 预设提示对应 CLI 不存在，请安装该 CLI，或改用 Shell 卡片。
ThreadTerm 不会自动安装第三方 AI CLI。

## 3. 固定并选择会话

1. 在卡片底部点击 **固定到悬浮选择器**。最多可固定 6 张卡片；
2. 按 `Cmd/Ctrl + Shift + Space` 打开全局选择器；
3. 使用方向键或数字键 `1` 到 `6` 选择已固定卡片；
4. 按 `M`，确认选择器能在平铺模式和轮播模式之间切换；
5. 按 `Enter`，在浮动终端中打开当前卡片；
6. 确认同一会话的输出仍可见。输入一个无副作用的命令，确认输出正常回显且
   会话没有丢失；
7. 按 `Cmd/Ctrl + Shift + O`，将浮动会话送回主窗口。

如果全局选择器没有出现，请打开 **设置 > 快捷键**，确认 **轻量模式** 已关闭，
并检查该快捷键是否被其他应用占用。主窗口获得焦点时，按
<kbd>Cmd/Ctrl</kbd> + <kbd>&#96;</kbd> 可改为打开内联选择器。

## 4. 验证通知

1. 打开 **设置 > 快捷键**；
2. 在 **通知** 区域点击 **发送测试通知**；
3. 确认 ThreadTerm 显示请求成功，并到操作系统通知中心检查测试通知。

开发模式、系统通知权限或专注模式可能隐藏横幅。仅看到请求成功并不能证明系统
已经展示通知；发布前仍需使用打包后的应用重复验证。

## 5. 继续验证

如需在 macOS 和 Windows 上完整回归浮窗功能，请使用
[全局浮窗手动测试](global-overlay-manual-test.md)。打包与发布门禁见
[构建和发布](build-release.md)。

# Windows x64 打包指南

本文用于在 Windows 机器上打包当前 ThreadTerm Tauri 桌面应用。

## 1. 环境要求

1. Windows 10/11 x64
2. Node.js 22 LTS 和 npm 10+
3. Rust toolchain
4. Tauri CLI: `cargo install tauri-cli`
5. Visual Studio Build Tools 2022，安装 `Desktop development with C++` 工作负载
6. Windows 10/11 SDK

建议固定使用 Node 22 LTS，避免前端工具链或原生依赖在更新版本上出现兼容问题。

## 2. 获取项目

在 PowerShell 中进入项目根目录：

```powershell
cd D:\path\to\ThreadTerm
```

如果目录里带有从其他系统拷贝来的 `node_modules`，先删除：

```powershell
rmdir /s /q node_modules
```

## 3. 安装依赖

```powershell
npm install
```

## 4. 构建前验证

```powershell
npm run typecheck
npx vitest run src/components/terminal/TerminalEventBridge.test.tsx src/components/terminal/providerSession.test.ts src/components/terminal/useProjectGroups.test.ts src/stores/overlayStore.test.ts src/stores/terminalStore.test.ts src/theme/themePacks.test.ts
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml pty::tests
```

## 5. 打 Windows 包

```powershell
npm run tauri:build
```

产物位于：

```text
src-tauri\target\release\bundle\
```

实际文件类型取决于 Tauri bundler 在本机可用的 Windows 目标配置。

## 6. 常见问题排查

### Visual Studio 或 MSBuild 报错

修复或重新安装 Visual Studio Build Tools 2022，并确认已勾选：

1. `Desktop development with C++`
2. Windows 10/11 SDK

### Rust 工具链不可用

确认 PowerShell 中可以执行：

```powershell
rustc --version
cargo --version
```

如果不可用，重新安装 Rust 并重启 PowerShell。

### Node 或 npm 版本异常

确认版本：

```powershell
node -v
npm -v
```

推荐 Node `v22.x` 和 npm `10.x`。

### 应用启动后找不到默认 Shell

后端会优先启动 `powershell.exe`，失败时回退到 `cmd.exe`。如果两者都不可用，检查系统 `PATH` 和 Windows 安装完整性。

## 7. 交付建议

优先交付 Tauri bundler 生成的安装包；如需便携版或签名发布，在 `src-tauri/tauri.conf.json` 中调整 bundle 配置后重新执行 `npm run tauri:build`。

# Windows x64 EXE 打包指南

本文用于在 Windows 机器上打包 OpenWork 的桌面安装包（`.exe`）。

## 1. 环境要求

1. Windows 10/11 x64
2. Node.js 22 LTS（建议 22.x）
3. npm 10+
4. Visual Studio Build Tools 2022（安装 `Desktop development with C++` 工作负载）

建议不要使用 Node 25+ 打包，以免触发 `better-sqlite3/sqlite3/node-pty` 的原生模块兼容问题。

## 2. 首次准备

在 PowerShell 中执行：

```powershell
node -v
npm -v
```

确认 Node 为 `v22.x` 后再继续。

## 3. 获取项目

把项目目录拷到 Windows 本机（或重新拉取代码）后，进入项目根目录：

```powershell
cd D:\path\to\claudecodeui-main
```

如果目录里带有从 macOS 拷过来的 `node_modules`，先删除：

```powershell
rmdir /s /q node_modules
```

## 4. 安装依赖

```powershell
npm ci
```

## 5. 构建前建议（原生模块重建）

```powershell
npm run rebuild:native:electron
```

## 6. 打 Windows 包

```powershell
npm run build:win
```

当前配置会产出两个 x64 文件：

1. NSIS 安装包（`Setup.exe`）
2. 便携版（`Portable ... .exe`）

产物目录：

```text
release\
```

## 7. 常见问题排查

### 7.1 `module ... was compiled against a different Node.js version`

先执行：

```powershell
npm run rebuild:native:node
npm run rebuild:native:electron
```

不行就删除 `node_modules` 后重新 `npm ci`。

### 7.2 `failed to spawn ... spawn node ENOENT`

说明运行时找不到 `node`：

1. 确认 `node -v` 在 PowerShell 可用
2. 确认 Node 安装目录在系统 `PATH`
3. 重新打开终端/重启系统后再打包

### 7.3 `spawn ENOTDIR`

通常是可执行路径配置异常或缓存脏数据导致：

1. 删除应用配置目录后重试  
   `C:\Users\<你的用户名>\AppData\Roaming\OpenWork`
2. 重新安装最新包再测试

### 7.4 构建时报 C++/MSBuild 相关错误

安装或修复 Visual Studio Build Tools 2022，并确保已勾选：

1. `Desktop development with C++`
2. Windows 10/11 SDK

## 8. 交付建议

给测试同学优先发 NSIS 安装包（`Setup.exe`）；便携版可用于免安装调试。

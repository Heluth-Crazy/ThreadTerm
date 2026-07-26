# 审查结论安全整改与功能决策门

## Goal

把 `docs/full-project-audit-adjudication-2026-07-26.md` 中已经复核为成立的结论转化为可执行整改，同时建立严格的功能决策门：首批只实施可证明不改变产品语义的工程修复；任何可能改变协议、交互、数据、安全、恢复或调度语义的项目必须先单独取得用户确认。

## Confirmed Facts

- 当前分支是 `exp/windows-native-terminal-host`，工作区包含移动端工作台的大量既有暂存改动。
- `src-tauri/src/bridge/mod.rs`、`src/components/terminal/Shell.jsx`、`TerminalView.tsx` 和 `FloatSession.tsx` 已有其他任务的大幅修改；本批不得叠加修改这些文件。
- `src-tauri/src/git.rs` 的 7 个生产 Git 子进程和 `src-tauri/src/pty/shell.rs` 的 `where.exe` 探测在 Windows 未使用 `CREATE_NO_WINDOW`。
- `src-tauri/Cargo.lock` 已把 `tauri-nspanel` 解析到 commit `a3122e894383aa068ec5365a42994e3ac94ba1b6`，但 `Cargo.toml` 仍跟踪 `v2.1` 分支。
- 仓库目前没有 `.github/workflows/`；已有本地 `typecheck`、Vitest 和 Cargo test 门禁。
- GitNexus 索引对应当前 HEAD，但不包含 190+ 个未提交路径；关键字 FTS 当前不可用。精确符号 impact 仍可用。

## Requirements

### R1 — 首批功能等价整改

1. 为 `git.rs` 中全部 7 个生产 `git` 子进程统一使用一个模块内命令构造器。
2. 构造器只在 Windows 设置 `CREATE_NO_WINDOW = 0x0800_0000`；其他平台的命令构造保持不变。
3. 不得改变 Git 子进程的程序名、参数顺序、cwd、stdout/stderr 捕获、退出码判断和错误映射。
4. 为 Windows `where.exe` shell 探测设置同一窗口标志；不得改变 `pwsh > powershell > cmd` 的选择顺序、一次性缓存或失败回退。
5. 把 `tauri-nspanel` manifest 声明锁到 Cargo.lock 已使用的同一 commit；不得升级依赖内容。
6. 新增最小 Windows CI，复用现有 `npm run typecheck`、`npm run test` 和 `cargo test --manifest-path src-tauri/Cargo.toml`；不得引入发布、部署、自动提交或远端写操作。
7. 若 CI 暴露仅存在于测试并行执行中的共享状态竞态，只允许增加 `#[cfg(test)]` 隔离；不得借机修改生产缓存语义。

### R2 — 冲突隔离

- 本批不修改任何已被移动端/UI任务占用的文件。
- PowerShell LAN IP 探测隐藏窗口、`replayRecentOutput` 死参数删除等即使可做等价改动，也必须等待占用文件收口后另行处理。
- 保留所有既有暂存改动，不重置、不覆盖、不提交、不推送。

### R3 — 功能决策门

以下类别只记录证据、影响面和候选方案，不得在本任务首批直接实现：

- 移动桥协议 epoch、心跳、撤销终态与重连策略。
- Bridge 同步节流、maxWait、订阅握手、缓存和 `spawn_blocking` 调度。
- LAN 绑定默认值、TLS、证书/指纹、权限或 token 传输策略。
- terminalFeed 字节上限、bucket 回收和丢弃策略。
- PTY 输出排序、ACK/缺口处理、背压、后台消费者 TTL。
- 审计 SQLite 写入队列、失败策略和持久化时序。
- 工作区目录授权模型与已注册根目录限制。
- React memo 比较器、实时排序、可见性降载和任何用户可见 UI 行为。
- 依赖 major 升级、桥模块拆分或其他大规模重构。

## Acceptance Criteria

- [x] 任务具有完整 `prd.md`、`design.md`、`implement.md`，并在开始编码前进入 `in_progress`。
- [x] 所有被编辑的既有函数均先完成 GitNexus upstream impact；HIGH/CRITICAL 已向用户明确告警。
- [x] 7 个生产 Git 调用全部经同一隐藏窗口构造器；测试代码是否使用原始 `Command` 不影响验收。
- [x] Windows `where.exe` 探测不再创建可见控制台窗口，shell 选择与缓存逻辑不变。
- [x] `tauri-nspanel` 的 manifest revision 与变更前 Cargo.lock commit 完全一致。
- [x] CI 仅包含读取源码、安装依赖和运行三项既有门禁，不含发布或远端写入。
- [x] `cargo fmt --check`、Git 模块测试、全量 Cargo test、Clippy、CI YAML 静态检查和 `git diff --check` 通过。
- [x] GitNexus `detect_changes --scope unstaged` 确认源代码范围为 LOW、0 条执行流外溢。
- [x] 本任务改动仅暂存；不 commit，不 push。

## Out of Scope

- 本轮不实现任何功能决策门项目。
- 本轮不修改移动端协议、bridge 状态结构、终端渲染、通知逻辑或 UI。
- 本轮不修复审查报告中的所有性能问题；后续按用户逐项确认建立子任务。

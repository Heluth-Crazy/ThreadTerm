# 审查结论安全整改 · Implementation Plan

## Phase A — Planning and Safety Gates

- [x] 创建独立任务，不改变移动端工作台任务状态。
- [x] 记录用户约束：只直接实施功能等价项；功能影响项逐项确认。
- [x] 检查工作区冲突；排除 bridge 与终端 UI 已占用文件。
- [x] 读取 backend Windows background-process spec 与 code-reuse guide。
- [x] 对 8 个既有函数运行 GitNexus upstream impact。
- [x] 向用户披露 `git_repo_root` 的 HIGH 调用面。
- [x] `task.py start 07-26-audit-safe-remediation`。

## Phase B — Behavior-Preserving Implementation

### B1. Git child processes

- [x] 在 `git.rs` 增加 Windows gated `CommandExt` 和
  `CREATE_NO_WINDOW`。
- [x] 增加私有 `git_command()`，非 Windows 行为保持原样。
- [x] 替换 7 个生产 `Command::new("git")`。
- [x] 搜索确认唯一保留的原始调用是测试 fixture。
- [x] `cargo fmt --check`。
- [x] Git 模块 12/12 通过。

### B2. Shell discovery

- [x] 在 `pty/shell.rs::which_exists` 设置 `CREATE_NO_WINDOW`。
- [x] 保持 `WINDOWS_SHELL` Lazy、优先级和失败回退不变。
- [x] shell 模块 3/3 通过，含 Windows `where cmd.exe` 回归用例。

### B3. Reproducible macOS dependency

- [x] 把 `tauri-nspanel` 改为现有 lock commit 的 `rev`。
- [x] 让 Cargo 规范地更新 lock source。
- [x] 断言变更前后最终 commit hash 均为
  `a3122e894383aa068ec5365a42994e3ac94ba1b6`。
- [x] `cargo metadata --manifest-path src-tauri/Cargo.toml --locked --no-deps`。

### B4. Minimal CI

- [x] 新增 `.github/workflows/quality.yml`。
- [x] 限定只读权限，无发布/上传/远端写入步骤。
- [x] 复用 typecheck、Vitest、Cargo test 三项现有命令。
- [x] `actionlint` 未安装；已用仓库现有 `yaml` Node 包解析成功
  (`jobs=test`) 并人工核对 Actions 结构。

### B5. Validation-discovered test isolation

- [x] 定位 Claude 全局缓存测试的并行 `clear()` 竞态。
- [x] 对三个被编辑测试函数运行 impact：均 LOW、0 上游。
- [x] 仅在 `#[cfg(test)]` 中增加 `CACHE_TEST_LOCK`。
- [x] 全量并行 Cargo test 连续两次 280/280 通过。

## Phase C — Verification

- [x] `cargo fmt --manifest-path src-tauri/Cargo.toml --check`。
- [x] Git 模块 12/12。
- [x] shell 模块 3/3。
- [x] 全量 Cargo test 连续两次 280/280。
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`。
- [x] `npm run typecheck`。
- [x] `npm run test`：102 files、760 tests。
- [x] `npm run lint`：0 errors、22 个既有 warnings（阈值 31）。
- [x] `git diff --check`。
- [x] GitNexus `detect_changes`：6 个已索引源/规范文件、24 个符号、
  0 affected processes、LOW；Cargo/CI/忽略的活动任务文档另行人工核对。

## Phase D — Staging and Handoff

- [x] 只暂存本任务新增/修改路径，不扰动已有 index。
- [x] 更新本清单的实际结果、测试数量和环境限制。
- [x] 功能决策门已保留在下方，本批未实现。
- [x] 不 commit，不 push，不归档，等待用户下一步。

## Decision Gates — Do Not Implement in This Batch

1. 移动协议 epoch / heartbeat / revoke / reconnect。
2. Bridge maxWait、订阅门控、IP 缓存与 async 调度。
3. LAN TLS、默认 bind、token 安全策略。
4. terminalFeed 限额、GC、丢弃语义。
5. 输出缺口/ACK/背压/background TTL。
6. 审计写队列及失败语义。
7. 工作区根目录授权模型。
8. React memo、实时排序、可见性降载与 UI 行为。
9. 大模块拆分、依赖 major 升级。

## Stop Conditions

- Cargo pin 解析到不同 commit。
- 任何测试显示 Git 输出、错误或 shell 选择行为变化。
- 实施中必须修改已被移动端/UI任务占用的文件。
- 新发现的改动需要协议、数据格式、交互或安全策略选择。

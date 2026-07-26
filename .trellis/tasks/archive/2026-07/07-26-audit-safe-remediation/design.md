# 审查结论安全整改 · Technical Design

## 1. Boundary

本批只允许两类修改：

1. Windows 进程创建属性：改变子进程是否显示控制台窗口，不改变被执行程序及其输入输出协议。
2. 构建与验证元数据：把已解析的 Git 依赖固定到同一 commit，并让现有本地门禁在 GitHub Actions 中自动运行。

不修改任何业务数据结构、Tauri command 签名、前端 IPC、移动桥协议、终端输出流、持久化版本或用户交互。

## 2. Windows Git Command Construction

在 `src-tauri/src/git.rs` 增加模块内私有构造器：

```rust
fn git_command() -> Command
```

行为：

- 所有平台仍执行裸程序名 `git`，继续依赖原有 PATH 解析。
- Windows 通过 `std::os::windows::process::CommandExt` 设置
  `CREATE_NO_WINDOW`。
- 非 Windows 编译不导入 Windows API，也不设置额外 flag。
- 7 个生产调用只把 `Command::new("git")` 替换为 `git_command()`；
  后续 `.arg()`、`.output()` 和错误分支逐字保持。
- 测试辅助代码可以继续直接使用 `Command::new("git")`，避免改变测试
  fixture 的目的。

### Blast Radius

GitNexus 精确 impact：

- `list_worktrees_for_directory`：LOW，5 个上游符号。
- `list_branches_for_directory`：LOW，2 个上游符号。
- `status_for_directory`：LOW，1 个上游符号。
- `git_repo_root`：HIGH，4 个直接调用者、9 个上游符号；覆盖 status、
  file diff、text diff 和 worktree add。
- `run_git_diff`：LOW，5 个上游符号。
- `read_git_blob`：LOW，3 个上游符号。
- `add_worktree_for_branch`：LOW，1 个上游符号。

`git_repo_root` 的 HIGH 来自复用面，不是数据流或协议变化。对策是保持命令
参数/错误处理不变，并扩大到 Git 模块测试与全量 Cargo test。

## 3. Windows Shell Discovery

`which_exists(name)` 保留原签名和 `where <name>` 语义，只改为：

1. 创建可变 `std::process::Command`；
2. Windows 设置 `CREATE_NO_WINDOW`；
3. 继续读取 `output.status.success()`；
4. spawn/output 失败仍返回 `false`。

`WINDOWS_SHELL` 仍是 `Lazy`，不改变探测次数和 shell 优先级。

GitNexus impact：LOW，唯一直接消费者是一次性 `WINDOWS_SHELL` 初始化。

## 4. Exact Cargo Revision

把：

```toml
tauri-nspanel = { git = "...", branch = "v2.1" }
```

改为：

```toml
tauri-nspanel = { git = "...", rev = "a3122e..." }
```

Cargo.lock 的 source selector 随 manifest 从 `branch=` 变为 `rev=`，但最终
commit hash必须仍是 `a3122e894383aa068ec5365a42994e3ac94ba1b6`。若 Cargo
解析到任何其他 commit，立即回滚此项。

## 5. Minimal CI

新增 `.github/workflows/quality.yml`：

- 触发：pull request；以及 `main` push。
- 权限：`contents: read`。
- 平台：`windows-latest`，直接覆盖本批最相关的 Windows 行为和现有 Windows
  Rust 测试。
- Node：22；安装使用 `npm ci`。
- Rust：stable toolchain。
- 门禁：`npm run typecheck`、`npm run test`、
  `cargo test --manifest-path src-tauri/Cargo.toml`。
- 不运行 release、签名、部署、上传 artifact、自动修复、commit 或 push。

此工作流不修改应用功能；只有代码将来被推到 GitHub 后才产生 CI 运行成本。
本轮不推送。

## 6. Conflict Isolation

以下已被其他任务修改的文件保持只读：

- `src-tauri/src/bridge/mod.rs`
- `src/components/terminal/Shell.jsx`
- `src/components/terminal/TerminalView.tsx`
- `src/windows/float/FloatSession.tsx`

因此 PowerShell 探测的隐藏窗口标志和死 prop 清理不在首批实现。后续应在相关
任务落稳后重新检查 diff，再做独立小补丁。

## 7. Rollback

- Git/where 改动可分别回滚到原始 `Command::new`，不涉及数据迁移。
- Cargo pin 可恢复 `branch = "v2.1"` 并恢复对应 lock source。
- CI 是独立新文件，可单文件删除。
- 本轮只暂存，不提交、不推送；回滚边界在文件级清晰可见。

## 8. Validation-Only Test Isolation

首次新增 CI 后，全量 Cargo test 暴露了一个既有并行测试竞态：

- `cache_reuses_unchanged_mtime_and_invalidates_on_change`
- `catalog_search_matches_title_and_prompt_not_present_in_file_path`
- `catalog_cursor_advances_without_dropping_sessions`

三个测试并行共享并清空 `CLAUDE_PARSE_CACHE`。缓存复用测试在两次读取之间可能
被其他测试清空，因此单独运行通过、全量并行运行失败。修复仅在 `#[cfg(test)]`
模块增加 `CACHE_TEST_LOCK`，三个测试持锁后再触碰共享缓存。生产缓存、TTL、
容量和调用路径完全不变。GitNexus 对三个测试函数的 impact 均为 LOW、0 上游。

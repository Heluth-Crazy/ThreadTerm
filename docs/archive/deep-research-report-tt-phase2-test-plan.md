# 阶段二 FIX-4/5/6 测试文档（Windows / Linux 真机验收）

> 适用提交：`635885a` FIX-6 ｜ `cbff251` FIX-5 ｜ `8ef7b48` FIX-4
> 分支：`fix/deep-research-defect-fix`（已 push 到 `origin`）
> 关联：`docs/deep-research-report-tt-fix-implementation-plan.md`（行 220–367 权威规格）、`.trellis/tasks/05-19-windows-linux-fix-4-5-6/fix-log.md`（改动与偏差登记）
> 本文档自包含：在目标机器上无需回看其他文档即可逐条执行。

---

## 0. 文档结构与判定规则

- **L1 自动化测试**：任意 host（含目标机）均可跑；已在 macOS 全绿，目标机需复跑以确认平台一致性。
- **L2 编译验证**：目标平台 `cargo check` / 构建通过（非 macOS 分支在 macOS 编译期不可达，此为唯一确认途径）。
- **L3 真机手测**：运行时窗口/进程行为，无法自动化，逐用例人工执行。

**单用例判定**：每条用例填 `结果`（PASS / FAIL / BLOCKED / N/A）+ `证据`（截图/录屏/命令输出片段路径）。出现 FAIL 立即按 §7 缺陷模板记录，不继续依赖该路径的后续用例。

**整体放行标准**：见 §6 退出标准。任一 `严重度=阻断` 用例 FAIL → 阶段二不放行。

---

## 1. 环境矩阵与前置准备

### 1.1 目标环境（三套，缺一不可覆盖 FIX-4）

| 环境 | 必备 | 说明 |
|---|---|---|
| ENV-WIN | Windows 11，Rust stable，Node ≥ 18，WebView2 Runtime | FIX-4/5/6 全覆盖 |
| ENV-X11 | Linux + X11 会话，webkit2gtk-4.1，Rust，Node | FIX-4 焦点策略 |
| ENV-WAY | Linux + Wayland 会话（同机切会话即可） | FIX-4 Wayland 焦点差异需单列结论 |

### 1.2 代码获取

```bash
git clone https://github.com/Heluth-Crazy/ThreadTerm.git
cd ThreadTerm
git checkout fix/deep-research-defect-fix
git log --oneline -3      # 应见 8ef7b48 / cbff251 / 635885a
```

> 注意：`docs/` 与 `.trellis/` 被 `.gitignore` 排除，本测试文档不随 git 传输。请将本文件单独拷贝到目标机，或见 §8 可选「随仓库传输」方案。

### 1.3 依赖与基线构建

```bash
npm ci
npm run check          # 基线门：tsc + vitest + build:mobile + cargo check 全绿才开始
```

记录基线：

| 项 | 期望 | 实测 |
|---|---|---|
| tsc | 0 error | |
| vitest | 73 文件 / 532 passed | |
| build:mobile | built | |
| cargo check | Finished，0 error | |

---

## 2. L1 自动化测试（目标机复跑）

在目标机 `src-tauri/` 下执行。这些用例验证 FIX-5/6 的纯逻辑契约，与平台无关，目标机复跑用于排除平台差异。

| 用例 | 命令 | 期望 | 结果 | 证据 |
|---|---|---|---|---|
| L1-1 FIX-6 校验 | `cargo test --lib pty::tests::validate_working_dir` | 5 passed（empty / whitespace / missing / file / existing-dir） | | |
| L1-2 FIX-5 优先级 | `cargo test --lib 'pty::shell::tests'` | 6 passed（SHELL 命中 / SHELL 不解析回退 / pwsh 优先 / powershell 回退 / COMSPEC / cmd 兜底） | | |
| L1-3 全量 lib | `cargo test --lib` | 135 passed / 0 failed | | |
| L1-4 前端套件 | 仓库根 `npm run test` | 532 passed / 0 failed | | |

判定：任一 FAIL → 说明平台行为与 macOS 不一致，属真实缺陷（非环境问题），按 §7 记录。

---

## 3. L2 编译验证（目标平台，最高优先）

FIX-4 非 macOS 分支、FIX-5 windows cfg 分支在 macOS 编译期不可达——目标平台编译是它们「能否编译」的唯一证据。

| 用例 | 平台 | 命令 | 期望 | 结果 | 证据 |
|---|---|---|---|---|---|
| L2-1 | ENV-WIN | `cd src-tauri && cargo check` | Finished，0 error | | |
| L2-2 | ENV-WIN | `cargo build`（或 `npm run tauri build`） | 链接通过，产物生成 | | |
| L2-3 | ENV-WIN | `cargo clippy --lib 2>&1 | tail` | 无新增 error（warning 记录即可） | | |
| L2-4 | ENV-X11/WAY | `cd src-tauri && cargo check` | Finished，0 error | | |
| L2-5 | ENV-X11/WAY | `cargo build` | 链接通过 | | |

**重点核对（FAIL 高发点）**：
- FIX-4 `src-tauri/src/overlay/platform.rs` 非 macOS `order_overlay_window_front` / `activate_float_window_for_keyboard` 是否因 `WebviewWindow::set_focus()` 签名/返回类型在该平台不一致而编译失败（预期不会：全平台同签名稳定 API）。
- FIX-5 `src-tauri/src/pty/shell.rs` windows 分支 `windows_shell_choice(env_var_nonempty, |name| which_exists(name))` 与 `which_exists`（`#[cfg(target_os="windows")]`）在 Windows 上是否正常解析。

---

## 4. L3 真机手测

### 4.1 FIX-6 ｜working_dir 校验 + 结构化错误（ENV-WIN 主，X11/WAY 抽测）

前置：启动桌面应用；准备 ① 一个不存在的路径 ② 一个文件路径（如任意 `.txt`）③ 一个正常目录。

| 用例 | 步骤 | 期望 | 结果 | 证据 |
|---|---|---|---|---|
| F6-1 不存在路径 | 以不存在路径作为项目/工作目录新建终端卡 | 后端拒绝，错误含前缀 `working_dir_not_found:`；不产生残留 PTY | | |
| F6-2 文件路径 | 以一个文件（非目录）路径新建终端卡 | 错误含 `working_dir_not_a_directory:` | | |
| F6-3 空路径 | 触发 working_dir 为空的创建路径（若 UI 不可达则标 N/A 并说明） | 错误含 `working_dir_empty:` | | |
| F6-4 正常目录 | 以正常目录新建终端卡 | 正常拉起 shell，无回归 | | |
| F6-5 移动端文案 | 移动端连接桌面，触发 F6-1 同款失败 | 移动端错误提示直接呈现结构化前缀文案（`spawn_result` 直通 `message`），可读 | | |
| F6-6 桌面行为观察（非判定项） | 桌面触发 F6-1，观察 `connectPty` | 记日志结构化错误；**已知**：fatal 时桌面会无限重连——属既有独立缺陷，非本次回归，仅记录现象 | | |

> F6-6 不计入放行判定（fix-log 已登记为范围外既有缺陷）；仅观察确认结构化前缀使日志可归因。

### 4.2 FIX-5 ｜default_shell Windows 优先级（仅 ENV-WIN）

前置：能装/卸 pwsh（PowerShell 7+）、能设/清 `SHELL` 与 `COMSPEC` 环境变量。每组改完环境后**重启应用**再新建终端卡，用卡内命令判定实际 shell：
- 判 pwsh vs Windows PowerShell：`$PSVersionTable.PSVersion`（7.x = pwsh；5.1 = Windows PowerShell）
- 判 cmd：提示符 `C:\>` 且 `ver` 输出 Windows 版本
- 判显式 SHELL：卡内进程为所指 shell

| 用例 | 环境组合 | 期望拉起 | 结果 | 证据 |
|---|---|---|---|---|
| F5-1 | 设 `SHELL=<可解析的某 shell 全路径>`，pwsh 已装 | 该 `SHELL` 指定的 shell | | |
| F5-2 | 设 `SHELL=<不存在路径>`，pwsh 已装 | 回退到 `pwsh.exe`（不被无效 SHELL 卡住） | | |
| F5-3 | 不设 `SHELL`，装 pwsh 且有 powershell | `pwsh.exe`（pwsh 优先于 Windows PowerShell） | | |
| F5-4 | 不设 `SHELL`，卸载 pwsh，保留 powershell | `powershell.exe` | | |
| F5-5 | 不设 `SHELL`，无 pwsh/无 powershell（极端，可用 PATH 屏蔽模拟），设 `COMSPEC` | `COMSPEC` 指向的解释器 | | |
| F5-6 | 同上但清空/不设 `COMSPEC` | `cmd.exe` 兜底 | | |

> 行为变化备注（release note）：现代 Windows（装 pwsh 7+、未设 SHELL）默认 shell 由原 `powershell.exe` 改为 `pwsh.exe`。F5-3 是该变化的核心确认点。

### 4.3 FIX-4 ｜非 macOS overlay 前台化与键盘焦点（ENV-WIN + ENV-X11 + ENV-WAY 各一轮）

前置：配置好 overlay 全局热键 A（selector）与 B（回收主窗口）；准备一个**他应用**（如浏览器/记事本）置于前台并最大化。

每个环境（WIN / X11 / WAY）独立跑下表一轮，**Wayland 结论单列**。

| 用例 | 步骤 | 期望 | WIN | X11 | WAY |
|---|---|---|---|---|---|
| F4-1 selector 前台化 | 他应用前台 → 按热键 A | selector 窗口到最前、可见，无需点击 | | | |
| F4-2 selector 键盘焦点 | F4-1 后直接用方向键/快捷键在 selector 选卡（不点鼠标） | 键盘即可导航选择（焦点已在 selector） | | | |
| F4-3 float 立即输入 | 在 selector 选一张卡进入 float | float 到前台且终端**立即可键入**（无需先点一下） | | | |
| F4-4 热键 B 回收 | float/selector 显示时按热键 B | 主窗口 show + unminimize + 取得焦点（回收正常） | | | |
| F4-5 反复开关 | 连续 A→选卡→B 循环 ≥ 5 次 | 每次均稳定前台化+聚焦，无「需点击才聚焦」「窗口不前置」回归 | | | |
| F4-6 跨工作区/虚拟桌面 | 切到另一虚拟桌面/工作区后按热键 A | selector 在当前工作区前台并聚焦（与 macoS 行为对齐目标） | | | |
| F4-7 置顶泄漏观察 | 关闭 overlay（B 或隐藏）后观察 selector/float | 记录是否仍 always-on-top 常驻置顶（计划列为子任务，依赖真机焦点策略观察；此处仅采集结论，不强判 PASS/FAIL） | | | |

**Wayland 专项结论**（F4-1~F4-6 在 ENV-WAY 的差异，单独成段记录）：

```
Wayland 焦点策略观察：
- set_focus() 是否生效拉起前台：________
- 与 X11 的差异：________
- 是否需要 compositor 侧策略/协议限制说明：________
```

### 4.4 macOS 零回归复核（若有 Mac，可选）

FIX-4 仅动非 macOS 分支，macOS 路径逐字未改（git diff 已核实零 +/- 行）。如手头有 Mac：跑 §4.3 同款 F4-1~F4-5，期望与改动前**完全一致**（NSPanel 路径）。无 Mac 则标 N/A（已由代码层 git diff 证据替代）。

---

## 5. 回归基线对照

| 项 | 改动前（macOS 基线已知） | 目标机实测 | 一致? |
|---|---|---|---|
| Rust lib 测试 | 135 passed | | |
| vitest | 532 passed | | |
| 既有终端卡创建/连接/重连 | 正常 | | |
| overlay macOS 行为 | 未改（N/A 非 mac） | | |

---

## 6. 退出标准（阶段二放行判定）

阶段二**放行**当且仅当全部满足：

- [ ] L1 自动化：L1-1~L1-4 全 PASS（目标机与 macOS 一致）
- [ ] L2 编译：L2-1、L2-4 PASS（Win + Linux `cargo check` 0 error）；L2-2、L2-5 PASS（构建链接通过）
- [ ] L3 FIX-6：F6-1~F6-4 PASS，F6-5 PASS（移动端文案可读）
- [ ] L3 FIX-5：F5-1~F5-6 全 PASS（优先级链与兜底正确，F5-3 确认行为变化符合预期）
- [ ] L3 FIX-4：F4-1~F4-6 在 ENV-WIN 与 ENV-X11 全 PASS；ENV-WAY 跑完并产出 Wayland 结论（Wayland 若因 compositor 限制不达 X11 同效，需在结论中明确并由你判定是否可接受，不阻断 WIN/X11 放行）
- [ ] 无 `严重度=阻断` 缺陷未关闭
- [ ] F4-7 置顶泄漏结论已采集（供后续子任务决策，不阻断放行）

放行签字：

| 角色 | 姓名 | 日期 | 结论(放行/打回) |
|---|---|---|---|
| 测试执行 | | | |
| 复核 | | | |

---

## 7. 缺陷记录模板（每个 FAIL 一份）

```
缺陷ID：P2-DEF-__
关联用例：F_-_ / L_-_
环境：ENV-WIN | ENV-X11 | ENV-WAY ｜ 提交：8ef7b48/cbff251/635885a
严重度：阻断 | 严重 | 一般 | 观察
现象（实际）：
期望：
复现步骤：
1.
2.
证据（截图/录屏/命令输出路径）：
初判归属：FIX-4 | FIX-5 | FIX-6 | 既有缺陷(非本次) | 环境问题
```

> 区分提醒：分支上另有 `8bd13f7「修复 Windows 端 4 个缺陷（#4 #5 #6 #7）」`，其编号口径疑似来自 `05-17-system-defect-audit-fix`，与本计划 FIX-4/5/6 **不是同一套编号**。记录缺陷时按本文件 FIX-4/5/6 口径，避免混淆。

---

## 8. 附：本测试文档跨机传输（可选）

`docs/` 被 gitignore，本文件不随 `git pull` 到目标机。三种方式任选：

1. **手动拷贝**（最简）：将本文件随代码包/U盘/网盘带到目标机。
2. **临时纳入跟踪**（随分支传输）：`git add -f docs/deep-research-report-tt-phase2-test-plan.md` 后提交推送——属仓库可见改动，需你确认后我才执行（commit/push 仅在你明确要求时进行）。
3. **改放已跟踪目录**：如你希望长期随仓库，可指定一个非 gitignore 路径，我据此移动并按 trellis 流程处理。

需要我执行 2 或 3 的话告诉我。

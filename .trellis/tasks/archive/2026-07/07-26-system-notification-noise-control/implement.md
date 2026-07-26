# 系统通知降噪与语义去重 — Implementation Plan

## Phase A — Baseline and conflict gate

- [x] 记录 staged/unstaged 文件边界，确认 UI Agent 热区。
- [x] 对所有将修改的生产符号执行 GitNexus upstream impact。
- [x] 若出现 HIGH/CRITICAL，先向用户报告具体调用链再编辑。
- [x] 建立通知触发矩阵和现有测试基线。

## Phase B — Routing types and pure coordinator

- [x] 为 `NotificationEntry` 增加可选 routing 元数据。
- [x] 新增 `osNotificationPolicy` 纯模块：
  - visibility gate
  - legacy worktree classification
  - episode/fingerprint normalization
  - source priority
  - bounded sent/pending state
  - timer cleanup
- [x] 为前台、后台、目标可见、completed、worktree 和 legacy 条目编写纯单测。

## Phase C — Producer episode metadata

- [x] `TerminalEventBridge`：
  - reply completion routing
  - auto-restart limit routing
  - PTY waiting/error routing
  - 同 generation + fingerprint 的应用内重复抑制
- [x] Rust `attention-required` payload 增加稳定 prompt fingerprint。
- [x] `tauri-bridge` 类型兼容 optional fingerprint。
- [x] `CodexRequestBridge` 写入 structured-request routing。
- [x] `useSupervisor` 写入 generation/fingerprint routing。
- [x] `supervisorStore` 从 60 秒重复许可改为 episode 精确防重。

## Phase D — OS bridge integration

- [x] `NotificationBridge` 通过 coordinator 投递 OS toast。
- [x] flush 时重新检查开关、窗口焦点和当前 focused card。
- [x] 保留 Rust command → Web Notification fallback。
- [x] 卸载时取消所有 pending timer。
- [x] 添加 Bridge fake-timer 集成测试：
  - PTY + Supervisor + Codex 合并为 Codex
  - foreground suppression
  - background completion
  - worktree success/failure
  - dispose cleanup

## Phase E — Verification and knowledge capture

- [x] 定向 Vitest：
  - notification policy/bridge
  - TerminalEventBridge
  - CodexRequestBridge
  - supervisor store/hook
- [x] 定向 Rust tests：PTY attention fingerprint + Supervisor。
- [x] `npm run typecheck`
- [x] `npm run check`
- [x] `git diff --check`
- [x] `git status --short` 确认未改 UI Agent 热区。
- [x] `gitnexus detect_changes --scope all` 审计影响范围。
- [x] 使用 `trellis-update-spec` 更新系统通知跨层契约。

## Planned Files

允许修改：

- `src/types/terminal.ts`
- `src/lib/tauri-bridge.ts`
- `src/lib/osNotificationPolicy.ts`（新增）
- `src/lib/osNotificationPolicy.test.ts`（新增）
- `src/components/terminal/NotificationBridge.tsx`
- `src/components/terminal/NotificationBridge.test.tsx`（新增）
- `src/components/terminal/TerminalEventBridge.tsx`
- `src/components/terminal/TerminalEventBridge.test.tsx`
- `src/components/codex/CodexRequestBridge.tsx`
- `src/components/codex/CodexRequestBridge.test.tsx`
- `src/lib/supervisor/useSupervisor.ts`
- `src/lib/supervisor/useSupervisor.test.ts`
- `src/lib/supervisor/supervisorStore.ts`
- `src/lib/supervisor/supervisorStore.test.ts`
- `src-tauri/src/pty/events.rs`

禁止修改（并行 UI Agent 热区）：

- `src/components/terminal/TerminalManager.tsx`
- `src/components/terminal/ProjectSidebar.tsx`
- `src/components/terminal/Shell.jsx`
- `src/components/terminal/TerminalView.tsx`
- `src/components/settings/NotificationSettings.tsx`
- `src/components/workbench/**`
- UI/CSS/Tailwind 文件

## Rollback Points

1. routing type + pure policy，可独立回退。
2. producer metadata/episode 防重，可按来源独立回退。
3. NotificationBridge coordinator 接入，可恢复直接 dispatch。
4. Rust fingerprint 为 additive wire field，可独立删除。

# Terminal Manager Lite

轻量化的多终端管理工具。以**终端会话**为核心，配合**蒲公英式放射切换器**、**系统级通知**和**应用内消息中心**，让多项目/多 CLI 的并行工作更顺手。

分支：`terminal-manager-lite`（从 `feat/openwork-phase0-control-plane` 派生）

---

## 快速开始

```bash
# 桌面开发
npm run tauri dev

# 仅前端构建
npm run build

# 运行终端存储单测
npx vitest run src/stores/terminalStore.test.ts
```

---

## 架构速览

```
App.tsx
├── TerminalEventBridge     ← 订阅 pty-output / session-state-changed / attention-required
├── NotificationBridge      ← 监听 store.notifications，转发给 tauri-plugin-notification
├── KeyboardBridge          ← 全局快捷键（capture 阶段）
└── <div>
     ├── TerminalManager    ← 顶栏 + grid ↔ full-screen
     │    ├── CardGrid
     │    ├── TerminalView (复用 Shell.jsx 的 plain-shell 模式)
     │    └── CreateTerminalDialog
     ├── RadialSwitcher     ← Ctrl+` 蒲公英呼出
     └── NotificationCenter ← 铃铛抽屉
```

**状态层**（`src/stores/terminalStore.ts`）：
单一 Zustand store + persist，持久化 `cards / focusedCardId / lastActiveCardId / notifications`；`switcher*` 为易失状态。

**类型层**（`src/types/terminal.ts`）：
`TerminalCard / TerminalStatus / TerminalType / NotificationEntry / TerminalEvent`。

---

## 快捷键

| 键位 | 功能 |
|---|---|
| `Ctrl/Cmd + \`` | 打开/关闭蒲公英切换器 |
| 切换器打开时：`← / → / Tab / Shift+Tab` | 选中上一个 / 下一个 |
| 切换器打开时：`Enter` | 确认 |
| 切换器打开时：`1-9` | 直接跳转并确认 |
| `Ctrl/Cmd + 1-9` | 直接跳卡（不经切换器） |
| `Ctrl/Cmd + Tab` / `Ctrl/Cmd + Shift + Tab` | 下一张 / 上一张 |
| 双击 `Ctrl/Cmd`（<300ms） | 切回上一张 |
| `Ctrl/Cmd + N` | 打开"新建终端" |
| `Ctrl/Cmd + W` | 关闭当前卡片 |
| `Ctrl/Cmd + B` | 打开/关闭通知中心 |
| `Esc` | 返回网格 / 关闭抽屉 |

---

## 卡片信息（丰富版）

- 类型图标 + 项目名 + CLI 类型标签
- 项目绝对路径 + worktree 徽章（可选）
- 状态 chip（idle/running/waiting/completed/failed），带未读红点
- 最近回复片段（3-5 行，从 PTY 输出 heuristic 抽取）
- 活跃时长 · 用户输入次数 · "需人工介入/发生错误"提示
- Hover 展开迷你时间线（最近 5 条事件）
- 快捷方块：复制路径 / 打开目录 / 关闭终端

---

## 通知系统

**两条路径并行**：

1. **系统通知**（`@tauri-apps/plugin-notification`）：
   - 命中 `attention-required` 事件时自动弹窗
   - 点击通知 → 应用聚焦 + 自动 focus 到对应卡片
   - 前端 4s 去抖（即使 Rust 侧防抖较短也不会轰炸）

2. **应用内消息中心**（铃铛抽屉）：
   - 顶栏铃铛带未读计数
   - 按时间降序聚合所有通知
   - 点击条目 → 标记已读 + 跳转到卡片
   - 支持标记全部已读 / 单条移除 / 清空

---

## 蒲公英切换器

- **触发**：`Ctrl+\``
- **布局**：
  - ≤6 张 → 单环
  - 7-12 张 → 内环 6 + 外环余数（错位）
  - &gt;12 张 → 黄金角螺旋
- **动画**：Framer Motion spring，入场 stagger 0.02s/张
- **跨平台**：使用 `e.code === 'Backquote'`，Windows/Mac 一致行为

---

## 构建状态

| 检查 | 命令 | 状态 |
|---|---|---|
| TypeScript + Vite | `npm run build` | ✅ |
| Rust | `cd src-tauri && cargo check` | ✅ |
| 终端存储单测 | `npx vitest run src/stores/terminalStore.test.ts` | ✅ 12 passing |

---

## 已砍掉 / 暂未归档的模块

本分支只是**停止引用**这些重度模块，文件仍在原位以便随时回退：

- `src/components/mission-control/` · `overview/` · `live-grid/` · `task-queue/` · `loop/` · `session-focus/` · `task-panel/` · `terminal-grid/`
- `src/components/workbench/` · `main-content/` · `sidebar/` · `chat/` · `app/AppContent.tsx`
- `src/stores/backgroundRunStore.ts` · `taskQueueStore.ts` · `taskStore.ts` · `liveGridStore.ts` · `missionControlStore.ts` · `attentionStore.ts`
- `src/hooks/useAttentionRouter.ts` · `useAutoExecutor.ts` · `useSessionStatusTracker.ts` · `useLiveGridSnapshotSync.ts` · 等

要真正归档，未来可以 `git mv` 到 `src/archive/`；不急。

---

## 已知局限 / Future Work

- 启动恢复目前只持久化了卡片元数据；PTY 不会自动重连（进入全屏视图后 Shell.jsx 会新开一个）。下一步可以做"会话复活"策略。
- `onOpenDir` 依赖 `@tauri-apps/plugin-shell open()`；web 模式下是 no-op。
- `onAction` (系统通知点击回跳) 依赖 `tauri-plugin-notification` v2 的 `extra` 字段回传；如果未来升级插件失效，已有 title 中 `[cardId]` 的 fallback。
- 目前未提供自定义快捷键 UI，修改需要改 `KeyboardBridge.tsx`。

---

## 设计理念

> 像 iTerm2 一样管理终端，像 Launchpad 一样切换，像系统一样通知你 —— 无 AI Agent 编排的心智负担。

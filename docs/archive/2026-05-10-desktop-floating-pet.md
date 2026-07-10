# Plan: 桌面悬浮宠物 (Desktop Floating Pet)

## Context

ThreadTerm 当前是终端会话管理器，主窗里已经有 `NotificationCenter` 抽屉持久化展示
4 类通知（waiting / completed / failed / attention），但**没有"瞥一眼就懂"的氛围入口**——
长任务跑着的时候用户必须切回主窗才能看到状态。

桌面宠物的目标是把这层信息提到桌面级：
- 一直浮在屏幕角落，作为 glanceable 的状态指示器
- 通知到来时做轻量动画反馈，可替代或补充系统通知（用户可在设置里切换）
- 点击宠物 → 弹出"卡片列表 + 通知聚合"小窗，每行一个有未读的终端卡片，
  点击直接跳回主窗对应卡片；底部按钮通向已有的 NotificationCenter 抽屉做深度查看
- 不重复造轮子：复用现有 overlay 浮窗体系、`tauri-plugin-notification`、
  `terminalStore.notifications`、`NotificationCenter`

确认的关键决策：
1. 弹窗形态：**卡片列表 + 通知聚合**（每卡聚合最新事件 + 未读徽章）
2. 平台范围：**macOS + Windows/Linux 兜底**（mac 走 nspanel，其它走普通 WebviewWindow）
3. 视觉：**纯 CSS + SVG 矢量**（无新依赖，跟主题 tokens 联动）
4. 通知粒度：**全局四选一**（off / system-only / pet-only / both）

---

## 实现方案

### 1. 后端 (Tauri / Rust)

**1.1 新增 pet overlay 窗口** —— 在现有 prewarm 体系里追加第三个 label `"pet"`

修改 `src-tauri/src/overlay/window.rs`：参考现有 `selector` / `float` 窗口的构造模式
（已有 `set_always_on_top`、`set_visible_on_all_workspaces`、`is_floating_panel` 等
封装）新增一个 `prewarm_pet_window` 函数。

平台分叉：
- **macOS**：复用 `tauri-nspanel`，参考 `src-tauri/src/overlay/platform.rs:30-35`
  的 `CanJoinAllSpaces | IgnoresCycle` 集合行为；`can_become_key_window: true`，
  `is_floating_panel: true`
- **Windows / Linux**：普通 `WebviewWindowBuilder`，配置
  `.always_on_top(true).decorations(false).transparent(true).skip_taskbar(true).resizable(false)`

尺寸：吸附态 96×96（只显示宠物本体），展开态 296×380（宠物 + 面板）。
默认位置屏幕右下角内距 24px，位置持久化到 zustand persist。

**1.2 新增 Tauri 命令** —— `src-tauri/src/overlay/commands.rs`

参考现有 `overlay_show_selector` 模式新增：
- `pet_show()` / `pet_hide()` —— 启停
- `pet_set_position(x, y)` —— 拖动后保存
- `pet_set_expanded(expanded: bool)` —— 切换吸附/展开尺寸
- `pet_focus_main_to_card(card_id: String)` —— 主窗激活并定位到卡片
- `pet_open_notification_center()` —— 主窗激活并打开 NotificationCenter

复用：`src-tauri/src/notification.rs:4-33` 的 `notification_send_os`，无需改动。

**1.3 注册** —— `src-tauri/src/lib.rs` 的 `invoke_handler` 数组追加新命令；
启动序列追加 `prewarm_pet_window` 调用。`src-tauri/tauri.conf.json` 的
`windows` 数组追加 pet 元数据（`visible: false`，启动时不显示）。

### 2. 前端 (React)

**2.1 多入口与窗口根组件**

修改 `vite.config.ts` 加 multi-entry（`rollupOptions.input` 同时含 `index.html`
和新建的 `pet.html`）。新增 `src/pet/main.tsx` 作为 pet 窗口入口，根组件为
`src/pet/PetWindow.tsx`。

**2.2 SVG 宠物 + CSS 动画** —— `src/pet/PetSprite.tsx` + `src/pet/petAnimations.css`

4 种状态变体：
- `idle` —— 呼吸缩放 + 不规则眨眼
- `alert` —— 弹跳 + 边缘发光（新通知到来时触发 1.2s）
- `happy` —— 点击/hover 反馈（眼睛上弯）
- `sleep` —— 无未读且 30s 无活动时半透明并降低呼吸频率

颜色全部用 `var(--theme-app-primary)` 等主题 token，跟随 `useTheme()`。

**2.3 卡片+通知聚合面板** —— `src/pet/PetPanel.tsx`（296×380）

数据来源：`useTerminalStore.cards`，过滤 `unread > 0 || status in {waiting,failed}`
后按 `lastActivity desc` 排序。每行结构：
```
[状态图标] 卡片标题            [未读徽章]
          最新事件单行预览（取自 lastReplyPreview / lastOutput）
```

复用：`src/types/terminal.ts:133-171` 的 `TerminalCard` 数据结构，
`src/components/terminal/CardFooter.tsx:59-113` 的状态图标映射。

行点击 → `invoke('pet_focus_main_to_card', { cardId })`。
底部按钮"查看全部通知 →" → `invoke('pet_open_notification_center')`。

**2.4 跨窗口状态同步** —— `src/pet/usePetSync.ts`

webview 之间不会共享内存里的 zustand store，必须 emit/listen 桥接：
- 主窗：`terminalStore.subscribe` → emit Tauri event `pet://state-update`
  payload = `{ cards: needAttention[], notifications: recent[] }`
- pet 窗口：`listen('pet://state-update')` → 更新本地轻量 store
- 反向：pet 窗口的位置 / expanded 态 → emit `pet://settings-update` →
  主窗持久化到 `terminalStore.petConfig`（新增字段）

**2.5 设置面板** —— 新建 `src/components/settings/DesktopPetSettings.tsx`

挂载点：`src/components/Settings.jsx:444-452` 的 `shortcuts` Tab，紧邻已有
`NotificationSettings`。表单项：
- 开关「启用桌面宠物」 → 触发 `pet_show` / `pet_hide`
- 单选「通知形式」`off / system / pet / both`
- 单选「默认位置」`rightBottom / leftBottom / lastDragged`
- 滑块「宠物大小」 80~120
- 复选「无未读时半透明」

持久化：复用 `terminalStore` 的 zustand persist（`src/stores/terminalStore.ts`），
新增字段 `petConfig: { enabled, notificationMode, defaultPosition, size, idleTranslucent }`。

**2.6 通知派发分流** —— 改 `src/stores/terminalStore.ts` 的 `pushNotification`

```
pushNotification(notif):
  appendToStore(notif)                     // 已有：写入 notifications 数组
  switch petConfig.notificationMode:
    'off':    return
    'system': invoke('notification_send_os', ...)
    'pet':    emit('pet://notify', notif)  // pet 窗口接收后触发 alert + 顶部气泡 2s
    'both':   两个都发
```

**2.7 i18n** —— 4 个 locale 文件 `src/i18n/locales/{en,ja,ko,zh-CN}/settings.json`
各加一个 `desktopPet` 块（title / enable / notificationMode.{off,system,pet,both} /
position.{rightBottom,leftBottom,lastDragged} / size / idleTranslucent）。

---

## 关键文件清单

| 操作 | 路径 | 说明 |
|---|---|---|
| 新增 | `src-tauri/src/overlay/window.rs` 内 `prewarm_pet_window` | 复用 selector/float 模式 |
| 新增 | `src-tauri/src/overlay/commands.rs` 5 个 `pet_*` 命令 | 参考 `overlay_show_selector:15-87` |
| 修改 | `src-tauri/src/lib.rs` | invoke_handler 追加 + 启动 prewarm |
| 修改 | `src-tauri/tauri.conf.json` | windows 数组追加 pet 元数据 |
| 复用 | `src-tauri/src/notification.rs:4-33` | `notification_send_os` 无改 |
| 修改 | `vite.config.ts` | multi-entry |
| 新增 | `pet.html` | pet 窗口 HTML 入口 |
| 新增 | `src/pet/main.tsx`、`PetWindow.tsx`、`PetSprite.tsx`、`PetPanel.tsx`、`usePetSync.ts`、`petAnimations.css` |  |
| 修改 | `src/stores/terminalStore.ts` | `petConfig` 字段 + `pushNotification` 分流 |
| 新增 | `src/components/settings/DesktopPetSettings.tsx` | 设置表单 |
| 修改 | `src/components/Settings.jsx` shortcuts tab | 挂载 |
| 修改 | `src/i18n/locales/{en,ja,ko,zh-CN}/settings.json` | 4 个 locale |
| 复用 | `src/components/terminal/NotificationCenter.tsx` | 底部按钮的目的地，无改 |
| 复用 | `src/types/terminal.ts:133-171` `TerminalCard` | 直接用 |

---

## 阶段化交付（建议拆 4 个提交）

1. **Stage 1 — 窗口骨架**：pet overlay 三平台都能显示一个空白 SVG 宠物 +
   能拖动 + 位置持久化 + 设置面板「启用」开关跑通
2. **Stage 2 — 卡片面板**：点击宠物 → 展开 296×380 面板 → 渲染 cards 列表 →
   点击行跳主窗
3. **Stage 3 — 通知联通**：notificationMode 4 选 1 落地 → pushNotification 分流 →
   宠物 alert 动画 + 顶部气泡 → 卡片行未读徽章 + 最新事件预览 → 底部按钮拉起
   NotificationCenter
4. **Stage 4 — 打磨**：i18n 4 语言、主题色跟随、空闲半透明、空状态文案

---

## 验证（端到端）

**macOS 流程**
1. `npm run tauri dev` 启动
2. 设置 → shortcuts → 启用桌面宠物 + 通知形式选「都有」
3. 主窗开一个会失败的终端命令
4. 期望：系统通知 + 宠物 alert 动画同时触发
5. 点击宠物 → 面板出现，failed 卡片排在最上 + 红色未读徽章 + 最新事件单行
6. 点击该行 → 主窗 focus 并定位到对应卡片
7. 点击底部「查看全部通知」 → 主窗 NotificationCenter 抽屉打开
8. 拖宠物到屏幕中央 → 重启 app → 位置保留
9. 切换通知形式为「仅宠物」、再触发一次 → 系统通知不出，仅宠物气泡

**Windows / Linux 兜底验证**
- 窗口 always-on-top、透明背景、无任务栏图标
- 透明 WebView 边缘无可见黑边（如有，启用纯色 fallback）

**i18n 验证**
- 4 个语言切换，所有 desktopPet 文案正常显示

---

## 风险点

- **跨 webview store 同步**：必须走 Tauri event 桥接，不能假设主窗 zustand
  会自动出现在 pet 窗口。已在 §2.4 设计 `usePetSync.ts` 解决
- **Windows 透明窗口黑边**：某些 Win 版本透明 WebView 渲染有 1px 黑边，
  Stage 1 完成后做 QA，必要时切换为半透明纯色背景
- **multi-entry vite**：现有 `vite.config.ts` 单入口；扩展时确保 dev server
  HMR 与 build 都正常，不破坏主窗 build
- **prewarm 内存开销**：再加一个浮窗会增加常驻内存。可在 Stage 1 完成后
  实测，必要时改为按需创建（仅在「启用」时 prewarm）

---

## 完成记录（2026-05-12）

已完成实现：
- 新增 `pet.html` 多入口、`src/pet/**` 宠物窗口、SVG/CSS 动画、卡片聚合面板和
  跨 webview 事件同步。
- 新增 `DesktopPetSettings`，并将 `petConfig` 纳入 `terminalStore`、settings
  export/import、4 个 `settings` locale。
- 新增 `pet_*` Tauri 命令、`pet` capability、`OverlayPetPanel` macOS NSPanel
  与非 macOS `WebviewWindow` 兜底。
- 通知分流由 `NotificationBridge` 负责系统通知，`PetBridge` 负责宠物通知，
  保持 `terminalStore` 只做状态写入。

有意偏离计划：
- 未在 `tauri.conf.json` 增加静态 `pet` window，改为沿用现有 overlay 的
  programmatic window 创建模式，避免 macOS 上出现非 NSPanel 的重复窗口。
- 未把通知副作用写入 `pushNotification`，改为 store subscription 桥接，
  保持 persisted store 无 native side effect。
- 非 macOS 兜底窗口暂未启用透明窗口；当前用 CSS 视觉边界兜底，避免部分
  WebView 透明渲染黑边。

验证已通过：
- `npm run typecheck`
- `npx vitest run`
- `npm run build`
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo build --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- Playwright 浏览器冒烟：打开 `http://127.0.0.1:5176/pet.html`，确认 sprite
  可见、点击可展开 panel、无页面错误。

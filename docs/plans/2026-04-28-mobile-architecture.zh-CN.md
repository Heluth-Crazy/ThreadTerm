# ThreadTerm 移动端架构方案 (Web 本地 + iOS)

**日期:** 2026-04-28
**状态:** 提案 / 待评审

---

## 0. TL;DR

- **本质定位:** 移动端是 ThreadTerm 桌面端的 **远程观察 + 控制台**。Claude / Codex / Gemini CLI 仍然只跑在桌面机器上,移动端不本地执行 PTY。
- **桥接方式:** 桌面端内嵌一个 **本地 WebSocket / HTTP 服务**,由 Tauri Rust 进程拉起,与现有 PTY 事件总线复用。Web PWA 与 iOS App 共用同一份协议。
- **两条客户端线:**
  1. **Web 本地版 (PWA):** 同局域网内任何浏览器访问 `http://<mac-lan-ip>:port`,扫码配对即用,可"添加到主屏"作为 PWA。
  2. **iOS 原生 App (SwiftUI):** 内嵌 WKWebView 渲染流式输出 + 原生壳负责后台、推送、配对、Universal Link。
- **远程访问 (可选):** 接 Tailscale / Cloudflare Tunnel,不自建中继,不存用户内容。
- **用户体验金线:** 通知 → 一键打开卡片 → 看到最新回复 → 语音/快捷键回复 → 收起手机。**< 10 秒完成一次"轻互动"** 是核心目标。

---

## 1. 现状回顾

| 模块 | 现实现 | 影响移动端的关键点 |
|---|---|---|
| Tauri 后端 | `src-tauri/src/pty.rs` 管理 portable_pty 会话,emit `pty-output / session-state-changed / attention-required / pty-exit` | 已经是事件驱动,直接转发给远程客户端即可 |
| Tauri 命令 | `spawn / write / resize / close / get_session_state / get_recent_output ...` | 一一映射成 RPC 即可 |
| 前端 store | `useTerminalStore` (Zustand + persist),卡片元数据 + 通知中心 | 状态模型可直接复用,move 到 RN/PWA 不必重写 |
| 预览生成 | `headlessPreview.ts` 用 xterm.js 跑 headless 拿到 `lastReplyPreview` | **桌面端生成**,移动端只展示文本——移动端零 xterm 依赖 |
| AI 会话状态 | `providerSession.ts` 推断 claude/codex/gemini 的 session id 和绑定状态 | 数据已结构化,推送到移动端零成本 |

**关键设计含义:** 移动端不接 raw PTY 字节流,只接收桌面端已经清洗好的 `preview` + 状态事件。流量极小(每帧 < 1 KB),也避免移动端模拟终端的复杂度。

---

## 2. 总体架构

```
┌────────────────────────────── 桌面机 ──────────────────────────────┐
│                                                                    │
│  ┌── Tauri Rust ──────────────────────────────────────────────┐    │
│  │  PTY (claude/codex/gemini/shell)  ←→  既有 Tauri events    │    │
│  │            │                                                │    │
│  │            ▼                                                │    │
│  │  ┌── bridge.rs (新增) ──────────────────────────────────┐   │    │
│  │  │  • LocalServer  (axum + tokio-tungstenite)           │   │    │
│  │  │  • 配对管理 (QR token / pair store)                   │   │    │
│  │  │  • 状态广播 / 命令分发                                 │   │    │
│  │  │  • 鉴权中间件 (HMAC token)                            │   │    │
│  │  └────────────────────────────────────────────────────────┘   │    │
│  └────────────────────────────────────────────────────────────┘    │
│           ▲                                  ▲                     │
│           │ ws://<lan-ip>:5174               │ Tauri IPC (现有)    │
│           │ (LAN)                            │                     │
│           │                                  ▼                     │
│           │                          桌面 React UI (现状)           │
└───────────┼────────────────────────────────────────────────────────┘
            │
            │  内网直连 / Tailscale / Cloudflare Tunnel
            │
   ┌────────┴────────────┐                  ┌────────────────────┐
   │  Web PWA            │                  │  iOS App           │
   │  (浏览器)            │                  │  (SwiftUI + WKWeb) │
   │                     │                  │                    │
   │  • 局域网即开即用    │                  │  • APNs 推送       │
   │  • 添加到主屏        │                  │  • 后台唤醒        │
   │  • 自适应布局        │                  │  • 触觉/语音       │
   └─────────────────────┘                  └────────────────────┘
```

### 2.1 为什么不在云上做中继?

- **隐私**: 用户的代码、prompt、AI 回复全是敏感内容,不应过我们的服务器。
- **依赖**: 一上云就要有运维、计费、合规、SLA,与项目"开发者本地工具"定位冲突。
- **远程刚需路径**: 已有 Tailscale / Cloudflare Tunnel / Cursor 内置 SSH 等成熟方案,文档化即可,不重造。

> 兜底:`bridge.rs` 留一个 trait `Transport`,后期想接公网中继不需要重构。

### 2.2 与现有窗口的关系

桌面端三个 webview (主窗口、float、selector) **不变**。`bridge.rs` 是与它们平级的第四个消费方,直接订阅 `useTerminalStore` 在 Rust 侧的 mirror,而不是重新实现 PTY 管理。

---

## 3. 协议设计

### 3.1 传输层

- **WebSocket** (优先) — 双向,适合事件流
- **HTTP GET /snapshot** — 用于初次连接拿全量,避免 ws 第一帧塞太多
- **HTTP POST /pair** — 配对握手,只在初次设备绑定时调用

JSON 文本帧,不用 protobuf:协议不复杂,前期调试方便,流量本就小。

### 3.2 客户端 → 服务端

```ts
type C2S =
  | { kind: 'subscribe'; cardIds?: string[] }
  | { kind: 'input'; cardId: string; data: string }
  | { kind: 'resize'; cardId: string; cols: number; rows: number }
  | { kind: 'spawn'; terminalType: TerminalType; projectPath: string; command?: string }
  | { kind: 'close'; cardId: string }
  | { kind: 'pin'; cardId: string; pinned: boolean }
  | { kind: 'set_intent'; cardId: string; intent: TerminalAiIntent | null }
  | { kind: 'mark_read'; cardId: string }
  | { kind: 'ping' };
```

### 3.3 服务端 → 客户端

```ts
type S2C =
  | { kind: 'snapshot'; cards: CardMeta[]; notifications: NotificationEntry[] }
  | { kind: 'card_added' | 'card_updated' | 'card_removed'; card: CardMeta }
  | { kind: 'preview'; cardId: string; lastReplyPreview: string; hiddenLineCount: number }
  | { kind: 'state'; cardId: string; status: TerminalStatus }
  | { kind: 'attention'; cardId: string; kind: 'waiting' | 'failed'; message: string }
  | { kind: 'exit'; cardId: string; code: number | null }
  | { kind: 'notification'; entry: NotificationEntry }
  | { kind: 'pong'; t: number }
  | { kind: 'error'; code: string; message: string };
```

`CardMeta` 直接 JSON-序列化现有 `TerminalCard` 类型,但去掉 `lastOutput` 大字段,只留 `lastReplyPreview` 来省流量。

### 3.4 节流 / 背压

- `preview` 帧 **每 100 ms 最多 1 次/卡片**,落地后只发最新一帧。
- `output` raw 流默认不发(移动端不需要),除非客户端显式 `subscribe_raw`。
- WebSocket send buffer 超过 1 MB 触发 backpressure:服务端先丢 `preview` 中间帧,再丢非关键事件。

---

## 4. 安全模型

### 4.1 配对流程 (一次性)

1. 桌面 UI 设置面板:**"启用移动端访问"** 开关。
2. 开启后桌面显示一个二维码,内含:
   ```
   ttapp://pair?host=192.168.1.42&port=5174&fingerprint=<sha256>&otp=<6位>
   ```
3. 手机扫码:
   - **Web 浏览器** → 跳转到 `https://<host>:<port>/?otp=...` 或 `http://...`(LAN 自签 / 明文,见下)
   - **iOS App** → Universal Link 触达,内置 deeplink 处理
4. 客户端用 `otp` 调 `POST /pair`,后端返回长期 `device_token` (JWT, 30 天滚动续期)。
5. `otp` 一次性,5 分钟过期。

### 4.2 鉴权

- 后续所有 ws 帧带 `?token=...` 在 URL,或在初始帧 `auth`。
- `device_token` 与设备名绑定,用户可在桌面"已配对设备"列表里随时撤销。

### 4.3 传输加密

- **LAN 内**: 默认明文,设置项可启用 **自签 TLS**,提供"扫码安装证书"流程到 iOS Trust Store。
- **远程 (Tailscale)**: 走 Tailscale wireguard tunnel,本身已加密,bridge 仍走 ws。
- **远程 (Tunnel)**: Cloudflare Tunnel 强制 TLS。

### 4.4 权限分级

- **只读模式**: 客户端只能 `subscribe / mark_read`,不能 `input / spawn / close`。适合在公共网络只想"看一眼进度"的场景。
- **完整模式**: 所有命令可用。
- **危险命令二次确认**: 服务端对 `input` 做关键词扫描(`rm -rf`、`sudo`、`> /dev/`、`curl ... | sh`),触发后回 `error: confirm_required`,客户端弹原生确认对话框,带桌面端通知确认。

### 4.5 审计

`db.rs` 新增 `audit_log` 表,记录每条远程命令(发起设备、命令摘要、时间、结果),桌面 UI 可查阅。

---

## 5. 移动端交互体验 (核心)

> **设计原则:** 移动场景是"碎片时间介入",不是替代桌面工作。每个交互必须问:**"用户能在 5 秒内完成 / 看到结果吗?"**

### 5.1 首屏 — 卡片流

```
┌──────────────────────────────┐
│  ThreadTerm    🔵 已连接  ⋮   │   ← 顶部栏 (sticky)
├──────────────────────────────┤
│ 🔍 搜索 / 筛选 (折叠)          │
├──────────────────────────────┤
│ ╔════════════════════════╗   │
│ ║ 🟢 OpenWork · Codex    ║   │   ← 单列大卡片
│ ║ 正在处理…              ║   │
│ ║ "Refactored preview…"  ║   │
│ ║ 59h ⏱  7 💬   [回复]   ║   │
│ ╚════════════════════════╝   │
│                              │
│ ╔════════════════════════╗   │
│ ║ 🟡 ThreadTerm · Claude ║   │
│ ║ 等待你确认             ║   │
│ ║ "Run npm test next?"   ║   │
│ ╚════════════════════════╝   │
└──────────────────────────────┘
   📋 卡片  🔔 通知 (3)  ⚙️
```

**关键决策:**
- **单列大卡片**,不复制桌面网格。让每张卡片占满宽度,字号大、点击区大。
- **状态色带** (左侧 4px 高对比色条): 绿=运行中, 黄=待确认, 红=失败, 灰=空闲。一眼扫到要紧的。
- **未读以呼吸光晕表达**(不只是小圆点),比静态徽标更显眼。
- **回复按钮直接放卡片底部**,不让用户必须先点开。

### 5.2 卡片手势

| 手势 | 行为 | 说明 |
|---|---|---|
| 单击 | 进入会话视图 | 主路径 |
| 左滑 | 关闭会话(滑到末段触发,带阻尼) | 与系统邮箱一致 |
| 右滑 | 钉/取消钉 | |
| 长按 | 浮起菜单(复制路径、打开终端、语音回复…) | 触觉 medium |
| 双击 | 标记已读并最小化 | 适合"扫一眼就够了" |
| 卡片下拉 | 同步状态(rerun snapshot) | 不要依赖 ws 自愈 |

### 5.3 会话视图

```
┌──────────────────────────────┐
│ ←  OpenWork · Codex      ⋮   │
├──────────────────────────────┤
│                              │
│  [可滚动的回复历史]           │  ← 上 70%
│  自动滚到底,长按选中          │
│                              │
│  ┌─────────────────────────┐ │
│  │ ⌃ ⌥ ⇧ Esc Tab ↑↓ ←→  🎤│ │  ← 工具条 (sticky 在键盘上)
│  ├─────────────────────────┤ │
│  │ > 输入或粘贴…           │ │  ← 输入区,多行可展开
│  │                  [发送] │ │
│  └─────────────────────────┘ │
└──────────────────────────────┘
```

**输入区是移动端最难的地方,以下细节必须做对:**

- **常驻工具条 (input accessory view)**: `Esc / Tab / Ctrl / Shift / 方向键`,这些 iOS 软键盘没有但 AI CLI 经常需要。可滑动横向显示更多。
- **快捷短语条 (可选第二行)**:用户自定义,默认包含 `continue`、`y`、`n`、`approve`、`cancel`、`/clear`。一键发送。
- **语音输入**: 长按 🎤 按住说话,松开自动转写填入,不直接发送(留人工校对)。中文用 `SFSpeechRecognizer` 系统能力。
- **粘贴检测**: 粘贴长文本时弹"作为代码块发送 / 作为单行发送"选项,避免格式破坏。
- **草稿持久化**: 输入未发送时切走,回来仍在。
- **键盘避让**: WKWebView + native input,不要让 web 端管 keyboard inset(iOS 这一块 webview 行为不可靠)。

### 5.4 通知 (生命线)

**这是用户回到 App 的唯一触发器,必须做扎实。**

- **三类 push (按重要性):**
  1. `attention.waiting` — Claude/Codex 等待确认 → **time-sensitive** 等级,锁屏可见,仍能突破专注模式。
  2. `attention.failed` — CLI 报错或缺失 → **critical**(需要用户授权 entitlement)。
  3. `reply.ready` — 长任务完成 → **default**,合并通知(组 by 项目)。
- **正文带预览前 240 字**(已经在 `cardPreview` 里清洗过)。
- **可操作通知 (Notification Actions)**:
  - 「批准」`approve` — 直接发 `y\n`
  - 「拒绝」`reject` — 发 `n\n`
  - 「打开」 — 跳进 App
- **送达兜底**: 桌面端检测到 push 5 分钟未被读 → 触发 macOS 系统通知(原通道),保证不丢消息。

### 5.5 触觉与音效

- 回复就绪:轻 `UIImpactFeedbackGenerator(.light)`
- 错误/红状态:`.notificationOccurred(.error)` 双震
- 危险命令二次确认弹窗:`.warning` 三震
- 默认无音效(终端用户讨厌系统音)

### 5.6 微交互细节清单 (容易漏的)

- 输入框聚焦时,卡片 header 折叠到 32 px,把屏幕让给键盘。
- WebSocket 断线 → 顶部出现细红条,5s 自动重连,失败转手动按钮,**不弹模态**。
- 卡片预览文本长按可"全选/复制",**不**进入选择终端模式(避免误碰)。
- 切到后台时若有运行中卡片,角标徽章 = 运行中数量。
- App 冷启动 < 1.5 秒到首屏(用 snapshot HTTP 而不是等 ws 握手)。
- 黑暗模式跟随系统,且**默认在移动端就是深色**(终端上下文)。
- 中英文输入法切换不要触发 onSubmit。
- 语音转写出错时保留音频文件可回放,不是直接丢。

---

## 6. iOS 应用技术选型

### 6.1 候选对比

| 方案 | 优点 | 缺点 | 评分 |
|---|---|---|---|
| 纯 SwiftUI | 原生体验最佳,push/后台/触觉/语音零摩擦 | 卡片预览渲染要重写一遍,与 Web 不共享 | 7 |
| 纯 React Native | 复用前端代码,生态好 | 后台 ws / 推送细节难做精,性能调优陷阱多 | 6 |
| **SwiftUI 壳 + WKWebView 渲染**(推荐) | 列表/会话视图渲染走 Web,系统能力(push/后台/触觉/语音/Universal Link)走原生;WKWebView 只渲染 PWA 已有的卡片组件 | 需要定义 native ↔ web bridge | **9** |
| Capacitor | 一次开发跨平台 | App Store 审核风险大,后台 ws 不可靠 | 5 |

### 6.2 SwiftUI + WKWebView 边界

| 由原生负责 | 由 WKWebView 负责 |
|---|---|
| 启动屏 / 配对流程 / 设置 | 卡片列表 (复用 PWA 代码) |
| 推送注册 / Notification Action | 会话视图 (复用 PWA 代码) |
| 后台 silent push 唤醒 | 输入工具条 UI |
| 系统语音 (SFSpeechRecognizer) | 卡片预览渲染 |
| 触觉反馈 | |
| Universal Link 路由 | |
| WebSocket 长连(避免 webview 后台被杀) | |

WebSocket **跑在原生侧** (`URLSessionWebSocketTask`),通过 `webView.evaluateJavaScript` 把事件灌进 PWA。这样 webview 即使被回收,主连接还在,push 唤醒也能直接复用。

### 6.3 后台运行策略

iOS 不允许长时间后台 WebSocket。策略组合:

- 前台 / 短暂后台 (≤ 30 秒): WebSocket 直连。
- 长时间后台 / 锁屏: 静默 push (`content-available: 1`) 唤醒 → 拉一次 `/snapshot` → 决定是否升级为可见 push。
- 桌面端: `bridge.rs` 检测到关键事件且客户端 ws 离线 → 走 APNs。
- App 杀掉后: 完全靠桌面 push,App 启动时再 fetch snapshot。

---

## 7. Web 本地版 (PWA)

### 7.1 形态

- 桌面 Tauri 内置 axum,在 LAN 暴露 `/` 静态资源 + `/ws` + `/api/*`。
- Web 客户端 = 现有 `src/` 复用 + 新建 `src/mobile/` 移动布局入口。
- `vite` 构建产物在桌面应用包内,Tauri 启动时一并 serve。

### 7.2 自适应路由

```ts
// 在 main.jsx 启动前
const isMobile = window.matchMedia('(max-width: 768px)').matches
                  || /iPhone|Android/i.test(navigator.userAgent);
import(isMobile ? './mobile/App.tsx' : './App.tsx');
```

不在同一个组件树里做响应式 — 移动布局组件树独立,免得桌面端的 framer-motion / portal / 多 webview 假设污染移动端。

### 7.3 PWA 关键

- `manifest.json` (display: standalone, theme_color, icons)
- `service-worker.ts`: 缓存 app shell + i18n 包,数据请求不缓存(终端实时)
- "添加到主屏" 提示在第二次访问时弹

### 7.4 LAN 即用流程

1. 桌面打开"启用移动访问"开关 → 控制台打印 `http://192.168.1.42:5174/?otp=ABC123` + QR
2. 手机扫码 → 浏览器打开 → 自动配对 → 进入卡片流
3. iOS 用户提示"添加到主屏" → 下次直接图标进入

---

## 8. 后端改动清单 (Rust)

### 8.1 新文件

```
src-tauri/src/
  bridge/
    mod.rs           # 启停服务、Tauri 命令封装
    server.rs        # axum + ws,路由 / pair / snapshot
    protocol.rs      # serde 类型,与前端共享 JSON schema
    pairing.rs       # OTP / token 生成与校验
    audit.rs         # db.rs 写审计
    push.rs          # APNs (rusoto-apns 或 a2 crate)
```

### 8.2 现有文件改动

- `lib.rs`: 注册新 commands `bridge_start`, `bridge_stop`, `bridge_pair_qr`, `bridge_devices`, `bridge_revoke_device`
- `pty.rs`: 不动核心逻辑,在 `emit` 同时调一份 `bridge::broadcast(...)`
- `db.rs`: 新表 `paired_devices`, `audit_log`, `apns_tokens`
- `provider_sessions.rs`: 不动,客户端读现有字段即可
- `notification.rs`: 复用 `pushNotification` 接入 APNs

### 8.3 依赖

```toml
axum = "0.7"
tokio-tungstenite = "0.21"
tower-http = { version = "0.5", features = ["cors", "trace"] }
qrcode = "0.14"           # 配对二维码
jsonwebtoken = "9"        # device_token
a2 = "0.10"               # APNs HTTP/2
hmac = "0.12"
sha2 = "0.10"
```

---

## 9. 前端改动清单 (TS / React)

### 9.1 新增

```
src/mobile/
  App.tsx
  routes/
    CardListRoute.tsx
    SessionRoute.tsx
    SettingsRoute.tsx
    PairRoute.tsx
  components/
    MobileCard.tsx
    InputBar.tsx
    InputAccessory.tsx
    VoiceButton.tsx
    Connection.tsx
  bridge/
    wsClient.ts
    snapshotApi.ts
    nativeBridge.ts        # 与 iOS 壳通信 (window.webkit.messageHandlers)

src/lib/
  remoteStore.ts           # 与 useTerminalStore 同形,但状态来自 ws
```

### 9.2 复用

- `cardPreview.ts`(已经清洗过,在桌面执行,移动端只展示)
- `providerSession.ts`
- i18n 资源
- types/terminal.ts

### 9.3 不复用

- `headlessPreview.ts` (xterm)、`TerminalView.tsx`、`OverlayBridge.tsx` — 移动端不需要终端模拟器
- `Shell.jsx`、`CreateTerminalDialog.tsx`(改写为移动版)

---

## 10. 关键风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| iOS 后台 ws 被杀 | 高 | 通知漏掉 | 静默 push 唤醒 + 桌面端兜底 push |
| LAN IP 变化 | 中 | 配对失效 | mDNS 广播 (`_threadterm._tcp.local`),客户端自动重发现 |
| 自签 TLS 用户不会装 | 高 | 远程访问门槛 | 默认明文 LAN 模式 + 文档化 Tailscale 路径 |
| 危险命令误触发 | 中 | 数据丢失 | 关键词扫描 + 二次确认 |
| 移动端流量 | 低 | 移动数据费 | 默认只发 preview,不发 raw |
| App Store 审核拒绝 | 中 | 上架延迟 | 强调"远程开发工具",对标 Termius / Blink Shell;不在主流 App 描述里出现 "AI agent" 字样以避免 4.7 误伤 |
| 多设备并发输入冲突 | 低 | 命令交错 | 输入加 client clock 序号,服务端串行化,UI 显示"另一设备正在输入" |

---

## 11. 分阶段实施路线图

> 每个 stage 对齐项目 `IMPLEMENTATION_PLAN.md` 习惯。

### Stage 1 — 桥接基座 (2 周)

**Goal**: 桌面拉起本地 ws server,自有桌面端能通过 ws 连接拿到与 Tauri events 等价的事件。
**Success Criteria**:
- `bridge_start` / `bridge_stop` 可用
- `wscat` 连接后能看到 snapshot + 实时 preview
- 协议 schema 单元测试覆盖 ≥ 80%
**Tests**: Rust 集成测试用 `tokio::test` 跑 ws,前端 `wsClient.test.ts` mock server。

### Stage 2 — Web 移动 PWA (3 周)

**Goal**: 手机浏览器能完成"扫码 → 看到卡片 → 回复 → 收到回复就绪提示"全闭环。
**Success Criteria**:
- 单列卡片流、会话视图、输入工具条、语音
- PWA manifest 通过 Lighthouse ≥ 90
- 端到端在两个真机(iPhone/Android)上各跑 5 个常见任务无回归
**Tests**: 新增 Playwright mobile viewport E2E,覆盖配对、回复、断线重连。

### Stage 3 — iOS 原生壳 (4 周)

**Goal**: SwiftUI 壳 + WKWebView 加载 PWA,接入 APNs 与系统能力。
**Success Criteria**:
- TestFlight 内部 5 个测试者每天用 ≥ 3 次,通知漏报率 < 5%
- 后台 30 分钟回到 App 能在 2 秒内恢复同步状态
- App Store metadata 准备就绪
**Tests**: XCUITest 跑配对 / 通知 action,集成测试用 mock APNs。

### Stage 4 — 远程访问与精修 (2 周)

**Goal**: 远程接入文档化,二次确认与审计齐备,用户可分享一次性"协作 token"。
**Success Criteria**:
- Tailscale 接入 zero-config 通过测试
- 危险命令误触发率 (内部 dogfooding) < 1%
- 审计日志可在桌面端可视化

---

## 12. 待回答的问题 (留给后续讨论)

1. iOS 是否做完全离线的"只读历史"模式(用本地 SQLite 缓存最近 N 张卡片快照)?
2. Web 端是否需要支持桌面浏览器(平板/笔记本)而不仅是手机?如果是,断点策略要明确。
3. 多用户协作(同一桌面多个手机连接)是否进入 v1 范围?当前方案是支持的,但 UX 需要更多设计。
4. 是否提供 watchOS 复杂功能(Glance "正在思考的卡片数")?
5. 危险命令黑名单 vs 白名单 — 一开始走小黑名单(rm/sudo/curl|sh),足够?

---

## 13. 决策需求

需要项目方确认的关键选择:

- [ ] **iOS 技术栈** 确认走 "SwiftUI + WKWebView 混合",而非纯 RN/纯 SwiftUI?
- [ ] **远程访问** 一期不自建中继,只文档化 Tailscale 路径?
- [ ] **危险命令策略** 默认开启二次确认,可在设置里关闭?
- [ ] **审计日志** 默认开启(隐私 vs 可追溯)?
- [ ] **优先级** 先 Web PWA 再 iOS,还是 iOS 优先以建立差异化?

确认以上后即可启动 Stage 1。

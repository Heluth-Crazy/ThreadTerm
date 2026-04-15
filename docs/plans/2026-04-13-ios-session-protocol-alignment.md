# iOS Session Protocol Alignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 iOS 移动端进入项目会话列表和会话详情后的协议错配问题，消除 `connection error: there was bad response from the server`，并完成完整构建与测试验证。

**Architecture:** 以后端 `src-tauri/src/http_server.rs` 的当前 REST/WebSocket 协议为唯一标准，逐项校正 iOS 端路径、查询参数、消息协议和详情页初始化行为。优先修复会话详情自动触发的网络链路，再补充回归测试，避免再次出现旧接口回归。

**Tech Stack:** SwiftUI, URLSession, URLSessionWebSocketTask, Rust Axum backend, XCTest, xcodebuild

---

### Task 1: 复现并定位 bad response 的真实来源

**Files:**
- Inspect: `OpenWorkMobile/OpenWorkMobile/App/ContentView.swift`
- Inspect: `OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionView.swift`
- Inspect: `OpenWorkMobile/OpenWorkMobile/Views/Sessions/PTYOutputView.swift`
- Inspect: `OpenWorkMobile/OpenWorkMobile/Views/History/HistoryView.swift`
- Inspect: `OpenWorkMobile/OpenWorkMobile/Networking/ChatWebSocketClient.swift`
- Inspect: `OpenWorkMobile/OpenWorkMobile/Networking/PTYWebSocketClient.swift`

**Step 1: 抓取运行日志并确认报错来源**

Run:

```bash
xcrun simctl spawn booted log show --style compact --last 10m --predicate 'process == "OpenWorkMobile"'
```

Expected:
- 能看到具体是哪个请求或哪个 WebSocket 握手返回 bad response

**Step 2: 对照会话详情页初始化行为**

检查 `SessionDetailView` 打开时是否同时初始化 Chat、Terminal、History 三个子页面，以及每个页面的 `.task` 是否会立刻发请求。

**Step 3: 记录需要修正的协议项**

输出一个最小修复集合：
- 错误 REST 路径
- 错误 WebSocket 消息类型
- 错误的详情页初始化时机

### Task 2: 修复会话历史接口错配

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Networking/OpenWorkAPIClient.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/HistoryViewModel.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/History/HistoryView.swift`

**Step 1: 写出当前后端真实路径映射**

后端真实路径：

```text
GET /api/session-history
GET /api/session-history/{session_id}/messages
```

**Step 2: 修复 iOS 历史消息请求路径**

将旧的 `/api/session_history` 替换为当前后端路径，并只传后端真正支持的 query 参数。

**Step 3: 确保错误可见**

如果历史请求失败，页面需要展示真实 error，而不是静默落空。

**Step 4: 验证**

Run:

```bash
xcodebuild -project OpenWorkMobile/OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -sdk iphonesimulator -configuration Debug build CODE_SIGNING_ALLOWED=NO
```

Expected:
- Build succeeds

### Task 3: 修复会话详情中的 bad response 主因

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/App/ContentView.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionView.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Sessions/PTYOutputView.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/TerminalViewModel.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Networking/PTYWebSocketClient.swift`

**Step 1: 如果 bad response 来自详情页过早初始化**

延迟非当前 Tab 的网络连接，避免一进入详情页就并发建立 Chat / PTY / History 三条链路。

**Step 2: 如果 bad response 来自 PTY WebSocket**

按后端当前 `/api/pty/{id}/ws` 协议修正连接行为，并确保失败时上抛到 UI，而不是伪装成已连接。

**Step 3: 修复终端连接状态**

不要在发起连接后立即标记 `isConnected = true`，应在真正收到可确认连接建立的事件后再置位。

**Step 4: 验证**

Run:

```bash
xcodebuild -project OpenWorkMobile/OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'platform=iOS Simulator,id=8CA7E0AA-9C41-4F9E-A1EF-FC29B7086D74' test CODE_SIGNING_ALLOWED=NO
```

Expected:
- 现有测试通过
- 无新的 bad response 失败

### Task 4: 修复 Claude/Codex 共用聊天链路的协议错配

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Networking/ChatWebSocketClient.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/SessionViewModel.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionView.swift`
- Inspect: `src-tauri/src/http_server.rs`

**Step 1: 以后端当前 WebSocket 可处理消息为准**

如果后端尚未支持移动端聊天消息，则要么补齐最小兼容层，要么在移动端禁用未实现能力并给出明确提示，而不是卡死在 streaming 状态。

**Step 2: 修复可选链 + try? 吞错问题**

发送失败必须写入可见错误状态。

**Step 3: Claude/Codex 统一路径**

不要只修 `claude-command`；需要确保 codex 分支同样能工作或同样被明确拦截提示。

### Task 5: 增加回归测试并跑完整测试

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobileTests/ConnectionSetupViewPasteTests.swift`
- Modify: `OpenWorkMobile/OpenWorkMobileTests/TokenStorageTests.swift`
- Add/Modify: `OpenWorkMobile/OpenWorkMobileTests/*Session*Tests.swift`

**Step 1: 为本轮协议修复补最小测试**

至少覆盖：
- 错误接口路径不会再次回归
- 关键 ViewModel 失败时能暴露错误，不会静默卡住

**Step 2: 运行全量测试**

Run:

```bash
xcodebuild -project OpenWorkMobile/OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'platform=iOS Simulator,id=8CA7E0AA-9C41-4F9E-A1EF-FC29B7086D74' test CODE_SIGNING_ALLOWED=NO
```

Expected:
- All tests passed

**Step 3: 运行最终构建**

Run:

```bash
xcodebuild -project OpenWorkMobile/OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -sdk iphonesimulator -configuration Debug build CODE_SIGNING_ALLOWED=NO
```

Expected:
- BUILD SUCCEEDED

# iOS Session Protocol Alignment Design

**Context**

当前 `OpenWorkMobile` 的连接入口已经基本恢复，但项目会话列表及其后续详情链路仍混用了旧版 iOS 设计文档里的接口路径和协议。当前 Rust 后端以 `src-tauri/src/http_server.rs` 为准，移动端需要对齐这一实现，而不是继续沿用早期 `/api/session_history`、旧聊天消息协议和未落地的 PTY HTTP 接口。

**Problem**

用户进入移动端项目会话列表及会话详情时会触发 `connection error: there was bad response from the server`。这类错误通常来自 WebSocket 握手阶段收到非 101 响应，或从错误 HTTP 路径拿到了 HTML fallback/401/404。当前代码中已确认至少存在以下错配：

- 健康检查曾请求错误路径 `/api/health`
- 会话历史仍请求错误路径 `/api/session_history`
- 聊天 WebSocket 客户端仍按旧消息协议发送/接收
- 若详情页同时初始化聊天、终端、历史三个子页面，任何一个子页面的旧协议都可能导致用户感知为“进入会话即报错”

**Chosen Approach**

采用“以后端当前协议为唯一真相”的对齐方案，一次性修复会话列表进入详情页后的 REST 与 WebSocket 主链路：

1. 核实 `SessionDetailView` 打开后哪些子页面立即发起网络请求
2. 抓出 `bad response` 的实际请求源
3. 修正 iOS 端对应路径、查询参数和消息协议
4. 对 Claude/Codex 共用链路统一修正，避免只修单一 provider
5. 增加回归测试，至少覆盖 token 粘贴和本轮修复涉及的协议/路径问题

**Scope**

- 修复 iOS 项目会话列表进入后的报错
- 修复 Claude/Codex 共用的会话详情链路中已确认错配的协议
- 跑完整 iOS 构建和测试

**Out of Scope**

- 重新设计移动端信息架构
- 增加全新会话创建能力
- 清理所有历史占位文件

**Implementation Areas**

- `OpenWorkMobile/OpenWorkMobile/App/ContentView.swift`
- `OpenWorkMobile/OpenWorkMobile/Views/Sessions/*.swift`
- `OpenWorkMobile/OpenWorkMobile/Views/History/*.swift`
- `OpenWorkMobile/OpenWorkMobile/Networking/*.swift`
- `OpenWorkMobile/OpenWorkMobile/ViewModels/*.swift`
- `OpenWorkMobile/OpenWorkMobileTests/*.swift`

**Validation**

- 复现并消除 “bad response” 报错
- `xcodebuild ... build`
- `xcodebuild ... test`
- 必要时追加针对会话详情链路的 targeted test

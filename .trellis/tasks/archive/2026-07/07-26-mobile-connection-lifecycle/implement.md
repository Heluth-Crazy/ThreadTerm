# 手机连接状态与自动恢复 · Implementation Plan

## Step 1 — Impact and Tests First

- [x] impact：`useBridgeConnection`、消息解析器、服务端 revoke 路径。
- [x] 固化健康连接、静默断网、撤销、前后台切换的失败测试。

## Step 2 — Heartbeat

- [x] 增加 ping 计时器、最后回应时间和 watchdog。
- [x] socket 替换/关闭时统一清理全部计时器。
- [x] 15 秒超时进入退避重连。

## Step 3 — Revocation Terminal State

- [x] 复用服务端已有 `auth_revoked` / `auth_expired` 原因码，不修改协议版本。
- [x] 核实服务端撤销前发送原因并关闭对应连接的既有测试。
- [x] 移动端停止重连并显示重新配对入口。

## Step 4 — Lifecycle Reconnect

- [x] 页面事件改为健康检查。
- [x] 对重复事件做单次合并。
- [x] 网络恢复后只创建一个新 socket。

## Validation

- [x] 定向 Vitest：34/34。
- [x] Rust bridge tests：64/64。
- [x] 移动端 E2E：16/16（Android Chrome + iOS Safari）。
- [x] typecheck、full Vitest（767/767）、mobile build、Clippy。
- [x] GitNexus detect-changes：仅移动连接链路，medium，无意外业务流程。

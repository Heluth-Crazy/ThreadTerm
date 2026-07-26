# 手机连接状态与自动恢复 · Technical Design

## State Model

移动端连接状态扩展为：

```text
connecting -> open -> reconnecting
                    -> revoked (terminal until re-pair)
                    -> offline
```

`open` 只表示 WebSocket 建立且最近 15 秒收到服务端存活回应。

## Heartbeat

- 移动端每 5 秒发送现有协议 `ping`。
- 服务端继续使用 `pong` 回应。
- 移动端记录最近一次 `pong`/业务消息时间。
- 15 秒无回应则主动关闭旧 socket，进入退避重连。
- 页面隐藏时保持低频心跳；浏览器冻结后恢复时立即探测一次。

## Revocation

现有服务端已经会在关闭被撤销或过期设备前发送带稳定原因码的错误消息：

```text
error { code: "auth_revoked" | "auth_expired", message: "..." }
```

不新增协议消息，也不提升协议版本。移动端收到这两个现有原因码后清除
socket/timer，设置 `revoked`，停止重连。重新配对成功时清除该状态。旧版服务端
没有明确原因码时，移动端仍按普通 close 兼容处理。

## Lifecycle Events

`visibilitychange` / `online` / `pageshow`：

- socket 健康：只发一次 ping。
- socket 非 OPEN 或心跳过期：触发一次受去重保护的 reconnect。
- 不再无条件 `forceReconnect()`。

## Compatibility

- 沿用现有 `ping` / `pong` 与 `error.code`，保持当前协议版本。
- `bridge_stopped` 仍视为可恢复断线；只有 `auth_revoked` / `auth_expired`
  停止自动重连。
- 不把 bearer token 写入日志。

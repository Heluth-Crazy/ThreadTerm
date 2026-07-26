# 手机终端输出连续性与内存边界 · Technical Design

## Desktop Runtime Identity

Bridge 进程启动时生成随机 `runtimeId`，在初始快照、终端快照和增量输出中携带。
现有 PTY `seq` 是所有终端共享的业务输出编号，多卡交错时天然会在单卡内跳号，
不能用于判定丢包。因此 Bridge 另增只在实际广播终端输出时递增的全局
`streamSeq`。移动端按 `(runtimeId, streamSeq)` 判断传输连续性，继续用现有
`seq` 做单卡快照/输出去重。

## Gap Recovery

- `runtimeId` 改变：原地清空所有旧 feed 内容但保留已挂载终端的订阅，应用新快照。
- 同一实例 `streamSeq > lastStreamSeq + 1`：进入一次全局恢复，发送
  `terminal_resync` 请求。缺失输出可能属于任意卡，因此不能错误地只恢复触发
  跳号的那张卡。
- 服务端只向请求设备返回当前状态快照和所有活动终端完整快照，重设水位后继续接收增量。
- 恢复状态和完整画面可能在同一浏览器任务内连续到达，因此 feed 先向已挂载终端发送
  本地 `recovery_boundary`，同步放行下一张完整快照；不依赖 React 重渲染时机。
- `streamSeq <= lastStreamSeq` 作为重复传输忽略；现有 `seq` 仍负责单卡去重。
- 新字段保持可选，旧版服务端没有 `runtimeId` / `streamSeq` 时继续沿用现有
  重连与 backpressure 恢复，不发送新请求。

## State Sync Deadline

桌面端同步采用“短延迟合并 + 1 秒最长等待”。持续输出可以延迟多次短计时器，
但不能越过最长等待。独立查询是否有手机订阅者，只有桥接服务运行且确有手机连接时
才序列化移动快照；不扩充被全仓共用的 `BridgeStatus`，避免高风险公共接口扩散。

## Feed Memory

每卡 bucket 维护增量历史的 UTF-8 字节计数、最近输出和 `truncated` 状态。LRU
全局预算 32 MiB，单卡预算 4 MiB。当前终端快照是有后端上限的恢复基线，不计入
“增量历史”预算且始终保留。裁剪只发生在已经收到并完成顺序确认的移动端展示
缓存，不裁剪桌面 PTY 原始流。

删除/归档卡和 runtime 变化会立即释放旧缓存。截断信息是 feed 的本地状态提示，
在 xterm 外单独显示，不会写入或冒充真实终端字节。

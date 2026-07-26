# 手机终端输出连续性与内存边界 · Implementation Plan

## Protocol

- [x] impact 所有 snapshot/output/feed 消费者。
- [x] 加 `runtimeId`、连续的手机流编号和定向 resync 请求/响应。
- [x] 更新桌面、手机和测试消息类型。

## Sync Deadline

- [x] 为状态同步增加独立最长等待计时器。
- [x] bridge 未运行或没有手机订阅者时不做移动快照序列化。
- [x] 持续输出压力测试断言最大同步间隔。

## Feed Bounds

- [x] feed 按 UTF-8 字节计数。
- [x] 实现单卡 4 MiB、全局 32 MiB LRU。
- [x] 增加截断提示与 bucket dispose。
- [x] runtime 变化时原子清空旧水位和旧内容。

## Validation

- [x] 协议单测、feed 单测、MainTerminal 集成测试。
- [x] 桌面重启/缺口/删除卡 E2E。
- [x] 多卡内存边界与持续同步最长等待压力测试。
- [x] 全量门禁与 detect-changes（入口级范围被标为高风险，771 前端、282 后端、
  20 移动端 E2E 全部通过）。
- [x] 2026-07-27 收口复核：类型检查、代码规范、23 项手机输出/连接检查和
  29 项真实本机 Bridge 检查通过；跨端连续性与内存边界已写入长期规范。

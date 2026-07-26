# 终端输出处理性能与无损保护 · Technical Design

## Recent Text Summary

不采用“直接截 raw tail 再正则清洗”。摘要从末尾按小窗口读取，但每个窗口必须
先校验并移动到完整控制指令边界；遇到横跨窗口的长 OSC/DCS 时跳过控制负载，
再从控制指令之前补足可见字符。有状态的每卡消费器只记住跨 chunk 的解析阶段，
不保留控制负载；最近输出仍只保留 2000 个可见字符。

## Headless Preview

每个 chunk 只 `write` 到 emulator 并标记 dirty。output buffer flush 前读取一次
preview，覆盖该周期内的多次写入。Waiting/EOF/attention 强制 flush 仍保持。

## Bounded Recovery Queue

pending background output 按 UTF-8 字节计数。达到预算时：

1. 标记 `snapshotRequired`；
2. 停止保留更多可由权威快照替代的旧展示数据；
3. 继续完成后端 ACK/流控契约所需的最小状态；
4. IPC 恢复后先 attach snapshot，再恢复增量。

不得假装被替代的增量连续存在。所有转换都有 generation guard。

## Observability

记录 gap、queue high-water、snapshot fallback 和恢复次数，不记录终端内容。

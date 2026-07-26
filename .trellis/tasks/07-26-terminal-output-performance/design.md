# 终端输出处理性能与无损保护 · Technical Design

## Recent Text Summary

不采用“先截 raw tail 再正则清洗”。改为有状态的流式 ANSI 消费器，只保留生成
最近 2000 个可见字符所需的有界状态；跨 chunk 的 escape sequence 保留解析状态。
若复用现有终端 emulator 更安全，则从 emulator 的最近可见行生成摘要。

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

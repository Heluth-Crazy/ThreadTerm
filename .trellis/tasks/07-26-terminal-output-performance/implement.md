# 终端输出处理性能与无损保护 · Implementation Plan

## Baseline

- [x] impact cards slice、headless preview、output buffer、event bridge。
- [ ] 建立 10/100 MiB、ANSI 跨块和 TUI 重绘基准。

## Summary and Preview

- [x] 合并 ANSI 清洗并只保留业务需要的可见尾部。
- [x] preview read 移至 flush 边缘。
- [x] fast flush 使用有界最近文本，避免重复清洗全部积压。

## Bounded Recovery

- [x] 给后台积压增加 4 MiB 字节预算和 high-water 指标。
- [x] 超限转为 snapshot-required，不静默宣称连续。
- [x] IPC 恢复后的 snapshot-first 测试。

## Validation

- [x] 全屏重绘、进度覆盖、跨块控制符和中文宽字符画面测试。
- [x] 生命周期/generation/连续 ACK 失败回归测试。
- [x] full Vitest、typecheck、build、Cargo test。
- [x] detect-changes；输出接收、预览与恢复流程属于本任务预期影响范围。

# 终端输入与后台运行可靠性 · Implementation Plan

## Input and Audit

- [x] impact mobile input、audit、PTY write 路径。
- [x] 增加 per-PTY 有序输入 writer。
- [x] 增加审计专职队列、批量写、失败计数和 shutdown flush。
- [x] 数据库阻塞、队列满、失败与 1000 次输入顺序压力测试。

## Hidden Renderer Flow

- [ ] 复现最小化持续输出。
- [x] 为 background consumer 增加 TTL 和恢复注册。
- [x] 过期 renderer 不参与水位，恢复时走权威快照。
- [x] 多窗口慢/快消费者、过期和接回测试。

## Process Tree

- [ ] impact 所有受管后台进程创建与退出路径。
- [ ] Windows Job Object 管理 app-server 与包装进程树。
- [ ] 正常退出、崩溃退出和 spawn 失败测试。

## Validation

- [x] 输入顺序/延迟/日志失败测试。
- [ ] 最小化 10 分钟压力测试。
- [ ] 退出后进程清单验证。
- [x] 全量 TypeScript、Vitest、Cargo test、Clippy、构建和页面流程。
- [x] detect-changes；终端输入、后台观察者和恢复流程属于预期影响范围。

## Decision Gate

- [ ] Windows Job Object 会改变子进程随 ThreadTerm 退出时的结束语义，
  等用户确认后单独实施和真机核对，不混入本批。

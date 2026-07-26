# 后台网络探测与会话目录性能 · Implementation Plan

## Network Address

- [x] impact bridge status/pair/start/IP parser。
- [x] 隐藏 PowerShell，移入 blocking worker。
- [x] 30 秒 single-flight cache + 手动 refresh。
- [x] 并发只探测一次、普通查询复用缓存的测试。

## Provider Sessions

- [x] Claude 改为有界前缀读取。
- [x] Gemini 扫描移入 blocking worker；Claude 保持既有 blocking worker。
- [x] 保留既有稳定分页与目录缓存。
- [ ] 50 MiB 文件、10k 文件 fixture 测试。

## Bridge Projection

- [x] 核对所有 snapshot/enrich 调用来源。
- [x] 无订阅跳过补全；有订阅才生成发送快照。
- [x] 普通状态同步不再重复广播每个终端的全屏快照。

## Validation

- [x] Rust 定向测试。
- [x] bridge 并发请求测试。
- [x] 全量 Cargo test/Clippy。
- [x] detect-changes；网络探测、审计记录与会话扫描属于预期影响范围。

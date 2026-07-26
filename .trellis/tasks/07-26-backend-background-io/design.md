# 后台网络探测与会话目录性能 · Technical Design

## LAN Address Cache

维护 `(value, collectedAt)` 缓存，TTL 30 秒。普通 status/QR 请求使用缓存；
显式 refresh 绕过缓存。PowerShell 运行放入 blocking worker，并在 Windows
设置隐藏窗口标志。并发 cache miss 通过 single-flight 合并。

## Provider Catalog

- Claude metadata parser 使用 `BufReader` 读取最多 40 行及明确字节上限。
- Gemini/Claude 文件系统扫描放入 blocking worker。
- 目录项先收集轻量 path/mtime，再按 mtime 排序、分页解析。
- cursor 持有稳定的排序边界，不以“扫描前 N 个后丢弃其余”冒充分页。
- 解析缓存按 path + mtime 失效。

## Bridge Snapshot Work

状态 mirror 始终保持轻量权威数据；只有存在订阅者且确实需要发送 snapshot 时
才补全 live PTY 信息。通知和设置变化复用已有卡片投影，避免复制大输出缓冲。

# 终端输入与后台运行可靠性 · Technical Design

## Input Funnel

所有移动输入先通过单一入口完成权限、长度和提交键校验，然后立即写入 per-PTY
有序输入通道。审计元数据复制到独立有界队列，不再同步等待 SQLite。

审计队列：

- 单生产入口、专职写线程；
- 容量 2048；
- 批量事务写入；
- 满队列时不阻塞输入，递增 `auditDropped` 并写限频告警；
- 应用退出最多等待 2 秒 flush；
- 永不保存原始输入。

## PTY Writer

每个 PTY 使用串行 writer worker，async command 只 enqueue。队列关闭、PTY
退出和写失败返回稳定错误，并触发会话状态更新。禁止每次按键单独
`spawn_blocking` 造成乱序。

## Renderer Expiry

renderer 租约由后端单调时钟决定。超过 TTL 的 renderer 不参与最慢水位；
恢复时必须重新注册并取得 attach snapshot。background consumer 同样有明确
TTL，不允许永久成为隐藏水位。

## Windows Process Lifetime

受管后台进程加入应用级 Job Object（kill-on-close）。正常退出先走现有优雅
关闭，再由 Job Object 兜底清理进程树。交互式 PTY 继续使用既有终止流程。

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

每个长期运行的受管后台服务使用独立 Job Object（kill-on-close），不把
ThreadTerm 本身或它为用户打开的外部应用放入全局 Job。进程先以 suspended
状态创建，加入 Job 后才恢复运行，封住“刚启动就生成后代”的逃逸窗口。

正常断连和管理对象释放时主动终止整个 Job；ThreadTerm 崩溃、无法运行 Drop
时，由 Windows 在关闭最后一个 Job 句柄时兜底终止整个进程树。交互式 PTY
继续使用既有终止流程。

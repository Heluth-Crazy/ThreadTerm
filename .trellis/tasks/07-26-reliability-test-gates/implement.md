# 真实断连与多任务质量门禁 · Implementation Plan

## Connection Tests

- [x] heartbeat timeout/recovery、退避上限、重复断线、卸载和换 token 测试。
- [x] Rust 真实 loopback socket 启停、重启、撤销测试。
- [x] Android Chrome / iOS Safari 页面重连、缺口和重启流程（受控连接）。
- [x] Android Chrome 手机页面直连真实 Rust bridge，完成一次性配对、身份校验、
  工作台同步和终端卡片展示，全程不使用 MockWebSocket。
- [x] 真实 bridge 连接主动中断后，页面进入重连状态；停机期间更新电脑端摘要，
  恢复后自动重连、保留原凭证并补回完整状态，连续 10 次通过。
- [x] Android Chrome 与 iPhone WebKit 浏览器内核分别使用独立一次性码直连真实
  bridge，断开恢复链路各连续 10 次通过。
- [ ] 物理手机局域网验收。

## Multi-Terminal Tests

- [x] 3 卡高频交错输出、独立 ACK 和内存边界。
- [x] 输出中删除、桌面 restart 和缺口重同步。
- [x] main/float/background 注册、慢消费者与过期水位测试。

## Windows Acceptance

- [ ] 最小化 10 分钟持续输出。
- [x] Windows 原生进程树清理：正常释放宿主、宿主异常退出、隐藏命令包装器
  三种场景均实际创建进程并通过。
- [x] 所有已知 Git、shell、网络探测后台命令均使用无窗口启动。
- [ ] Release 真机目视确认背景查询无黑框。

## CI

- [x] 扩展 quality workflow：lint、typecheck、Vitest、移动构建、
  Clippy、Cargo test、手机/电脑页面流程。
- [x] 增加每周和手工十轮稳定性 job。
- [x] 本地前端恢复链路、真实 loopback bridge 与真实手机浏览器连接门禁
  各连续 10 次通过。
- [x] 桌面页面流程在业务断言前完成开发模块预热，不复用正在退出的旧服务，
  并使用当前工作台存档版本；7 条完整流程通过。
- [x] detect-changes 和任务结果记录；真机验收项继续保持未完成。

## Real Browser Boundary

- 真实浏览器门禁会启动产品同一套 Rust bridge，并通过真实 HTTP / WebSocket
  完成配对、首屏同步、主动断开、自动重连和离线状态补回。
- 每个浏览器、每一轮都重新启动 bridge 并生成新的配对码，符合“一码一次使用”
  的产品规则。
- 当前门禁运行在本机回环地址，预置测试卡片；它不等同于物理手机、真实 Wi-Fi
  或完整 Tauri 桌面应用验收。

## Windows Run Record · 2026-07-27

- 当前桌面资源与 Rust Release 均重新构建成功；
  `src-tauri/target/release/threadterm.exe` 生成于 06:07，PE 子系统为
  `Windows GUI`，应用自身不会附带控制台窗口。
- `dropping_managed_windows_process_ends_descendant_tree`、
  `managed_windows_process_tree_ends_after_owner_crash`、
  `resolved_cmd_shim_runs_with_hidden_piped_process` 各实际执行 1 次并通过。
- 最小化持续输出和 Release 目视检查未冒充通过：验收时已有另一个
  `cargo run` 调试实例占用 ThreadTerm 单实例锁。为避免中断现有工作台和其它
  agent 会话，本轮未最小化、关闭或接管该窗口。

# 真实断连与多任务质量门禁 · Implementation Plan

## Connection Tests

- [x] heartbeat timeout/recovery、退避上限、重复断线、卸载和换 token 测试。
- [x] Rust 真实 loopback socket 启停、重启、撤销测试。
- [x] Android Chrome / iOS Safari 页面重连、缺口和重启流程（受控连接）。
- [x] Android Chrome 手机页面直连真实 Rust bridge，完成一次性配对、身份校验、
  工作台同步和终端卡片展示，全程不使用 MockWebSocket。
- [ ] 真实 bridge 连接主动中断后的页面重连与全量状态补回。
- [ ] iPhone/WebKit 直连真实 bridge 与物理手机局域网验收。

## Multi-Terminal Tests

- [x] 3 卡高频交错输出、独立 ACK 和内存边界。
- [x] 输出中删除、桌面 restart 和缺口重同步。
- [x] main/float/background 注册、慢消费者与过期水位测试。

## Windows Acceptance

- [ ] 最小化 10 分钟持续输出。
- [ ] 退出后进程树清理。
- [x] 所有已知 Git、shell、网络探测后台命令均使用无窗口启动。
- [ ] Release 真机目视确认背景查询无黑框。

## CI

- [x] 扩展 quality workflow：lint、typecheck、Vitest、移动构建、
  Clippy、Cargo test、手机/电脑页面流程。
- [x] 增加每周和手工十轮稳定性 job。
- [x] 本地前端恢复链路、真实 loopback bridge 与真实手机浏览器连接门禁
  各连续 10 次通过。
- [x] detect-changes 和任务结果记录；真机验收项继续保持未完成。

## Real Browser Boundary

- 真实浏览器门禁会启动产品同一套 Rust bridge，并通过真实 HTTP / WebSocket
  完成配对和首屏同步。
- 每一轮都重新启动 bridge 并生成新的配对码，符合“一码一次使用”的产品规则。
- 当前门禁运行在本机回环地址，预置测试卡片；它不等同于物理手机、真实 Wi-Fi
  或完整 Tauri 桌面应用验收。

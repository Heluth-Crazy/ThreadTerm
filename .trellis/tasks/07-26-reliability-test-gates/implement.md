# 真实断连与多任务质量门禁 · Implementation Plan

## Connection Tests

- [x] heartbeat timeout/recovery、退避上限、重复断线、卸载和换 token 测试。
- [x] Rust 真实 loopback socket 启停、重启、撤销测试。
- [x] Android Chrome / iOS Safari 页面重连、缺口和重启流程。
- [ ] 手机浏览器直连真实桌面 bridge（现有页面流程仍使用受控传输替身）。

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
- [x] 本地前端恢复链路与真实 loopback bridge 各连续 10 次通过。
- [x] detect-changes 和任务结果记录；真机验收项继续保持未完成。

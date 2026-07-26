# 真实断连与多任务质量门禁 · Technical Design

## Test Layers

1. 纯状态机单测：fake timers，快速覆盖所有连接转换。
2. Rust server integration：真实 loopback listener/WebSocket。
3. Mobile browser E2E：真实 socket，控制服务端断开和重启。
4. Desktop multi-renderer：main/float/background 水位与恢复。
5. Windows long-run：最小化、10/100 MiB 输出、进程退出。

MockWebSocket 只用于组件展示，不再作为重连正确性的唯一证据。

## CI Split

- PR 必跑：typecheck、Vitest、Cargo test、关键真实 loopback tests。
- 定时/手工：长时输出、真机浏览器、Windows 进程证据和完整桌面 E2E。
- 所有 job 只读，不发布、不提交。

## Flake Policy

禁止用无限重试掩盖随机失败。每个 flake 记录共享状态、时钟、端口或文件系统
依赖并修复隔离；必要重试必须只覆盖已知外部资源且输出首次失败。

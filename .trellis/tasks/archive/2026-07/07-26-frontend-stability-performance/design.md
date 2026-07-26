# 工作台界面稳定性与渲染性能 · Technical Design

## Stable Ordering

运行卡保留进入当前分组时的稳定 rank；`lastActivity` 只用于初次排序和非 live
卡片。状态边界（start/finish/archive/manual refresh）才更新 rank。

## Render Boundaries

- `TerminalView` / `Shell` 使用显式、可测试的 props 比较。
- 不能只忽略 callback identity；回调必须稳定或纳入比较。
- Sidebar auxiliary actions 比较 icon/loading，不能只比较 key/title。
- NotificationCenter 在关闭分支提前返回，避免 O(N) 标签构建。
- Codex 行组件按 item identity memo；消息摄取与可见绘制分离。

## Surface Recovery

mousedown 仅 focus。完整 fit/refresh/focus-retry 由尺寸变化、renderer 恢复或明确
健康检查失败触发，保留用户手动恢复入口。

## Measurement

使用 React Profiler/测试计数器记录单卡 10Hz 输出时各组件 render 次数，性能
验收同时断言标题、状态、spinner 和 callback 行为。

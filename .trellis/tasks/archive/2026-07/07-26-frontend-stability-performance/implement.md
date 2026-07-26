# 工作台界面稳定性与渲染性能 · Implementation Plan

## Correctness Fixes

- [x] impact CardGrid sort、SidebarRow comparator、notification/codex consumers。
- [x] 先补 spinner 和稳定排序失败测试。
- [x] 修比较器，保持所有可见字段一致。

## Render Isolation

- [x] 为 TerminalView/Shell 建立不受无关父级更新影响的渲染测试。
- [x] memo TerminalView/Shell，稳定上游 callback。
- [x] NotificationCenter 关闭分支不构建映射。
- [x] CodexItemRow memo，隐藏卡只减少绘制不停止摄取。
- [x] 电脑工作台与手机总览共用一次数据订阅，不再完整读取两遍。

## Surface Focus

- [x] 区分普通 focus 与异常恢复。
- [x] 保留 resize/reattach 后完整恢复。

## Validation

- [x] React 单测和渲染次数断言。
- [x] 多卡 10Hz 输出 60 秒（以 600 次交替输出刷新做确定性自动验证）。
- [x] 1000 条 Codex 流式增量在隐藏/恢复后完整测试。
- [x] typecheck、lint、full Vitest、build。
- [x] detect-changes；工作台、终端卡片与会话显示属于预期影响范围。

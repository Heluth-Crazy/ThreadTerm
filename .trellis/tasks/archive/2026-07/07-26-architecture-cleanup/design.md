# 大型模块拆分与废弃代码收口 · Technical Design

## Sequencing Rule

此任务最后执行。先让协议、性能和可靠性逻辑稳定，再按最终职责拆分，避免在功能
仍变化时同时移动代码。

## Rust Bridge Modules

目标边界：

- `runtime`：server start/stop/generation；
- `projection`：card/notification/workbench mirror；
- `preview`：纯预览处理；
- `commands`：Tauri command 薄入口；
- `network`：地址与绑定策略。

锁和跨模块调用方向必须单向，纯函数优先搬迁。

## Frontend Boundaries

`Shell` 先补类型，不一次性重写。提取 hooks 时保持现有 DOM/xterm 实例所有权。
`TerminalManager` 只保留页面协调，模型计算和注册表迁出。

## Dead Code

删除前必须用 `rg`、TypeScript/Rust 编译和 GitNexus impact 三重确认零消费者。
实验代码若仍被测试单独引用，连同无产品价值测试一起删除并记录原因。

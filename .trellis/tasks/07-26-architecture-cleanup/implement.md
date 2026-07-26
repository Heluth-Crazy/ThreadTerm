# 大型模块拆分与废弃代码收口 · Implementation Plan

## Preparation

- [x] 锁定全量测试与现有页面流程基线。
- [x] GitNexus context/impact 建立小清理依赖图。
- [x] 前序功能任务均已独立提交，工作区除工具缓存外稳定后开始大模块搬迁。

## Small Cleanup

- [x] 删除 `replayRecentOutput`。
- [x] 合并 ANSI 清洗实现。
- [x] 删除零生产引用实验渲染脚手架及无效开关。
- [x] `@tauri-apps/cli` 归入开发依赖，并应用不跨大版本的安全更新。

## Module Splits

- [x] bridge 纯函数/preview 先拆。
- [x] bridge projection/runtime/commands 分层。
  - [x] 纯卡片资料组装与项目名派生迁入 projection。
  - [x] 状态镜像与实时终端补全迁入 projection。
  - [x] 网络地址与安全隧道校验迁入 network。
  - [x] 服务生命周期迁入 runtime。
  - [x] Tauri 命令薄入口迁入 commands。
- [x] Shell 类型化并按生命周期拆 hooks。
  - [x] Shell 从 JSX 迁为严格类型的 TSX，保持对外 props 与运行顺序不变。
  - [x] 尺寸、聚焦、可见性恢复与重绘迁入终端表面 hooks。
  - [x] xterm 创建、插件、输入、滚动监听与卸载迁入实例 hook。
  - [x] 输出监听清理、消费租约释放与快照恢复迁入输出生命周期 hook。
  - [x] 实时输出写入、滚动跟随与写入后确认迁入独立输出管线。
  - [x] 会话创建、退出与重连迁入连接生命周期 hook。
- [ ] TerminalManager 模型/注册/协调拆分。
  - [x] 工作区内容标签栏、未保存提示与关闭菜单迁入独立组件。
  - [x] 工作区内容标签状态与文件/差异页协调迁入专用 hook。
  - [x] 移动端工作台镜像调度迁入专用 hook。
  - [ ] 命令面板登记与页面导航协调迁入专用 hook。

## Validation

- [x] 既有 madge 审查确认无循环，本批未新增循环入口。
- [x] TypeScript/Rust 全量门禁。
- [x] 协议、终端输出和页面流程回归测试。
- [x] `npm audit --omit=dev`：生产依赖 0 漏洞；剩余告警仅发布工具，
  需要跨大版本升级，保留确认。
- [x] 已完成本批“小范围清理”的 detect-changes；大模块搬迁尚未开始，
  后续需重新独立检查。

## Conflict Gate

- [x] 开始拆分前确认工作区无重叠功能改动；后端 preview 首步与 UI 文件无交集，
  并保持独立提交。

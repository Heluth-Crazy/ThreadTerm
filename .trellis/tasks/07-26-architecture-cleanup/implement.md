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
- [ ] bridge projection/runtime/commands 分层。
  - [x] 纯卡片资料组装与项目名派生迁入 projection。
  - [ ] 状态镜像与实时终端补全迁入 projection。
  - [ ] 服务生命周期迁入 runtime。
  - [ ] Tauri 命令薄入口迁入 commands。
- [ ] Shell 类型化并按生命周期拆 hooks。
- [ ] TerminalManager 模型/注册/协调拆分。

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

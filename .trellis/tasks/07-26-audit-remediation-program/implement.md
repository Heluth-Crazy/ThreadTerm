# 项目审查整改总计划 · Implementation Plan

## Phase 1 — Planning

- [x] 创建父任务。
- [x] 创建 9 个新子任务。
- [x] 链接既有 `audit-safe-remediation` 子任务。
- [x] 明确文件浏览范围为唯一排除项。
- [x] 完成全部子任务 PRD、设计和实施清单。

## Phase 2 — Execution Order

1. `mobile-connection-lifecycle`
2. `mobile-output-sync-memory`
3. `reliability-test-gates`（随 1/2 同步补门禁）
4. `lan-security-exposure`
5. `terminal-runtime-reliability`
6. `backend-background-io`
7. `frontend-stability-performance`
8. `terminal-output-performance`
9. `architecture-cleanup`

## Integration Gate

- [x] 每个子任务开始前运行 GitNexus impact；高风险范围在修改前已单独告知。
- [x] 完成全批次 detect-changes：68 个代码路径、210 个业务节点，核心连接、输入、
  输出与恢复流程属于预期高影响范围；文件浏览范围不在差异中。
- [x] 协议、持久化、输入、输出和权限契约的变化均有任务与测试记录。
- [x] Desktop/mobile/Rust 定向测试与全量测试通过。
- [x] 不修改文件浏览范围。
- [x] 不提交、不推送，除非用户另行下令。

## 已完成的独立项

- [x] 手机入口改为“本机服务 + 用户提供的 HTTPS 安全隧道”，并校验电脑身份；
  真实隧道和物理手机验收仍在 `lan-security-exposure` 保持开放。
- [x] ThreadTerm 管理的 Windows 后台进程树随宿主结束，正常退出和异常退出均有
  原生进程测试。
- [x] 旧网址 token、任意来源跨域兼容和长期 token 保存方式已下线。
- [x] `bridge`、`Shell`、`TerminalManager` 大模块已经按职责拆分，拆分任务已归档。
- [x] 依赖治理已完成风险收口：Git 分支依赖锁定到明确版本；不执行没有业务收益、
  可能改变功能的盲目跨大版本升级。

## 仍需现场验收

- [ ] 用户选定真实 HTTPS 隧道后，用物理 iPhone/Android 做连接和抓包验收。
- [ ] Windows Release：10 分钟最小化持续输出，以及背景命令无黑框的目视验收。

## 已知提交边界例外

- 2026-07-26 的用户指定工作区 checkpoint 同时包含工作台与首轮整改；其后的安全、
  进程、架构和真实连接门禁均已拆成独立本地提交。全程未推送远端。

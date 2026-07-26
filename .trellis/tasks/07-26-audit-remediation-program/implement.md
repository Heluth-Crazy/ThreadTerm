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

## 本批保留的独立确认项

- [ ] 局域网真正加密与电脑身份校验方案。
- [ ] Windows 进程树随 ThreadTerm 强制结束。
- [ ] 旧网址 token、任意来源跨域兼容和长期 token 保存方式下线。
- [ ] `bridge` / `Shell` / `TerminalManager` 大模块拆分。
- [ ] 发布工具跨大版本升级。
- [ ] Windows Release 真机：10 分钟最小化、浮窗焦点/多屏、黑框和孤儿进程。

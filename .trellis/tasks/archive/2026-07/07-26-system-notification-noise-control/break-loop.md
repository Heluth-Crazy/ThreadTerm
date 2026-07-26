# Bug Analysis: 一个会话重复触发系统通知

## 1. Root Cause Category

- **Category**: B / D / E — Cross-Layer Contract、Test Coverage Gap、Implicit Assumption
- **Specific Cause**:
  - PTY、Supervisor、Codex request 各自把“检测到信号”直接等同于“应发送一次
    OS toast”，缺少统一副作用边界。
  - 4 秒/5 秒/60 秒 cooldown 被错误地当成事件身份；TUI 重绘或粘滞提示超过
    时间窗口后，会被当成全新交互。
  - 通知随机 ID 只能防 React 重放，不能表达“同一卡片、同一次用户输入、
    同一提示”的语义身份。
  - 既有单元测试只覆盖单个生产者，没有覆盖多个检测器同时描述同一请求。

## 2. Why Fixes Failed

1. **延长 PTY debounce**：只能降低频率，无法终止粘滞提示的周期性重发。
2. **按通知 ID 防重**：每次 `pushNotification` 都生成新 ID，无法跨来源合并。
3. **只在某个生产者降级**：会丢失应用内证据，而且其他生产者仍可发送同一
   语义的 OS toast。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Architecture | OS toast 统一经过 `NotificationBridge` 协调器 | DONE |
| P0 | Semantic identity | 使用 `episodeKey + origin + fingerprint`，不再用 cooldown 充当身份 | DONE |
| P0 | Cross-layer contract | Rust PTY payload 增加稳定匹配行 fingerprint，TS 字段保持可选 | DONE |
| P0 | Integration tests | 同 episode 的 PTY/Supervisor/Codex 合并为最高优先级 | DONE |
| P1 | Runtime hygiene | pending timer 卸载清理，processed/episode cache 有界 | DONE |
| P1 | Documentation | 写入前端通知 code-spec 与跨层检查清单 | DONE |

## 4. Systematic Expansion

- **Similar Issues**: 任何同时拥有文本探测和结构化事件的功能，都可能产生重复
  副作用；例如声音、角标、自动打开面板。
- **Design Improvement**: 生产者只描述事实和语义路由，副作用策略由单一边界
  结合焦点、可见性和优先级决定。
- **Process Improvement**: 通知变更必须列出全部生产者，并增加组合测试，不能
  只为单一 detector 写 debounce 测试。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/frontend/quality-guidelines.md`
- [x] 更新 `.trellis/spec/guides/cross-layer-thinking-guide.md`
- [x] 由 task PRD/design/implement 固化触发矩阵、冲突边界和验证命令
- [x] 添加纯策略、Bridge 集成、PTY、Supervisor、Codex 与 Rust 回归测试

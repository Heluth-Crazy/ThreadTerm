# 系统通知降噪与语义去重 — Technical Design

## 1. Architecture

保留现有业务生产者和应用内通知模型，在 OS 边界新增统一协调器：

```text
PTY / Codex request / Supervisor / retry / worktree
                    |
                    v
       terminalStore.pushNotification()
                    |
                    +--> Notification Centre / Workbench（不丢证据）
                    |
                    v
          OsNotificationCoordinator
        [visibility + episode + priority]
                    |
                    v
       notification_send_os / fallback
```

设置页测试通知继续绕过协调器，直接调用 `notification_send_os`。

## 2. Optional Routing Contract

在 `NotificationEntry` 上增加可选路由元数据：

```typescript
type NotificationOrigin =
  | 'pty'
  | 'reply'
  | 'codex_request'
  | 'supervisor'
  | 'auto_restart';

type NotificationFamily =
  | 'interaction'
  | 'completion'
  | 'failure'
  | 'system';

interface NotificationRouting {
  origin: NotificationOrigin;
  family: NotificationFamily;
  episodeKey?: string;
  fingerprint?: string;
}

interface NotificationEntry {
  // existing fields...
  routing?: NotificationRouting;
}
```

兼容性：

- routing 为可选字段；旧 localStorage 记录无需迁移。
- legacy 通知按 `cardId + kind` 推导保守策略。
- `system:worktrees` 不要求修改 UI 生产调用点。

## 3. Episode Semantics

### 3.1 PTY interaction

```text
episodeKey = interaction:<cardId>:<messageCount>
fingerprint = <attention type>:<normalized matched prompt>
```

- 同 generation、同 fingerprint：永久抑制到 generation 或 fingerprint 改变。
- 新用户提交令 `messageCount` 增长，自动重武装。
- Rust attention payload 增加可选 `fingerprint`；旧测试/调用方可缺省。

### 3.2 Reply completion

```text
episodeKey = completion:<cardId>:<messageCount>
fingerprint = normalized reply preview
```

同一次用户输入只产生一次完成 OS toast，且只允许在后台发送。

### 3.3 Codex structured request

```text
episodeKey = interaction:<cardId>:<messageCount>
fingerprint = request key + normalized request summary
```

多个结构化 request 继续全部保留在 pending store 和应用内通知中；短合并窗口内
OS 只需用最高优先级条目提示用户打开该会话。

### 3.4 Supervisor

```text
episodeKey = interaction:<cardId>:<messageCount>
fingerprint = ruleId + normalized sampleText
```

Supervisor store 的应用内防重键改为：

```text
cardId + ruleId + messageCount + normalized sampleText
```

不再把“60 秒过去了”视为相同粘滞提示重新通知的理由。

## 4. OS Coordinator

新增纯逻辑协调器，职责如下：

1. 在接受候选和定时 flush 时都重新读取：
   - `document.hasFocus()`
   - `terminalStore.focusedCardId`
   - `terminalStore.osNotificationsEnabled`
2. 可见性规则：
   - 前台 + 目标卡片可见：drop OS，保留应用内。
   - completed + 前台：drop OS。
   - worktree completed：always drop OS。
   - worktree failed + 前台：drop OS。
3. interaction 候选进入短合并窗口（目标 500ms）。
4. 同 episode 的候选按优先级选择：

```text
codex_request (30) > supervisor (20) > pty (10)
```

5. 已发送 episode：
   - 不同来源的后续候选抑制，避免跨检测器重复。
   - 相同来源只有 fingerprint 改变时才允许重新武装。
6. completion/failure/system 使用各自 episode，不与 interaction 粗暴互斥。
7. sent/pending Map 有容量与时间上限，Bridge 卸载时清理全部 timer。

## 5. PTY Fingerprint

Rust 从当前被 RegexSet 命中的最近一行构造稳定指纹：

```text
<kind>:<collapse-whitespace(last matching line, bounded)>
```

约束：

- 不改变用户可见 message 文案。
- waiting/error 使用各自 RegexSet。
- ANSI 清理沿用现有 cleaned output。
- payload 新字段使用 camelCase，并在 TypeScript 端声明为可选。

## 6. Failure and Fallback Behavior

| Condition | Behavior |
|---|---|
| routing 缺失 | 使用 legacy 分类，不抛错 |
| fingerprint 缺失 | episode 仍可按 generation 防重 |
| app focus API 不可用 | 保守视为后台，避免漏掉关键通知 |
| Rust OS command 失败 | 保留现有 Web Notification fallback |
| Bridge 卸载时有 pending | 取消 timer，不延迟发送幽灵通知 |
| card 已删除 | body 仍可 fallback；策略按 cardId 执行 |

## 7. Concurrency / Conflict Plan

另一位 Agent 的改动属于 UI/CSS；本任务不修改其热区。

明确避让：

- `TerminalManager.tsx`
- `ProjectSidebar.tsx`
- `Shell.jsx`
- `TerminalView.tsx`
- `NotificationSettings.tsx`
- `src/components/workbench/**`
- `src/index.css` / Tailwind / UI primitives

worktree 通知规则由 OS coordinator 识别既有 `system:worktrees` 条目，因此无需修改
两个 UI 生产者。

## 8. Rollback

- routing 字段可选，移除协调器即可恢复旧行为。
- PTY fingerprint 只增加 payload 字段，不改变旧消费者。
- Supervisor generation 字段仅驻留内存，无持久化迁移。
- 每一步保留定向测试，发现通知漏发时可单独回退对应 gate。

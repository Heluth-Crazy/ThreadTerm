# Multica → OpenWork 技术调查报告与迁移方案

> **文档版本**: v1.0  
> **撰写日期**: 2025年7月  
> **目标读者**: OpenWork 核心开发者、技术决策者  
> **摘要**: 本文档基于对 multica-ai/multica 项目的深度技术调研，系统分析其以任务为核心的 Agent 管理架构，并结合 OpenWork 当前代码实际状况，提出三套迁移方案及最优推进路径。

---

## 目录

- [第一部分：Multica 深度技术剖析](#第一部分multica-深度技术剖析)
  - [1.1 Agent 通信机制完整分析](#11-agent-通信机制完整分析)
  - [1.2 任务生命周期状态机](#12-任务生命周期状态机)
  - [1.3 Skills 系统的设计哲学](#13-skills-系统的设计哲学)
  - [1.4 WebSocket 实时系统分析](#14-websocket-实时系统分析)
  - [1.5 Daemon 架构的优势分析](#15-daemon-架构的优势分析)
- [第二部分：OpenWork vs Multica 架构对比](#第二部分openwork-vs-multica-架构对比)
  - [2.1 全维度对比分析](#21-全维度对比分析)
  - [2.2 当前 OpenWork 的痛点量化评估](#22-当前-openwork-的痛点量化评估)
  - [2.3 各自的设计取舍和适用场景](#23-各自的设计取舍和适用场景)
- [第三部分：迁移方案可行性分析](#第三部分迁移方案可行性分析)
  - [3.1 方案 A：渐进式增强（推荐）](#31-方案-a渐进式增强推荐)
  - [3.2 方案 B：双轨并行](#32-方案-b双轨并行)
  - [3.3 方案 C：完全迁移](#33-方案-c完全迁移)
  - [3.4 三方案综合对比](#34-三方案综合对比)
- [第四部分：最优推进路径](#第四部分最优推进路径)
  - [4.1 立即可执行的最小可行方案（1-2周）](#41-立即可执行的最小可行方案12周)
  - [4.2 中期迁移里程碑（1-3个月）](#42-中期迁移里程碑13个月)
  - [4.3 长期目标（3-6个月）](#43-长期目标36个月)
- [第五部分：关键技术决策建议](#第五部分关键技术决策建议)

---

## 第一部分：Multica 深度技术剖析

### 1.1 Agent 通信机制完整分析

Multica 的 Agent 通信体系采用**三层架构**设计：本地 Daemon 进程负责 Agent 生命周期管理和任务执行，通过 REST API 与中心服务器交互，而前端浏览器通过 WebSocket 获得实时推送。这三层之间形成了一个高效的消息流水线。

#### 1.1.1 通信架构全景

整体通信流如下（文字描述的时序图）：

```
┌──────────┐     REST Poll (3s)      ┌──────────────┐     WebSocket Push     ┌──────────┐
│  Daemon   │ ──────────────────────→ │ Multica      │ ──────────────────────→ │  前端     │
│ (本地Go)  │ ←────────────────────── │ Server (Go)  │ ←────────────────────── │ (Next.js) │
│           │     REST Response       │              │     用户操作            │           │
│  ┌──────┐ │                         │  ┌────────┐  │                         │           │
│  │Claude│ │     500ms 批量上报       │  │PostgreSQL│ │                         │           │
│  │Codex │ │  ReportTaskMessages()   │  │ + Redis │ │                         │           │
│  │Gemini│ │ ───────────────────────→│  └────────┘  │                         │           │
│  └──────┘ │                         │  ┌────────┐  │                         │           │
│           │     Heartbeat (15s)     │  │Event   │  │                         │           │
│           │ ───────────────────────→│  │Bus     │  │                         │           │
└──────────┘                         └──────────────┘                         └──────────┘
```

这里有一个关键的设计选择：**Daemon 不使用 WebSocket，而是使用 REST 轮询**。这看似"落后"，但实际上是深思熟虑的架构决策：

1. **可靠性优先**：REST 请求天然幂等，重试简单；WebSocket 断连后重连状态恢复复杂
2. **穿透性强**：REST 可穿越任何 HTTP 代理和防火墙，而 WebSocket 在某些企业网络环境中会被阻断
3. **简化 Daemon 实现**：无需维护持久连接状态，Daemon 代码更简洁

#### 1.1.2 完整的任务执行时序

以一个典型的"用户创建 Issue → Agent 自动执行 → 前端实时看到结果"流程为例：

```
时间轴 ───────────────────────────────────────────────────────────────────→

[用户]                [前端]              [Server]            [Daemon]           [CLI]
  │                     │                    │                   │                 │
  │ 创建 Issue          │                    │                   │                 │
  ├────────────────────→│ POST /api/issues   │                   │                 │
  │                     ├───────────────────→│                   │                 │
  │                     │                    │ EnqueueTask()     │                 │
  │                     │                    │ status=queued     │                 │
  │                     │                    │                   │                 │
  │                     │    WS Push         │                   │                 │
  │                     │←───────────────────│ task:created      │                 │
  │                     │                    │                   │                 │
  │                     │                    │   ← 3秒后 →       │                 │
  │                     │                    │                   │ pollLoop()      │
  │                     │                    │←──────────────────│ ClaimTask()     │
  │                     │                    │ status=claimed    │                 │
  │                     │                    ├──────────────────→│ task 数据       │
  │                     │                    │                   │                 │
  │                     │    WS Push         │                   │ handleTask()    │
  │                     │←───────────────────│ task:claimed      │                 │
  │                     │                    │                   │ StartTask()     │
  │                     │                    │←──────────────────│ PATCH start     │
  │                     │    WS Push         │ status=running    │                 │
  │                     │←───────────────────│ task:started      │                 │
  │                     │                    │                   │ BuildPrompt()   │
  │                     │                    │                   │ Prepare workdir │
  │                     │                    │                   │ 注入 CLAUDE.md  │
  │                     │                    │                   │ 注入 Skills     │
  │                     │                    │                   ├────────────────→│
  │                     │                    │                   │ Execute(prompt) │
  │                     │                    │                   │                 │
  │  [实时消息流 — 每500ms一批]               │                   │←────────────────│
  │                     │                    │                   │ text/thinking   │
  │                     │                    │←──────────────────│ ReportMessages  │
  │                     │    WS Push         │ 写 task_messages  │                 │
  │                     │←───────────────────│ messages          │                 │
  │  看到 Agent 思考过程  │                    │                   │                 │
  │                     │                    │                   │←────────────────│
  │                     │                    │                   │ tool_use        │
  │                     │                    │←──────────────────│ ReportMessages  │
  │                     │    WS Push         │                   │                 │
  │                     │←───────────────────│ tool_use event    │                 │
  │  看到 Agent 调工具    │                    │                   │                 │
  │                     │                    │                   │                 │
  │                     │                    │                   │←────────────────│
  │                     │                    │                   │ CLI 退出        │
  │                     │                    │←──────────────────│ CompleteTask()  │
  │                     │    WS Push         │ status=completed  │                 │
  │                     │←───────────────────│ task:completed    │                 │
  │  看到任务完成 ✓       │                    │                   │                 │
```

这个时序图揭示了几个关键设计：

**a) 三段式状态上报**

任务状态通过 REST API 进行三次关键更新：`ClaimTask()`（声明领取）、`StartTask()`（正式开始）、`CompleteTask()/FailTask()`（最终完成/失败）。这种显式的状态推进确保了即使 Daemon 崩溃，服务器也能准确知道任务停在哪个阶段。

**b) 500ms 消息批量上报机制**

```go
// daemon 内部的 executeAndDrain 函数核心逻辑
ticker := time.NewTicker(500 * time.Millisecond)
var batch []TaskMessage

for {
    select {
    case msg, ok := <-session.Messages:
        if !ok {
            // channel 关闭，flush 剩余消息
            if len(batch) > 0 {
                client.ReportTaskMessages(taskID, batch)
            }
            return
        }
        batch = append(batch, convertMessage(msg))

    case <-ticker.C:
        if len(batch) > 0 {
            client.ReportTaskMessages(taskID, batch)
            batch = batch[:0] // 清空但保留底层数组
        }
    }
}
```

这里 500ms 的间隔经过精心权衡：
- 太短（如 100ms）：HTTP 请求频繁，服务器压力大，在多 Agent 并行时尤其明显
- 太长（如 2s）：用户感知延迟过高，"实时感"丧失
- 500ms 是人类感知的"准实时"阈值——大多数用户不会察觉低于 500ms 的延迟

**c) 工具调用结果截断**

```go
case agent.MessageToolResult:
    // 截断到 8192 字节，防止大文件输出撑爆数据库和网络
    if len(msg.Content) > 8192 {
        msg.Content = msg.Content[:8192] + "\n... [truncated]"
    }
```

这个细节非常重要——AI Agent 的工具调用（如读取大文件、执行 `find` 命令）可能产生数 MB 的输出。不截断会导致：task_messages 表膨胀、WebSocket 推送卡顿、前端渲染卡死。8192 字节足以包含有用信息同时控制成本。

#### 1.1.3 Daemon 的多循环并发模型

Daemon 内部运行着四个独立的 goroutine 循环，形成了一个精密的后台调度系统：

```
┌─────────────────────────────────────────────────────────────────┐
│                         Daemon 进程                              │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────┐  ┌───────────┐ │
│  │ pollLoop    │  │ heartbeat   │  │ gcLoop   │  │ workspace │ │
│  │ 每3秒       │  │ Loop 每15秒  │  │ 定期清理  │  │ SyncLoop  │ │
│  │             │  │             │  │ workdir  │  │ 每30秒     │ │
│  │ 遍历所有    │  │ 向 server   │  │          │  │           │ │
│  │ runtimeID  │  │ 发送心跳    │  │ 清理已完  │  │ 同步本地  │ │
│  │ → ClaimTask│  │ 携带版本号  │  │ 成任务的  │  │ workspace │ │
│  │ → goroutine│  │             │  │ 临时目录  │  │ 列表到    │ │
│  │   执行任务  │  │             │  │          │  │ server    │ │
│  └─────────────┘  └─────────────┘  └──────────┘  └───────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    activeTasks (atomic.Int64)             │   │
│  │  跟踪当前正在执行的任务数量，用于并发控制                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  runtimeIndex: map[string]Runtime                        │   │
│  │  每个 (CLI二进制 × workspace) = 一个 Runtime 注册         │   │
│  │  例: claude@/home/user/project-a = runtime_001           │   │
│  │      codex@/home/user/project-a  = runtime_002           │   │
│  │      claude@/home/user/project-b = runtime_003           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Runtime 的概念**是理解 Multica 调度模型的关键。一个 Runtime = 一个具体的 CLI 工具 + 一个工作区。比如用户同时在 project-a 和 project-b 上工作，且机器上安装了 claude 和 codex 两个 CLI，那么 Daemon 会注册 4 个 Runtime（2 × 2 的组合）。服务器在分配任务时，会基于 Runtime 的能力（哪个 CLI、哪个项目目录）进行精准调度。

### 1.2 任务生命周期状态机

Multica 的任务状态机是整个系统的脊梁。理解这个状态机，就理解了整个任务管理系统的核心逻辑。

#### 1.2.1 状态流转图

```
                    ┌─────────────────────────────────────────┐
                    │                                         │
                    ▼                                         │
              ┌──────────┐                                    │
              │  queued   │ ← EnqueueTaskForIssue()           │
              │  (排队中)  │                                    │
              └────┬─────┘                                    │
                   │ ClaimTask() — Daemon 原子认领              │
                   │ SELECT...FOR UPDATE (悲观锁)              │
                   ▼                                          │
              ┌──────────┐                                    │
              │  claimed  │                                    │
              │  (已认领)  │                                    │
              └────┬─────┘                                    │
                   │ StartTask() — Daemon 准备就绪              │
                   ▼                                          │
              ┌──────────┐                                    │
              │  running  │                                    │
              │  (执行中)  │                                    │
              └──┬───┬──┬┘                                    │
                 │   │  │                                     │
    CompleteTask │   │  │ FailTask()        CancelTask()      │
                 │   │  │                   (用户取消)          │
                 ▼   │  ▼                        │            │
           ┌─────┐  │  ┌────────┐  ┌──────────┐ │            │
           │done │  │  │failed  │  │cancelled │◄┘            │
           │(完成)│  │  │(失败)  │  │(已取消)   │              │
           └─────┘  │  └───┬────┘  └──────────┘              │
                    │      │                                  │
                    │      │ 自动重试 (如果配置了重试策略)        │
                    │      └──────────────────────────────────┘
                    │
                    │ blocked (可选状态)
                    ▼
              ┌──────────┐
              │  blocked  │ ← 依赖其他任务未完成
              │  (阻塞)   │
              └──────────┘
```

#### 1.2.2 ClaimTask 的原子性保障

ClaimTask 是状态机中最关键的转换，因为可能有多个 Daemon 实例（或同一 Daemon 的多个 Runtime）同时尝试认领任务。Multica 使用 PostgreSQL 的 `SELECT ... FOR UPDATE SKIP LOCKED` 来实现无竞争的原子认领：

```sql
-- 伪 SQL，展示核心逻辑
BEGIN;
  SELECT id, issue_id, priority
  FROM agent_task_queue
  WHERE status = 'queued'
    AND runtime_id = $1
  ORDER BY priority DESC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  -- 如果选到了任务
  UPDATE agent_task_queue
  SET status = 'claimed',
      claimed_at = NOW(),
      claimed_by_runtime = $1
  WHERE id = $selected_id;
COMMIT;
```

`SKIP LOCKED` 的妙处在于：如果另一个事务已经锁定了最高优先级任务，当前事务不会阻塞等待，而是跳过它去看下一个可用任务。这确保了高并发场景下的无等待调度。

#### 1.2.3 并发控制策略

```go
// 服务端在 ClaimTask 处理中的并发检查
func (s *TaskService) ClaimTask(ctx context.Context, agentID, runtimeID string) (*Task, error) {
    // 1. 检查 Agent 级别的并发限制
    agent, _ := s.queries.GetAgent(ctx, agentID)
    running, _ := s.queries.CountRunningTasks(ctx, agentID)
    if running >= int64(agent.MaxConcurrentTasks) {
        return nil, nil // 没有容量，返回空（不是错误）
    }

    // 2. 原子认领
    task, err := s.queries.ClaimNextTask(ctx, runtimeID)
    if err != nil || task == nil {
        return nil, err // 没有可用任务
    }

    // 3. 发布事件
    s.eventBus.Publish(events.Event{
        Type:        "task:claimed",
        WorkspaceID: task.WorkspaceID,
        ActorType:   "agent",
        ActorID:     agentID,
        Payload:     task,
    })

    return task, nil
}
```

这里有一个重要的设计：`CountRunningTasks` 计算的是 `agent` 级别而非 `runtime` 级别的正在运行任务数。这意味着如果一个 Agent 配置了 `max_concurrent_tasks = 3`，即使有 10 个 Runtime，同时也只能执行 3 个任务。这防止了资源过载。

### 1.3 Skills 系统的设计哲学

Multica 的 Skills 系统代表了一种"机构记忆"（Institutional Memory）的设计思想——AI Agent 在工作中积累的经验和最佳实践，应该被结构化保存并在后续任务中复用。

#### 1.3.1 技能数据模型

```go
type SkillData struct {
    Name    string          `json:"name"`     // 如 "Go error handling patterns"
    Content string          `json:"content"`  // 技能描述正文（Markdown）
    Files   []SkillFileData `json:"files,omitempty"` // 附带的文件模板
}

type SkillFileData struct {
    Path    string `json:"path"`    // 相对路径，如 ".claude/skills/go-errors.md"
    Content string `json:"content"` // 文件内容
}
```

Skills 不仅仅是文本提示（prompt），它还可以包含**文件**。这使得技能可以是一个完整的模板或配置片段。例如，一个 "React组件最佳实践" 技能不仅包含文字说明，还可以附带 `.eslintrc` 配置片段。

#### 1.3.2 技能注入流程

技能在任务执行准备阶段被注入到工作目录：

```
handleTask(task) 内部流程:
    │
    ├─ 1. 从 task.Skills 获取技能列表
    │
    ├─ 2. 根据 CLI 类型选择注入方式:
    │     ├─ Claude CLI → 写入 .claude/skills/ 目录 或追加到 CLAUDE.md
    │     ├─ Codex CLI → 写入 $CODEX_HOME/skills/ (Codex 原生识别)
    │     ├─ OpenCode  → 追加到 AGENTS.md
    │     └─ Gemini    → 追加到上下文 prompt
    │
    ├─ 3. 注入 runtime config（全局级别的指导文件）
    │     └─ 例如 CLAUDE.md 中的全局项目规范
    │
    └─ 4. 注入任务上下文到 .agent_context/ 目录
          ├─ issue.json       — Issue 的完整信息
          ├─ comments.json    — 相关评论
          └─ prior_session.md — 上次尝试的 session 记录（如果是重试）
```

这种**多格式适配**的注入策略非常实用。不同的 AI CLI 对指导文件的识别方式不同，Multica 通过适配层屏蔽了这个差异。对 OpenWork 来说，这提供了直接可借鉴的方案——OpenWork 已经集成了 Claude、Codex、Cursor 三种 CLI，需要的正是这样一个统一的技能注入层。

#### 1.3.3 技能生命周期

```
        任务执行 → Agent 发现最佳实践 → 保存为 Skill
             │                              │
             ▼                              ▼
        下一个任务 ← 加载已有 Skills ← 技能库 (PostgreSQL structured_skills 表)
```

技能可以关联到：
- **Workspace 级别**：整个项目团队共享
- **Agent 级别**：特定 Agent 的专属技能
- **全局级别**：所有工作区通用

这种分层设计意味着不同层次的知识有不同的共享范围，避免了"一个项目的特殊约定污染其他项目"的问题。

### 1.4 WebSocket 实时系统分析

#### 1.4.1 Hub 架构详解

Multica 的 WebSocket 系统采用经典的 Hub-Client 模式，基于 gorilla/websocket 库：

```go
type Hub struct {
    rooms      map[string]map[*Client]bool  // workspaceID → 在线客户端集合
    broadcast  chan []byte                   // 全局广播通道
    register   chan *Client                  // 客户端注册
    unregister chan *Client                  // 客户端注销
    mu         sync.RWMutex                 // 保护 rooms 的读写锁
}
```

**关键设计特征**：

1. **基于 Workspace 的房间隔离**：每个 Workspace 是独立的"房间"，BroadcastToWorkspace 只向同一 Workspace 的客户端推送。这确保了多团队使用同一 Multica 实例时的数据隔离。

2. **用户定向发送**：SendToUser 可以向特定用户发送消息，同时排除某些 Workspace（避免用户在多个标签页收到重复消息）。

3. **全局 Daemon 事件广播**：Broadcast 通道专门用于 Daemon 心跳、上下线等全局事件。

#### 1.4.2 消息协议

Multica 的 WebSocket 消息采用 JSON 格式，基本结构：

```json
{
  "type": "task:message",
  "workspace_id": "ws_xxx",
  "payload": {
    "task_id": "task_xxx",
    "messages": [
      {"type": "text", "content": "正在分析代码结构..."},
      {"type": "tool_use", "tool": "read_file", "input": {"path": "src/main.go"}},
      {"type": "tool_result", "content": "package main\nimport..."}
    ]
  }
}
```

**消息类型列表**（从 `server/pkg/protocol` 包整理）：

| 类型 | 方向 | 用途 |
|------|------|------|
| `auth` | 客户端→服务端 | 认证（首条消息） |
| `auth_ack` | 服务端→客户端 | 认证确认 |
| `task:created` | 服务端→客户端 | 新任务创建 |
| `task:claimed` | 服务端→客户端 | 任务被 Daemon 认领 |
| `task:started` | 服务端→客户端 | 任务开始执行 |
| `task:message` | 服务端→客户端 | 实时执行消息流 |
| `task:completed` | 服务端→客户端 | 任务完成 |
| `task:failed` | 服务端→客户端 | 任务失败 |
| `task:cancelled` | 服务端→客户端 | 任务取消 |
| `daemon:online` | 服务端→客户端 | Daemon 上线 |
| `daemon:offline` | 服务端→客户端 | Daemon 离线 |
| `invalidate` | 服务端→客户端 | 通知前端刷新缓存 |

#### 1.4.3 已知问题与缺陷

**客户端无心跳发送**：当前实现中，服务端每 54 秒发送 Ping 帧，pongWait 设为 60 秒，但客户端没有主动发送心跳。这意味着：
- 如果网络中间件（如 Nginx、AWS ALB）有 idle timeout（通常 60-120 秒），可能会在 Daemon 空闲时断开连接
- 客户端掉线检测完全依赖 pongWait 超时，最长可能需要 60 秒才能发现

**慢客户端踢除策略**：当 send channel 满时直接踢除客户端。这在极端情况下（如大量 Agent 同时输出）可能导致用户被频繁断连。一个更优的方案是使用消息合并或降采样。

### 1.5 Daemon 架构的优势分析

Multica 的本地 Daemon 进程是整个架构最精妙的设计。它解决了 AI Agent 管理的核心矛盾：**用户需要解放注意力，但 Agent 的执行环境必须在本地**（因为需要访问本地文件系统、Git 仓库、终端环境）。

#### 1.5.1 核心优势

**① 解耦执行与观察**

传统模式下，用户在终端执行 `claude` 命令后必须盯着终端。Daemon 将"执行"和"观察"分离：
- 执行：Daemon 在后台自主运行，无需用户关注
- 观察：用户可以随时通过 Web UI 查看进度，也可以完全不看

**② 自主性调度**

Daemon 的 pollLoop 实现了真正的自主性——它能自动发现并认领任务，无需人工触发。这使得以下场景成为可能：
- 用户在 Issue 中描述了 5 个 bug，Agent 自动依次修复
- 定时任务（通过 Autopilot）自动在凌晨执行代码审查
- PR 创建后自动触发 Agent 进行代码检查

**③ 执行环境隔离**

每个任务在独立的 workdir 中执行：

```go
// execenv.Prepare() 的核心逻辑
func Prepare(task *Task, workspace *Workspace) (*ExecEnv, error) {
    // 基于原始仓库创建工作目录（可能是 worktree 或克隆）
    workdir := filepath.Join(workspace.Path, ".multica", "tasks", task.ID)
    os.MkdirAll(workdir, 0755)

    // 如果有 PriorWorkDir，复用上次的工作目录（Session 恢复）
    if task.PriorWorkDir != "" {
        workdir = task.PriorWorkDir
    }

    // 注入配置文件到工作目录
    injectRuntimeConfig(workdir, workspace.RuntimeConfig)
    injectSkills(workdir, task.Skills)
    injectContext(workdir, task)

    return &ExecEnv{WorkDir: workdir, Env: buildEnvVars(task)}, nil
}
```

这种隔离确保了：
- 并行任务之间不会冲突（各自在不同目录工作）
- 失败的任务不会污染工作区
- 可以方便地回溯和复现问题（workdir 保留了现场）

**④ 多 CLI 适配层**

Daemon 内部的 agent 包提供了统一的接口来启动不同的 CLI：

```go
type Runtime interface {
    Execute(ctx context.Context, prompt string, opts ExecOpts) (*Session, error)
}

// Claude 实现
type ClaudeRuntime struct { /* ... */ }

// Codex 实现
type CodexRuntime struct { /* ... */ }

// 通用 CLI 实现（支持任何命令行工具）
type GenericRuntime struct { /* ... */ }
```

每种 Runtime 知道如何：
- 构造正确的命令行参数
- 解析 CLI 的输出格式
- 处理该 CLI 特有的交互模式（如权限请求）
- 注入正确格式的上下文文件

**⑤ 优雅的生命周期管理**

Daemon 的关闭流程经过精心设计：

```
SIGINT/SIGTERM 信号
    │
    ├─ 1. 停止 pollLoop（不再认领新任务）
    ├─ 2. 等待所有 activeTasks 完成（或超时后强制取消）
    ├─ 3. 向 server 注销所有 Runtime
    ├─ 4. 清理临时文件
    └─ 5. 退出
```

---

## 第二部分：OpenWork vs Multica 架构对比

### 2.1 全维度对比分析

基于对 OpenWork 源码的实际审查（特别是 `src/lib/tauri-bridge.ts`、`src/stores/sessionStatusStore.ts`、`src/stores/liveGridStore.ts`、`src/contexts/WebSocketContext.tsx` 等核心文件），以下是详细的对比分析：

| 维度 | Multica | OpenWork | 差距分析 |
|------|---------|----------|---------|
| **后端运行时** | Go (Daemon + Server 双进程) | Rust (Tauri) + 纯前端 SPA | OpenWork 当前架构为 **Tauri 桌面应用**，后端逻辑在 Rust 层通过 IPC 暴露给前端，无独立 HTTP 服务器进程 |
| **任务管理** | PostgreSQL 任务队列 + 完整状态机 (queued→claimed→running→completed/failed/blocked/cancelled) | Markdown 文件持久化 + 简单 CRUD (open→in_progress→done→failed) | OpenWork 有基础 Task 模型（`tauri-bridge.ts:605`），但仅支持手动状态切换，无自动调度 |
| **会话管理** | 以 Task 为中心，一个 Task 绑定一个 Session | 以 Session 为中心，直接在卡片/终端中操作 | 架构范式不同：Multica 是"任务驱动"，OpenWork 是"会话驱动" |
| **多会话并行** | Daemon 自动管理，max_concurrent_tasks 控制 | LiveGrid 2×2/3×3 网格布局，手动管理卡片 | OpenWork 的 LiveGrid（`liveGridStore.ts`）支持最多 9 个并行会话，但完全需要人工管理 |
| **Agent 自主性** | pollLoop 每 3 秒自动轮询认领 | 用户手动点击触发 | **核心差距**：OpenWork 完全没有自主执行能力 |
| **通信架构** | Daemon↔Server: REST; Server↔Frontend: WebSocket | Tauri IPC（桌面）; WebSocket（Web 模式） | OpenWork 的 WebSocket 仅用于 Web/移动端访问（`WebSocketContext.tsx:26-31`），桌面端使用 Tauri IPC |
| **执行隔离** | 每任务独立 workdir + 环境变量注入 | 共享 PTY 进程 | OpenWork 的 PTY 会话共享同一 shell 环境 |
| **Skills/技能** | 结构化技能系统 (structured_skills 表) | 无 | 缺失 |
| **Session 恢复** | PriorSessionID + PriorWorkDir | 无（会话关闭即丢失） | 缺失 |
| **数据库** | PostgreSQL 17 (关系 + 向量) | Tauri 端使用本地存储 | OpenWork 的 task 数据用 Markdown 文件持久化 |
| **心跳机制** | 服务端 54s ping / 60s pongWait | 客户端 30s ping（`WebSocketContext.tsx:34`） | 两者都有不足，但 OpenWork 的客户端主动 ping 方案实际更健壮 |
| **进度流** | 500ms 批量上报 → 服务端存储 → WS 推送 | PTY 原始输出流 / Tauri 事件 | OpenWork 通过 `pty-output` 事件（`tauri-bridge.ts:102-113`）实时推送终端输出 |
| **Loop/迭代** | 无（任务级别的重试） | LoopRunner（`tauri-bridge.ts:628-657`）：Worker + Verifier 迭代 | **OpenWork 的亮点**：LoopRunner 实现了 worker-verifier 双 Agent 迭代模式，Multica 没有这个 |
| **Autopilot** | Cron 触发自动创建任务 | 无 | 缺失 |
| **前端框架** | Next.js 16 (App Router) + pnpm monorepo | Vite + React 18 SPA + Tauri | 架构风格不同，但前端能力相当 |
| **桌面端** | Electron（`apps/desktop/`）| Tauri（`src-tauri/`）| OpenWork 使用 Tauri 而非 Electron，**这是重要差异**——Tauri 的 Rust 后端具备更强的系统级能力 |

### 2.2 当前 OpenWork 的痛点量化评估

基于实际代码分析，将用户痛点与现有代码能力进行量化对照：

#### 痛点 1：需要人工盯终端 — 严重度 🔴 高

**现状分析**：

OpenWork 的 `SessionStatusStore`（`sessionStatusStore.ts:4-8`）定义了四种状态：

```typescript
export type SessionRuntimeStatus =
  | 'idle'        // 空闲
  | 'processing'  // 处理中
  | 'needs_attention'  // 需要注意
  | 'completed';       // 已完成
```

以及关注原因：
```typescript
export type AttentionReason = 'error' | 'permission' | 'aborted';
```

这说明 OpenWork 已经有了会话状态追踪，但 `needs_attention` 的处理方式仍然依赖用户手动介入。当 `attentionReason` 为 `'permission'` 时（Claude 请求权限），用户必须手动审批。

**量化影响**：假设同时运行 4 个会话（2×2 网格），每个会话每 5 分钟需要一次人工关注（权限审批、错误处理、提供输入），则用户的注意力切换频率为 **每 1.25 分钟一次**，这在深度编码工作中是不可接受的。

#### 痛点 2：多项目并行注意力成本高 — 严重度 🔴 高

**现状分析**：

LiveGrid 支持最多 3×3 = 9 个卡片（`liveGridStore.ts:27-34`），每个卡片对应一个会话：

```typescript
export type GridLayout = '1x2' | '2x2' | '2x3' | '3x3';
```

但所有卡片是"等权重"的——没有优先级、没有自动关注、没有智能路由。用户需要自己视觉扫描所有卡片来发现哪个需要关注。

**量化影响**：在 3×3 布局下，每个卡片占屏幕面积约 11%，文本几乎不可读。实际有用的布局上限约为 2×2（4 个会话），且用户需要频繁切换焦点。

#### 痛点 3：缺少任务排队能力 — 严重度 🟡 中高

**现状分析**：

OpenWork 的 Task 系统（`tauri-bridge.ts:605-625`）仅支持简单的 CRUD：

```typescript
export const tasks = {
  list: (projectPath: string) => ...,
  create: (projectPath: string, title: string, ...) => ...,
  update: (projectPath: string, id: string, updates: ...) => ...,
  delete: (projectPath: string, id: string) => ...,
};
```

关键缺失：
- 没有 `enqueue` / `claim` / `start` 操作
- 没有任务与会话的自动关联（`session_id` 字段存在但需要手动设置）
- 没有任务依赖执行（`deps` 字段存在但无自动调度逻辑）

**量化影响**：用户需要手动为每个任务创建会话、输入提示词、等待完成、再处理下一个。如果有 10 个任务，即使每个只需 5 分钟执行，人工调度开销也至少是 30 分钟（每个任务 3 分钟调度开销 × 10）。

#### 痛点 4：无技能积累 — 严重度 🟡 中

**量化影响**：每次新会话都是"从零开始"。即使用户在 project-a 中已经让 Agent 学会了正确的代码风格，在 project-b 中需要重新教授。按保守估计，每个新会话因缺少上下文而额外产生 2-3 轮低效对话（约 1000-2000 tokens/轮），长期累积的成本不可忽视。

### 2.3 各自的设计取舍和适用场景

#### OpenWork 的设计取舍

**选择**：以 Tauri 为后端，纯前端 SPA + 本地 IPC

**优势场景**：
- **个人开发者、单项目**：快速启动，零配置，打开即用
- **交互式编码**：实时 PTY 终端、代码编辑器、Git 面板——OpenWork 是一个"增强版终端"
- **低资源消耗**：Tauri 的内存占用远低于 Electron（Multica 的桌面方案），适合在开发机上长期运行
- **LoopRunner 特色**：Worker-Verifier 迭代模式是独特优势，适合需要自动验证的重构/修复任务

**不适用场景**：
- 多项目同时自主运行
- 无人值守的长时间任务
- 团队协作（当前为单用户设计）

#### Multica 的设计取舍

**选择**：中心服务器 + 本地 Daemon 分离，面向团队协作

**优势场景**：
- **团队级 Agent 管理**：多人共享 Agent 资源，统一的 Skills 知识库
- **无人值守执行**：Daemon 自主轮询+执行，不需要 UI 在线
- **大规模并行**：理论上可同时运行数十个 Agent 实例
- **审计追溯**：所有消息持久化到 task_messages 表

**不适用场景**：
- 需要快速原型验证的个人开发
- 重度交互式编码（无 PTY 终端能力）
- 对部署复杂度敏感的场景（需要 PostgreSQL + Go Server + Daemon）

---

## 第三部分：迁移方案可行性分析

### 3.1 方案 A：渐进式增强（推荐）

#### 核心思路

在 OpenWork 现有 Tauri + React 架构基础上，参考 Multica 的任务管理模式，在 Rust 后端层实现一个轻量级的任务调度器（Daemon Worker），利用现有的 PTY 管理能力驱动 CLI 执行。

#### 架构设计

```
┌───────────────────────────────────────────────────────────────────┐
│                    OpenWork + Task Harness                        │
│                                                                   │
│  ┌─────────────────────────────────┐   ┌───────────────────────┐ │
│  │         React Frontend           │   │   Tauri Rust Backend  │ │
│  │                                   │   │                       │ │
│  │  ┌────────┐  ┌────────────────┐  │   │  ┌─────────────────┐ │ │
│  │  │LiveGrid│  │ TaskQueuePanel │  │   │  │  TaskScheduler  │ │ │
│  │  │(现有)   │  │ (新增)         │  │   │  │  (新增核心)      │ │ │
│  │  └────────┘  └────────────────┘  │   │  │                 │ │ │
│  │  ┌────────┐  ┌────────────────┐  │   │  │  pollLoop()     │ │ │
│  │  │Chat    │  │ SkillsManager  │  │   │  │  claimTask()    │ │ │
│  │  │(现有)   │  │ (新增)         │  │   │  │  executeTask()  │ │ │
│  │  └────────┘  └────────────────┘  │   │  │  reportStatus() │ │ │
│  │  ┌────────┐  ┌────────────────┐  │   │  └────────┬────────┘ │ │
│  │  │Task    │  │ AutopilotPanel │  │   │           │          │ │
│  │  │Panel   │  │ (新增)         │  │   │  ┌────────▼────────┐ │ │
│  │  │(现有)   │  └────────────────┘  │   │  │   PTY Manager   │ │ │
│  │  └────────┘                       │   │  │   (现有, 增强)   │ │ │
│  │                                   │   │  └────────┬────────┘ │ │
│  │         Tauri IPC / Events        │   │           │          │ │
│  │  ←────────────────────────────────│───│───────────┘          │ │
│  └─────────────────────────────────┘   │  ┌─────────────────┐ │ │
│                                         │  │  SQLite (本地)   │ │ │
│                                         │  │  tasks 表        │ │ │
│                                         │  │  task_messages 表 │ │ │
│                                         │  │  skills 表       │ │ │
│                                         │  └─────────────────┘ │ │
│                                         └───────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

#### 详细实施计划

##### A1. SQLite 任务队列表

在 Tauri Rust 后端中，通过已有的本地存储机制（当前 Task 使用 Markdown 文件），迁移到 SQLite：

```sql
-- 新增 task_queue 表（参考 Multica 的 agent_task_queue）
CREATE TABLE IF NOT EXISTS task_queue (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    prompt TEXT,                    -- Agent 执行的完整 prompt
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','claimed','running','completed','failed','cancelled','blocked')),
    priority INTEGER DEFAULT 0,     -- 优先级，越高越先执行
    provider TEXT DEFAULT 'claude'
        CHECK(provider IN ('claude','codex','cursor')),
    session_id TEXT,                -- 关联的 PTY session
    depends_on TEXT,                -- JSON array of task IDs
    error_message TEXT,
    branch_name TEXT,               -- 完成时的 Git 分支
    work_dir TEXT,                  -- 任务工作目录
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    claimed_at TEXT
);

-- 任务消息流表（参考 Multica 的 task_messages）
CREATE TABLE IF NOT EXISTS task_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES task_queue(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('text','thinking','tool_use','tool_result','error','system')),
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    metadata TEXT   -- JSON，存储 tool_name、input 等
);

-- 技能表
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,         -- Markdown 格式的技能描述
    scope TEXT DEFAULT 'global'
        CHECK(scope IN ('global','project','session')),
    project_path TEXT,             -- scope=project 时关联的项目
    files TEXT,                    -- JSON array of {path, content}
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX idx_task_queue_status ON task_queue(status, priority DESC);
CREATE INDEX idx_task_messages_task ON task_messages(task_id, timestamp);
CREATE INDEX idx_skills_scope ON skills(scope, project_path);
```

**为什么用 SQLite 而非 PostgreSQL**：

OpenWork 是单机桌面应用，SQLite 完全满足需求：
- 不需要网络访问（本地文件）
- 单写者场景下性能极优
- Tauri/Rust 生态中有 `rusqlite` 这样的一流支持
- 部署零依赖（不需要额外安装数据库）
- SQLite 的 WAL 模式支持并发读取，足以应对 Scheduler 写 + 前端读的场景

Multica 用 PostgreSQL 是因为它是多用户服务端应用，需要并发写入和高级查询。OpenWork 不需要。

##### A2. TaskScheduler（Rust 后台 Worker）

在 Tauri Rust 后端中实现一个后台调度器。以下是核心逻辑的伪 Rust 代码：

```rust
// src-tauri/src/task_scheduler.rs (概念设计)

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tokio::time;

pub struct TaskScheduler {
    db: SqlitePool,
    active_tasks: AtomicI64,
    max_concurrent: i64,        // 默认 3
    poll_interval: Duration,    // 默认 3 秒
    running: AtomicBool,
}

impl TaskScheduler {
    /// 启动调度循环
    pub async fn start(&self) {
        let mut interval = time::interval(self.poll_interval);
        while self.running.load(Ordering::Relaxed) {
            interval.tick().await;

            // 检查容量
            let active = self.active_tasks.load(Ordering::Relaxed);
            if active >= self.max_concurrent {
                continue;
            }

            // 尝试认领任务（原子操作）
            if let Some(task) = self.claim_next_task().await {
                self.active_tasks.fetch_add(1, Ordering::Relaxed);

                // 在新的 tokio task 中执行
                let scheduler = self.clone();
                tokio::spawn(async move {
                    let result = scheduler.execute_task(&task).await;
                    scheduler.active_tasks.fetch_sub(1, Ordering::Relaxed);

                    match result {
                        Ok(_) => scheduler.complete_task(&task).await,
                        Err(e) => scheduler.fail_task(&task, &e.to_string()).await,
                    }
                });
            }
        }
    }

    /// 原子认领：利用 SQLite 的事务
    async fn claim_next_task(&self) -> Option<Task> {
        // SQLite 不支持 SKIP LOCKED，但在单进程场景下不需要
        // 使用 IMMEDIATE 事务确保原子性
        sqlx::query_as!(Task,
            "UPDATE task_queue SET status = 'claimed', claimed_at = datetime('now')
             WHERE id = (
                 SELECT id FROM task_queue
                 WHERE status = 'queued'
                   AND (depends_on IS NULL OR NOT EXISTS (
                       SELECT 1 FROM json_each(depends_on) AS dep
                       JOIN task_queue t2 ON t2.id = dep.value
                       WHERE t2.status != 'completed'
                   ))
                 ORDER BY priority DESC, created_at ASC
                 LIMIT 1
             )
             RETURNING *"
        )
        .fetch_optional(&self.db)
        .await
        .ok()
        .flatten()
    }

    /// 执行任务：启动 CLI 子进程
    async fn execute_task(&self, task: &Task) -> Result<()> {
        // 1. 更新状态为 running
        self.update_status(task.id, "running").await;

        // 2. 准备执行环境
        let work_dir = self.prepare_workdir(task).await?;

        // 3. 注入 Skills
        self.inject_skills(&work_dir, task).await?;

        // 4. 构建命令
        let (cmd, args) = match task.provider.as_str() {
            "claude" => ("claude", vec!["-p", &task.prompt, "--output-format", "stream-json"]),
            "codex"  => ("codex", vec![task.prompt.as_str()]),
            "cursor" => ("cursor", vec!["--message", &task.prompt]),
            _ => return Err(anyhow!("Unknown provider")),
        };

        // 5. 启动子进程并流式收集输出
        let mut child = Command::new(cmd)
            .args(&args)
            .current_dir(&work_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        // 6. 消息收集循环（参考 Multica 的 executeAndDrain）
        self.drain_output(task.id, &mut child).await?;

        // 7. 检查退出码
        let status = child.wait().await?;
        if !status.success() {
            return Err(anyhow!("CLI exited with code: {:?}", status.code()));
        }
        Ok(())
    }

    /// 流式收集 CLI 输出（500ms 批量保存到 task_messages）
    async fn drain_output(&self, task_id: &str, child: &mut Child) -> Result<()> {
        let stdout = child.stdout.take().unwrap();
        let reader = BufReader::new(stdout);
        let mut batch = Vec::new();
        let mut interval = time::interval(Duration::from_millis(500));

        loop {
            tokio::select! {
                line = reader.next_line() => {
                    match line? {
                        Some(text) => batch.push(TaskMessage::new(task_id, "text", &text)),
                        None => break, // EOF
                    }
                }
                _ = interval.tick() => {
                    if !batch.is_empty() {
                        self.save_messages(&batch).await?;
                        // 通过 Tauri 事件推送到前端
                        self.emit_to_frontend("task:messages", &batch);
                        batch.clear();
                    }
                }
            }
        }
        // 最后一批
        if !batch.is_empty() {
            self.save_messages(&batch).await?;
            self.emit_to_frontend("task:messages", &batch);
        }
        Ok(())
    }
}
```

##### A3. Skills 注入系统

```rust
// 概念设计：skills_injector.rs

async fn inject_skills(work_dir: &Path, task: &Task, provider: &str) -> Result<()> {
    // 1. 查询全局技能 + 项目级技能
    let skills = db.query_skills(task.project_path).await?;

    for skill in &skills {
        match provider {
            "claude" => {
                // 写入 .claude/skills/<name>.md
                let skill_dir = work_dir.join(".claude").join("skills");
                fs::create_dir_all(&skill_dir)?;
                fs::write(skill_dir.join(format!("{}.md", skill.name)), &skill.content)?;

                // 如果有附带文件，也写入
                if let Some(files) = &skill.files {
                    for f in files {
                        let path = work_dir.join(&f.path);
                        fs::create_dir_all(path.parent().unwrap())?;
                        fs::write(&path, &f.content)?;
                    }
                }
            }
            "codex" => {
                // Codex 原生支持 $CODEX_HOME/skills/
                let codex_home = dirs::home_dir().unwrap().join(".codex").join("skills");
                fs::create_dir_all(&codex_home)?;
                fs::write(codex_home.join(format!("{}.md", skill.name)), &skill.content)?;
            }
            _ => {
                // 通用：追加到 AGENTS.md 或 README 顶部
                let agents_md = work_dir.join("AGENTS.md");
                let mut content = fs::read_to_string(&agents_md).unwrap_or_default();
                content.push_str(&format!("\n\n## Skill: {}\n\n{}\n", skill.name, skill.content));
                fs::write(&agents_md, content)?;
            }
        }
    }
    Ok(())
}
```

##### A4. 前端 UI 改造

需要新增/修改的前端组件：

**新增**：`src/components/task-queue/` — 任务队列管理面板

```tsx
// 概念设计：TaskQueuePanel.tsx
function TaskQueuePanel() {
    const tasks = useTaskQueue();  // 新 hook，从 SQLite 读取

    return (
        <div className="flex flex-col h-full">
            {/* 顶部：快速添加任务 */}
            <TaskQuickAdd />

            {/* 主体：按状态分组的任务列表 */}
            <div className="flex-1 overflow-auto">
                <TaskGroup status="running" tasks={tasks.running} />
                <TaskGroup status="queued" tasks={tasks.queued} />
                <TaskGroup status="completed" tasks={tasks.completed} />
                <TaskGroup status="failed" tasks={tasks.failed} />
            </div>

            {/* 底部：调度器状态 */}
            <SchedulerStatus
                active={tasks.running.length}
                maxConcurrent={3}
                isEnabled={scheduler.isRunning}
                onToggle={scheduler.toggle}
            />
        </div>
    );
}
```

**改造**：现有 `TaskPanel`（`src/components/task-panel/`）升级为支持自动执行

在现有的 `TaskItem` 上添加"自动执行"按钮，点击后将任务放入队列：

```tsx
// 在现有 TaskItem 上添加
<Button
  variant="ghost"
  size="sm"
  onClick={() => enqueueTask(task.id, task.title)}
  title="加入自动执行队列"
>
  <PlayCircle className="h-4 w-4" />
</Button>
```

##### A5. Autopilot Cron 集成

利用 Tauri 的后台能力，实现简单的 Cron 调度：

```rust
// 概念设计：简化版 autopilot
struct Autopilot {
    schedules: Vec<AutopilotRule>,
}

struct AutopilotRule {
    cron_expr: String,       // "0 0 2 * * *" = 每天凌晨2点
    title: String,           // "Nightly code review"
    prompt: String,          // 执行的 prompt
    project_path: String,
    provider: String,
}

impl Autopilot {
    async fn start(&self) {
        for rule in &self.schedules {
            let cron = cron_parser::parse(&rule.cron_expr)?;
            tokio::spawn(async move {
                loop {
                    let next = cron.next_after(Utc::now());
                    tokio::time::sleep_until(next.into()).await;

                    // 创建一个新的排队任务
                    db.enqueue_task(Task {
                        title: rule.title.clone(),
                        prompt: rule.prompt.clone(),
                        provider: rule.provider.clone(),
                        project_path: rule.project_path.clone(),
                        status: "queued",
                        ..Default::default()
                    }).await;
                }
            });
        }
    }
}
```

#### 方案 A 总结

| 项目 | 详情 |
|------|------|
| **预估工作量** | 4-8 周（1-2 名全栈开发者） |
| **改动范围** | Tauri Rust 后端新增约 2000 行，前端新增约 1500 行 |
| **风险等级** | 🟢 低——在现有架构上增量开发，不影响已有功能 |
| **核心收益** | 解决 80% 的人工监控痛点，支持任务排队和自动执行 |
| **主要局限** | 单机限制（SQLite 不支持远程访问），无团队协作 |

### 3.2 方案 B：双轨并行

#### 核心思路

在本地同时运行 Multica Server + Daemon + OpenWork。Multica 负责任务调度和 Agent 执行，OpenWork 作为增强前端提供 PTY 终端、代码编辑、Git 可视化等 Multica 缺少的交互能力。两者通过 HTTP API 桥接。

#### 架构设计

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                               本地开发环境                                    │
│                                                                              │
│  ┌────────────────────────┐         ┌────────────────────────────────────┐   │
│  │    Multica Stack        │         │        OpenWork (Tauri)            │   │
│  │                         │         │                                    │   │
│  │  ┌──────────────────┐  │  HTTP   │  ┌────────────────────────────┐   │   │
│  │  │ Multica Server   │◄─┼─────────┼──│ Multica API Bridge (新增)  │   │   │
│  │  │ (Go, :8080)      │  │         │  │  - 读取任务列表/状态         │   │   │
│  │  │                  │──┼─────────┼─→│  - 同步消息流               │   │   │
│  │  │  PostgreSQL      │  │         │  │  - 转发取消/重试操作         │   │   │
│  │  │  WebSocket Hub   │  │  WS     │  └────────────────────────────┘   │   │
│  │  └──────────────────┘  │         │                                    │   │
│  │  ┌──────────────────┐  │         │  ┌──────────────────────────────┐ │   │
│  │  │ Multica Daemon   │  │         │  │ OpenWork 原有功能             │ │   │
│  │  │  - pollLoop      │  │         │  │  - PTY 终端                  │ │   │
│  │  │  - Agent 执行    │  │         │  │  - 代码编辑器                │ │   │
│  │  │  - Skills 注入   │  │         │  │  - Git 面板                  │ │   │
│  │  │  - 心跳          │  │         │  │  - LiveGrid                  │ │   │
│  │  └──────────────────┘  │         │  │  - LoopRunner                │ │   │
│  └────────────────────────┘         │  └──────────────────────────────┘ │   │
│                                      └────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### 实施要点

##### B1. Multica API Bridge

在 OpenWork 的 Tauri 后端中新增一个 HTTP 客户端，连接 Multica Server：

```rust
// multica_bridge.rs (概念设计)

pub struct MulticaBridge {
    base_url: String,     // 默认 http://localhost:8080
    token: String,        // Multica PAT
    ws_connection: Option<WebSocket>,
}

impl MulticaBridge {
    /// 获取任务列表
    pub async fn list_tasks(&self, workspace_id: &str) -> Vec<MulticaTask> {
        self.get(&format!("/api/workspaces/{}/tasks", workspace_id)).await
    }

    /// 创建新任务
    pub async fn create_task(&self, req: CreateTaskRequest) -> MulticaTask {
        self.post("/api/tasks", &req).await
    }

    /// 订阅实时事件（WebSocket）
    pub async fn subscribe(&mut self, workspace_id: &str) {
        let ws = connect_ws(&format!("{}/ws", self.base_url)).await;
        ws.send(json!({"type": "auth", "payload": {"token": &self.token}})).await;
        self.ws_connection = Some(ws);
    }

    /// 读取消息流并转发给前端
    pub async fn relay_messages(&self, app_handle: &AppHandle) {
        while let Some(msg) = self.ws_connection.as_ref().unwrap().next().await {
            // 转换 Multica WS 消息格式 → OpenWork Tauri 事件格式
            let event = convert_multica_event(msg);
            app_handle.emit_all("multica:event", &event).unwrap();
        }
    }
}
```

##### B2. 统一任务视图

前端需要合并两个来源的任务：
- 本地任务（OpenWork 原有的 Markdown 持久化 + 新增的 SQLite 队列）
- Multica 任务（通过 Bridge 拉取）

```tsx
// 统一任务列表 hook
function useUnifiedTasks() {
    const localTasks = useLocalTasks();
    const multicaTasks = useMulticaTasks();  // 新 hook

    return useMemo(() => {
        // 合并并去重（同一任务可能在两边都有记录）
        return mergeTaskLists(localTasks, multicaTasks);
    }, [localTasks, multicaTasks]);
}
```

##### B3. 本地启动脚本

```bash
#!/bin/bash
# start-with-multica.sh

# 1. 启动 PostgreSQL（如果使用 Docker）
docker compose up -d postgres

# 2. 启动 Multica Server
multica server &

# 3. 启动 Multica Daemon
multica daemon &

# 4. 启动 OpenWork
cd /path/to/openwork && npm run tauri:dev
```

#### 方案 B 总结

| 项目 | 详情 |
|------|------|
| **预估工作量** | 3-5 周（API Bridge + 前端集成） |
| **改动范围** | Tauri Rust 新增约 800 行（Bridge），前端约 1000 行（统一视图） |
| **风险等级** | 🟢 低——两个系统独立运行，互不影响 |
| **核心收益** | 立即获得 Multica 的全部任务管理能力，同时保留 OpenWork 的交互优势 |
| **主要局限** | 本地需要运行 PostgreSQL + Go Server + Daemon + OpenWork 四个进程；依赖 Multica 项目的稳定性 |
| **额外依赖** | 需要安装 Go 运行时、PostgreSQL、Multica 二进制 |

### 3.3 方案 C：完全迁移

#### 核心思路

将 OpenWork 完全迁移到 Multica 的技术栈（Go + Next.js + PostgreSQL），成为 Multica 生态的一部分。OpenWork 的独特功能（PTY 终端、LoopRunner、LiveGrid）作为 Multica 的功能增强。

#### 迁移路线图

```
Phase 1 (月1-2): 后端迁移
├── 将 OpenWork Tauri Rust 后端逻辑移植到 Go
│   ├── PTY 管理 → Go 的 creack/pty 库
│   ├── CLI 集成 → 复用 Multica 的 agent 包
│   ├── SQLite → PostgreSQL
│   └── Tauri IPC → REST API
│
Phase 2 (月3-4): 前端迁移
├── React SPA → Next.js App Router
│   ├── 组件逻辑可大量复用（都是 React）
│   ├── 路由迁移：react-router → App Router
│   ├── 状态管理：Zustand store → 可保留
│   └── 样式：Tailwind 通用，迁移成本低
│
Phase 3 (月5-6): 功能整合
├── 将 LoopRunner 移植到 Multica task 系统
├── 将 LiveGrid 适配到 Multica workspace 概念
├── 整合 Skills 系统
└── 端到端测试和稳定化
```

#### 关键移植难点

**难点 1：PTY 终端移植**

OpenWork 目前通过 Tauri 的 Rust 后端直接管理 PTY（`src-tauri/src/` 中的 PTY 实现）。迁移到 Go 需要使用 `creack/pty` 库。Go 的 PTY 管理在 Linux/macOS 上成熟，但在 Windows 上需要额外的 `conpty` 适配（Go 生态中这部分不如 Rust/Node.js 成熟）。

**难点 2：Tauri → Electron 的倒退**

Multica 的桌面端使用 Electron。如果完全迁移，意味着放弃 Tauri 的小体积和低内存优势，回到 Electron。这可能会遭到现有 OpenWork 用户社区的反对。

**难点 3：monorepo 复杂度**

Multica 使用 pnpm + Turborepo monorepo，包含 `apps/web`、`apps/desktop`、`packages/core`、`packages/ui` 等。OpenWork 的组件需要拆分到这个结构中，拆分过程中容易引入回归 bug。

#### 方案 C 总结

| 项目 | 详情 |
|------|------|
| **预估工作量** | 6-9 个月（2-3 名开发者全职） |
| **改动范围** | 完全重写后端，大幅改造前端 |
| **风险等级** | 🔴 高——长周期、跨技术栈迁移，任何环节失误都可能导致项目停滞 |
| **核心收益** | 获得 Multica 的全部能力，代码统一，长期维护成本低 |
| **主要局限** | 工作量巨大；放弃 Tauri 生态优势；对 Go 后端开发技能有硬性要求 |

### 3.4 三方案综合对比

| 对比维度 | 方案A 渐进增强 | 方案B 双轨并行 | 方案C 完全迁移 |
|---------|--------------|--------------|--------------|
| **解决用户核心痛点** | ✅ 80%+ | ✅ 95%+ | ✅ 100% |
| **工作量** | 4-8 周 | 3-5 周 | 6-9 月 |
| **风险** | 🟢 低 | 🟢 低 | 🔴 高 |
| **部署复杂度** | 🟢 无新依赖 | 🟡 需要 Go + PG | 🔴 完全切换技术栈 |
| **代码自主权** | ✅ 完全自主 | 🟡 依赖 Multica | ❌ 受 Multica 架构约束 |
| **团队协作能力** | ❌ 单机 | ✅ 通过 Multica | ✅ 原生支持 |
| **长期维护** | 🟡 需自行演进 | 🟡 两套系统 | 🟢 统一代码库 |
| **对现有用户的影响** | 🟢 无感知 | 🟡 需学习 Multica | 🔴 完全不同的使用方式 |

**推荐**：先实施方案 A，快速解决用户痛点。在方案 A 稳定后，如果出现团队协作需求，再考虑方案 B 作为过渡。方案 C 仅在团队决定全面投入 Multica 生态时才考虑。

---

## 第四部分：最优推进路径

### 4.1 立即可执行的最小可行方案（1-2周）

#### 目标
在不改动 Tauri Rust 后端的前提下，仅通过**前端改造**实现基础的任务排队和自动执行能力。

#### Milestone 1.1：前端任务队列（第 1 周）

**功能描述**：
- 在 Zustand store 中实现一个内存任务队列
- 用户可以预设多个"待执行任务"（prompt + 项目 + provider）
- 添加一个"自动执行下一个"开关
- 当一个会话完成（`sessionStatusStore` 中状态变为 `completed`）时，自动启动队列中的下一个

**需要修改/新增的文件**：

| 文件 | 操作 | 描述 |
|------|------|------|
| `src/stores/taskQueueStore.ts` | 新增 | 任务队列 Zustand store |
| `src/hooks/useAutoExecutor.ts` | 新增 | 监听 session 状态变化，自动触发下一个任务 |
| `src/components/task-queue/TaskQueuePanel.tsx` | 新增 | 任务队列 UI 面板 |
| `src/components/task-queue/TaskQueueItem.tsx` | 新增 | 单个队列任务组件 |
| `src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx` | 修改 | 在侧边栏添加队列入口 |
| `src/hooks/useSessionStatusTracker.ts` | 修改 | 在 session 完成时触发 auto-executor |

**预估工作量**：3-4 天

**核心代码设计**：

```typescript
// src/stores/taskQueueStore.ts
interface QueuedTask {
  id: string;
  title: string;
  prompt: string;
  projectPath: string;
  provider: 'claude' | 'codex' | 'cursor';
  status: 'queued' | 'running' | 'done' | 'failed';
  createdAt: number;
}

interface TaskQueueState {
  queue: QueuedTask[];
  autoExecute: boolean;        // 自动执行开关
  maxConcurrent: number;       // 最大并行数
  addTask: (task: Omit<QueuedTask, 'id' | 'status' | 'createdAt'>) => void;
  removeTask: (id: string) => void;
  setAutoExecute: (enabled: boolean) => void;
  claimNext: () => QueuedTask | null;
  markDone: (id: string) => void;
  markFailed: (id: string) => void;
  reorder: (fromIndex: number, toIndex: number) => void;
}
```

**技术风险**：🟢 极低——纯前端状态管理，不涉及后端改动。唯一风险是 Zustand 内存状态不持久化（刷新或重启后队列丢失），但可通过 `persist` 中间件写入 localStorage 解决。

#### Milestone 1.2：智能注意力路由（第 2 周）

**功能描述**：
- 在 LiveGrid 中，自动将焦点切换到`needs_attention`的卡片
- 添加全局通知：桌面通知 + 声音提醒
- 在状态栏显示全局任务进度摘要（如 "3 running / 2 queued / 1 needs attention"）

**需要修改/新增的文件**：

| 文件 | 操作 | 描述 |
|------|------|------|
| `src/hooks/useAttentionRouter.ts` | 新增 | 监听 sessionStatusStore，自动聚焦需要注意的卡片 |
| `src/components/status-strip/` | 修改 | 底部状态栏添加全局任务摘要 |
| `src/utils/notifications.ts` | 修改 | 添加桌面通知逻辑 |
| `src/components/live-grid/view/LiveCard.tsx` | 修改 | 添加视觉优先级指示器（如红色边框表示需要注意） |

**预估工作量**：2-3 天

**技术风险**：🟢 低——利用现有的 `sessionStatusStore` 和 `liveGridStore`。

### 4.2 中期迁移里程碑（1-3个月）

#### Milestone 2.1：Rust 后端 TaskScheduler（月 1）

**功能描述**：
在 Tauri Rust 后端实现完整的 TaskScheduler，包括：
- SQLite 任务队列（替代前端内存队列）
- 后台调度循环（poll → claim → execute）
- CLI 子进程管理
- 500ms 消息批量上报

**需要修改/新增的文件**：

| 文件 | 操作 | 描述 |
|------|------|------|
| `src-tauri/src/task_scheduler.rs` | 新增 | 核心调度器 |
| `src-tauri/src/task_db.rs` | 新增 | SQLite 任务表操作 |
| `src-tauri/src/cli_executor.rs` | 新增 | CLI 子进程执行器 |
| `src-tauri/src/main.rs` | 修改 | 注册新的 Tauri commands 和启动调度器 |
| `src-tauri/Cargo.toml` | 修改 | 添加 rusqlite、tokio-cron 等依赖 |
| `src/lib/tauri-bridge.ts` | 修改 | 添加 task_scheduler 相关 IPC 调用 |

**预估工作量**：2-3 周

**技术风险**：🟡 中——Rust 异步编程 + CLI 子进程管理有一定复杂度，特别是 Windows 平台的兼容性。

#### Milestone 2.2：Skills 系统 V1（月 2）

**功能描述**：
- SQLite 技能存储
- 手动创建/编辑/删除技能
- 任务执行前自动注入技能到工作目录
- 支持 Claude、Codex 两种注入格式

**需要修改/新增的文件**：

| 文件 | 操作 | 描述 |
|------|------|------|
| `src-tauri/src/skills.rs` | 新增 | 技能 CRUD 和注入逻辑 |
| `src/components/skills/SkillsManager.tsx` | 新增 | 技能管理 UI |
| `src/components/skills/SkillEditor.tsx` | 新增 | 技能编辑器（Markdown） |
| `src-tauri/src/task_scheduler.rs` | 修改 | 在执行前调用技能注入 |

**预估工作量**：1-2 周

**技术风险**：🟢 低——CRUD + 文件写入，逻辑清晰。

#### Milestone 2.3：Autopilot V1（月 3）

**功能描述**：
- Cron 表达式解析和调度
- 定时自动创建排队任务
- 简单的 Autopilot 管理 UI

**需要修改/新增的文件**：

| 文件 | 操作 | 描述 |
|------|------|------|
| `src-tauri/src/autopilot.rs` | 新增 | Cron 调度器 |
| `src/components/autopilot/AutopilotPanel.tsx` | 新增 | Autopilot 规则管理 UI |
| `src-tauri/src/main.rs` | 修改 | 启动 Autopilot |

**预估工作量**：1 周

**技术风险**：🟢 低——成熟的 cron 库（`cron` crate）+ 简单的任务入队。

### 4.3 长期目标（3-6个月）

#### Milestone 3.1：Session 恢复与 Git Worktree 隔离（月 4）

**功能描述**：
- 任务执行使用 Git worktree 实现目录隔离
- 任务失败时保留现场，支持"恢复"操作
- 恢复时复用上次的 worktree 和 session 上下文
- 支持 `PriorSessionID` + `PriorWorkDir` 模式

**需要修改/新增的文件**：

| 文件 | 操作 | 描述 |
|------|------|------|
| `src-tauri/src/workdir_manager.rs` | 新增 | Git worktree 管理 |
| `src-tauri/src/session_recovery.rs` | 新增 | Session 恢复逻辑 |
| `src-tauri/src/task_scheduler.rs` | 修改 | 集成 worktree 和恢复 |
| `src/components/task-queue/TaskQueueItem.tsx` | 修改 | 添加"恢复"按钮 |

**预估工作量**：2-3 周

**技术风险**：🟡 中——Git worktree 在某些场景下有坑（如未提交的更改、子模块等）。

#### Milestone 3.2：进程内事件总线（月 5）

**功能描述**：
参考 Multica 的 `events/bus.go`，在 Rust 后端实现一个进程内事件总线，解耦各模块之间的直接调用：
- TaskScheduler 发布 `task:started`、`task:completed` 等事件
- Autopilot 订阅 `task:completed` 来触发后续逻辑
- 前端通过 Tauri 事件桥接接收所有事件

```rust
// 事件定义
enum AppEvent {
    TaskCreated { task_id: String },
    TaskStarted { task_id: String },
    TaskCompleted { task_id: String, branch: Option<String> },
    TaskFailed { task_id: String, error: String },
    SkillLearned { skill_id: String },
}
```

**需要修改/新增的文件**：

| 文件 | 操作 | 描述 |
|------|------|------|
| `src-tauri/src/event_bus.rs` | 新增 | 事件总线 |
| `src-tauri/src/task_scheduler.rs` | 修改 | 发布事件 |
| `src-tauri/src/autopilot.rs` | 修改 | 订阅事件 |
| `src/hooks/useAppEvents.ts` | 新增 | 前端事件消费 |

**预估工作量**：1-2 周

**技术风险**：🟢 低——Rust 的 `tokio::sync::broadcast` 提供了开箱即用的进程内广播。

#### Milestone 3.3：智能技能积累（月 6）

**功能描述**：
- 任务完成后，自动分析 Agent 的输出，提取潜在的最佳实践
- 以建议形式呈现给用户，确认后保存为 Skill
- 类似 Multica 的"Agent 自主学习"能力

**预估工作量**：2-3 周

**技术风险**：🟡 中——需要 LLM 分析 Agent 输出，准确率和成本是挑战。

---

## 第五部分：关键技术决策建议

### 5.1 数据库选型：SQLite vs PostgreSQL

**建议：保持 SQLite，不迁移到 PostgreSQL**

理由：

1. **场景匹配**：OpenWork 是单用户桌面应用。SQLite 在单写者场景下的性能（约 50,000 INSERT/s）远超需求。即使最繁忙的任务队列，每秒也不会超过 10 次写入。

2. **零部署依赖**：SQLite 是嵌入式数据库，随应用分发。如果要求用户安装 PostgreSQL，会大幅提高使用门槛——这与 OpenWork "开箱即用"的定位矛盾。

3. **并发读取够用**：SQLite WAL 模式支持一写多读，TaskScheduler 写入 + 前端读取的模式完全够用。

4. **缺少的特性可以替代**：
   - `SKIP LOCKED`：单进程不需要（使用 SQLite 的 IMMEDIATE 事务即可）
   - `pgvector`：如果未来需要向量搜索，可使用 `sqlite-vss` 扩展
   - `LISTEN/NOTIFY`：使用 Tauri 事件系统替代

**何时考虑 PostgreSQL**：当 OpenWork 增加"多用户服务端模式"时（类似 Multica 的 SaaS 部署），届时再迁移。

### 5.2 Daemon 实现语言：Rust（Tauri 内嵌） vs Node.js vs Go

**建议：使用 Rust，内嵌在 Tauri 后端中**

| 选项 | 优势 | 劣势 | 推荐度 |
|------|------|------|--------|
| **Rust (Tauri 内嵌)** | 零额外进程；利用现有 Tauri 基础设施；性能最优 | 开发门槛较高；生态中 CLI 管理库较少 | ⭐⭐⭐⭐⭐ |
| **Node.js (独立进程)** | 团队熟悉度高；npm 生态丰富 | 需要额外进程；内存占用较高；需要单独的 IPC 机制 | ⭐⭐⭐ |
| **Go (独立二进制)** | 与 Multica 代码可互通；并发模型优秀 | 需要额外二进制分发；增加构建复杂度 | ⭐⭐ |

**核心理由**：

OpenWork 已经使用 Tauri（Rust）作为后端。在现有的 Tauri 进程中添加一个 `tokio::spawn` 后台 task 来实现调度器，比启动一个新的 Node.js 或 Go 进程要简洁得多：

```rust
// 在 Tauri main.rs 中
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            // 启动 TaskScheduler（作为 tokio task 运行在同一进程中）
            tauri::async_runtime::spawn(async move {
                let scheduler = TaskScheduler::new(handle);
                scheduler.start().await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

这意味着：
- 用户不需要手动启动任何额外服务
- 调度器和 Tauri IPC 共享同一个进程，通信零延迟
- 应用关闭时调度器自动关闭，生命周期管理简单

### 5.3 Skills 系统设计：与现有 CLI 集成

**建议：采用 Multica 的多格式适配方案，但简化为两层**

```
Skills 存储
├── 全局级 (Global)
│   └── 所有项目共享的通用技能
│       例: "Always use TypeScript strict mode"
│           "Follow conventional commits"
│
└── 项目级 (Project)
    └── 绑定到特定 project_path
        例: "This project uses Tailwind CSS with HSL variables"
            "Use react-i18next for all user-facing strings"
```

**注入策略**：

```
TaskScheduler.execute_task()
    │
    ├─ 加载 全局 Skills + 当前项目 Skills
    │
    ├─ 按 provider 类型选择注入方式:
    │
    ├─ Claude:
    │   ├─ 优先: 写入 .claude/skills/{name}.md (Claude Code 原生识别)
    │   └─ 回退: 追加到 CLAUDE.md
    │
    ├─ Codex:
    │   └─ 写入工作目录的 AGENTS.md 或 codex 配置文件
    │
    └─ Cursor:
        └─ 写入 .cursor/rules/ 目录 (Cursor Rules 格式)
```

**与现有集成的兼容性**：

OpenWork 当前通过 `tauri-bridge.ts` 的 `sessions.create()` 启动 CLI 会话（`tauri-bridge.ts:280-310`）。技能注入应该在 `sessions.create()` 之前执行：

```typescript
// 修改后的执行流程
async function executeTask(task: QueuedTask) {
    // 1. 注入技能 (新增)
    await skills.inject(task.projectPath, task.provider);

    // 2. 创建会话 (现有)
    const sessionId = await sessions.create({
        projectPath: task.projectPath,
        provider: task.provider,
        prompt: task.prompt,
        // ...
    });

    // 3. 关联任务和会话
    await taskQueue.markRunning(task.id, sessionId);
}
```

### 5.4 WebSocket 架构：现有架构改造建议

**建议：保持现有架构，小幅增强**

OpenWork 当前的 WebSocket 使用分为两种模式：
- **Tauri 桌面端**：使用 Tauri IPC 事件（`listen`/`emit`），不走 WebSocket
- **Web/移动端**：通过 `WebSocketContext.tsx` 连接后端 WebSocket

对于方案 A（渐进式增强），不需要大改 WebSocket 架构。TaskScheduler 在 Tauri Rust 层运行，通过 Tauri 事件直接通知前端：

```rust
// TaskScheduler 中
app_handle.emit_all("task:status-changed", &TaskStatusEvent {
    task_id: task.id.clone(),
    new_status: "running".to_string(),
})?;

app_handle.emit_all("task:message", &TaskMessageEvent {
    task_id: task.id.clone(),
    messages: batch.clone(),
})?;
```

前端通过现有的 `TauriEventContext` 监听：

```typescript
// src/hooks/useTaskEvents.ts
useEffect(() => {
    const unlisten = listen<TaskStatusEvent>('task:status-changed', (event) => {
        taskQueueStore.updateStatus(event.payload.task_id, event.payload.new_status);
    });
    return () => { unlisten.then(fn => fn()); };
}, []);
```

**需要改造的部分**：

仅当 Web 模式（非 Tauri）需要任务功能时，才需要扩展 WebSocket 协议。建议在现有消息类型集合（`CHAT_MESSAGE_TYPES`，`WebSocketContext.tsx:56-69`）中添加：

```typescript
const TASK_MESSAGE_TYPES = new Set([
    'task-created',
    'task-status-changed',
    'task-message',
    'task-completed',
    'task-failed',
    'scheduler-status',
]);
```

### 5.5 Session 恢复机制：在 OpenWork 中的实现建议

**建议：基于 Git Worktree + 任务快照实现**

Session 恢复解决的核心问题是：当一个任务失败或被中断时，能够从上次的状态继续执行，而不是从头开始。

**实现方案**：

```
任务首次执行:
    1. git worktree add .openwork/tasks/{task_id} -b task/{task_id}
    2. 在 worktree 目录中注入 Skills 和上下文
    3. 启动 CLI 执行
    4. 保存 session 快照到 SQLite:
       - 最后一次 CLI 输出
       - 使用的 prompt
       - 工作目录路径
       - Git commit SHA

任务恢复:
    1. 检查 .openwork/tasks/{task_id} worktree 是否存在
    2. 如果存在 → 在同一目录中启动新的 CLI session
    3. 构建恢复 prompt:
       "你上次在处理以下任务时中断了：{original_prompt}
        上次的工作进度：{last_output_summary}
        请继续完成任务。"
    4. 执行并更新快照
```

**恢复 prompt 构建**（参考 Multica 的 `prior_session.md` 注入）：

```rust
fn build_recovery_prompt(task: &Task, prior_session: &SessionSnapshot) -> String {
    format!(
        r#"## 任务恢复上下文

### 原始任务
{}

### 上次执行摘要
- 状态: {} (在 {} 中断)
- 最后输出:
```
{}
```

### 请求
请继续完成上述任务。工作目录已保留上次的状态，你可以直接查看文件了解进度。"#,
        task.prompt,
        prior_session.status,
        prior_session.interrupted_at,
        &prior_session.last_output[..min(2000, prior_session.last_output.len())]
    )
}
```

**关键注意事项**：

1. **Worktree 清理策略**：已完成的任务应在一定时间后（如 7 天）自动清理 worktree，防止磁盘占用过大。参考 Multica 的 `gcLoop`。

2. **合并回主分支**：任务完成后，需要引导用户将 worktree 分支的更改合并回主分支。可以在 TaskQueuePanel 中添加"合并"按钮。

3. **冲突处理**：如果多个任务同时在不同 worktree 中修改了相同文件，合并时会产生冲突。需要在 UI 中提供冲突可视化和解决工具（OpenWork 已有的 `DiffViewer` 组件可以复用）。

---

## 附录 A：总体推荐实施顺序

```
第 1-2 周    Milestone 1.1 前端任务队列 + Milestone 1.2 智能注意力路由
             → 立即减轻 50% 人工监控压力

第 3-6 周    Milestone 2.1 Rust TaskScheduler
             → 实现真正的后台自动执行，减轻 80% 人工监控压力

第 7-8 周    Milestone 2.2 Skills V1
             → 消除重复教学成本

第 9 周      Milestone 2.3 Autopilot V1
             → 支持定时任务，实现无人值守

第 10-12 周  Milestone 3.1 Session 恢复 + Worktree 隔离
             → 提升任务成功率和可靠性

第 13-14 周  Milestone 3.2 事件总线
             → 系统解耦，为后续功能铺路

第 15-17 周  Milestone 3.3 智能技能积累
             → 系统自主学习能力
```

## 附录 B：关键技术参考

| 参考来源 | 路径/位置 | 借鉴价值 |
|---------|-----------|---------|
| Multica Daemon | `server/internal/daemon/daemon.go` | pollLoop、heartbeat、任务执行流程 |
| Multica 任务状态机 | `server/internal/service/task.go` | ClaimTask 原子操作、并发控制 |
| Multica 消息上报 | `server/internal/daemon/execute.go` | 500ms 批量 flush 机制 |
| Multica Skills | `server/internal/daemon/types.go` | SkillData 数据结构、注入策略 |
| Multica 事件总线 | `server/internal/events/bus.go` | 进程内 pub/sub 模式 |
| Multica WebSocket | `server/internal/realtime/hub.go` | Room 隔离、慢客户端处理 |
| OpenWork Session 状态 | `src/stores/sessionStatusStore.ts` | 现有状态模型（复用） |
| OpenWork LiveGrid | `src/stores/liveGridStore.ts` | 现有多会话管理（增强） |
| OpenWork 任务模型 | `src/lib/tauri-bridge.ts:605-625` | 现有 Task 接口（扩展） |
| OpenWork LoopRunner | `src/lib/tauri-bridge.ts:628-657` | Worker-Verifier 模式（独特优势，保留） |

---

> **结论**：Multica 的以任务为核心的 Agent 管理架构是一套成熟的设计，其 Daemon + 任务队列 + Skills 的组合有效解决了 AI Agent 自主执行的核心问题。对于 OpenWork 而言，**方案 A（渐进式增强）**是最优选择——它允许在保持现有架构优势（Tauri 轻量、LoopRunner 迭代、PTY 交互）的同时，引入 Multica 的关键理念（任务排队、自动认领、技能复用）。预计经过 4-8 周的开发，即可实现 80% 以上的核心痛点解决，同时保持代码自主权和架构简洁性。

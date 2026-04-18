# OpenWork feat/paseo-iteration 缺陷评估报告

**评估日期**: 2025-07-18  
**评估分支**: `feat/paseo-iteration` (HEAD: `803f882`)  
**评估范围**: 最近 6 次提交引入的变更  

---

## 第一部分：已知 Bug 深度分析

---

### Bug 1：Codex split view 右侧 terminal 一直显示"正在连接到 shell"

**优先级**: P0

**问题描述**  
在 Codex split view 模式下，右侧终端（`Shell.jsx` 组件，`isPlainShell=false, provider=codex`）永远停留在"正在连接到 shell…"的 spinning 状态，无法正常显示终端输出。

**根因分析**

核心问题在于 **Tauri PTY 事件监听器的双重注册冲突** 和 **Claude 专有启动路径导致 Codex 走 fallback 逻辑**。

**1. 双重 `pty.onOutput` 监听器冲突**

- `TauriEventContext.tsx` 第 270-276 行：全局 `useEffect` 注册了一个 `pty.onOutput` 监听器，用于解析 AI session 的 JSON 输出（`parsePtyOutput`）。
- `Shell.jsx` 第 234-251 行：`connectWebSocket → setupPty` 中 **又注册了一个** `pty.onOutput` 监听器，用于将原始输出写入 xterm 终端。

这两个监听器都通过 `pty.onOutput()` 注册，底层是 Tauri 的 `listen('pty-output', ...)` — 两个监听器会**同时接收到所有 PTY 的输出事件**。但 `Shell.jsx` 中的监听器仅通过 `if (sid === ptySessionId)` 过滤（第 235 行），而 `TauriEventContext.tsx` 的监听器调用 `parsePtyOutput(id, data)` 对每一行尝试 JSON 解析。

对于 Codex split view 右侧终端的普通 shell PTY（`isPlainShell=false, shellProvider=codex`），`Shell.jsx` 第 291-292 行：
```js
} else if (shellProvider === 'codex') {
  connectedPtyId = await pty.create(ptySessionId, projectPath, rows, cols);
```
这里创建的是一个 **普通 PTY shell**（等效于 `isPlainShell`），而不是 `ai.startSession`。

**2. 但实际上 `setConnected(true)` 应该被调用了**

查看 `Shell.jsx` 第 332 行，`setConnected(true)` 在 `setupPty()` async 函数的末尾，在 `pty.create()` 成功返回后立即执行。如果 `pty.create()` 本身没有抛出异常，`setConnected(true)` 会被执行。

**3. 真正的根因：`pty.create()` 返回值与 `ptySessionId` 不匹配导致输出过滤失败**

`Shell.jsx` 第 230 行定义：
```js
const ptySessionId = paneId || `shell-${Date.now()}`;
```
第 292 行：`connectedPtyId = await pty.create(ptySessionId, projectPath, rows, cols);`

Tauri 的 `pty.create()` 可能返回一个不同于传入 `ptySessionId` 的实际 PTY ID。然后在第 301 行 `ptyIdRef.current = connectedPtyId`，但 `Shell.jsx` 第 234 行的 `pty.onOutput` 监听器仍然用 `ptySessionId` 过滤：
```js
if (sid === ptySessionId && terminal.current) {
```
如果 `connectedPtyId !== ptySessionId`，**所有输出都会被这个 filter 丢弃**，终端永远空白。

同时，`setConnected(true)` 在第 332 行执行没问题，但用户看到终端一直没有输出，**视觉上表现为"卡住"**。实际状态可能是"已连接但无输出"。

**4. 竞态条件：Tauri 异步监听器注册 vs PTY 创建**

`Shell.jsx` 第 234 行 `const unlistenOut = await pty.onOutput(...)` 是异步的。如果 `pty.onOutput` 的 promise 解析**慢于**第 283-295 行的 `pty.create()`，那么 PTY 的初始输出可能在监听器注册之前就被发送了，导致 shell prompt 丢失。

但更关键的是，`TauriEventContext` 的全局监听器（第 271 行）也在接收这些输出并尝试 `JSON.parse`，对于普通 shell 输出（如 `$ ` prompt），解析会在 `catch` 中静默失败（第 255-257 行），不会产生任何消息 — 这本身不是 bug。

**5. 总结根因优先级**

最大嫌疑是 `connectedPtyId` 与 `ptySessionId` 的不匹配。当 `pty.create()` 返回的 ID 与传入的不一致时，`onOutput` 过滤器 `sid === ptySessionId` 永远为 false，终端无输出。

**复现路径**
1. 选择一个项目，创建 Codex 会话
2. 进入 split view（chat + terminal 并排）
3. 右侧终端显示 "正在连接到 shell..."，永不消失

**修复建议**
1. `Shell.jsx` 第 235 行的 `onOutput` 过滤器应使用 `ptyIdRef.current` 而非闭包中的 `ptySessionId`：
   ```js
   if (sid === ptyIdRef.current && terminal.current) {
   ```
2. 将 `pty.onOutput` 监听器注册移到 `pty.create()` 之后（或至少用 ref 匹配），确保过滤条件基于实际返回的 PTY ID。
3. 考虑为 Codex split view 的 shell 设置 `isPlainShell=true`，因为它实际上就是一个普通 shell（Codex 的 chat 通过 `codex exec` 走 TauriEventContext，不需要这个终端做 AI 交互）。

---

### Bug 2：Codex chat 会话无法 resume + 所有 Codex 会话显示相同消息

**优先级**: P0

**问题描述**  
1. 所有 Codex 会话共享同一套消息列表，切换会话时消息不会更新
2. Codex 无法恢复之前的会话（每次都创建新 thread）
3. Claude chat 工作正常

**根因分析**

这是一个由 **三个独立问题** 叠加导致的复合 bug。

**问题 2A：所有 Codex 会话显示相同消息（消息路由错误）**

核心在 `useChatPanel.ts` 第 623-631 行的 `handleLatestMessage`：

```ts
if (messageType === 'session-created' && typeof message.sessionId === 'string') {
  currentSessionIdRef.current = message.sessionId;  // 第 624 行
  suppressNextSessionSwitchResetRef.current = message.sessionId;
  setCurrentSessionId(message.sessionId);
  onReplaceTemporarySession?.(message.sessionId);
  onNavigateToSession?.(message.sessionId);
  ...
  return;
}
```

在 `TauriEventContext.tsx` 第 134-148 行，当 Codex `thread.started` 事件到达时：
```ts
if (ptype === 'thread.started' && typeof parsed.thread_id === 'string') {
  ...
  pushMessage({
    type: 'session-created',
    sessionId,              // thread_id
    originalSessionId,      // 原始 codexSid
  });
}
```

**每个 Codex exec 调用都会产生一个 `session-created` 消息**，且 `sessionId` 是 `thread_id`。`handleLatestMessage` 处理 `session-created` 时**无条件**地将 `currentSessionIdRef.current` 更新为新的 `thread_id`（第 624 行）。

但 `shouldProcessBufferedMessage`（第 848-878 行）对 `session-created` 的过滤只检查：
```ts
if (messageType === 'session-created') {
  return !activeSessionId || activeSessionId.startsWith('new-session-');
}
```

这意味着如果用户已经有一个活跃的 Codex session（`currentSessionIdRef` 不是 `new-session-` 且不为空），**后续的 `session-created` 消息会被过滤掉** — 这部分OK。但如果用户刚打开一个 Codex 会话（`new-session-*` 状态），任何来自**其他 Codex 会话**的 `session-created` 都会被错误接收，导致 `currentSessionIdRef` 被劫持。

**更严重的是**：`session-created` 的 `sessionId` 是 Codex `thread_id`（如 `thread_abc123`），但 `useChatPanel` 随后的消息过滤（第 655-678 行）会比对 `message.sessionId === activeSessionId`。如果同一时间有多个 Codex 会话产生 `codex-response` 消息（且 `sessionId` 各不相同），它们的消息只会路由到 `currentSessionIdRef` 匹配的那个 panel — **所有其他 Codex chat panel 都收不到消息**。

**问题 2B：Codex 会话无法 resume**

`TauriEventContext.tsx` 第 396-425 行的 `sendMessage` 处理 codex 命令：

```ts
if (provider === 'codex') {
  const codexSid = sid || `codex-${Date.now()}`;     // 第 399 行
  const doCodexSend = async () => {
    const threadId = codexThreadIds.current.get(codexSid);  // 第 401 行
    const ptyId = await ai.runCodexExec(codexSid, projectPath, message.command ?? '', threadId || resumeId);
    ptyToSession.current.set(ptyId, codexSid);
  };
```

**第一次发送消息时的流程**：
1. `sid` = `currentSessionIdRef.current` = 用户选择的会话 ID（如 `thread_xyz789`，是之前的 Codex thread）
2. `codexSid = sid`（因为 sid 非空）= `thread_xyz789`
3. `codexThreadIds.current.get('thread_xyz789')` — 如果这是用户切换会话后的第一次发送，`codexThreadIds` ref 中**可能有这个映射**（因为 `thread.started` 时设置了 `codexThreadIds.set(thread_id, thread_id)`）
4. 但如果用户**刷新页面或重新挂载 TauriEventProvider**，`codexThreadIds.current` 是一个新的 `Map`（第 92 行 `useRef<Map<string, string>>(new Map())`），**所有历史 thread 映射丢失**
5. 于是 `threadId = undefined`，`resumeId` 也是 `undefined`（因为 `useChatPanel` 发送时未设置 `resumeSessionId`）
6. `ai.runCodexExec` 收到 `resume_session_id = None`，不传 `resume` 参数 → Codex CLI 创建全新 thread

**问题 2C：`codex exec resume` 命令参数顺序错误**

即使 `threadId` 正确传入，`ai.rs` 第 135-146 行：
```rust
let mut args: Vec<&str> = vec![
    "exec",
    "--skip-git-repo-check",
    "--json",
];
if let Some(ref resume_id) = resume_session_id {
    args.push("resume");
    args.push(resume_id.as_str());
}
args.push(prompt.as_str());
```
生成的命令为：`codex exec --skip-git-repo-check --json resume <thread_id> <prompt>`

但 Codex CLI 的 `exec` 子命令语法应为 `codex exec [options] <prompt>` 或 `codex exec resume <thread_id> [options] <prompt>`。将 `resume <thread_id>` 放在 `--json` 之后、prompt 之前，**取决于 Codex CLI 的解析器是否接受这种参数顺序**。这需要验证 — 如果不接受，resume 将永远失败。

**复现路径**
1. 创建 Codex 会话 A，发送消息 → 正常
2. 创建 Codex 会话 B，发送消息 → 会话 A 的 chat panel 也可能被更新
3. 切换回会话 A，发送消息 → 创建新 thread 而不是 resume
4. 刷新页面后，所有 Codex 会话的 resume 能力完全丧失

**修复建议**
1. **消息路由隔离**：`handleLatestMessage` 中处理 `session-created` 时，应检查 `message.originalSessionId` 是否匹配当前会话的 ID，而不是无条件接受：
   ```ts
   if (messageType === 'session-created') {
     const mySessionId = currentSessionIdRef.current;
     const isForMe = message.originalSessionId === mySessionId
       || mySessionId?.startsWith('new-session-');
     if (!isForMe) return;
     ...
   }
   ```
2. **持久化 Codex thread 映射**：将 `codexThreadIds` 映射存储到 `localStorage` 或后端数据库，确保页面刷新后仍可 resume。
3. **在 `sendChatMessage` 中传递 `resumeSessionId`**：`useChatPanel.ts` 第 966-979 行构建 `options` 时，如果会话是已有 Codex 会话且 ID 不是 `new-session-*`，应设置 `options.resumeSessionId = activeSessionId`。
4. **验证 `codex exec resume` 参数顺序**：确认 Codex CLI 是否接受 `exec --json resume <id> <prompt>` 格式，必要时调整 `ai.rs` 中 `resume` 子命令和选项的顺序。

---

### Bug 3：项目详情 UI 超出边框/整体布局偏移

**优先级**: P1

**问题描述**  
项目详情页面（`SelectedProjectOverviewPage.tsx`）的"项目操作"区域 UI 超出容器边框，整体布局有偏移。

**根因分析**

**1. 操作按钮区内层 grid 超出父容器**

`SelectedProjectOverviewPage.tsx` 第 410-447 行：

```tsx
<div className="rounded-[20px] border border-border/60 bg-background/90 p-3 shadow-sm">
  ...
  <div className="mt-2.5 grid gap-1.5">
    {/* 新建 Claude 按钮（flex 布局，含图标+文字描述）*/}
    <button ...>...</button>
    {/* 新建 Codex 按钮 */}
    <button ...>...</button>
    {/* 三列子 grid */}
    <div className="grid gap-1.5 sm:grid-cols-3">
      <button>星标</button>
      <button>重命名</button>
      <button>删除</button>
    </div>
  </div>
</div>
```

父容器 `p-3` (12px padding) 加上 `rounded-[20px]` 圆角。内部的按钮（第 415-432 行）包含两个 `flex items-start gap-2` 按钮，每个内部有 `min-w-0` 的文字区域，这部分 OK。

**关键问题在第 433 行的子 grid `sm:grid-cols-3`**：当父容器处于 `xl:grid-cols-[minmax(0,1.55fr)_308px]` 右侧列（固定宽度 308px）时：
- 308px - 2×12px(padding) = 284px 可用宽度
- `sm:grid-cols-3` + `gap-1.5` (6px) = 3 列 + 2×6px gap = 需要 3 列各约 90px
- 每个按钮内容为 `px-2.5 py-1.5 text-[12px]`，加上图标和文字（如"重命名项目"），单个按钮最小宽度可能超过 90px

当按钮文字较长时（特别是在中文等多字节语言下，如"取消星标"、"重命名"、"删除项目"），三列布局在 308px 容器中会溢出。

**2. 顶层 grid `xl:grid-cols-[minmax(0,1.55fr)_308px]` 的右列固定宽度问题**

第 364 行：
```tsx
<div className="grid gap-2.5 xl:grid-cols-[minmax(0,1.55fr)_308px]">
```

右列固定 308px，但内部操作面板包含两个宽按钮（"新建 Claude 会话"、"新建 Codex 会话"）加三列按钮行。当 `xl` 断点激活（≥1280px）时，如果左列 `min-w-0` 的内容较宽，右列的 308px 可能不够放下所有内容。

**3. 外层滚动容器 `overflow-y-auto` 无 `overflow-x-hidden`**

第 361 行：
```tsx
<div className="h-full overflow-y-auto bg-background">
```

只设置了 `overflow-y-auto`，未设置 `overflow-x: hidden`。当内部内容超出宽度时，会出现水平滚动条或内容溢出。

**4. StatTile grid `xl:grid-cols-4` 在窄屏下的问题**

第 392 行：
```tsx
<div className="mt-2.5 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
```

在 `sm` 和 `xl` 之间缺少 `lg` 断点的过渡。当容器宽度在 640px-1280px 之间时，左列可能很窄（因为 xl grid 未激活，变成单列），4 个 StatTile 挤在 2 列中可能溢出。

**复现路径**
1. 打开项目详情页面
2. 在 xl 断点以上的屏幕宽度下查看
3. 观察右侧"项目操作"区域的三列按钮行超出圆角边框
4. 缩小窗口到 sm-lg 范围，观察 StatTile 区域布局偏移

**修复建议**
1. 为项目操作面板添加 `overflow-hidden`：
   ```tsx
   <div className="rounded-[20px] border ... p-3 shadow-sm overflow-hidden">
   ```
2. 将 `sm:grid-cols-3` 改为 `grid-cols-1 sm:grid-cols-3`，或在右列 308px 上下文中始终使用单列堆叠（因为宽度不足以支撑三列）。更好的方案是使用 `flex flex-wrap gap-1.5` 替代 grid，让按钮自动换行。
3. 考虑将右列从 `308px` 改为 `minmax(260px, 320px)` 并给内部留更多弹性空间。
4. 外层容器添加 `overflow-x-hidden`。

---

## 第二部分：其他潜在缺陷

---

### Bug 4：`chatLastProcessedMessageSequence` 全局变量跨实例污染

**优先级**: P1

**问题描述**  
如果同时有多个 ChatPanel 实例（如 split view 中左右两个 chat panel），所有实例共享同一个模块级全局变量 `chatLastProcessedMessageSequence`，导致消息处理竞态。

**根因分析**

`useChatPanel.ts` 第 65 行：
```ts
let chatLastProcessedMessageSequence = 0;
```

这是一个**模块级变量**（不在组件内部），所有使用 `useChatPanel` 的组件实例共享同一份。

第 130 行：
```ts
const lastProcessedSequenceRef = useRef<number>(chatLastProcessedMessageSequence);
```

当组件 A 处理了 sequence 100 并更新 `chatLastProcessedMessageSequence = 100`，组件 B 重新挂载时 `useRef<number>(chatLastProcessedMessageSequence)` 初始化为 100 — **跳过了组件 B 应该处理的 sequence 1-100**。

**修复建议**  
使用 per-session key 存储到 `sessionStorage` 或 Map，或者让每个 `useChatPanel` 实例维护独立的 sequence 追踪。

---

### Bug 5：Codex 在 Web 模式（非 Tauri）下完全不可用

**优先级**: P1

**问题描述**  
Codex chat 功能在 Web/Express 模式下抛出 reject 错误，无法使用。

**根因分析**

`tauri-bridge.ts` 第 276-279 行：
```ts
runCodexExec: (...): Promise<string> =>
  isTauriEnv()
    ? invoke<string>('ai_run_codex_exec', { ... })
    : Promise.reject(new Error('Codex exec not available in web mode')),
```

`TauriEventContext.tsx` 第 402 行调用 `ai.runCodexExec(...)`，在 Web 模式下会 reject。虽然 `doCodexSend().catch(console.error)` 捕获了错误（第 424 行），但：
1. 用户没有任何错误反馈
2. 消息已经添加到 UI 中（`appendMessage` 在 `sendChatMessage` 中先执行），显示为"发送中"但永远不会完成

**修复建议**  
在 `sendMessage` 中为 Web 模式的 Codex 提供一个兼容的 HTTP API fallback，或者在 `sendChatMessage` 调用前检测环境并显示用户友好的错误提示。

---

### Bug 6：TauriEventContext `parsePtyOutput` 中 error 类型被 Claude 分支覆盖

**优先级**: P2

**问题描述**  
`parsePtyOutput` 中 Codex 的 `error` 事件和 Claude 的 `error` 事件存在重复匹配逻辑。

**根因分析**

`TauriEventContext.tsx` 第 198-206 行（Codex error 分支）：
```ts
if (ptype === 'error') {
  pushMessage({ type: 'codex-error', ... });
  continue;
}
```

第 222-228 行（Claude error 分支）：
```ts
} else if (ptype === 'error') {
  pushMessage({ type: 'claude-error', ... });
}
```

由于 Codex 的 `error` 分支在前面使用了 `continue`，Claude 的 `error` 分支**永远不会被执行** — 所有 `error` 类型消息都被当作 `codex-error` 处理。对于纯 Claude 会话，如果 PTY 输出包含 `{"type": "error", ...}`，它会被错误地路由为 `codex-error`。

虽然当前 `useChatPanel.ts` 第 826-836 行同时处理 `claude-error` 和 `codex-error`，UI 表现类似，但消息类型不正确可能影响将来的逻辑。

**修复建议**  
在 `parsePtyOutput` 中，根据 `sessionId` 或 `ptyId` 判断当前 PTY 的 provider，将 `error` 路由到正确的消息类型。

---

### Bug 7：Shell.jsx Codex 终端启动命令缺少 launch profile args

**优先级**: P2

**问题描述**  
当 Codex split view 右侧终端启动时，虽然获取了 `launchArgs`，但只拼接了基本的 `codex` 命令，缺少权限模式等关键参数。

**根因分析**

`Shell.jsx` 第 339-342 行：
```js
} else if (!isPlainShellRef.current && shellProvider === 'codex') {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const codexCommand = ['codex', ...launchArgs].join(' ');
  await pty.input(connectedPtyId, codexCommand + '\r');
}
```

这里在 PTY 中输入 `codex <launchArgs>` 来启动交互式 Codex TUI。但这个 TUI shell **与 `TauriEventContext` 的 `codex exec` 路径是独立的**。Chat 消息通过 `ai.runCodexExec()` 发送（产生 JSON 输出），而这个 TUI 是用户直接交互的界面。

**问题**：如果用户预期 split view 右侧的终端显示 exec 模式的输出，但实际启动的是交互式 TUI，两者的输出格式完全不同。这解释了为什么右侧终端"卡住" — 它启动了交互式 Codex，但没有人往里面输入命令。

**修复建议**  
明确 split view 右侧终端的定位：如果它是用来显示 exec 模式结果的，不应启动交互式 TUI；如果它是独立交互终端，应确保用户理解这一点。建议为 Codex split view 的右侧使用 `isPlainShell=true` 并与 exec 结果解耦。

---

### Bug 8：Task Queue store 无 executor — 队列永远不会自动执行

**优先级**: P2

**问题描述**  
Task Queue 有完整的状态管理（`taskQueueStore.ts`）和 UI（`TaskQueuePanel.tsx`），但缺少**执行引擎** — `autoExecute` 开关存在但从未被任何代码消费。

**根因分析**

`taskQueueStore.ts` 定义了 `addTask`、`claimNext`、`markRunning`、`markDone` 等方法和 `autoExecute` 状态，但没有任何 `useEffect` 或 subscriber 在 `autoExecute=true` 时调用 `claimNext()` 并实际发送消息。

- `claimNext()` 在整个代码库中没有被调用（除了 store 内部定义）
- 没有 hook 或组件将 queue 中的 task 转换为 `sendMessage` 调用
- `markRunning`、`markDone`、`markFailed` 也没有外部调用者

整个 Task Queue 功能是 **纯 UI 壳子**，没有后端集成。

**修复建议**  
创建一个 `useTaskQueueExecutor` hook，在 `autoExecute=true` 时订阅 store 变化，调用 `claimNext()` 获取任务，通过 `sendMessage` 发送到对应 provider，并根据 `codex-complete` / `claude-complete` 事件更新任务状态。

---

### Bug 9：Task Queue UI 硬编码英文，缺少 i18n

**优先级**: P3

**问题描述**  
`TaskQueuePanel.tsx`、`TaskQueueItem.tsx`、`TaskQuickAdd.tsx` 中所有用户可见字符串均为硬编码英文。

**根因分析**

- `TaskQueuePanel.tsx` 第 49 行: `"Task Queue"`
- `TaskQueueItem.tsx` 第 14-20 行: `"Queued"`, `"Running"`, `"Done"`, `"Failed"`, `"Cancelled"`
- `TaskQuickAdd.tsx` 第 41 行: `"Add a task prompt..."`
- 未使用 `useTranslation` hook

项目要求所有 user-facing 字符串通过 `react-i18next`。

**修复建议**  
为 Task Queue 相关组件添加 i18n 支持，在 `src/i18n/locales/` 的 en、ko、zh-CN、ja 文件中添加对应翻译 key。

---

### Bug 10：`pty.onOutput` 事件监听器在 `Shell.jsx` 中的内存泄漏风险

**优先级**: P2

**问题描述**  
每次 `connectWebSocket` 被调用时，都会注册新的 `pty.onOutput` 和 `pty.onExit` 监听器，但只有在 `disconnectFromShell` 或组件卸载时才清理。如果重连循环触发多次，会累积多个监听器。

**根因分析**

`Shell.jsx` 第 206 行 `connectWebSocket` 是一个 `useCallback`。在 Tauri 模式下（第 234 行），每次进入 `setupPty()` 都会调用 `await pty.onOutput(...)` 注册新监听器，并将 `unlistenOutputRef.current = unlistenOut` 覆盖旧引用。

如果 `connectWebSocket` 被快速连续调用（虽然有 `isConnectingRef` 守卫，但异步 gap 中可能被绕过），旧的 `unlisten` 函数可能丢失，导致多个监听器同时存在。

**复现路径**  
快速切换会话导致重连循环。

**修复建议**  
在 `setupPty()` 开头，先清理已有的 `unlistenOutputRef.current` 和 `unlistenExitRef.current`，再注册新的监听器。

---

### Bug 11：`sendChatMessage` 中 `selectedProject` 依赖不在 deps 数组中

**优先级**: P3

**问题描述**  
`useChatPanel.ts` 第 1028-1044 行，`sendChatMessage` 的 `useCallback` 依赖数组中缺少 `selectedProject`（只有 `selectedProject.name`）。

**根因分析**

第 965 行：
```ts
const workingDirectory = selectedProject.fullPath || selectedProject.path || '';
```

使用了 `selectedProject.fullPath` 和 `selectedProject.path`，但 deps 数组中没有 `selectedProject` 对象引用（只有通过 `selectedProject.name` 间接依赖）。如果项目的 `fullPath` 改变但 `name` 不变，`sendChatMessage` 会使用旧的 `workingDirectory`。

不过这在实践中较少触发，因为项目名和路径通常一起变化。

---

### Bug 12：`TauriEventContext.sendMessage` 的 Codex 分支中 "mirror to interactive PTY" 逻辑可能向错误 PTY 发送消息

**优先级**: P2

**问题描述**  
当 Codex chat 消息通过 exec 模式发送后，代码尝试将同样的消息 "mirror" 到交互式 PTY。

**根因分析**

`TauriEventContext.tsx` 第 406-422 行：

```ts
if (sid) {
  for (const [pid, s] of ptyToSession.current) {
    if (s === sid && pid !== ptyId) {
      // Found the interactive TUI PTY
      const cmdText = message.command ?? '';
      try {
        await pty.input(pid, cmdText);
        await new Promise((r) => setTimeout(r, 100));
        await pty.input(pid, '\r');
      } catch {
        // Non-fatal
      }
      break;
    }
  }
}
```

这段代码假设 `ptyToSession` 中另一个映射到 `sid` 的 PTY 就是交互式 TUI PTY。但如果有**多个 exec PTY** 映射到同一个 `sid`（例如快速连续发送两条消息），可能会向错误的 PTY（一个正在运行的 exec PTY）发送输入，导致结果污染。

**修复建议**  
维护一个单独的 `interactivePtyIds` Map 来区分交互式 PTY 和 exec PTY。

---

### Bug 13：`ai.rs` 中 `codex exec` 的 `resume` 子命令位置可能不正确

**优先级**: P1

**问题描述**  
Codex CLI `exec` 子命令的 `resume` 参数放置在 flags 之后、prompt 之前，可能不被正确解析。

**根因分析**

`ai.rs` 第 135-146 行生成的命令为：
```
codex exec --skip-git-repo-check --json resume <thread_id> <prompt>
```

Codex CLI 的 exec 子命令预期格式可能是：
```
codex exec resume <thread_id> --skip-git-repo-check --json <prompt>
```

即 `resume` 应该紧跟在 `exec` 之后作为子命令，而不是放在 flags 后面。当前的参数顺序可能导致 Codex CLI 将 `resume` 解释为 prompt 文本而非子命令。

**修复建议**  
调整参数顺序，将 `resume <thread_id>` 放在 `exec` 之后、flags 之前：
```rust
let mut args: Vec<&str> = vec!["exec"];
if let Some(ref resume_id) = resume_session_id {
    args.push("resume");
    args.push(resume_id.as_str());
}
args.push("--skip-git-repo-check");
args.push("--json");
args.push(prompt.as_str());
```

---

### Bug 14：`currentTime` 在 `SelectedProjectOverviewPage` 中不更新

**优先级**: P3

**问题描述**  
`SelectedProjectOverviewPage.tsx` 第 161 行 `const currentTime = new Date();` 在每次渲染时创建新的 Date 对象，但 "last activity" 的 `formatTimeAgo` 显示的是组件挂载时的时间，长时间停留在页面上不会更新相对时间。

**修复建议**  
使用 `setInterval` 定期更新 `currentTime` state（例如每分钟一次）。

---

## 总体评估

### 设计/架构层面问题

**1. Codex 集成的双轨模型混乱**

Codex 同时使用了两种完全不同的集成模式：
- **Exec 模式**（`ai.runCodexExec`）：通过 `TauriEventContext.sendMessage` → `codex exec --json` 产生结构化 JSON → `parsePtyOutput` 解析 → chat panel 显示
- **Interactive TUI 模式**（`pty.create` + `pty.input('codex\r')`）：通过 `Shell.jsx` 启动交互式 Codex → 终端直接渲染

这两条路径的 PTY 监听、session ID 管理、消息路由是**独立且互相干扰的**。特别是 split view 场景下，一个 session 同时有 exec PTY 和 interactive PTY，`ptyToSession` 映射中的冲突是所有 Codex bug 的根本原因。

**建议**：选择一种集成模式并完全实现。Exec 模式更适合 chat panel（结构化输出），但应放弃在 split view 中启动独立的交互式 TUI。

**2. 全局消息路由缺乏 session 隔离**

`TauriEventContext` 的 `pushMessage` 是一个全局广播 — 所有消息发给所有 consumer。消息过滤完全依赖 consumer 端的 `shouldProcessBufferedMessage` 和 `handleLatestMessage`。当多个 Codex 会话并发时，`session-created` 事件的处理是 first-come-first-served，极易出现消息路由到错误会话的问题。

**建议**：在 context 层实现 per-session 消息队列，而非全局广播 + 客户端过滤。

**3. `codexThreadIds` 作为内存 ref 过于脆弱**

Codex 的 thread resume 功能依赖 `codexThreadIds.current`（`useRef<Map>`），这个 Map 在 TauriEventProvider 重新挂载时完全丢失。对于一个需要持久化的功能（跨页面刷新恢复会话），使用内存中的 ref 是不够的。

**4. 缺少测试覆盖**

项目没有自动化测试，以上所有 bug 都无法通过 CI 防御。特别是消息路由逻辑和 PTY 生命周期管理这类复杂异步逻辑，缺少单元测试是质量风险的主要来源。

### 开发质量评价

本批次开发（6 次提交）引入了重要的 Codex exec 模式和 IME 修复，但：

- **P0 bug 2 个**：Codex 核心功能（chat 和 terminal）均不可用
- **P1 bug 4 个**：包括 Web 模式兼容性、消息路由污染、resume 参数错误
- **P2 bug 4 个**：内存泄漏、类型路由、mirror 逻辑问题
- **P3 bug 3 个**：i18n 缺失、minor 依赖问题

整体质量属于 **alpha 阶段**，Codex 相关功能需要重新设计 PTY 管理和消息路由后才能稳定使用。Claude 功能（通过 `ai.startSession` 直接集成）相对稳定，因为其路径更简单（单 PTY，无双轨问题）。

/* ThreadTerm v3 synthetic session lifecycle, Chat, and history feature. */
(() => {
  "use strict";
  const api = window.ThreadTermPrototype;
  if (!api) throw new Error("ThreadTermPrototype must load before sessions.js");

  const AGENTS = ["Codex", "Claude Code", "Kimi", "Gemini", "OpenCode"];
  const TOOL_PRESETS = ["Grok", "Shell", "命令预设"];
  const timers = new Map();
  const streamTimers = new Map();
  const completionTimers = new Map();
  let scanTimer = null, scanGeneration = 0;
  let pendingConfig = null;
  let endWaitTimer = null;
  let focusSnapshot = null;
  const now = () => new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const esc = (value) => String(value ?? "").replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const id = () => `v3-session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const state = api.featureState("sessions", {
    configs: {}, chats: {}, drafts: {}, history: [], historyCap: 80, lifecycle: {}, viewports: {}, workspace: {}, scan: { status: "idle", progress: 0, error: "", filter: "all", query: "", provider: "all", page: 1 },
    create: { mode: "terminal", agent: "Codex", startup: "", oneShot: false },
  });
  state.scan.query ||= ""; state.scan.provider ||= "all"; state.scan.page ||= 1;
  const session = (sid) => api.sessionById(sid);
  const isChat = (item) => Boolean(item && state.chats[item.id]);
  const providerOf = (value) => value === "Claude" ? "Claude Code" : value;
  const configFor = (sid) => {
    const config = (state.configs[sid] ||= { retry: "manual", limit: 2, retryCount: 0, pendingRestart: false, startup: "", mode: isChat(session(sid)) ? "chat" : "terminal" });
    config.retryHistory ||= [];
    return config;
  };
  const persist = () => api.save();
  const alive = (item) => item && !api.isEnded(item) && !api.isMissing(item) && !api.isUnavailable(item);
  const availableTree = (tree) => Boolean(tree && !tree.missing && !api.store.removedTrees?.includes(tree.id) && !api.store.deletedTrees?.includes(tree.id) && !api.store.archivedTrees?.includes(tree.id) && !api.store.deletedProjects?.includes(tree.project) && !api.store.archivedProjects?.includes(tree.project));
  const normalizedPath = (path) => {
    const value = String(path || "").replaceAll("\\", "/").replace(/\/+$/, "");
    return /^[A-Za-z]:/.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
  };
  const absolutePath = (path) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path);
  const treeForPath = (path) => Object.values(api.trees).find((tree) => availableTree(tree) && normalizedPath(tree.path) === normalizedPath(path));
  const appendOutput = (item, text) => { if (item) { item.output ||= []; item.output.push(text); } };
  const cancelTimer = (sid) => { const timer = timers.get(sid); if (timer) clearInterval(timer); timers.delete(sid); };
  const cancelStream = (sid) => { const timer = streamTimers.get(sid); if (timer) clearInterval(timer); streamTimers.delete(sid); };
  const setLife = (item, next, detail) => { if (!item) return; item.state = next; item.detail = detail; state.lifecycle[item.id] = { state: next, detail }; };
  const visibleHistory = () => state.history.filter((entry) => (state.scan.filter === "all" || entry.kind === state.scan.filter) && (state.scan.provider === "all" || entry.provider === state.scan.provider) && (!state.scan.query || `${entry.name} ${entry.provider} ${entry.cwd}`.toLowerCase().includes(state.scan.query.toLowerCase())));
  const historyById = (historyId) => state.history.find((entry) => entry.id === historyId);
  const cancelCompletion = (sid) => { clearTimeout(completionTimers.get(sid)); completionTimers.delete(sid); };

  // Restore once. Later core state changes must not be overwritten by an old snapshot.
  for (const [sid, saved] of Object.entries(state.lifecycle)) {
    const item = session(sid);
    if (item) Object.assign(item, saved);
  }
  for (const key of ["wsTab", "wsFile", "wsTiles", "wsInspector", "termDrafts", "pendingByTree"]) {
    if (state.workspace[key] !== undefined) api.ui[key] = state.workspace[key];
  }
  if (state.scan.status === "scanning") state.scan.status = "idle";
  for (const chat of Object.values(state.chats)) {
    for (const message of chat.messages) {
      if (message.streaming) { message.streaming = false; message.text += "\n[刷新后已暂停，可继续发送]"; }
    }
  }

  function resolveToolAttention(chat) {
    if (chat?.tool?.attentionId && !api.store.resolved.includes(chat.tool.attentionId)) api.store.resolved.push(chat.tool.attentionId);
  }

  function completeTask(item) {
    if (!alive(item)) return;
    cancelTimer(item.id); cancelStream(item.id); cancelCompletion(item.id);
    appendOutput(item, "任务已完成 · 退出码 0，输出已保留。");
    setLife(item, "ended", "任务完成 · 退出码 0");
    if (!api.store.ended.includes(item.id)) api.store.ended.push(item.id);
    addHistory(item, "ended", "一次性任务完成，保留输出与运行记录。");
    api.publishAttention({ session: item.id, kind: "review", title: "任务已完成", reason: "退出码 0；可以查看输出或再次运行。", identity: `complete:${item.id}:${Date.now()}` });
    persist(); api.render();
  }

  function closeView(item) {
    if (!item) return;
    const remaining = (api.ui.wsTiles || []).filter((sid) => sid !== item.id);
    api.ui.wsTiles = remaining;
    api.closeDialog(false);
    if (remaining.length) api.openSession(remaining[0]);
    else api.navigate("#/terminals");
    api.toast(`已关闭 ${api.displayName(item)} 的视图；会话仍保留。`);
  }

  function finishEnd(item, forced = false) {
    if (!item || api.isEnded(item)) return;
    clearTimeout(endWaitTimer); endWaitTimer = null;
    cancelTimer(item.id); cancelStream(item.id); cancelCompletion(item.id);
    const chat = state.chats[item.id];
    resolveToolAttention(chat);
    if (chat?.tool?.status === "pending") chat.tool.status = "cancelled";
    chat?.messages.forEach((message) => { message.streaming = false; });
    appendOutput(item, forced ? "已强制结束演示会话；输出与文件草稿保留。" : "已收到结束确认；输出与文件草稿保留。");
    setLife(item, "ended", forced ? "已强制结束" : "已结束");
    addHistory(item, "ended", "结束会话，保留输出和文件草稿。");
    const trigger = document.createElement("button"); trigger.dataset.session = item.id;
    api.baseActions["end-session-confirm"](trigger);
  }

  function endProblem(item, problem) {
    clearTimeout(endWaitTimer); endWaitTimer = null;
    api.openDialog(problem === "failure" ? "结束失败，已保留会话" : "结束超时，已保留会话", "尚未确认退出，终端视图和文件草稿仍可继续使用。",
      `<p data-testid="session-end-status">${esc(api.displayName(item))} · ${problem === "failure" ? "模拟结束请求被拒绝" : "等待结束回执超时"}</p>`,
      `${api.btn("保留会话", "sessions-end-keep")}${api.btn("继续等待", "sessions-end-wait", { "data-session": item.id })}${api.btn("重试结束", "sessions-end-retry", { "data-session": item.id })}${api.btn("强制结束", "sessions-end-force", { "data-session": item.id }, "btn btn-danger")}`);
  }

  function openEnd({ sessionId, invoker }) {
    const item = session(sessionId);
    if (!item || api.isEnded(item)) return api.toast("此会话已经结束。");
    clearTimeout(endWaitTimer); endWaitTimer = null;
    api.openDialog(`关闭 · ${api.displayName(item)}`, "只关闭视图会保留运行；结束会话会中断当前回复，文件和差异草稿继续保留。",
      '<label class="v3-form">结束结果演示<select id="v3-end-outcome"><option value="success">正常结束</option><option value="timeout">未收到结束回执</option><option value="failure">结束请求失败</option></select></label>',
      `${api.btn("取消", "close-dialog")}${api.btn("只关闭视图", "sessions-close-view", { "data-session": item.id })}${api.btn("确认结束", "sessions-end-confirm", { "data-session": item.id }, "btn btn-danger")}`, { invoker });
  }

  function runTask(item, reason = "手动运行") {
    if (!item || !availableTree(api.trees[item.tree])) return api.toast("工作目录不可用，请先重新定位。");
    cancelTimer(item.id); cancelStream(item.id); cancelCompletion(item.id);
    api.store.ended = api.store.ended.filter((sid) => sid !== item.id);
    const config = configFor(item.id);
    config.pendingRestart = false;
    if (config.startup) item.command = config.startup;
    setLife(item, "running", reason);
    appendOutput(item, `${reason}：${item.command || item.agent}`);
    if (config.oneShot && !isChat(item)) completionTimers.set(item.id, setTimeout(() => completeTask(item), 1200));
    persist(); api.render();
  }

  function addHistory(item, kind = "ended", detail = "本地模拟记录") {
    if (!item) return;
    const key = `history-${item.id}`;
    const existing = state.history.find((entry) => entry.id === key);
    const config = configFor(item.id);
    const entry = { id: key, sessionId: item.id, kind, provider: providerOf(item.agent), nativeId: config.nativeId || `local-${item.id}`, name: api.displayName(item), project: item.project, tree: item.tree, cwd: api.trees[item.tree]?.path || "", detail, at: now(), mode: config.mode, interactiveRoot: true, output: [...(item.output || [])], messages: state.chats[item.id]?.messages || [] };
    if (existing) Object.assign(existing, entry);
    else state.history.unshift(entry);
    state.history = state.history.slice(0, Number(state.historyCap) || 80);
  }

  function scanFixtures() {
    const records = AGENTS.flatMap((provider, providerIndex) => Array.from({ length: 3 }, (_, index) => ({
      id: `scan-${provider.toLowerCase().replaceAll(" ", "-")}-${index + 1}`,
      provider, nativeId: `root-${providerIndex}-${index + 1}`, name: `${provider} · ${["结账键盘复核", "接口重试设计", "项目文档整理"][index]}`,
      project: "orbit", tree: "orbit-checkout", cwd: api.trees["orbit-checkout"].path,
      kind: "ended", mode: index === 1 ? "chat" : "terminal", interactiveRoot: true,
      at: `09-${String(8 - index).padStart(2, "0")} 10:${providerIndex}0`, detail: "本机历史扫描示例 · 尚未导入卡片",
      output: [`${provider} history root`, "已完成分析，等待显式恢复。", "建议检查键盘焦点与回归结果。"],
      messages: [{ role: "user", text: "检查结账页面的键盘交互。" }, { role: "assistant", text: "已找到两个需要复核的焦点边界。" }],
    })));
    records.unshift({ ...records[0], id: "scan-codex-child", nativeId: "subagent-child", name: "Codex · 子记录（不可交互）", interactiveRoot: false, detail: "这是子 Agent 记录，不能作为可交互根会话恢复。" });
    records.unshift({ ...records[0], id: "scan-kimi-missing", provider: "Kimi", nativeId: "missing-root", name: "Kimi · 旧目录中的任务", tree: "orbit-missing", cwd: api.trees["orbit-missing"].path, kind: "missing", interactiveRoot: true, detail: "工作目录缺失；可以读取历史，重新定位后恢复。" });
    const bound = session("pulse-codex");
    if (bound) records.unshift({ ...records.at(-1), id: "scan-codex-bound", provider: "Codex", nativeId: "existing-codex-root", sessionId: bound.id, boundSessionId: bound.id, name: "Codex · 已绑定的接口会话", project: bound.project, tree: bound.tree, cwd: api.trees[bound.tree].path, kind: "active", output: [...bound.output], detail: "已有卡片持有该会话身份，恢复时必须复用。" });
    records.push({ ...records.at(-1), id: "scan-shell-output", provider: "Shell", nativeId: "", name: "Shell · 上次构建输出", kind: "ended", interactiveRoot: false, sessionId: "", boundSessionId: "", detail: "Shell 仅保留输出，不使用 AI 会话 ID 恢复。" });
    for (const record of records) if (!historyById(record.id)) state.history.push(record);
    state.history = state.history.slice(0, state.historyCap);
  }

  function historyOwner(entry) {
    if (!entry) return null;
    const candidates = api.sessions().filter((item) => !api.store.deletedSessions.includes(item.id));
    return candidates.find((item) => {
      const config = configFor(item.id);
      const sameIdentity = item.id === entry.boundSessionId || item.id === entry.sessionId || (entry.nativeId && config.nativeId === entry.nativeId && providerOf(item.agent) === entry.provider);
      return sameIdentity && (!api.isEnded(item) || api.store.archivedSessions.includes(item.id) || config.importedOnly);
    }) || null;
  }

  function openBoundHistory(entry) {
    const owner = historyOwner(entry);
    if (!owner) return openHistoryResume(entry);
    if (api.store.archivedSessions.includes(owner.id)) {
      return api.openDialog("此历史已有归档卡片", "复用已有身份，不创建重复会话。", `<p>${esc(api.displayName(owner))}</p><p>恢复卡片后可以继续检查输出。</p>`, `${api.btn("取消", "close-dialog")}${api.btn("恢复已有卡片并打开", "sessions-history-unarchive", { "data-history": entry.id }, "btn btn-primary")}`);
    }
    api.openSession(owner.id);
  }

  function historyProblem(entry) {
    if (!entry) return "历史记录不存在。";
    if (entry.provider === "Shell" || !entry.nativeId) return "Shell 输出仅供阅读，不能按 AI 会话身份恢复。";
    if (entry.interactiveRoot === false) return "该记录不是可交互根会话，请选择根记录。";
    if (!treeForPath(entry.cwd)) return "工作目录不可用，请先重新定位。";
    return "";
  }

  function historyItem(entry, mode, importedOnly = false) {
    const tree = treeForPath(entry.cwd);
    if (!tree) return null;
    const item = { id: id(), project: tree.project, tree: tree.id, name: `${entry.name} · ${importedOnly ? "历史卡片" : "恢复"}`, command: mode === "chat" ? "Chat" : `${entry.provider.toLowerCase().replaceAll(" ", "-")} resume ${entry.nativeId}`, agent: entry.provider, state: importedOnly ? "ended" : "running", detail: importedOnly ? "导入的只读快照" : "从历史继续", time: "刚刚", summary: entry.detail, output: [...(entry.output || []), importedOnly ? "已导入快照，尚未恢复。" : "已显式恢复同一历史身份。"] };
    api.store.userSessions.push(item);
    state.configs[item.id] = { retry: "manual", limit: 2, retryCount: 0, retryHistory: [], mode, nativeId: entry.nativeId, cwd: tree.path, startup: item.command, importedOnly };
    if (mode === "chat") state.chats[item.id] = { messages: JSON.parse(JSON.stringify(entry.messages || [])), tool: null };
    if (importedOnly) api.store.ended.push(item.id);
    entry.boundSessionId = item.id;
    entry.bound = true;
    entry.kind = "active";
    persist();
    return item;
  }

  function openHistoryResume(entry) {
    const owner = historyOwner(entry);
    if (owner && !configFor(owner.id).importedOnly) {
      return api.openDialog("此历史已绑定会话", "活动和归档卡片共用同一个恢复身份。", `<p>${esc(api.displayName(owner))}</p><p>请打开已有会话；不会重复创建。</p>`, `${api.btn("取消", "close-dialog")}${api.btn("打开已有会话", "sessions-history-open-bound", { "data-history": entry.id }, "btn btn-primary")}`);
    }
    const problem = historyProblem(entry);
    if (problem) return api.openDialog("暂时无法恢复", problem, `<p>${esc(entry?.name || "")}</p>`, api.btn("关闭", "close-dialog"));
    const supportsChat = AGENTS.includes(entry.provider);
    api.openDialog("恢复历史会话", "校验已通过：目录可用、根记录有效、身份未被重复占用。", `<div class="v3-form"><p>${esc(entry.name)}<br><code>${esc(entry.cwd)}</code></p><label>恢复模式<select id="v3-resume-mode"><option value="terminal">Terminal</option><option value="chat" ${supportsChat ? "" : "disabled"}>Chat</option></select></label><p>在此明确选择模式；运行中的会话不提供热切换。</p></div>`, `${api.btn("取消", "close-dialog")}${api.btn(owner ? "恢复已有历史卡片" : "恢复为新会话", "sessions-history-confirm", { "data-history": entry.id }, "btn btn-primary")}`);
  }

  function confirmHistoryResume(entry) {
    const mode = document.querySelector("#v3-resume-mode")?.value;
    if (!mode || historyProblem(entry)) return api.toast(historyProblem(entry) || "请重新选择恢复方式。");
    if (mode === "chat" && !AGENTS.includes(entry.provider)) return api.toast("此提供者仅支持 Terminal。");
    const owner = historyOwner(entry);
    if (owner && !configFor(owner.id).importedOnly) return openHistoryResume(entry);
    let item = owner;
    if (item) {
      const config = configFor(item.id);
      config.importedOnly = false; config.mode = mode;
      if (mode === "chat") state.chats[item.id] = { messages: JSON.parse(JSON.stringify(entry.messages || [])), tool: null };
      runTask(item, "从历史继续");
    } else item = historyItem(entry, mode);
    if (!item) return;
    api.closeDialog(false); api.openSession(item.id);
  }

  function relocateHistory(entry) {
    if (!entry) return;
    const options = Object.values(api.trees).filter(availableTree).map((tree) => `<option value="${esc(tree.path)}">${esc(api.projects[tree.project].name)} · ${esc(tree.branch)}</option>`).join("");
    const root = api.openDialog("重新定位缺失目录", "选择一个可用的演示目录，预览后确认。", `<form id="v3-relocate-form" class="v3-form"><p>原目录：<code>${esc(entry.cwd)}</code></p><label>可用工作目录<select name="target">${options}</select></label><label>目标绝对路径<input name="path" required></label><p data-relocate-preview></p></form>`, `${api.btn("取消", "close-dialog")}<button class="btn btn-primary" type="submit" form="v3-relocate-form">确认重新定位</button>`);
    const form = root.querySelector("form");
    const sync = () => { form.elements.path.value = form.elements.target.value; form.querySelector("[data-relocate-preview]").textContent = `将保留 ${entry.provider} / ${entry.nativeId}，仅修改目录关联。`; };
    form.elements.target.addEventListener("change", sync); sync();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const path = form.elements.path.value.trim();
      const tree = treeForPath(path);
      if (!absolutePath(path) || !tree) return api.toast("请选择列表中可用的绝对目录；缺失或无权限目录不能恢复。");
      entry.cwd = tree.path; entry.tree = tree.id; entry.project = tree.project; entry.kind = "ended";
      entry.detail = `已确认新目录 ${tree.path}，历史内容与会话身份保留。`;
      persist(); api.closeDialog(false); api.render();
    });
  }

  function stopScan(status = "idle", error = "") {
    scanGeneration += 1;
    clearInterval(scanTimer); scanTimer = null;
    state.scan.status = status; state.scan.error = error;
    if (status === "idle") state.scan.progress = 0;
    persist(); api.render();
  }

  function scanHistory() {
    clearInterval(scanTimer);
    const generation = ++scanGeneration;
    state.scan = { ...state.scan, status: "scanning", progress: 0, error: "", startedAt: Date.now(), page: 1 };
    scanTimer = setInterval(() => {
      if (generation !== scanGeneration) return;
      state.scan.progress += 25;
      if (state.scan.progress >= 100) {
        clearInterval(scanTimer); scanTimer = null;
        state.scan.status = "done";
        state.scan.elapsed = ((Date.now() - state.scan.startedAt) / 1000).toFixed(1);
        scanFixtures();
      }
      persist(); api.render();
    }, 200);
    persist(); api.render();
  }
  function startRetry(item, automatic) {
    cancelTimer(item.id);
    cancelStream(item.id); cancelCompletion(item.id);
    const cfg = configFor(item.id); let remaining = automatic ? 3 : 1;
    if (automatic && cfg.retryCount >= cfg.limit) {
      setLife(item, "failed", "已达到自动重试上限");
      cfg.retryHistory.push({ at: now(), result: "达到上限，已停止" });
      api.publishAttention({ session: item.id, kind: "failed", title: "自动重试已停止", reason: "已达到配置的重试上限。", identity: `retry-limit:${item.id}:${cfg.retryCount}` });
      persist(); api.render(); return;
    }
    if (automatic) cfg.retryCount += 1;
    cfg.retryHistory.push({ at: now(), result: automatic ? `自动重试 ${cfg.retryCount} 已排队` : "手动重试已排队" });
    setLife(item, "retrying", automatic ? `自动重试将在 ${remaining}s 后开始` : "正在重试");
    timers.set(item.id, setInterval(() => {
      if (!alive(item)) return cancelTimer(item.id);
      remaining -= 1; setLife(item, "retrying", automatic ? `自动重试将在 ${remaining}s 后开始` : "正在重试");
      if (remaining <= 0) { cancelTimer(item.id); cfg.retryHistory.push({ at: now(), result: "重试成功" }); runTask(item, "重试成功"); }
      persist();
      api.render();
    }, 1000));
    persist();
    api.render();
  }
  function responseFor(item, prompt) {
    const chat = state.chats[item.id];
    chat.tool = null;
    chat.messages.push({ role: "assistant", text: "", streaming: true });
    const messageIndex = chat.messages.length - 1;
    const target = chat.messages[messageIndex];
    setLife(item, "running", "正在回复");
    const reply = `我已收到「${prompt}」。这是 ${item.agent} 的本地模拟增量回复：建议先检查变更，再按最小范围处理。\n\n\`\`\`ts\nretryWithBackoff(task)\n\`\`\``;
    let cursor = 0;
    const stream = setInterval(() => {
      if (!target.streaming || !alive(item)) { clearInterval(stream); streamTimers.delete(item.id); return; }
      cursor += 9; target.text = reply.slice(0, cursor);
      // Incremental replies update their own text node. They never replace a live editor or IME composition.
      document.querySelectorAll(`[data-testid="session-chat-${item.id}"] [data-message-index="${messageIndex}"] .v3-message-text`).forEach((node) => { node.textContent = target.text; });
      document.querySelectorAll(`[data-chat-log="${item.id}"]`).forEach((node) => {
        const view = state.viewports[item.id]?.chat;
        if (!view || view.follow) node.scrollTop = node.scrollHeight;
      });
      if (cursor >= reply.length) {
        clearInterval(stream); streamTimers.delete(item.id); target.streaming = false;
        const attention = api.publishAttention({ session: item.id, kind: "approval", title: "需要批准模拟工具请求", reason: "读取 package.json", identity: `tool:${item.id}:${chat.messages.length}` });
        chat.tool = { status: "pending", title: "读取 package.json", detail: "检查项目配置，确认后读取演示内容。", attentionId: attention.id };
        setLife(item, "needs", "等待工具批准");
        persist(); api.render();
      }
    }, 50);
    streamTimers.set(item.id, stream);
  }
  function chatMarkup(item) {
    const chat = state.chats[item.id]; if (!chat) return "";
    const disabled = !alive(item), busy = streamTimers.has(item.id), pending = chat.tool?.status === "pending";
    const messages = chat.messages.map((m, index) => `<article class="v3-chat-message ${m.role}" data-message-index="${index}"><b>${m.role === "user" ? "你" : esc(item.agent)}</b><div><span class="v3-message-text">${esc(m.text)}</span>${m.streaming ? '<span class="v3-caret">▍</span>' : ""}</div></article>`).join("") || '<p class="v3-empty">向此会话发送一条消息，回复会以增量方式出现。</p>';
    const tool = chat.tool ? `<section class="v3-tool-card ${chat.tool.status}"><b>${esc(chat.tool.title)}</b><p>${esc(chat.tool.detail)}</p>${chat.tool.status === "pending" ? '<button class="btn" data-action="sessions-tool" data-session="' + esc(item.id) + '" data-choice="approve">批准</button><button class="btn" data-action="sessions-tool" data-session="' + esc(item.id) + '" data-choice="reject">拒绝</button>' : `<small>${chat.tool.status === "approved" ? "已批准（未执行）" : "已拒绝"}</small>`}</section>` : "";
    return `<section class="v3-session-chat" data-testid="session-chat-${esc(item.id)}"><header><b>Chat · ${esc(item.agent)}</b><span>演示会话</span></header><div class="v3-chat-log" data-chat-log="${esc(item.id)}">${messages}${tool}</div><form data-v3-chat-form="${esc(item.id)}"><textarea aria-label="发送给 ${esc(item.agent)}" placeholder="输入消息" ${disabled ? "disabled" : ""}>${esc(state.drafts[item.id] || "")}</textarea><div><span class="dim">${pending ? "请先批准或拒绝工具请求" : item.state === "failed" ? "会话失败，请重试后继续" : ""}</span><button class="btn" type="button" data-action="sessions-chat-stop" data-session="${esc(item.id)}" ${busy ? "" : "disabled"}>停止</button><button class="btn btn-primary" type="submit" ${disabled || busy || pending || item.state === "failed" ? "disabled" : ""}>发送</button></div></form></section>`;
  }
  function controlsMarkup(item) {
    const cfg = configFor(item.id), failed = item.state === "failed" || item.state === "retrying";
    return `<div class="v3-session-controls" data-testid="session-controls-${esc(item.id)}"><span class="v3-mode">${cfg.mode === "chat" ? "Chat" : "Terminal"} · ${cfg.oneShot ? "一次性任务" : "交互式"}${cfg.intent ? ` · ${esc(cfg.intent)}` : ""}</span>${api.btn("关闭视图", "sessions-close-view", { "data-session": item.id })}${api.btn("配置", "sessions-config", { "data-session": item.id })}${api.btn("手动运行", "sessions-run", { "data-session": item.id })}${failed ? api.btn("重试", "sessions-retry", { "data-session": item.id }, "btn") : ""}${item.state === "retrying" ? api.btn("取消倒计时", "sessions-cancel-retry", { "data-session": item.id }, "btn") : ""}${api.btn("模拟错误", "sessions-fail", { "data-session": item.id })}${api.btn("模拟完成", "sessions-complete", { "data-session": item.id })}</div>`;
  }
  function wire(root) {
    root.querySelectorAll("[data-v3-chat-form]").forEach((form) => {
      const sid = form.dataset.v3ChatForm, input = form.querySelector("textarea");
      input.addEventListener("input", () => { state.drafts[sid] = input.value; persist(); });
      form.addEventListener("submit", (event) => { event.preventDefault(); const item = session(sid), prompt = input.value.trim(); if (!alive(item) || item.state === "failed" || !prompt || streamTimers.has(sid) || state.chats[sid].tool?.status === "pending") return; state.chats[sid].messages.push({ role: "user", text: prompt }); state.drafts[sid] = ""; persist(); responseFor(item, prompt); api.render(); });
    });
    root.querySelectorAll('select[data-action="sessions-history-filter"]').forEach((select) => {
      select.addEventListener("change", () => { state.scan.filter = select.value; state.scan.page = 1; persist(); api.render(); });
    });
    root.querySelectorAll('select[data-action="sessions-history-cap"]').forEach((select) => {
      select.addEventListener("change", () => { state.historyCap = Number(select.value); state.scan.page = 1; state.history = state.history.slice(0, state.historyCap); persist(); api.render(); });
    });
    root.querySelectorAll('select[data-action="sessions-history-provider"]').forEach((select) => select.addEventListener("change", () => { state.scan.provider = select.value; state.scan.page = 1; persist(); api.render(); }));
    root.querySelectorAll('input[data-action="sessions-history-query"]').forEach((input) => input.addEventListener("input", () => { state.scan.query = input.value; state.scan.page = 1; persist(); api.render(); }));
    root.querySelectorAll("[data-chat-log], [data-session-log]").forEach((node) => {
      const sid = node.dataset.chatLog || node.dataset.sessionLog, kind = node.dataset.chatLog ? "chat" : "terminal";
      const views = (state.viewports[sid] ||= {});
      const saved = views[kind];
      if (!saved || saved.follow) node.scrollTop = node.scrollHeight;
      else node.scrollTop = saved.top;
      node.addEventListener("scroll", () => { views[kind] = { ...views[kind], top: node.scrollTop, follow: node.scrollHeight - node.scrollTop - node.clientHeight < 24 }; });
    });
  }
  function openCreate({ invoker, preferredTree = "", preferredProject = "", preferredAgent = "", preferredName = "" } = {}) {
    const preferred = api.trees[preferredTree];
    const liveProjects = Object.entries(api.projects).filter(([key]) => !api.store.deletedProjects?.includes(key) && !api.store.archivedProjects?.includes(key));
    const initialProject = api.projects[preferredProject] ? preferredProject : preferred?.project || liveProjects[0]?.[0];
    const types = [...AGENTS, ...TOOL_PRESETS];
    const initialAgent = types.includes(providerOf(preferredAgent)) ? providerOf(preferredAgent) : state.create.agent;
    const firstLive = Object.values(api.trees).find((tree) => tree.project === initialProject && availableTree(tree));
    const initialMode = state.create.mode === "chat" ? "chat" : "terminal";
    const projectOptions = liveProjects.map(([key, p]) => `<option value="${esc(key)}" ${key === initialProject ? "selected" : ""}>${esc(p.name)}</option>`).join("");
    const treeOptions = (project, selected = preferredTree) => Object.values(api.trees).filter((tree) => tree.project === project && availableTree(tree)).map((tree) => `<option value="${esc(tree.id)}" ${tree.id === selected ? "selected" : ""}>${esc(tree.branch)} · ${esc(tree.path)}</option>`).join("") || '<option value="">此项目没有可用工作目录</option>';
    const agentOptions = types.map((agent) => `<option ${agent === initialAgent ? "selected" : ""}>${esc(agent)}</option>`).join("");
    const typeLabel = (agent) => (agent === "Claude Code" ? "Claude" : agent === "命令预设" ? "预设" : agent);
    const chips = liveProjects.slice(0, 6).map(([key, p]) => `<button type="button" class="create-chip${key === initialProject ? " is-on" : ""}" data-create-project="${esc(key)}" title="${esc(p.path)}">${api.icon("folder")}<span>${esc(p.name)}</span></button>`).join("");
    const typeCards = types.map((agent) => `<button type="button" class="create-type${agent === initialAgent ? " is-on" : ""}" data-create-agent="${esc(agent)}" aria-pressed="${agent === initialAgent}">${api.agentIcon(agent, "create-type-ico")}<span>${esc(typeLabel(agent))}</span></button>`).join("");
    const body = `<form id="v3-create-form" class="create-form">
      <div class="create-block">
        <span class="create-label">最近项目</span>
        <div class="create-chips">${chips}</div>
      </div>
      <div class="create-block">
        <label class="create-label" for="create-name">名称</label>
        <input id="create-name" class="create-input" name="name" maxlength="60" value="${esc(preferredName)}" placeholder="开发会话" autocomplete="off">
      </div>
      <div class="create-block">
        <label class="create-label" for="create-project">项目</label>
        <select id="create-project" class="create-input" name="project">${projectOptions}</select>
      </div>
      <div class="create-block">
        <label class="create-label" for="create-tree">工作目录</label>
        <div class="create-path-row">
          <select id="create-tree" class="create-input create-input-mono" name="tree">${treeOptions(initialProject)}</select>
          <button type="button" class="create-browse" data-create-browse title="演示不打开系统文件夹">${api.icon("folder")}<span>浏览</span></button>
        </div>
        <input class="create-input create-input-mono" name="cwd" value="${esc(preferred?.path || firstLive?.path || "")}" placeholder="跟随所选工作目录" aria-label="工作目录路径">
      </div>
      <div class="create-block">
        <span class="create-label">类型</span>
        <div class="create-type-grid">${typeCards}</div>
        <select class="create-native" name="agent" aria-hidden="true" tabindex="-1">${agentOptions}</select>
      </div>
      <div class="create-block">
        <span class="create-label">创建方式</span>
        <div class="create-choice-grid" role="group" aria-label="创建方式">
          <button type="button" class="create-choice${initialMode === "terminal" ? " is-on" : ""}" data-create-mode="terminal" aria-pressed="${initialMode === "terminal"}">Terminal</button>
          <button type="button" class="create-choice${initialMode === "chat" ? " is-on" : ""}" data-create-mode="chat" aria-pressed="${initialMode === "chat"}">Chat</button>
        </div>
        <select class="create-native" name="mode" aria-hidden="true" tabindex="-1"><option value="terminal" ${initialMode === "terminal" ? "selected" : ""}>Terminal</option><option value="chat" ${initialMode === "chat" ? "selected" : ""}>Chat</option></select>
      </div>
      <div class="create-block" data-create-preset>
        <label class="create-label" for="create-preset">命令预设</label>
        <select id="create-preset" class="create-input" name="preset"><option value="npm run dev">npm run dev</option><option value="yarn dev">yarn dev</option><option value="pnpm dev">pnpm dev</option><option value="docker compose up">docker compose up</option><option value="python -m http.server">python -m http.server</option><option value="node server.js">node server.js</option><option value="custom">自定义</option></select>
      </div>
      <div class="create-block">
        <label class="create-label" for="create-startup">初始命令 <span class="create-optional">可选</span></label>
        <input id="create-startup" class="create-input create-input-mono" name="startup" placeholder="npm run dev" value="${esc(state.create.startup || "")}">
        <p class="create-hint">留空则使用该类型的默认命令。仅演示，不会执行。</p>
      </div>
      <div class="create-block" data-create-oneshot>
        <span class="create-label">执行方式</span>
        <div class="create-choice-grid">
          <label class="create-choice"><input type="radio" name="exec" value="interactive" ${state.create.oneShot ? "" : "checked"}> 交互会话</label>
          <label class="create-choice"><input type="radio" name="exec" value="oneShot" ${state.create.oneShot ? "checked" : ""}> 一次性运行</label>
        </div>
        <label class="create-native"><input type="checkbox" name="oneShot" ${state.create.oneShot ? "checked" : ""}> 一次性运行，完成后保留历史</label>
      </div>
    </form>`;
    const root = api.openDialog("新建终端", "", body, '<button class="btn" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit" form="v3-create-form">创建</button>', { invoker, variant: "create", icon: "terminal", tone: "primary" });
    const form = root.querySelector("#v3-create-form"), agentField = form.elements.agent, modeField = form.elements.mode;
    const paintTypes = () => {
      form.querySelectorAll("[data-create-agent]").forEach((node) => {
        const on = node.dataset.createAgent === agentField.value;
        node.classList.toggle("is-on", on);
        node.setAttribute("aria-pressed", String(on));
      });
    };
    const paintModes = () => {
      form.querySelectorAll("[data-create-mode]").forEach((node) => {
        const on = node.dataset.createMode === modeField.value;
        node.classList.toggle("is-on", on);
        node.setAttribute("aria-pressed", String(on));
      });
    };
    const paintChips = () => {
      form.querySelectorAll("[data-create-project]").forEach((node) => node.classList.toggle("is-on", node.dataset.createProject === form.elements.project.value));
    };
    const syncMode = () => {
      const supportsChat = AGENTS.includes(agentField.value);
      modeField.querySelector('option[value="chat"]').disabled = !supportsChat;
      if (!supportsChat && modeField.value === "chat") modeField.value = "terminal";
      form.querySelector('[data-create-mode="chat"]').disabled = !supportsChat;
      form.querySelector("[data-create-preset]").hidden = agentField.value !== "命令预设";
      form.querySelector("[data-create-oneshot]").hidden = modeField.value === "chat";
      form.elements.oneShot.disabled = modeField.value === "chat";
      if (modeField.value === "chat") {
        form.elements.oneShot.checked = false;
        const interactive = form.querySelector('input[name="exec"][value="interactive"]');
        if (interactive) interactive.checked = true;
      }
      paintTypes();
      paintModes();
    };
    agentField.addEventListener("change", syncMode);
    modeField.addEventListener("change", syncMode);
    form.elements.project.addEventListener("change", () => {
      form.elements.tree.innerHTML = treeOptions(form.elements.project.value, "");
      form.elements.cwd.value = api.trees[form.elements.tree.value]?.path || "";
      paintChips();
    });
    form.elements.tree.addEventListener("change", () => { form.elements.cwd.value = api.trees[form.elements.tree.value]?.path || ""; });
    form.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-create-project]");
      if (chip) {
        form.elements.project.value = chip.dataset.createProject;
        form.elements.project.dispatchEvent(new Event("change"));
        return;
      }
      const type = event.target.closest("[data-create-agent]");
      if (type) {
        agentField.value = type.dataset.createAgent;
        agentField.dispatchEvent(new Event("change"));
        return;
      }
      const mode = event.target.closest("[data-create-mode]");
      if (mode && !mode.disabled) {
        modeField.value = mode.dataset.createMode;
        modeField.dispatchEvent(new Event("change"));
      }
    });
    form.addEventListener("change", (event) => {
      if (event.target.name === "exec") form.elements.oneShot.checked = event.target.value === "oneShot";
      if (event.target.name === "oneShot") {
        const value = form.elements.oneShot.checked ? "oneShot" : "interactive";
        const radio = form.querySelector(`input[name="exec"][value="${value}"]`);
        if (radio) radio.checked = true;
      }
    });
    form.querySelector("[data-create-browse]").addEventListener("click", () => {
      form.elements.cwd.value = api.trees[form.elements.tree.value]?.path || form.elements.cwd.value;
      api.toast("演示不访问文件系统；已使用所选工作目录。");
    });
    syncMode();
    queueMicrotask(() => form.elements.name.focus());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      let tree = api.trees[String(data.get("tree"))];
      if (!availableTree(tree)) return api.toast("请选择一个可用、未归档的工作目录。");
      const agent = String(data.get("agent")), mode = String(data.get("mode")), sid = id();
      const custom = String(data.get("startup") || "").trim(), preset = String(data.get("preset"));
      if (mode === "chat" && !AGENTS.includes(agent)) return api.toast("此工具不支持 Chat。");
      if (agent === "命令预设" && preset === "custom" && !custom) return api.toast("自定义命令不能为空。");
      const requestedCwd = String(data.get("cwd") || "").trim();
      if (requestedCwd && !absolutePath(requestedCwd)) return api.toast("工作目录必须是绝对路径。");
      if (requestedCwd && normalizedPath(requestedCwd) !== normalizedPath(tree.path)) {
        const existing = treeForPath(requestedCwd);
        if (existing) tree = existing;
        else {
          tree = { id: `directory-${sid}`, project: tree.project, branch: requestedCwd.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "独立目录", path: requestedCwd, detail: "独立目录 · 演示", user: true, removable: true };
          api.store.userTrees.push(tree); api.trees[tree.id] = tree;
        }
      }
      const providerCommand = { "Claude Code": "claude", Codex: "codex", Kimi: "kimi", Gemini: "gemini", OpenCode: "opencode", Grok: "grok", Shell: "powershell" }[agent];
      const startup = agent === "命令预设" ? (preset === "custom" ? custom : preset) : (custom || providerCommand);
      const cwd = tree.path, oneShot = mode === "terminal" && Boolean(data.get("oneShot"));
      const item = { id: sid, project: tree.project, tree: tree.id, name: String(data.get("name") || "").trim() || `${agent} ${mode === "chat" ? "Chat" : "终端"}`, command: mode === "chat" ? "Chat" : startup, agent, state: "running", detail: "运行中", time: "刚刚", summary: "你创建的本地演示会话。", output: [`${agent} · ${mode === "chat" ? "Chat" : "Terminal"} 已创建`, `目录：${cwd}`, "演示会话已就绪。"] };
      api.store.userSessions.push(item);
      state.configs[sid] = { retry: "manual", limit: 2, retryCount: 0, retryHistory: [], pendingRestart: false, cwd, startup, mode, oneShot };
      state.create = { mode, agent, startup, oneShot };
      if (mode === "chat") state.chats[sid] = { messages: [], tool: null };
      persist(); api.closeDialog(false); api.openSession(sid);
      if (oneShot) completionTimers.set(sid, setTimeout(() => completeTask(item), 1200));
      api.toast(`已创建 ${item.name}。`);
    });
  }
  function openConfig(item, invoker) {
    const cfg = configFor(item.id);
    const intents = ["", "评审", "修复", "调研", "测试", "文档"];
    const body = `<form id="v3-config-form" class="v3-form"><label>名称<input name="name" value="${esc(api.displayName(item))}" maxlength="60" required></label><label>本次意图<select name="intent">${intents.map((intent) => `<option value="${intent}" ${cfg.intent === intent ? "selected" : ""}>${intent || "未设置"}</option>`).join("")}</select></label><label>自动重试<select name="retry"><option value="manual" ${cfg.retry === "manual" ? "selected" : ""}>仅手动</option><option value="automatic" ${cfg.retry === "automatic" ? "selected" : ""}>发生错误后自动倒计时</option></select></label><label>最多重试 <input name="limit" type="number" min="0" max="5" value="${Number(cfg.limit) || 0}"></label><label>启动信息<textarea name="startup">${esc(cfg.startup || item.command || "")}</textarea></label><p class="form-note">保存后，启动信息在下次运行生效；停用自动重试会立即取消待执行重试。保存并重启需要再次确认。</p><div class="v3-retry-history" data-testid="sessions-retry-history"><b>本轮自动重试 ${cfg.retryCount} / ${cfg.limit}</b>${cfg.retryHistory.length ? cfg.retryHistory.slice(-6).map((entry) => `<p>${esc(entry.at)} · ${esc(entry.result)}</p>`).join("") : "<p>尚无重试记录。</p>"}</div></form>`;
    const root = api.openDialog(`配置 · ${api.displayName(item)}`, "保存不会运行命令。", body, '<button class="btn" data-action="close-dialog">取消</button><button class="btn" type="submit" form="v3-config-form" data-v3-save="next">保存，下次启动</button><button class="btn btn-primary" type="submit" form="v3-config-form" data-v3-save="restart">保存并重启</button>', { invoker });
    root.querySelector("#v3-config-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const values = { name: String(data.get("name") || "").trim(), intent: String(data.get("intent") || ""), retry: String(data.get("retry")), limit: Math.max(0, Math.min(5, Number(data.get("limit")) || 0)), startup: String(data.get("startup") || "") };
      if (!values.name) return;
      if (event.submitter?.dataset.v3Save === "restart") {
        pendingConfig = { sessionId: item.id, values };
        api.openDialog("确认保存并重启", "当前运行和未完成回复会被中断，已保存的文件草稿不会受影响。", `<p>${esc(values.name)}</p><pre>${esc(values.startup)}</pre>`, `${api.btn("取消", "close-dialog")}${api.btn("确认重启", "sessions-config-confirm", {}, "btn btn-primary")}`);
      } else applySessionConfig(item, values, false);
    });
  }

  function applySessionConfig(item, values, restart) {
    const cfg = configFor(item.id);
    const waiting = timers.has(item.id);
    api.store.aliases[item.id] = values.name;
    Object.assign(cfg, { intent: values.intent, retry: values.retry, limit: values.limit, startup: values.startup, pendingRestart: !restart });
    if (cfg.retry === "manual" && waiting) {
      cancelTimer(item.id);
      setLife(item, "failed", "已停用自动重试，倒计时已取消");
      cfg.retryHistory.push({ at: now(), result: "停用自动重试，取消待执行运行" });
    }
    api.closeDialog(false);
    if (restart) { cfg.retryCount = 0; runTask(item, "按新配置重新运行"); }
    persist(); api.render();
    api.toast(restart ? "配置已保存，会话已重新运行。" : "配置已保存，启动信息在下次运行生效。");
  }
  function historyPanel() {
    const scan = state.scan, entries = visibleHistory(), pages = Math.max(1, Math.ceil(entries.length / 10));
    scan.page = Math.max(1, Math.min(scan.page, pages));
    const pageEntries = entries.slice((scan.page - 1) * 10, scan.page * 10), providers = [...new Set(state.history.map((entry) => entry.provider))];
    const rows = pageEntries.map((entry) => {
      const owner = historyOwner(entry), problem = historyProblem(entry);
      const attrs = { "data-history": entry.id };
      let actions = api.btn("读取", "sessions-history-detail", attrs);
      if (owner && !configFor(owner.id).importedOnly) actions += api.btn(api.store.archivedSessions.includes(owner.id) ? "复用归档卡片" : "打开已绑定会话", "sessions-history-open-bound", attrs, "btn");
      else if (entry.provider === "Shell") actions += '<span class="dim">Shell 只读</span>';
      else if (entry.kind === "missing" || !treeForPath(entry.cwd)) actions += api.btn("重新定位", "sessions-history-relocate", attrs, "btn");
      else {
        actions += api.btn("显式恢复", "sessions-history-resume", attrs, "btn");
        if (!owner && !problem) actions += api.btn("导入卡片", "sessions-history-import-card", attrs);
      }
      return `<article class="v3-history-row" data-history-row="${esc(entry.id)}"><div><b>${esc(entry.name)}</b><span>${esc(entry.provider)} · ${esc(entry.mode)} · ${esc(entry.at)}</span><small>${esc(owner ? `已绑定：${api.displayName(owner)}` : entry.detail)}</small></div><div class="v3-history-row-actions">${actions}</div></article>`;
    }).join("") || `<p class="v3-empty">${state.history.length ? "没有匹配记录，试着清除筛选。" : "扫描本机历史，或载入示例记录开始体验。"}</p>`;
    return `<section class="panel v3-history t-rail-history" data-testid="sessions-history" tabindex="-1"><header><div><h2>本机会话历史</h2><p data-testid="history-scan-status">${scan.status === "scanning" ? `已扫描 ${scan.progress}% · ${((Date.now() - scan.startedAt) / 1000).toFixed(1)} 秒` : scan.status === "done" ? `扫描完成 · ${state.history.length} 条记录 · ${scan.elapsed || "0.8"} 秒` : "读取历史不会启动会话，恢复需要明确确认。"}</p></div><button type="button" class="btn btn-primary" data-action="sessions-history-scan" ${scan.status === "scanning" ? "disabled" : ""}>${scan.status === "scanning" ? `扫描 ${scan.progress}%` : "扫描模拟历史"}</button>${scan.status === "scanning" ? '<button type="button" class="btn" data-action="sessions-history-cancel">取消扫描</button>' : ""}</header><div class="v3-history-tools"><input aria-label="搜索历史" data-action="sessions-history-query" value="${esc(scan.query)}" placeholder="搜索名称或目录"><select aria-label="历史提供者" data-action="sessions-history-provider"><option value="all">所有提供者</option>${providers.map((provider) => `<option ${scan.provider === provider ? "selected" : ""}>${esc(provider)}</option>`).join("")}</select><select aria-label="历史状态" data-action="sessions-history-filter"><option value="all">全部记录</option><option value="ended" ${scan.filter === "ended" ? "selected" : ""}>已结束</option><option value="missing" ${scan.filter === "missing" ? "selected" : ""}>目录缺失</option><option value="active" ${scan.filter === "active" ? "selected" : ""}>已绑定</option></select><label>演示保留 <select data-action="sessions-history-cap"><option value="20" ${state.historyCap === 20 ? "selected" : ""}>20 条</option><option value="50" ${state.historyCap === 50 ? "selected" : ""}>50 条</option><option value="80" ${state.historyCap === 80 ? "selected" : ""}>80 条</option></select></label>${api.btn("模拟扫描错误", "sessions-history-error")}${api.btn("载入示例", "sessions-history-import")}</div>${scan.error ? `<p class="v3-error" role="alert">${esc(scan.error)} ${api.btn("重试", "sessions-history-scan", {}, "btn")}</p>` : ""}<div class="v3-history-list">${rows}</div><div class="v3-history-tools">${api.btn("上一页", "sessions-history-page", { "data-page": scan.page - 1, disabled: scan.page <= 1 }, "btn")}<span data-testid="history-page">${scan.page} / ${pages} · ${entries.length} 条</span>${api.btn("下一页", "sessions-history-page", { "data-page": scan.page + 1, disabled: scan.page >= pages }, "btn")}</div></section>`;
  }
  api.onBeforeRender(() => {
    const active = document.activeElement;
    focusSnapshot = active?.matches("[data-v3-chat-form] textarea") ? { sessionId: active.closest("form").dataset.v3ChatForm, start: active.selectionStart, end: active.selectionEnd } : null;
    document.querySelectorAll("[data-chat-log], [data-session-log]").forEach((node) => {
      const sid = node.dataset.chatLog || node.dataset.sessionLog, kind = node.dataset.chatLog ? "chat" : "terminal";
      const views = (state.viewports[sid] ||= {});
      views[kind] = { ...views[kind], top: node.scrollTop, follow: node.scrollHeight - node.scrollTop - node.clientHeight < 24 };
    });
    api.sessions().forEach((item) => {
      if (api.isEnded(item) || api.isMissing(item)) {
        cancelTimer(item.id); cancelStream(item.id); cancelCompletion(item.id);
        const chat = state.chats[item.id];
        if (chat?.tool?.status === "pending") { resolveToolAttention(chat); chat.tool.status = "cancelled"; }
        chat?.messages.forEach((message) => { message.streaming = false; });
        addHistory(item, api.isMissing(item) ? "missing" : "ended", api.isMissing(item) ? "目录缺失，只读可查看。" : "会话已结束，输出保留。");
      }
      state.lifecycle[item.id] = { state: item.state, detail: item.detail, output: [...(item.output || [])] };
    });
    for (const key of ["wsTab", "wsFile", "wsTiles", "wsInspector", "termDrafts", "pendingByTree"]) state.workspace[key] = api.ui[key];
    persist();
  });
  api.onRender(({ app, route }) => {
    app.querySelectorAll(".term").forEach((node) => {
      const form = node.querySelector("[data-terminal-form]"), item = session(form?.dataset.terminalForm);
      if (!item || node.querySelector(".v3-session-controls")) return;
      node.querySelector(".term-head")?.insertAdjacentHTML("afterend", controlsMarkup(item));
      const log = node.querySelector(".term-out");
      if (log) log.dataset.sessionLog = item.id;
      if (isChat(item)) {
        log?.insertAdjacentHTML("afterend", chatMarkup(item));
        node.classList.add("v3-chat-terminal");
        node.querySelector(".term-cmd")?.setAttribute("hidden", "");
        log?.setAttribute("hidden", ""); form.hidden = true;
      }
    });
    const floating = app.querySelector(".float-term"), floatItem = session(api.ui.float.sessionId);
    if (floating && isChat(floatItem)) {
      floating.classList.add("v3-chat-float");
      floating.querySelector(".float-out").hidden = true;
      floating.querySelector(".float-input").hidden = true;
      floating.querySelector(".float-cwd").insertAdjacentHTML("afterend", chatMarkup(floatItem));
    }
    if (route.name === "terminals") {
      const slot = app.querySelector("[data-terminals-history]");
      if (slot) slot.outerHTML = historyPanel();
    }
    app.querySelectorAll("[data-chat-log], [data-session-log]").forEach((node) => {
      if (node.hidden) return;
      const sid = node.dataset.chatLog || node.dataset.sessionLog, kind = node.dataset.chatLog ? "chat" : "terminal";
      const view = ((state.viewports[sid] ||= {})[kind] ||= { follow: true, top: 0, count: 0, unread: 0 });
      const count = kind === "chat" ? state.chats[sid].messages.length : (session(sid)?.output || []).length + (api.ui.logs[sid] || []).length;
      if (!view.follow) view.unread = (view.unread || 0) + Math.max(0, count - (view.count || 0));
      else view.unread = 0;
      view.count = count;
      if (!view.follow) node.insertAdjacentHTML("afterend", api.btn(`${view.unread ? `${view.unread} 条新输出 · ` : ""}回到最新`, "sessions-log-bottom", { "data-session": sid, "data-kind": kind }, "btn v3-output-notice"));
    });
    wire(app);
    if (focusSnapshot) {
      const input = app.querySelector(`[data-v3-chat-form="${focusSnapshot.sessionId}"] textarea`);
      input?.focus({ preventScroll: true }); input?.setSelectionRange(focusSnapshot.start, focusSnapshot.end);
    }
  });
  api.extendMenu("session", ({ session: item }) => item ? `${api.btn("会话配置", "sessions-config", { "data-session": item.id }, "menu-item")}${api.btn("再次运行任务", "sessions-run", { "data-session": item.id }, "menu-item")}${api.btn("追加演示输出", "sessions-output-demo", { "data-session": item.id }, "menu-item")}${item.agent === "Codex" ? api.btn("登录链接", "sessions-login", { "data-session": item.id }, "menu-item") : ""}` : "");
  api.extendMenu("scenario", () => `<div class="menu-sep"></div>${api.btn("重置 V3 演示数据", "sessions-reset-open", {}, "menu-item")}`);
  api.registerActions({
    "sessions-reset-open": () => api.openDialog("重置 V3 演示数据", "清除本副本中的演示会话、草稿、偏好和配对状态。", "<p>旧版原型和真实项目文件均不受影响。页面将回到欢迎引导。</p>", `${api.btn("取消", "close-dialog")}${api.btn("确认重置", "sessions-reset-confirm", {}, "btn btn-primary")}`),
    "sessions-reset-confirm": () => api.resetPrototype(),
    "sessions-new": (el) => openCreate({ invoker: el }),
    "sessions-close-view": (el) => closeView(session(el.dataset.session)),
    "sessions-end-confirm": (el) => {
      const item = session(el.dataset.session); if (!item) return;
      const outcome = document.querySelector("#v3-end-outcome")?.value || "success";
      if (outcome === "success") finishEnd(item);
      else endProblem(item, outcome);
    },
    "sessions-end-keep": () => { clearTimeout(endWaitTimer); endWaitTimer = null; api.closeDialog(); },
    "sessions-end-retry": (el) => openEnd({ sessionId: el.dataset.session, invoker: el }),
    "sessions-end-force": (el) => finishEnd(session(el.dataset.session), true),
    "sessions-end-wait": (el) => {
      const status = document.querySelector('[data-testid="session-end-status"]');
      const item = session(el.dataset.session); if (!status || !item) return;
      status.textContent = "继续等待结束回执…";
      clearTimeout(endWaitTimer);
      endWaitTimer = setTimeout(() => {
        endWaitTimer = null;
        if (status.isConnected && !api.isEnded(item)) status.textContent = "仍未收到结束回执，可以保留会话、重试或强制结束。";
      }, 700);
    },
    "sessions-config": (el) => { const item = session(el.dataset.session); if (item) openConfig(item, el); },
    "sessions-config-confirm": () => { if (!pendingConfig) return; const item = session(pendingConfig.sessionId); if (item) applySessionConfig(item, pendingConfig.values, true); pendingConfig = null; },
    "sessions-run": (el) => runTask(session(el.dataset.session)),
    "sessions-complete": (el) => completeTask(session(el.dataset.session)),
    "sessions-fail": (el) => {
      const item = session(el.dataset.session); if (!alive(item)) return;
      cancelStream(item.id); cancelCompletion(item.id);
      const chat = state.chats[item.id];
      chat?.messages.forEach((message) => { message.streaming = false; });
      if (chat?.tool?.status === "pending") { resolveToolAttention(chat); chat.tool.status = "cancelled"; }
      setLife(item, "failed", "模拟错误：等待处理"); appendOutput(item, "错误：模拟提供者响应失败。");
      const cfg = configFor(item.id);
      api.publishAttention({ session: item.id, kind: "failed", title: "模拟会话失败", reason: "提供者响应失败，可手动重试。", identity: `failed:${item.id}:${Date.now()}` });
      if (cfg.retry === "automatic") startRetry(item, true);
      persist(); api.render();
    },
    "sessions-retry": (el) => { const item = session(el.dataset.session); if (item && !api.isEnded(item) && !api.isMissing(item)) startRetry(item, false); },
    "sessions-cancel-retry": (el) => { const item = session(el.dataset.session); if (!item) return; cancelTimer(item.id); configFor(item.id).retryHistory.push({ at: now(), result: "已取消倒计时" }); setLife(item, "failed", "已取消自动重试"); persist(); api.render(); },
    "sessions-chat-stop": (el) => { const chat = state.chats[el.dataset.session], item = session(el.dataset.session); if (!chat || !streamTimers.has(el.dataset.session)) return; cancelStream(el.dataset.session); const last = chat.messages.at(-1); if (last?.streaming) { last.streaming = false; last.text += "\n\n[已停止]"; } setLife(item, "running", "回复已停止，可以继续输入"); persist(); api.render(); },
    "sessions-tool": (el) => {
      const chat = state.chats[el.dataset.session], item = session(el.dataset.session);
      if (!alive(item) || chat?.tool?.status !== "pending") return;
      chat.tool.status = el.dataset.choice === "approve" ? "approved" : "rejected";
      chat.tool.detail = chat.tool.status === "approved" ? '演示结果：{"name":"orbit-web","scripts":{"dev":"vite"}}' : "请求已拒绝，文件内容未读取。";
      resolveToolAttention(chat);
      setLife(item, "running", "本轮回复已完成");
      api.publishAttention({ session: item.id, kind: "review", title: "Chat 回复已完成", reason: chat.tool.status === "approved" ? "演示工具结果已就绪。" : "工具请求已拒绝，可以继续对话。", identity: `tool-result:${item.id}:${chat.messages.length}` });
      persist(); api.render();
    },
    "sessions-history-jump": () => {
      if (api.ui.tInspect) {
        api.ui.tInspect = "";
        api.ui.tHighlight = "";
        api.render();
      }
      const panel = document.querySelector('[data-testid="sessions-history"]');
      panel?.focus({ preventScroll: true });
    },
    "sessions-history-scan": scanHistory,
    "sessions-history-cancel": () => stopScan(),
    "sessions-history-error": () => stopScan("error", "扫描中断：模拟目录索引不可用。"),
    "sessions-history-page": (el) => { state.scan.page = Number(el.dataset.page) || 1; persist(); api.render(); },
    "sessions-history-import": () => { scanFixtures(); persist(); api.render(); },
    "sessions-history-import-card": (el) => { const entry = historyById(el.dataset.history); if (historyProblem(entry)) return api.toast(historyProblem(entry)); if (historyOwner(entry)) return openBoundHistory(entry); historyItem(entry, entry.mode, true); api.render(); api.toast("已导入只读卡片，尚未恢复或执行。"); },
    "sessions-history-detail": (el) => {
      const entry = historyById(el.dataset.history); if (!entry) return;
      const output = entry.mode === "chat" && entry.messages?.length ? entry.messages.map((message) => `${message.role === "user" ? "你" : entry.provider}: ${message.text}`).join("\n\n") : (entry.output || session(entry.sessionId)?.output || []).join("\n");
      api.openDialog(`历史详情 · ${entry.name}`, "只读快照 · 读取不会恢复或执行。", `<div class="v3-history-detail"><p><b>${esc(entry.provider)}</b> · ${esc(entry.mode)} · ${esc(entry.cwd || "目录未知")}</p><p>会话身份：${esc(entry.nativeId || "无 AI 会话 ID")} · ${entry.interactiveRoot === false ? "只读子记录 / 输出" : "可交互根记录"}</p><pre>${esc(output)}</pre></div>`, api.btn("关闭", "close-dialog"));
    },
    "sessions-history-open-bound": (el) => { api.closeDialog(false); openBoundHistory(historyById(el.dataset.history)); },
    "sessions-history-unarchive": (el) => { const entry = historyById(el.dataset.history), owner = historyOwner(entry); if (!owner) return; api.store.archivedSessions = api.store.archivedSessions.filter((sid) => sid !== owner.id); persist(); api.closeDialog(false); api.openSession(owner.id); },
    "sessions-history-relocate": (el) => relocateHistory(historyById(el.dataset.history)),
    "sessions-history-resume": (el) => openHistoryResume(historyById(el.dataset.history)),
    "sessions-history-confirm": (el) => confirmHistoryResume(historyById(el.dataset.history)),
    "sessions-output-demo": (el) => { const item = session(el.dataset.session); if (!item) return; const offset = item.output?.length || 0; for (let line = 1; line <= 40; line += 1) appendOutput(item, `[输出 ${offset + line}] 检查任务 ${line} / 40 · 已通过`); persist(); api.render(); },
    "sessions-log-bottom": (el) => { const view = state.viewports[el.dataset.session]?.[el.dataset.kind]; if (view) { view.follow = true; view.unread = 0; } document.querySelectorAll(`[data-${el.dataset.kind === "chat" ? "chat" : "session"}-log="${el.dataset.session}"]`).forEach((node) => { node.scrollTop = node.scrollHeight; }); api.render(); },
    "sessions-login": () => api.openDialog("Codex 登录链接", "此为登录过程演示，链接使用保留的 example 域名。", '<p>在浏览器完成登录后，终端会继续启动。</p><input aria-label="演示登录链接" id="v3-login-url" readonly value="https://login.example/activate?code=TT-CODEX">', `${api.btn("关闭", "close-dialog")}${api.btn("复制链接", "sessions-login-copy")}${api.btn("预览登录页", "sessions-login-preview", {}, "btn btn-primary")}`),
    "sessions-login-copy": async () => { const input = document.querySelector("#v3-login-url"); if (!input) return; try { await navigator.clipboard.writeText(input.value); api.toast("已复制演示链接。"); } catch { input.select(); api.toast("链接已选中，可按 Ctrl+C 复制。"); } },
    "sessions-login-preview": () => api.openDialog("浏览器登录 · 演示", "登录已完成后返回终端。", '<p>当前设备已获准连接演示账户。</p><p>此页面没有进行网络请求。</p>', api.btn("返回终端", "close-dialog", {}, "btn btn-primary")),
  });
  api.registerCreator(openCreate);
  api.registerTerminator(openEnd);
  api.onReset(() => { clearTimeout(endWaitTimer); endWaitTimer = null; scanGeneration += 1; clearInterval(scanTimer); scanTimer = null; timers.forEach((timer) => clearInterval(timer)); timers.clear(); streamTimers.forEach((timer) => clearInterval(timer)); streamTimers.clear(); completionTimers.forEach((timer) => clearTimeout(timer)); completionTimers.clear(); pendingConfig = null; });
  /* app.js performs its first paint before feature scripts load. */
  api.render();
})();

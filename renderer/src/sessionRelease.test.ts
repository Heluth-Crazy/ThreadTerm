import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderCapability, Session } from "@threadterm/protocol";
import { releaseBlockedReason, releaseErrorText, releaseMenuLabel } from "./sessionRelease";
import { sessionState, sessionStateLabel } from "./sessionState";

const provider = (overrides: Partial<ProviderCapability> = {}): ProviderCapability => ({
  id: "codex", name: "Codex", installed: true, terminal: true, chat: true,
  history: true, resume: true, terminalResumeCapture: "preassigned", auth: "authenticated",
  ...overrides,
});
const session = (overrides: Partial<Session> = {}): Session => ({
  id: "s", title: "Session", provider: "codex", mode: "chat", status: "idle",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  nativeId: "native-1", ...overrides,
} as Session);

test("the session menu offers the short Stop label in both languages", () => {
  assert.equal(releaseMenuLabel(false), "Stop (release resources)");
  assert.equal(releaseMenuLabel(true), "停止（释放资源）");
});

test("a released session reads as Stopped, not as a read-only or ended history", () => {
  assert.equal(sessionStateLabel(sessionState(session({ status: "exited" })), false), "Ended");
  assert.equal(sessionStateLabel(sessionState(session({ status: "exited" })), true), "已结束");
  assert.equal(sessionStateLabel(sessionState(session({ status: "exited" })), false, false, true), "Stopped");
  assert.equal(sessionStateLabel(sessionState(session({ status: "exited" })), true, false, true), "已停止");
});

test("release eligibility explains a running turn, pending interaction, missing ID, or a non-resuming provider", () => {
  assert.equal(releaseBlockedReason(session(), [provider()], false), undefined);
  assert.match(releaseBlockedReason(session({ status: "running" }), [provider()], false)!, /working/);
  assert.match(releaseBlockedReason(session({ activity: { state: "awaiting_approval", revision: 1 } }), [provider()], false)!, /waiting/);
  assert.match(releaseBlockedReason(session({ nativeId: undefined }), [provider()], false)!, /could not be continued later/);
  assert.match(releaseBlockedReason(session({ mode: "terminal" }), [provider({ terminalResumeCapture: "none" })], false)!, /cannot continue a terminal later/);
  assert.match(releaseBlockedReason(session({ status: "exited" }), [provider()], true)!, /未在运行/);
});

test("a released chat keeps control and offers one compact Continue action", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server.edge");
  const { createElement } = await import("react");
  const { StoppedState } = await import("./components/StoppedState");
  const { chatCanControl } = await import("./chatPresentation");
  const released = session({ status: "exited", released: true });
  assert.equal(chatCanControl(released), true, "a released chat can be resumed by an explicit action");
  assert.equal(chatCanControl(session({ status: "exited" })), false, "an ended chat cannot");
  assert.equal(chatCanControl(session({ status: "exited", released: true, readOnly: true })), false);
  const render = (zh: boolean, busy = false) => renderToStaticMarkup(createElement(StoppedState, { zh, busy, onContinue() {} }));
  for (const html of [render(false), render(true)]) {
    assert.match(html, /Stopped|已停止/);
    assert.match(html, /Continue|继续/);
    assert.match(html, /role="status"/);
  }
  assert.match(render(false, true), /Connecting/);
  assert.match(render(true, true), /正在连接/);
});

test("the terminal's stopped footer uses the same compact state, without a resume description", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server.edge");
  const { createElement } = await import("react");
  const { StoppedState } = await import("./components/StoppedState");
  // The terminal banner renders this row as its whole action; the released
  // terminal has no resume-on-open wording any more.
  const html = renderToStaticMarkup(createElement(StoppedState, { zh: false, onContinue() {} }));
  assert.match(html, /Stopped/);
  assert.match(html, /Continue/);
  const source = await import("node:fs").then(fs => fs.readFileSync("renderer/src/components/TerminalSurface.tsx", "utf8"));
  assert.doesNotMatch(source, /releasedResumeRequested/);
  assert.match(source, /onKeyDown=\{resumeOnTyping\}/);
});
test("archiving checks every live session first and names the ones it cannot stop", async () => {
  const { archiveReleaseRefusals } = await import("./sessionRelease");
  const live = [session({ title: "Docs", status: "idle" }), session({ title: "Shell", status: "running" })];
  assert.equal(archiveReleaseRefusals([live[0]], [provider()], false), undefined);
  const refusal = archiveReleaseRefusals(live, [provider()], false)!;
  assert.deepEqual(refusal.titles, ["Shell"]);
  assert.match(refusal.reason, /Shell/);
  assert.match(refusal.reason, /Finish or close them/);
  const zh = archiveReleaseRefusals([session({ title: "文档", nativeId: undefined })], [provider()], true)!;
  assert.match(zh.reason, /文档/);
  // Ended rows are not release candidates, so they never refuse the archive.
  assert.equal(archiveReleaseRefusals([session({ status: "exited" })], [provider()], false), undefined);
});
test("a running terminal is refused by the menu before the request is sent", () => {
  // The terminal agent's activity is what the runtime checks; the menu shows the
  // same one-line reason instead of offering a Stop that would be refused.
  const running = session({ mode: "terminal", status: "running", activity: { state: "running", revision: 3 } });
  assert.match(releaseBlockedReason(running, [provider()], false)!, /working/);
  assert.match(releaseBlockedReason(running, [provider()], true)!, /正在工作/);
  const idle = session({ mode: "terminal", status: "idle", activity: { state: "idle", revision: 3 } });
  assert.equal(releaseBlockedReason(idle, [provider()], false), undefined);
});

test("a refused Stop shows the reason in the reader's language, never the runtime code", () => {
  const queued = new Error("Error invoking remote method 'threadterm:request': Error: session_release_blocked: send or remove the queued messages first");
  assert.equal(releaseErrorText(queued, false), "Send or remove its queued messages first.");
  assert.equal(releaseErrorText(queued, true), "请先发送或删除它排队中的消息。");
  const pending = new Error("session_release_blocked: answer or dismiss the pending request first");
  assert.equal(releaseErrorText(pending, true), "请先回答或关闭它待处理的请求。");
  const unknown = new Error("session_release_blocked: something new");
  assert.equal(releaseErrorText(unknown, false), "This session can't be stopped right now.");
  for (const caught of [queued, pending, unknown]) {
    assert.doesNotMatch(releaseErrorText(caught, false), /session_release/);
    assert.doesNotMatch(releaseErrorText(caught, true), /session_release/);
  }
});

test("the idle menu entry is hidden with nothing idle and shows its count and memory", async () => {
  const { idleMenuLabel } = await import("./sessionRelease");
  assert.equal(idleMenuLabel(0, 1024, false), undefined);
  assert.equal(idleMenuLabel(3, 1.6 * 1024 ** 3, false), "Stop idle sessions (3 · 1.6 GB)");
  assert.match(idleMenuLabel(2, 512 * 1024 ** 2, true)!, /2/);
  assert.match(idleMenuLabel(2, 512 * 1024 ** 2, true)!, /512\.0 MB/);
});

test("the lease pool reports visible only while some holder is visible", async () => {
  const { createLeasePool, sessionVisible } = await import("./controlLease");
  const seen: (boolean | undefined)[] = [];
  const pool = createLeasePool({ claim: async () => 1, renew: async (_id, _epoch, visible) => { seen.push(visible); }, release: async () => {} });
  const hidden = await pool("s", () => {}, () => false);
  const shown = await pool("s", () => {}, () => true);
  await hidden.check();
  assert.equal(seen.at(-1), true, "one visible holder makes the lease visible");
  shown.release();
  await hidden.check();
  assert.equal(seen.at(-1), false, "a hidden holder alone reports hidden");
  hidden.release();
  assert.equal(sessionVisible({ getClientRects: () => ({ length: 1 }) as DOMRectList }, true), true);
  assert.equal(sessionVisible({ getClientRects: () => ({ length: 0 }) as DOMRectList }, true), false);
  assert.equal(sessionVisible({ getClientRects: () => ({ length: 1 }) as DOMRectList }, false), false);
});

test("Running agents renders one dense row per live tree, its setting and a quiet empty state", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server.edge");
  const { createElement } = await import("react");
  const { RunningAgentsView } = await import("./components/RunningAgents");
  const sessions = [
    { id: "a", title: "Fix the login redirect", provider: "codex", mode: "chat", status: "idle", createdAt: "", updatedAt: "", projectId: "p", worktreePath: "D:/work/app-feature" },
    { id: "b", title: "Review docs", provider: "claude", mode: "chat", status: "running", createdAt: "", updatedAt: "", projectId: "p", worktreePath: "D:/work/app" },
  ] as never;
  const projects = [{ id: "p", name: "App", path: "D:/work/app", createdAt: "" }] as never;
  const view = (processes: unknown, idleMinutes = 30) => renderToStaticMarkup(createElement(RunningAgentsView, {
    processes: processes as never, sessions, projects, zh: false, idleMinutes,
    onStopIdle() {}, onStop() {}, onOpen() {}, onIdleMinutes() {},
  }));
  const html = view({ sessions: [
    { sessionId: "a", processCount: 24, memoryBytes: 588_000_000, idleSeconds: 12 * 60, visible: false, idle: true },
    { sessionId: "b", processCount: 8, memoryBytes: 120_000_000, idleSeconds: 3, visible: true, idle: false, blocked: "the session is working or waiting for your answer" },
  ], memoryBytes: 708_000_000, idleReleaseMinutes: 30 });
  assert.match(html, /Running agents/);
  assert.match(html, /2 running · 675\.2 MB/);
  assert.match(html, /Fix the login redirect/);
  assert.match(html, /App · app-feature/);
  assert.match(html, /Idle 12 min/);
  assert.match(html, /In view/);
  assert.match(html, /Stop idle \(1 · 560\.8 MB\)/);
  // The shared Select shows the chosen option on its trigger; the label comes from the option list.
  assert.match(html, /data-value="30"[^>]*><span class="tt-select-value">30 min</);
  assert.match(html, /data-agent-tile="codex"/, "rows use the sidebar agent icon");
  assert.ok(html.indexOf("Stop idle") < html.indexOf("running-agents-rows"), "Stop idle sits on the header line");
  const empty = view({ sessions: [], idleReleaseMinutes: 30 });
  assert.match(empty, /No agent processes are running\./);
  assert.doesNotMatch(empty, /Stop idle/);
  const imported = view({ sessions: [], idleReleaseMinutes: 45 }, 45);
  assert.match(imported, /data-value="45"[^>]*><span class="tt-select-value">45 min</, "an imported idle value stays selectable");
  const off = view({ sessions: [{ sessionId: "a", processCount: 2, memoryBytes: 10_000_000, idleSeconds: 120, visible: false, idle: true }], memoryBytes: 10_000_000, idleReleaseMinutes: 0 }, 0);
  assert.match(off, /Stop idle \(1/, "Stop idle is available with auto-release Off");
  assert.match(off, /data-value="0"[^>]*><span class="tt-select-value">Off</);
});

test("a blocked row shows the refusal reason and disables only its own Stop", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server.edge");
  const { createElement } = await import("react");
  const { RunningAgentsView } = await import("./components/RunningAgents");
  const sessions = [
    { id: "waiting", title: "Answer the plan", provider: "codex", mode: "chat", status: "waiting", createdAt: "", updatedAt: "", projectId: "p" },
    { id: "blocked", title: "Background sync", provider: "codex", mode: "chat", status: "idle", createdAt: "", updatedAt: "", projectId: "p" },
  ] as never;
  const html = renderToStaticMarkup(createElement(RunningAgentsView, {
    processes: { sessions: [
      { sessionId: "waiting", processCount: 4, memoryBytes: 80_000_000, idleSeconds: 900, visible: false, idle: false, blocked: "the session is working or waiting for your answer" },
      { sessionId: "blocked", processCount: 2, memoryBytes: 20_000_000, idleSeconds: 900, visible: false, idle: false, blocked: "a background task is running" },
    ], memoryBytes: 100_000_000, idleReleaseMinutes: 30 } as never,
    sessions, projects: [], zh: false, idleMinutes: 30,
    onStopIdle() {}, onStop() {}, onOpen() {}, onIdleMinutes() {},
  }));
  assert.match(html, /Waiting for you/);
  assert.match(html, />Background task</, "the row shows a short label, not the runtime sentence");
  assert.doesNotMatch(html, /a background task is running/);
  assert.match(html, /title="A background task is still running\. Stop it first\."/);
  assert.match(html, /running-agents-row-stop[^>]*disabled/);
  assert.match(html, /aria-label="Stop Answer the plan"/);
  const zhHtml = renderToStaticMarkup(createElement(RunningAgentsView, {
    processes: { sessions: [
      { sessionId: "blocked", processCount: 2, memoryBytes: 20_000_000, idleSeconds: 900, visible: false, idle: false, blocked: "a background task is running" },
      { sessionId: "waiting", processCount: 4, memoryBytes: 80_000_000, idleSeconds: 900, visible: false, idle: false, blocked: "send or remove the queued messages first" },
    ], memoryBytes: 100_000_000, idleReleaseMinutes: 30 } as never,
    sessions, projects: [], zh: true, idleMinutes: 30,
    onStopIdle() {}, onStop() {}, onOpen() {}, onIdleMinutes() {},
  }));
  assert.match(zhHtml, />后台任务运行中</);
  assert.match(zhHtml, />有排队消息</);
  assert.doesNotMatch(zhHtml, /queued messages|background task/, "no English runtime text in the Chinese UI");
});


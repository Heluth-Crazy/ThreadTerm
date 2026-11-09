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

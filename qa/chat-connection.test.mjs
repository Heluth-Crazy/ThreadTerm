import assert from "node:assert/strict";
import test from "node:test";
import { applyConnectionEvent, emptyLink, overlayKind, reduceChatLink, connectionStatusText, mergeConnectionSnapshot, mergeConnectionEvent } from "../renderer/src/chatConnection.ts";
import { approvalButtonsEnabled, approvalData, scopeLabel } from "../renderer/src/chatApproval.ts";

const copy = (en, zh) => zh;

test("reconnect stays non-writable until the authoritative snapshot, including same-DB restart", () => {
  let state = emptyLink("s");
  const ready = { ...state.connection, phase: "ready", runtimeEpoch: "db-epoch", connectionGeneration: 8, revision: 20 };
  state = reduceChatLink(state, { type: "snapshot", snapshot: ready });
  state = reduceChatLink(state, { type: "transport-down" });
  state = reduceChatLink(state, { type: "transport-up", epoch: "db-epoch" });
  assert.equal(state.transport, "syncing");
  assert.equal(state.transport === "up" && state.connection.phase === "ready", false);
  const stale = reduceChatLink(state, { type: "snapshot", snapshot: ready, transportGeneration: 0 });
  assert.deepEqual(stale, state);
  // A restarted daemon may use the existing database epoch and reset its worker generation.
  state = reduceChatLink(state, { type: "snapshot", transportGeneration: 2, resync: true,
    snapshot: { ...ready, phase: "disconnected", connectionGeneration: 0, revision: 0 } });
  assert.equal(state.transport, "up");
  assert.equal(state.connection.phase, "disconnected");
});

test("only the current reconnect query can unlock writes; wrong epochs and sessions stay blocked", () => {
  let state = emptyLink("s");
  state = reduceChatLink(state, { type: "transport-down" });
  state = reduceChatLink(state, { type: "transport-up", epoch: "runtime" });
  const ready = { ...state.connection, phase: "ready", runtimeEpoch: "runtime", connectionGeneration: 1, revision: 1 };
  for (const snapshot of [{ ...ready, runtimeEpoch: "random-handshake-id" }, { ...ready, sessionId: "other" }]) {
    assert.equal(reduceChatLink(state, { type: "snapshot", snapshot, transportGeneration: 2, resync: true }).transport, "syncing");
  }
  state = reduceChatLink(state, { type: "transport-down" });
  state = reduceChatLink(state, { type: "transport-up", epoch: "runtime" });
  assert.equal(reduceChatLink(state, { type: "snapshot", snapshot: ready, transportGeneration: 2, resync: true }).transport, "syncing");
  state = reduceChatLink(state, { type: "snapshot", snapshot: ready, transportGeneration: 4, resync: true });
  assert.equal(state.transport, "up");
  assert.equal(state.connection.phase, "ready");
});

test("full overlay waits for provider ready, not lease or history", () => {
  assert.equal(overlayKind({ ended: false, canControl: true, phase: "connecting", hasTranscript: false, sessionStatus: "starting" }), "full");
  assert.equal(overlayKind({ ended: false, canControl: true, phase: "connecting", hasTranscript: false, sessionStatus: "running" }), "full");
  assert.equal(overlayKind({ ended: false, canControl: true, phase: "connecting", hasTranscript: false, sessionStatus: "waiting" }), "full");
  assert.equal(overlayKind({ ended: false, canControl: true, phase: "ready", hasTranscript: false, sessionStatus: "idle" }), "none");
  assert.equal(overlayKind({ ended: false, canControl: true, phase: "connecting", hasTranscript: true, sessionStatus: "idle" }), "banner");
});

test("generation and waiting do not use the connection overlay", () => {
  assert.equal(overlayKind({ ended: false, canControl: true, phase: "ready", hasTranscript: true, sessionStatus: "running" }), "none");
  assert.equal(overlayKind({ ended: false, canControl: true, phase: "ready", hasTranscript: true, sessionStatus: "waiting" }), "none");
  assert.equal(overlayKind({ ended: false, canControl: true, phase: "disconnected", hasTranscript: true, sessionStatus: "running" }), "banner");
});

test("read-only and ended views never show a connection overlay", () => {
  assert.equal(overlayKind({ ended: true, canControl: false, phase: "disconnected", hasTranscript: true, sessionStatus: "exited" }), "none");
  assert.equal(overlayKind({ ended: false, canControl: false, phase: "connecting", hasTranscript: false, sessionStatus: "idle" }), "none");
});

test("pipe-down keeps provider ready but blocks overlay as a reconnect banner", () => {
  assert.equal(overlayKind({ ended: false, canControl: true, phase: "ready", hasTranscript: true, sessionStatus: "idle", transportDown: true }), "banner");
  assert.equal(overlayKind({ ended: false, canControl: true, phase: "ready", hasTranscript: false, sessionStatus: "idle", transportDown: true }), "banner");
  assert.equal(overlayKind({ ended: false, canControl: true, phase: "connecting", hasTranscript: false, sessionStatus: "starting", transportDown: true }), "full");
});

test("stale connection events from older generations are ignored", () => {
  const current = { ...emptyLink("s").connection, phase: "ready", connectionGeneration: 3, revision: 5, runtimeEpoch: "e1" };
  assert.equal(applyConnectionEvent(current, { ...emptyLink("s").connection, phase: "connecting", connectionGeneration: 2, revision: 9, runtimeEpoch: "e1" }, "e1"), null);
  assert.equal(applyConnectionEvent(current, { ...emptyLink("other").connection, phase: "failed", connectionGeneration: 4, revision: 1, runtimeEpoch: "e1" }, "e1"), null);
  const next = applyConnectionEvent(current, { ...emptyLink("s").connection, phase: "disconnected", connectionGeneration: 3, revision: 6, runtimeEpoch: "e1" }, "e1");
  assert.equal(next.phase, "disconnected");
});

test("late events from a previous runtime epoch are dropped, snapshots resync", () => {
  const current = { ...emptyLink("s").connection, phase: "ready", connectionGeneration: 2, revision: 4, runtimeEpoch: "e2" };
  assert.equal(applyConnectionEvent(current, { ...emptyLink("s").connection, phase: "disconnected", connectionGeneration: 9, revision: 9, runtimeEpoch: "e1" }, "e1"), null);
  assert.equal(mergeConnectionEvent(current, { ...emptyLink("s").connection, phase: "failed", connectionGeneration: 9, revision: 9, runtimeEpoch: "e1" }, "e1").runtimeEpoch, "e2");
  assert.equal(mergeConnectionSnapshot(current, { ...emptyLink("s").connection, phase: "ready", connectionGeneration: 1, revision: 1, runtimeEpoch: "e3" }).runtimeEpoch, "e2");
});

test("ChatView-style reducer never applies a dropped late result as next", () => {
  let state = emptyLink("s", "connecting");
  state = reduceChatLink(state, { type: "snapshot", snapshot: { ...state.connection, phase: "ready", runtimeEpoch: "e1", connectionGeneration: 1, revision: 1, optionsLoadState: "ready" } });
  assert.equal(state.connection.phase, "ready");
  const late = reduceChatLink(state, { type: "event", snapshot: { ...state.connection, sessionId: "s", phase: "failed", runtimeEpoch: "old", connectionGeneration: 0, revision: 0, optionsLoadState: "unknown" }, epoch: "old" });
  assert.equal(late.connection.phase, "ready");
  assert.equal(late.connection.runtimeEpoch, "e1");
  const down = reduceChatLink(state, { type: "transport-down" });
  assert.equal(down.transport, "down");
  assert.equal(down.connection.phase, "ready");
  const up = reduceChatLink(down, { type: "transport-up", epoch: "e1", snapshot: { ...state.connection, phase: "ready", runtimeEpoch: "e1", connectionGeneration: 1, revision: 1, optionsLoadState: "ready" } });
  assert.equal(up.transport, "up");
  assert.equal(up.connection.phase, "ready");
  const restarted = reduceChatLink(down, { type: "transport-up", epoch: "e2", snapshot: { ...emptyLink("s").connection, phase: "disconnected", runtimeEpoch: "e2", connectionGeneration: 2, revision: 1, optionsLoadState: "unknown" } });
  assert.equal(restarted.connection.phase, "disconnected");
  assert.equal(restarted.connection.runtimeEpoch, "e2");
});

test("connection copy names the current provider", () => {
  assert.match(connectionStatusText("kimi", "connecting", copy), /Kimi/);
  assert.match(connectionStatusText("codex", "failed", copy), /Codex/);
  assert.match(connectionStatusText("grok", "disconnected", copy), /Grok/);
  assert.match(connectionStatusText("kimi", "ready", copy, true), /断开|lost/i);
});

test("approval cards require live pending choices and keep once/always distinct", () => {
  const part = {
    type: "approval",
    approvalId: "a1",
    status: "pending",
    data: {
      approvalId: "a1",
      submittable: true,
      choices: [
        { choiceId: "always", label: "Always", kind: "allow", scope: "persistent" },
        { choiceId: "once", label: "Once", kind: "allow", scope: "once" },
      ],
    },
  };
  const data = approvalData(part);
  assert.equal(data.choices[0].choiceId, "always");
  assert.equal(data.choices[1].choiceId, "once");
  assert.equal(scopeLabel(data.choices[1].scope, copy), "仅本次");
  assert.equal(approvalButtonsEnabled(part, true), true);
  assert.equal(approvalButtonsEnabled({ ...part, status: "resolved" }, true), false);
  assert.equal(approvalButtonsEnabled({ ...part, status: "expired" }, true), false);
  assert.equal(approvalButtonsEnabled({ type: "approval", approvalId: "old", status: "pending", data: { title: "legacy" } }, true), false);
});

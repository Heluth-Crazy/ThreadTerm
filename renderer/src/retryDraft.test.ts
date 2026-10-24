import assert from "node:assert/strict";
import test from "node:test";
import { adoptStoredRetry, editRetryDraft, initialRetryDraft, mergeStoredRetry, retryEventRelevant, savedRetryDraft } from "./retryDraft";

test("a reload for another session or unrelated activity never touches the draft", () => {
  const dirty = editRetryDraft(initialRetryDraft(2), 5);
  assert.equal(dirty.dirty, true);
  assert.deepEqual(mergeStoredRetry(dirty, 2), dirty, "an unchanged stored value leaves the typed maximum alone");
  assert.equal(dirty.value, 5);
  for (const event of [
    { event: "state.changed", data: { sessionId: "other", kind: "retry.scheduled" } },
    { event: "state.changed", data: { kind: "inbox" } },
    { event: "state.changed", data: { sessionId: "session-a", kind: "chat.message" } },
    { event: "session.status", data: { sessionId: "other" } },
    { event: "chat.context", data: { sessionId: "session-a" } },
  ]) assert.equal(retryEventRelevant(event, "session-a"), false, JSON.stringify(event));
});

test("retry, launch and own-status events reload the panel", () => {
  assert.equal(retryEventRelevant({ event: "state.changed", data: { kind: "retry.scheduled" } }, "session-a"), true);
  assert.equal(retryEventRelevant({ event: "state.changed", data: { kind: "retry.exhausted" } }, "session-a"), true);
  assert.equal(retryEventRelevant({ event: "state.changed", data: { sessionId: "session-a", kind: "session.launch" } }, "session-a"), true);
  assert.equal(retryEventRelevant({ event: "session.status", data: { sessionId: "session-a", status: "exited" } }, "session-a"), true);
});

test("a stored value that changed underneath keeps the draft and reports one conflict", () => {
  const edited = editRetryDraft(initialRetryDraft(2), 4);
  const conflict = mergeStoredRetry(edited, 3);
  assert.equal(conflict.value, 4, "the typed maximum survives the reload");
  assert.equal(conflict.loaded, 3);
  assert.equal(conflict.conflict, true);
  assert.deepEqual(mergeStoredRetry(conflict, 3), conflict, "the note stays until the user resolves it");
  assert.deepEqual(adoptStoredRetry(conflict), initialRetryDraft(3), "loading the stored value clears the draft and the note");
});

test("a clean field follows the stored value and a save clears the draft", () => {
  assert.deepEqual(mergeStoredRetry(initialRetryDraft(2), 6), initialRetryDraft(6));
  const dirty = editRetryDraft(initialRetryDraft(2), 6);
  assert.deepEqual(editRetryDraft(dirty, 2), initialRetryDraft(2), "typing the loaded value clears the dirty flag");
  assert.deepEqual(savedRetryDraft(6), initialRetryDraft(6));
});

test("the maximum stays inside the runtime's 1..10 bounds", () => {
  assert.equal(editRetryDraft(initialRetryDraft(1), 0).value, 1);
  assert.equal(editRetryDraft(initialRetryDraft(1), 99).value, 10);
  assert.equal(editRetryDraft(initialRetryDraft(1), Number.NaN).value, 1);
  assert.equal(editRetryDraft(initialRetryDraft(1), 2.6).value, 3);
});

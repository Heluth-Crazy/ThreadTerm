import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTerminalOutputTail,
  aiCompletionHintsEnabled,
  hasTentativeAiCompletionPrompt,
} from "./terminalCompletionHint.js";

test("AI completion hints require an AI provider and a bounded prompt-shaped tail", () => {
  assert.equal(hasTentativeAiCompletionPrompt("codex", "Finished\n› "), true);
  assert.equal(hasTentativeAiCompletionPrompt("claude", "\u001b[32mDone\u001b[0m\n❯ "), true);
  assert.equal(hasTentativeAiCompletionPrompt("shell", "Finished\n› "), false);
  assert.equal(hasTentativeAiCompletionPrompt("codex", "Finished\n$ "), false);
});

test("completion hint state keeps only a bounded output tail and is opt-in", () => {
  const tail = appendTerminalOutputTail("x".repeat(4096), "\n› ");
  assert.equal(tail.length, 4096);
  assert.equal(hasTentativeAiCompletionPrompt("opencode", tail), true);
  assert.equal(aiCompletionHintsEnabled({ aiCompletionHints: true }), true);
  assert.equal(aiCompletionHintsEnabled({ aiCompletionHints: "true" }), false);
});

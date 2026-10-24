// F11 chat presentation benchmark. Pure Node: no Electron, no runtime, no network.
//
//   node qa/chat-presentation-bench.mjs
//   node qa/chat-presentation-bench.mjs --sizes=500,2000,8000 --rounds=5
//
// "Before" is the pre-F11 helper that filtered the whole history for every
// rendered item (qa/lib/chat-presentation-legacy.mjs is a verbatim copy).
// "After" is one `chatPresentationIndex` pass per revision plus O(1) lookups,
// i.e. exactly what ChatView does per streaming update.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { legacyActiveTurnId, legacyItemShowsStreaming, sessionTranscript } from "./lib/chat-presentation-legacy.mjs";

const option = name => process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const sizes = (option("sizes") ?? "500,2000,8000").split(",").map(Number).filter(size => Number.isInteger(size) && size > 0);
const rounds = Number(option("rounds") ?? 3);
assert.ok(sizes.length > 0, "at least one record count is required");

// ChatView is mounted from a bundle, so the built module is what the app runs.
const scratch = await mkdtemp(join(tmpdir(), "tt-chat-bench-"));
await build({
  stdin: { contents: 'export { activeTurnIdFromIndex, chatPresentationIndex, itemShowsStreaming } from "./renderer/src/chatPresentation.ts";', resolveDir: resolve("."), loader: "ts" },
  bundle: true, platform: "node", format: "esm", outfile: join(scratch, "presentation.mjs"), logLevel: "error", external: ["node:*"],
});
const built = await import(pathToFileURL(join(scratch, "presentation.mjs")).href);
const { activeTurnIdFromIndex, chatPresentationIndex, itemShowsStreaming } = built;

const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
function time(action) {
  const started = performance.now();
  action();
  return performance.now() - started;
}
// Warm the JIT so the numbers describe steady streaming re-renders, not first-call costs.
for (let index = 0; index < 3; index += 1) {
  const warm = sessionTranscript(500);
  warm.forEach(item => legacyItemShowsStreaming(item, warm));
}

const results = [];
for (const size of sizes) {
  const items = sessionTranscript(size);
  const groups = new Set(items.map(item => item.turnId).filter(Boolean)).size;
  const before = [], after = [];
  for (let round = 0; round < rounds; round += 1) {
    // Old per-revision work: every rendered item scans the history, and renderTurn asks for the stop target per group.
    before.push(time(() => {
      for (const item of items) legacyItemShowsStreaming(item, items);
      for (let group = 0; group < groups; group += 1) legacyActiveTurnId(items, "running");
    }));
    // New per-revision work: one index pass, then O(1) lookups.
    after.push(time(() => {
      const index = chatPresentationIndex(items);
      for (const item of items) itemShowsStreaming(item, index);
      for (let group = 0; group < groups; group += 1) activeTurnIdFromIndex(index, "running");
    }));
  }
  const row = { records: items.length, turns: groups, beforeMs: median(before), afterMs: median(after) };
  row.speedup = row.beforeMs / Math.max(row.afterMs, 0.001);
  results.push(row);
}

console.log(`chat presentation benchmark (median of ${rounds} rounds, ${process.platform} ${process.arch}, node ${process.version})`);
console.log("records  turns   before ms   after ms   speedup");
for (const row of results) {
  console.log(`${String(row.records).padStart(7)}  ${String(row.turns).padStart(5)}  ${row.beforeMs.toFixed(2).padStart(9)}  ${row.afterMs.toFixed(2).padStart(9)}  ${row.speedup.toFixed(1).padStart(6)}x`);
}
const largest = results.at(-1);
assert.ok(largest.afterMs < 50, `8,000 records must stay well under 50 ms for the helper, got ${largest.afterMs.toFixed(2)} ms`);
if (results.length > 1) {
  const ratio = largest.afterMs / Math.max(results[0].afterMs, 0.001);
  const records = largest.records / results[0].records;
  assert.ok(ratio < records * 4, `index work must scale linearly: ${records.toFixed(1)}x records took ${ratio.toFixed(1)}x time`);
}
console.log(`PASS eight-thousand-record helper pass is ${largest.afterMs.toFixed(2)} ms (target < 50 ms)`);

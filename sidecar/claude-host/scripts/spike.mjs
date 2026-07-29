// Milestone-1 spike: prove SDK -> user-installed claude round trip with zero download.
// Usage: node scripts/spike.mjs [cwd]
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';

const cwd = process.argv[2] || process.env.SPIKE_CWD;
if (!cwd) {
  console.error('usage: node scripts/spike.mjs <cwd>');
  process.exit(2);
}
mkdirSync(cwd, { recursive: true });

const claudePath = process.env.CLAUDE_PATH;
const started = Date.now();
const seen = new Map();
let sessionId = null;
let resultInfo = null;

const q = query({
  prompt: 'Reply with exactly the word PONG and nothing else.',
  options: {
    ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    cwd,
    settingSources: [],
    allowedTools: [],
    maxTurns: 1,
    includePartialMessages: true,
  },
});

for await (const m of q) {
  seen.set(m.type, (seen.get(m.type) ?? 0) + 1);
  if (m.type === 'system' && m.subtype === 'init') {
    sessionId = m.session_id;
    console.log('[init]', JSON.stringify({ session_id: m.session_id, model: m.model, permissionMode: m.permissionMode, tools: (m.tools ?? []).length }));
  } else if (m.type === 'assistant') {
    const text = (m.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) console.log('[assistant]', JSON.stringify(text));
  } else if (m.type === 'result') {
    resultInfo = { subtype: m.subtype, num_turns: m.num_turns, total_cost_usd: m.total_cost_usd, session_id: m.session_id };
  }
}

console.log('[types]', JSON.stringify(Object.fromEntries(seen)));
console.log('[result]', JSON.stringify(resultInfo));
console.log('[elapsed_ms]', Date.now() - started);
if (!sessionId || !resultInfo || resultInfo.subtype !== 'success') {
  console.error('SPIKE FAILED');
  process.exit(1);
}
console.log('SPIKE OK');

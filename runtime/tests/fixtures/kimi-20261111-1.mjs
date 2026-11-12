// Source-derived PTY replay, not a recording of a live Kimi installation.
// @moonshot-ai/kimi-code@2.6.0: src/cli/update/forced-prompt.ts, forced.ts,
// and main.ts (61e4047858eff4fa094edd829f6832e24cbfcf17).
// Minimal ACP setup lets ThreadTerm allocate/load the ID before --session.
// The floor scenario models ordinary 2.0.2 startup without an upgrade prompt.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { clearLine, createInterface, cursorTo, emitKeypressEvents, moveCursor } from 'node:readline';

const args = process.argv.slice(2);
const store = process.env.TT_QA_KIMI_STORE;
assert.ok(store, 'fixture requires an isolated native store');
const record = (kind, extra = {}) => appendFileSync(join(store, 'events.jsonl'),
  `${JSON.stringify({ kind, args, pid: process.pid, ...extra })}\n`);
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
record('launch');

if (args[0] === '--version') {
  console.log('2.6.0');
} else if (args[0] === 'acp') {
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      reply(request.id, { protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { list: {}, load: {}, resume: {} } } });
    } else if (request.method === 'session/new') {
      const sessionId = randomUUID();
      writeFileSync(join(store, `${sessionId}.json`), JSON.stringify({ sessionId, cwd: request.params.cwd }));
      record('prepared', { sessionId, cwd: request.params.cwd });
      reply(request.id, { sessionId });
    } else if (request.method === 'session/load') {
      const saved = JSON.parse(readFileSync(join(store, `${request.params.sessionId}.json`), 'utf8'));
      assert.equal(saved.cwd, request.params.cwd);
      record('loaded', saved);
      reply(request.id, {});
    } else if (request.method === 'session/list') {
      reply(request.id, { sessions: [] });
    } else if (request.id !== undefined) {
      throw new Error(`unexpected fixture ACP request: ${request.method}`);
    }
  });
} else {
  assert.deepEqual(args.slice(0, 1), ['--session']);
  assert.equal(args.length, 2);
  assert.ok(process.stdin.isTTY && process.stdout.isTTY, 'must replay on a real PTY');
  const sessionId = args[1];
  const saved = JSON.parse(readFileSync(join(store, `${sessionId}.json`), 'utf8'));
  const scenario = basename(process.cwd());
  assert.equal(basename(saved.cwd), scenario);
  assert.ok(['skip', 'interrupt', 'floor'].includes(scenario));
  record('terminal', { sessionId, scenario });
  let attached = false;
  let selected = 0;
  let lineCount = 0;
  let timer;
  const skipAvailableAt = Date.now() + 10_000; // forced.ts SKIP_DELAY_MS
  const render = () => {
    const remaining = Math.max(0, Math.ceil((skipAvailableAt - Date.now()) / 1000));
    // Exact uncolored renderLines text, with the upstream cursor redraw shape.
    const lines = ['Kimi Code Upgrade Required', 'This version must be upgraded before continuing.',
      'Current  2.6.0', 'Minimum  2.6.1', 'Target   2.6.1', '', '↑↓ choose · Enter confirm', '',
      `${selected === 0 ? '❯' : ' '} Install update now (2.6.1)`,
      `${selected === 1 ? '❯' : ' '} Skip for this run${remaining ? ` (${remaining}s)` : ''}`];
    if (lineCount) moveCursor(process.stdout, 0, -(lineCount - 1));
    lines.forEach((line, index) => {
      clearLine(process.stdout, 0); cursorTo(process.stdout, 0);
      process.stdout.write(line + (index < lines.length - 1 ? '\n' : ''));
    });
    lineCount = lines.length;
  };
  const attach = () => {
    clearInterval(timer);
    process.stdout.write('\x1b[?25h\n');
    attached = true;
    record('attached', { sessionId, scenario });
    // welcome.ts:50-77 at 2.6.0; floor uses the same representative labels.
    // This is not a pixel recording of either release's complete TUI.
    console.log('Welcome to Kimi Code!');
    console.log(`Session:   ${sessionId}`);
    // Synthetic marker makes the fake's attachment boundary unambiguous.
    console.log(`FIXTURE_ATTACHED:${sessionId}:${scenario === 'floor' ? '2.0.2' : '2.6.0'}`);
  };
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (_input, key) => {
    if (attached) {
      if (key.name === 'q') { record('exit', { sessionId, code: 0 }); process.exit(0); }
      return;
    }
    if (key.ctrl && key.name === 'c') {
      record('interrupted', { sessionId, code: 130 });
      process.stdout.write('\x1b[?25h\n', () => process.exit(130)); // main.ts interrupt branch
    } else if (key.name === 'up' || key.name === 'down') {
      selected = (selected + 1) % 2;
      render();
    } else if (key.name === 'return' || key.name === 'enter') {
      if (selected === 1 && Date.now() >= skipAvailableAt) {
        record('skip', { sessionId });
        attach(); // forced.ts skip-passive -> main.ts runShell, no passive prompt
      } else if (selected === 0) {
        throw new Error('fixture must not install an update');
      } else {
        record('skip-disabled', { sessionId });
      }
    }
  });
  if (scenario === 'floor') attach();
  else {
    record('prompt', { sessionId, skipAvailableAt });
    process.stdout.write('\x1b[?25l');
    render();
    timer = setInterval(render, 250);
  }
}

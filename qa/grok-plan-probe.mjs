// One-shot live Grok ACP probe for the B4 grok plan [verify]. It runs a single
// short, ungated Grok turn in a throwaway cwd, logs every session/update frame,
// and removes ~/.grok/sessions/<encoded cwd> afterwards. Grok is the only live
// agent this task may start.
//   node qa/grok-plan-probe.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const source = process.env.THREADTERM_QA_GROK ?? 'C:\\Users\\demo\\.grok\\bin\\grok.exe';
if (!existsSync(source)) throw new Error(`Grok executable not found: ${source}`);
const scratch = await mkdtemp(join(tmpdir(), 'grok-plan-probe-'));
const bin = join(scratch, 'bin');
const cwd = join(scratch, 'workspace');
await Promise.all([mkdir(bin, { recursive: true }), mkdir(cwd, { recursive: true })]);
await writeFile(join(bin, 'grok.cmd'), `@echo off\r\n"${source}" %*\r\n`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|grok_home)$/i.test(key)));
env.Path = [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';');

const child = spawn(source, ['agent', '--no-leader', 'stdio'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let nextId = 0;
const pending = new Map();
const observed = [];
const updates = [];
const send = (method, params, withId = true) => {
  const id = withId ? ++nextId : undefined;
  child.stdin.write(`${JSON.stringify(withId ? { jsonrpc: '2.0', id, method, params } : { jsonrpc: '2.0', method, params })}\n`);
  if (!withId) return Promise.resolve();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout ${method}`)); }, 90_000);
  });
};
let buffer = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const update = parsed.params?.update;
    if (update) {
      updates.push(update);
      observed.push({ sessionUpdate: update.sessionUpdate, keys: Object.keys(update), text: String(update.content?.text ?? '').slice(0, 200) });
      if (String(update.sessionUpdate).includes('plan')) console.log(`PLAN FRAME ${JSON.stringify(parsed)}`);
    }
    if (parsed.id != null && pending.has(parsed.id)) {
      const waiter = pending.get(parsed.id);
      pending.delete(parsed.id);
      if (parsed.error) waiter.reject(new Error(JSON.stringify(parsed.error)));
      else waiter.resolve(parsed.result);
      continue;
    }
    // Answer agent-initiated requests so the turn cannot hang.
    if (parsed.id != null && parsed.method && parsed.result === undefined && parsed.error === undefined) {
      if (parsed.method === 'session/request_permission') {
        const options = parsed.params?.options ?? [];
        const chosen = options.find(option => /allow/i.test(String(option.optionId ?? option.kind))) ?? options[0];
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: chosen ? { outcome: { outcome: 'selected', optionId: chosen.optionId } } : { outcome: { outcome: 'cancelled' } } })}\n`);
      } else {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} })}\n`);
      }
    }
  }
});
child.stderr.on('data', chunk => process.stderr.write(String(chunk)));

try {
  await send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'threadterm-probe', title: 'ThreadTerm probe', version: '0' } });
  await send('initialized', {}, false);
  const session = await send('session/new', { cwd, mcpServers: [] });
  const sessionId = session?.sessionId;
  if (!sessionId) throw new Error('no sessionId');
  // Enter plan mode only when explicitly requested; the runtime's /plan does the same set_mode.
  if (process.env.GROK_PLAN_MODE === '1') await send('session/set_mode', { sessionId, modeId: 'plan' }).catch(error => console.error('set_mode failed', error.message));
  await send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Create a short implementation plan with three numbered steps for adding a hello() function to index.js. Present the plan only; do not create or edit any file.' }] });
  await new Promise(done => setTimeout(done, 2_000));
  console.log(JSON.stringify({ observed, planFrames: updates.filter(update => String(update.sessionUpdate).includes('plan')) }, null, 2));
} catch (error) {
  console.error('PROBE_ERROR', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  child.kill();
  const sessionsRoot = join(homedir(), '.grok', 'sessions');
  await rm(join(sessionsRoot, encodeURIComponent(cwd)), { recursive: true, force: true }).catch(() => {});
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

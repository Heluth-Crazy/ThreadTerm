// No model turns: capture native ACP mode acknowledgements and resume frames.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { removeAgentHistory } from './agent-history.mjs';

const provider = process.argv[2];
if (!['grok', 'kimi'].includes(provider)) throw Error('Expected grok or kimi');
const scratch = await mkdtemp('D:/project/ThreadTerm/tt-qa-temp/tt-permission-frames-');
const slug = scratch.split(/[\\/]/).at(-1).toLowerCase();
const cwd = join(scratch, 'workspace');
await mkdir(cwd);
const log = [];
const started = performance.now();
const record = (direction, message) => {
  const entry = { ms: Math.round(performance.now() - started), direction, message };
  log.push(entry); console.log(JSON.stringify(entry));
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let nextId = 1;
const pending = new Map();
function start() {
  const executable = join(homedir(), provider === 'grok' ? '.grok/bin/grok.exe' : '.kimi-code/bin/kimi.exe');
  child = spawn(executable, provider === 'grok' ? ['agent', '--no-leader', 'stdio'] : ['acp'], {
    cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TEMP: 'D:/project/ThreadTerm/tt-qa-temp', TMP: 'D:/project/ThreadTerm/tt-qa-temp' },
  });
  record('process', { pid: child.pid });
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { record('stdout', line); return; }
    record('received', message);
    const waiting = pending.get(message.id);
    if (waiting) {
      pending.delete(message.id); clearTimeout(waiting.timer);
      waiting.resolve(message);
    }
  });
  createInterface({ input: child.stderr }).on('line', line => record('stderr', line));
}
function request(method, params) {
  const id = nextId++;
  const message = { jsonrpc: '2.0', id, method, params };
  record('sent', message);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timeout`)); }, 30_000);
    pending.set(id, { resolve, timer });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}
async function initialize() {
  return request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'threadterm', version: '0.1.0' } });
}
async function stop() {
  if (child && child.exitCode === null) {
    const current = child;
    const exited = new Promise(resolve => current.once('exit', resolve));
    current.kill(); await Promise.race([exited, pause(3000)]);
  }
}
let failed;
try {
  record('probe', { provider, slug, scratch });
  start(); await initialize();
  const fresh = await request('session/new', { cwd, mcpServers: [] });
  const sessionId = fresh.result?.sessionId;
  if (!sessionId) throw Error('No session id');
  const setMode = value => request(provider === 'grok' ? 'session/set_mode' : 'session/set_config_option',
    provider === 'grok' ? { sessionId, modeId: value } : { sessionId, configId: 'mode', value });
  await setMode(provider === 'grok' ? 'bypassPermissions' : 'plan');
  await pause(2500);
  await stop();
  start(); await initialize();
  await request('session/load', { cwd, sessionId, mcpServers: [] });
  await setMode(provider === 'grok' ? 'bypassPermissions' : 'plan');
  await pause(2500);
} catch (error) { failed = error; record('failure', error.stack); }
finally {
  await stop(); await pause(8000);
  const leftovers = removeAgentHistory(slug);
  await writeFile(`.trellis/tasks/10-20-never-ask-delegation/data/${slug}.frames.json`, JSON.stringify({ provider, slug, log, leftovers }, null, 2));
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  if (failed || leftovers.length) process.exitCode = 1;
}

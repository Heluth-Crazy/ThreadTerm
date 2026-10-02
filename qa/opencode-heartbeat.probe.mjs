// Read-only, no-model probe of the installed OpenCode SSE cadence.
// Starts and stops only its own isolated --pure server process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executable = process.env.TT_QA_OPENCODE_EXE || 'C:\\Users\\27968\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe';
assert.ok(existsSync(executable), `OpenCode executable not found: ${executable}`);
const root = await mkdtemp(join(tmpdir(), 'threadterm-opencode-heartbeat-'));
const dirs = Object.fromEntries(await Promise.all(['config', 'data', 'cache', 'appdata', 'localappdata'].map(async name => {
  const path = join(root, name);
  await mkdir(path);
  return [name, path];
})));
const child = spawn(executable, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache, OPENCODE_CONFIG_DIR: dirs.config, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata },
});
let logs = '';
child.stdout.on('data', bytes => { logs += bytes.toString(); });
child.stderr.on('data', bytes => { logs += bytes.toString(); });
const pause = ms => new Promise(done => setTimeout(done, ms));
let response;
try {
  let url;
  for (let attempt = 0; attempt < 120; attempt++) {
    url = logs.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) break;
    if (child.exitCode !== null) throw Error(`OpenCode exited: ${logs}`);
    await pause(100);
  }
  assert.ok(url, `OpenCode did not publish a URL: ${logs}`);
  response = await fetch(`${url}/global/event`, { signal: AbortSignal.timeout(32_000) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const started = Date.now();
  let buffered = '';
  const observed = [];
  while (Date.now() - started < 24_000) {
    const next = await reader.read();
    if (next.done) throw Error('OpenCode closed SSE before two heartbeat intervals');
    buffered += new TextDecoder().decode(next.value);
    let boundary;
    while ((boundary = buffered.indexOf('\n\n')) >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = frame.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim();
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      observed.push({ atMs: Date.now() - started, type: parsed.payload?.type || parsed.type });
    }
    if (observed.filter(row => row.type === 'server.heartbeat').length >= 2) break;
  }
  const heartbeats = observed.filter(row => row.type === 'server.heartbeat');
  assert.ok(heartbeats.length >= 2, `Expected two native heartbeat events: ${JSON.stringify(observed)}`);
  console.log(JSON.stringify({ version: '1.18.31', root, observed, heartbeatGapMs: heartbeats[1].atMs - heartbeats[0].atMs }));
} finally {
  await response?.body?.cancel().catch(() => undefined);
  if (child.exitCode === null) child.kill();
  await Promise.race([new Promise(done => child.once('exit', done)), pause(3000)]);
}

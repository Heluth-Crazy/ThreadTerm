// Runtime-only memory probe for Phase 2 item 7 of the session-release task (run 7).
//
// One isolated runtime, no Electron: 40 shell terminals that each print about
// 1 MB and exit, sampled before they are created, after the last exit, and after
// a 20 s settle. The baseline kept up to 512 KB per exited session in memory; the
// new build keeps nothing, so only the baseline grows with the session count.
//
// Usage: node qa/runtime-output-memory.mjs --runtime=<path to threadterm-v3-runtime.exe> [--sessions=40] [--out=<json path>]
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { copyFile } from 'node:fs/promises';
import { connectSubagentPeer } from './lib/subagent-peer.mjs';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const source = arg('runtime') ?? process.env.THREADTERM_V3_RUNTIME_BIN ?? 'runtime/target-qa/debug/threadterm-v3-runtime.exe';
const count = Number(arg('sessions') ?? 40);
const out = arg('out') ?? join(tmpdir(), `threadterm-output-memory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const pause = ms => new Promise(done => setTimeout(done, ms));

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-output-memory-'));
const runtime = join(scratch, 'runtime.exe');
await copyFile(source, runtime);
const data = join(scratch, 'data');
const cwd = join(scratch, 'workspace');
await mkdir(cwd, { recursive: true });
const pipe = `\\\\.\\pipe\\threadterm-output-memory-${randomUUID()}`;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['threadterm_v3_data', 'threadterm_v3_pipe'].includes(key.toLowerCase()))),
  THREADTERM_V3_DATA: data,
  THREADTERM_V3_PIPE: pipe,
};

const daemon = spawn(runtime, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostic = '';
daemon.stderr.on('data', bytes => { diagnostic += bytes.toString(); });

function privateBytes(pid) {
  return promisify(execFile)('powershell', ['-NoProfile', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).PrivateMemorySize64`], { windowsHide: true })
    .then(({ stdout }) => Math.round(Number(stdout.trim()) / 1024));
}

let peer;
for (let attempt = 0; attempt < 400 && !peer; attempt++) {
  try {
    peer = await connectSubagentPeer(`${pipe}-control`);
    await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
  } catch {
    peer = undefined;
    if (daemon.exitCode !== null) throw Error(diagnostic || 'runtime exited during startup');
    await pause(50);
  }
}
if (!peer) throw Error('runtime startup timeout');

const before = await privateBytes(daemon.pid);
// ~1 MB per terminal: 5000 lines of 200 characters.
const command = `for /L %i in (1,1,5000) do @echo ${'x'.repeat(200)}`;
const ids = [];
for (let index = 0; index < count; index++) {
  const session = await peer.request('session.create', {
    cwd, provider: 'custom', mode: 'terminal', executable: 'cmd.exe', args: ['/Q', '/C', command],
    title: `output-memory-${index}`, operationId: randomUUID(),
  });
  ids.push(session.id);
}
const deadline = Date.now() + 10 * 60 * 1000;
for (;;) {
  const sessions = (await peer.request('runtime.snapshot')).sessions.filter(row => ids.includes(row.id));
  if (sessions.length === ids.length && sessions.every(row => row.status === 'exited')) break;
  if (Date.now() > deadline) throw Error(`terminals did not exit: ${sessions.map(row => row.status).join(',')}`);
  await pause(500);
}
const afterExits = await privateBytes(daemon.pid);
await pause(20000);
const settled = await privateBytes(daemon.pid);

const summary = {
  runtime: source, sessions: count,
  beforeStartsKiB: before, afterExitsKiB: afterExits, settledKiB: settled,
  grownAfterExitsKiB: afterExits - before, grownAfterSettleKiB: settled - before,
};
await writeFile(out, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
peer.close?.();
daemon.kill();

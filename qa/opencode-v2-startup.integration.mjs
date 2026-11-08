// Real debug runtime + isolated synthetic v2 native process. This checks the
// intentionally incomplete migration fence, not full v2 Chat compatibility.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connectSubagentPeer } from './lib/subagent-peer.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = await mkdtemp(join(tmpdir(), 'threadterm-opencode-v2-startup-'));
const bin = join(root, 'bin');
await mkdir(bin);
const runtime = process.env.THREADTERM_QA_RUNTIME_EXE || resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), `verified debug runtime is missing: ${runtime}`);
await writeFile(join(bin, 'shim.rs'), 'fn main(){std::fs::write(std::env::var("TT_QA_RESOLVED_EXE").unwrap(),std::env::current_exe().unwrap().to_string_lossy().as_bytes()).unwrap();let s=std::process::Command::new(std::env::var("TT_QA_NODE").unwrap()).arg(std::env::var("TT_QA_SCRIPT").unwrap()).args(std::env::args().skip(1)).status().unwrap();std::process::exit(s.code().unwrap_or(1));}');
// Reuse is opt-in and requires both the exact source and a caller-pinned binary hash.
let compiled;
if (process.env.THREADTERM_QA_OPENCODE_SHIM) {
  const prebuilt = resolve(process.env.THREADTERM_QA_OPENCODE_SHIM);
  assert.equal(await readFile(join(dirname(prebuilt), 'shim.rs'), 'utf8'), await readFile(join(bin, 'shim.rs'), 'utf8'), 'prebuilt shim source matches this harness');
  assert.equal(createHash('sha256').update(await readFile(prebuilt)).digest('hex'), process.env.THREADTERM_QA_OPENCODE_SHIM_SHA256?.toLowerCase(), 'prebuilt shim hash is explicitly pinned');
  await copyFile(prebuilt, join(bin, 'opencode.exe'));
  compiled = { status: 0, stderr: '' };
} else {
  compiled = spawnSync('rustc', [join(bin, 'shim.rs'), '-o', join(bin, 'opencode.exe')], { encoding: 'utf8', windowsHide: true });
}
assert.equal(compiled.status, 0, compiled.stderr);

for (const mode of ['normal', 'html-info', 'malformed-info', 'unknown-auth-help']) {
  const data = join(root, mode, 'data');
  const cwd = join(root, mode, 'project');
  await mkdir(cwd, { recursive: true });
  const requestsFile = join(root, mode, 'native-requests.jsonl');
  const pipe = `\\\\.\\pipe\\threadterm-opencode-v2-startup-${randomUUID()}`;
  const runtimeCopy = join(root, mode, 'runtime.exe');
  await copyFile(runtime, runtimeCopy);
  const daemon = spawn(runtimeCopy, [], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')),
      Path: [bin, dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
      THREADTERM_QA_PROVIDER_BIN: bin,
      THREADTERM_V3_DATA: data,
      THREADTERM_V3_PIPE: pipe,
      TT_QA_NODE: process.execPath,
      TT_QA_RESOLVED_EXE: join(root, mode, 'resolved-exe.txt'),
      TT_QA_SCRIPT: resolve('qa/fixtures/mock-opencode-v2.mjs'),
      TT_QA_OPENCODE_REQUESTS: requestsFile,
      TT_QA_OPENCODE_AUTH_DIAGNOSTIC: join(root, mode, 'auth-diagnostic.jsonl'),
      TT_QA_OPENCODE_CLI_DIAGNOSTIC: join(root, mode, 'cli-diagnostic.jsonl'),
      TT_QA_OPENCODE_V2_MODE: mode,
    },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostic = '';
  daemon.stderr.on('data', bytes => { diagnostic += bytes.toString(); });
  let peer;
  try {
    let clientId;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      try {
        peer = await connectSubagentPeer(`${pipe}-control`);
        clientId = await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
        break;
      } catch {
        peer?.close(); peer = undefined;
        assert.equal(daemon.exitCode, null, diagnostic);
        await pause(50);
      }
    }
    assert.ok(peer, 'isolated runtime authenticated');
    let selected;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const providers = await peer.request('provider.list');
      const matches = providers.filter(provider => provider.id === 'opencode');
      assert.ok(matches.length <= 1, 'at most one requested provider');
      if (matches[0]?.installed) { selected = matches[0]; break; }
      await pause(50);
    }
    assert.ok(selected?.installed, 'exactly one fake OpenCode provider completed discovery');
    assert.match(selected.version, /2\.2\.5-qa-source-fixture/, 'resolved native executable identifies the selected fixture');
    const session = await peer.request('session.create', { cwd, title: `V2 ${mode}`, provider: 'opencode', mode: 'chat', operationId: randomUUID() });
    const leaseEpoch = (await peer.request('session.claim', { sessionId: session.id, clientId })).leaseEpoch;
    await assert.rejects(peer.request('chat.connect', { sessionId: session.id, leaseEpoch, operationId: randomUUID() }), error => {
      assert.equal(error.code, ['normal', 'unknown-auth-help'].includes(mode) ? 'provider_method_unsupported' : 'provider_protocol', `native startup: ${diagnostic}; inspect ${join(root, mode, 'auth-diagnostic.jsonl')}`);
      return true;
    });
    const connection = await peer.request('chat.connection', { sessionId: session.id });
    assert.equal(connection.phase, 'failed');
    const snapshot = await peer.request('runtime.snapshot');
    assert.equal(snapshot.sessions.find(row => row.id === session.id).nativeId, undefined, 'failed negotiation/fenced v2 must not allocate a replacement identity');
    const requests = (await readFile(requestsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.ok(requests.some(row => row.path === '/api/info'));
    assert.ok(requests.every(row => row.method === 'GET' && ['/api/info', '/global/health'].includes(row.path)), 'no create/prompt/legacy-event request before full v2 event support');
    const observedProvider = (await readFile(join(root, mode, 'resolved-exe.txt'), 'utf8')).trim();
    assert.equal(resolve(observedProvider).toLowerCase(), resolve(bin, 'opencode.exe').toLowerCase(), 'actual native shim executable must match isolated selection');
    const cli = (await readFile(join(root, mode, 'cli-diagnostic.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    const auth = cli.filter(row => row.args.includes('auth') && row.args.includes('list'));
    if (mode === 'unknown-auth-help') assert.equal(auth.length, 0, 'unknown help never starts a potentially persistent auth command');
    else assert.ok(auth.length > 0 && auth.every(row => JSON.stringify(row.args) === JSON.stringify(['--standalone', 'auth', 'list'])), 'discovery uses only the private v2 auth command');
    console.log(JSON.stringify({ mode, scenario: 'v2-startup-fence', result: 'PASS', runtime, resolvedProvider: observedProvider, nativeRequests: requests.length, authCommands: auth.length, compatibilityClaim: false }));
  } finally {
    if (peer) {
      await peer.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
      peer.close();
    }
    if (daemon.exitCode === null) {
      daemon.kill();
      await Promise.race([new Promise(done => daemon.once('exit', done)), pause(3_000)]);
      assert.ok(daemon.exitCode !== null || daemon.signalCode !== null, 'owned runtime terminated');
    }
  }
}

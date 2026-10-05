// What a chat provider's background process gets as its environment (runtime/src/environment.rs,
// `apply_to_service` in `spawn_managed_service`), compared with a new terminal's.
//
// Fake providers only: no account, network, quota or agent history. Every provider command is a
// native shim in a scratch bin that runs `fake-provider.mjs`, which records its environment; the
// Claude SDK host is a fake that answers `host.ping`. `provider.list` makes the runtime start every
// kind of background process it has (version probes, auth checks, ACP and SDK workers); a shell
// terminal then writes `set` for comparison. Read-only for the registry.
//
// The runtime is started like a QA run that isolates a home, plus stale copies of two variables
// Windows defines in its Environment keys:
//   USERPROFILE/APPDATA in scratch, TT_ENV_PROBE and HTTPS_PROXY set only by the launcher → kept;
//   TEMP/TMP and JAVA_HOME pointing into scratch → Windows' current values;
//   Path = fake bin + node + System32 → Windows' current Path (the fake bin is found by the runtime,
//   which still resolves provider executables against its own PATH).
//
// usage: node qa/provider-environment.mjs [--keep]   (needs runtime/target-qa/debug/threadterm-v3-runtime.exe)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPeer } from './pipe-client.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const exe = process.env.THREADTERM_V3_RUNTIME_BIN || join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(exe), `missing ${exe}`);
const keep = process.argv.includes('--keep');
const delay = ms => new Promise(done => setTimeout(done, ms));
const scratch = await mkdtemp(join(tmpdir(), 'tt-provider-env-'));
const bin = join(scratch, 'bin'), data = join(scratch, 'data'), cwd = join(scratch, 'workspace');
const events = join(scratch, 'provider-events.jsonl');
const pipe = `\\\\.\\pipe\\tt-provider-env-${randomUUID()}`;
await Promise.all([bin, data, cwd, join(scratch, 'home'), join(scratch, 'appdata')].map(path => mkdir(path, { recursive: true })));

const fakeProvider = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [provider, ...args] = process.argv.slice(2);
appendFileSync(process.env.TT_QA_EVENTS, JSON.stringify({ provider, args, env: { ...process.env } }) + '\\n');
const once = { '--version': provider + ' 0.0.0-qa', 'auth status --json': '{"loggedIn":true}', 'login status': 'Logged in', 'auth list': '0 credentials' };
const key = args.includes('--version') ? '--version' : args.join(' ');
if (key in once) { console.log(once[key]); process.exit(0); }
// ACP worker (kimi acp, gemini --acp, grok agent stdio): just enough to initialize.
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, load: {} } } } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;
const fakeHost = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(process.env.TT_QA_EVENTS, JSON.stringify({ provider: 'claude-sdk-host', args: [], env: { ...process.env } }) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, ok: { pid: process.pid, sdk: true } }) + '\\n');
});
`;
await writeFile(join(bin, 'fake-provider.mjs'), fakeProvider);
await writeFile(join(scratch, 'fake-claude-host.mjs'), fakeHost);
// Native shim: provider = its own file name; stdio passes straight through.
await writeFile(join(bin, 'shim.rs'), 'fn main(){let exe=std::env::current_exe().unwrap();let name=exe.file_stem().unwrap().to_owned();let status=std::process::Command::new(std::env::var_os("TT_QA_NODE").expect("TT_QA_NODE")).arg(std::env::var_os("TT_QA_SCRIPT").expect("TT_QA_SCRIPT")).arg(name).args(std::env::args_os().skip(1)).status().unwrap();std::process::exit(status.code().unwrap_or(1));}');
const compiled = spawnSync('rustc', ['-O', join(bin, 'shim.rs'), '-o', join(bin, 'shim.exe')], { encoding: 'utf8', windowsHide: true });
assert.equal(compiled.status, 0, compiled.stderr);
const providers = ['claude', 'codex', 'kimi', 'grok', 'opencode', 'gemini'];
for (const name of providers) await copyFile(join(bin, 'shim.exe'), join(bin, `${name}.exe`));

const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const dropped = /^(path|temp|tmp|java_home|claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|tt_.*|http_proxy|https_proxy|all_proxy|no_proxy|grok_.*)$/i;
const launcher = {
  Path: [bin, dirname(process.execPath), system32].join(';'),
  USERPROFILE: join(scratch, 'home'), APPDATA: join(scratch, 'appdata'),
  TEMP: join(scratch, 'stale-temp'), TMP: join(scratch, 'stale-temp'), JAVA_HOME: join(scratch, 'stale-jdk'),
  TT_ENV_PROBE: 'launcher', HTTPS_PROXY: 'http://inherited.invalid:8081',
  THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'user'), THREADTERM_V3_PIPE: pipe, THREADTERM_V3_CONPTY: 'system',
  THREADTERM_CLAUDE_NODE: process.execPath, THREADTERM_CLAUDE_SDK_HOST: join(scratch, 'fake-claude-host.mjs'), THREADTERM_CLAUDE_PATH: join(bin, 'claude.exe'),
  TT_QA_NODE: process.execPath, TT_QA_SCRIPT: join(bin, 'fake-provider.mjs'), TT_QA_EVENTS: events,
};
const runtimeEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !dropped.test(name))), ...launcher };
const daemon = spawn(exe, [], { env: runtimeEnv, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostic = '', peer;
daemon.stderr.on('data', bytes => { diagnostic += bytes.toString(); });

const upper = env => new Map(Object.entries(env).filter(([name]) => !name.startsWith('=')).map(([name, value]) => [name.toUpperCase(), value]));
const inScratch = value => value?.toLowerCase().startsWith(scratch.toLowerCase());
function check(vars) {
  const path = (vars.get('PATH') ?? '').split(';').filter(Boolean);
  return {
    launcherOnlyKept: vars.get('TT_ENV_PROBE') === 'launcher' && vars.get('HTTPS_PROXY') === launcher.HTTPS_PROXY,
    isolatedHomeKept: vars.get('USERPROFILE') === launcher.USERPROFILE && vars.get('APPDATA') === launcher.APPDATA,
    runtimeSettingsKept: vars.get('THREADTERM_V3_DATA') === data && vars.get('TT_QA_EVENTS') === events,
    tempIsWindows: vars.get('TEMP') === process.env.TEMP && vars.get('TMP') === process.env.TMP && !inScratch(vars.get('TEMP')),
    javaHomeIsWindows: vars.get('JAVA_HOME') === process.env.JAVA_HOME,
    pathIsWindows: path.length > 3 && !path.some(inScratch) && path.some(entry => entry.toLowerCase() === system32.toLowerCase()),
    noBootstrapVariables: ![...vars.keys()].some(name => name.startsWith('THREADTERM_V3_BOOTSTRAP')),
  };
}

try {
  for (let attempt = 0; attempt < 150 && !peer; attempt++) {
    try { peer = await connectPeer(`${pipe}-control`); await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim()); }
    catch { peer?.close(); peer = undefined; if (daemon.exitCode !== null) throw Error(`runtime exited: ${diagnostic}`); await delay(100); }
  }
  assert.ok(peer, 'runtime started');
  const capabilities = await peer.request('provider.list', {}, 120_000);
  const rows = (await readFile(events, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));

  const file = join(scratch, 'terminal-env.txt');
  const terminal = await peer.request('session.create', { cwd, title: 'QA env', provider: 'shell', mode: 'terminal', executable: 'cmd.exe', args: ['/d', '/c', `set>${file}`], operationId: randomUUID() }, 60_000);
  for (let attempt = 0; attempt < 300 && !(existsSync(file) && statSync(file).size > 0); attempt++) await delay(100);
  await delay(500);
  const terminalVars = new Map((await readFile(file, 'latin1')).split(/\r?\n/).filter(Boolean).map(line => { const at = line.indexOf('=', 1); return [line.slice(0, at).toUpperCase(), line.slice(at + 1)]; }));
  await peer.request('session.stop', { sessionId: terminal.id, force: true, operationId: randomUUID() }).catch(() => {});

  const results = rows.map(({ provider, args, env }) => {
    const vars = upper(env);
    // Same names and values as the terminal, apart from what cmd.exe adds (PROMPT).
    const onlyHere = [...vars.keys()].filter(name => !terminalVars.has(name)).sort();
    const onlyTerminal = [...terminalVars.keys()].filter(name => !vars.has(name) && name !== 'PROMPT').sort();
    const differentValue = [...vars.keys()].filter(name => terminalVars.has(name) && terminalVars.get(name) !== vars.get(name)).sort();
    return { process: [provider, ...args].join(' '), ...check(vars), sameAsTerminal: !onlyHere.length && !onlyTerminal.length && !differentValue.length, onlyHere, onlyTerminal, differentValue };
  });
  const terminalCheck = check(terminalVars);
  const given = new Set(Object.keys(runtimeEnv).map(name => name.toUpperCase()));
  const summary = {
    capabilities: Object.fromEntries(capabilities.map(row => [row.id, { installed: row.installed, chat: row.chat, reason: row.reason ?? null }])),
    processes: results,
    terminal: terminalCheck,
    // Names only: what Windows adds that the launcher did not give, and the reverse.
    notFromLauncher: [...terminalVars.keys()].filter(name => !given.has(name)).sort(),
    launcherDropped: [...given].filter(name => !terminalVars.has(name)).sort(),
  };
  console.log(JSON.stringify(summary, null, 2));

  for (const name of ['claude', 'codex', 'kimi', 'grok', 'opencode', 'claude-sdk-host']) assert.ok(rows.some(row => row.provider === name), `${name} was not started`);
  for (const name of ['kimi', 'grok']) assert.ok(rows.some(row => row.provider === name && !row.args.includes('--version')), `${name} ACP worker was not started`);
  for (const result of [...results, { process: 'terminal', ...terminalCheck, sameAsTerminal: true }]) {
    for (const [name, value] of Object.entries(result)) if (typeof value === 'boolean') assert.ok(value, `${result.process}: ${name}`);
  }
  console.log(`PASS: ${results.length} provider processes start from the same environment as a terminal`);
} catch (error) {
  console.error(JSON.stringify({ scratch, diagnostic: diagnostic.slice(-4000) }));
  throw error;
} finally {
  if (peer) { try { await peer.request('runtime.shutdown', { operationId: randomUUID() }); } catch {} peer.close(); }
  if (daemon.exitCode === null) await Promise.race([new Promise(done => daemon.once('exit', done)), delay(5000)]);
  if (daemon.exitCode === null) daemon.kill();
  if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => console.error(`scratch left: ${scratch} (${error.message})`));
}

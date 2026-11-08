// Startup-only, isolated native evidence probe for issue #38. It never sends a
// prompt or touches a default executable, PATH, profile, or existing service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';

const usage = `Usage: node qa/opencode-compat-live.mjs --exe <absolute pinned .exe> --home <absolute scratch root> --expect-version <1.18.35|2.2.5> --scenario startup

Runs only isolated executable identity, auth list, private loopback serve, and health validation.
Only .exe launchers are accepted; npm cmd/ps1 wrappers are intentionally unsupported.`;
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const exeArg = value('--exe');
const homeArg = value('--home');
const version = value('--expect-version');
const scenario = value('--scenario');
try {
if (args.length !== 8 || !exeArg || !homeArg || !['1.18.35', '2.2.5'].includes(version) || scenario !== 'startup' || args.some((arg, index) => index % 2 === 0 && !['--exe', '--home', '--expect-version', '--scenario'].includes(arg))) {
  console.error(usage); process.exit(2);
}
if (!isAbsolute(exeArg) || !isAbsolute(homeArg) || !/\.exe$/i.test(exeArg)) throw new Error('Require absolute direct .exe paths; wrappers are unsupported');

const expectedRoot = resolve(process.env.LOCALAPPDATA || '', 'Temp', 'tt-qa-temp', 'opencode-v2');
const inside = (root, target) => { const path = relative(root, target); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
const home = await realpath(homeArg);
const root = await realpath(expectedRoot);
if (!inside(root, home)) throw new Error(`--home must remain below ${root}`);
const exe = await realpath(exeArg);
if (!inside(home, exe)) throw new Error('--exe must be inside the supplied scratch home');
if (!(await stat(exe)).isFile()) throw new Error('--exe is not a file');

const row = version === '2.2.5' ? 'v2' : 'v1';
const paths = Object.fromEntries(await Promise.all(['homes', 'config', 'data', 'cache', 'state', 'tmp', 'projects'].map(async name => {
  const path = join(home, name, row); await mkdir(path, { recursive: true }); return [name, path];
})));
const project = join(paths.projects, 'startup-probe'); await mkdir(project, { recursive: true });
const config = join(paths.config, 'opencode.json');
const v1Config = join(paths.config, 'opencode', 'opencode.json');
if (version === '2.2.5') await writeFile(config, JSON.stringify({ $schema: 'https://opencode.ai/config.json', autoupdate: false, server: { hostname: '127.0.0.1', mdns: false } }));
else { await mkdir(join(paths.config, 'opencode'), { recursive: true }); await writeFile(v1Config, JSON.stringify({ autoupdate: false })); }
const password = randomBytes(32).toString('base64url');
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^OPENCODE_/i.test(key))),
  USERPROFILE: paths.homes, HOME: paths.homes, APPDATA: paths.config, LOCALAPPDATA: paths.data,
  TEMP: paths.tmp, TMP: paths.tmp, XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.data,
  XDG_CACHE_HOME: paths.cache, XDG_STATE_HOME: paths.state,
  OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password,
  ...(version === '2.2.5' ? { OPENCODE_CONFIG: config } : { OPENCODE_SERVER_USERNAME: 'threadterm' }),
};
async function command(commandArgs, timeoutMs) {
  const child = spawn(exe, commandArgs, { cwd: project, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  let timer;
  const exit = await Promise.race([
    new Promise(resolve => child.once('exit', code => resolve(code))),
    new Promise(resolve => child.once('error', () => resolve('spawn_error'))),
    new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (exit === 'timeout' && child.exitCode === null) {
    // The direct executable is ours, so Windows may terminate its exact
    // process tree by this PID on a bounded command timeout.
    const stopper = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await Promise.race([new Promise(resolve => stopper.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3_000))]);
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3_000))]);
  }
  return { exit, stdout, stderr };
}
function freePort() { return new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(error => error ? reject(error) : resolve(address.port)); }); }); }
const receipt = { scenario, expectedVersion: version, executable: exe, home, results: { isolation: { autoUpdateDisable: version === '1.18.35' ? 'source_verified: XDG_CONFIG_HOME/opencode/opencode.json autoupdate:false' : 'source_verified: OPENCODE_CONFIG autoupdate:false' } } };
const versionResult = await command(['--version'], 10_000);
receipt.results.version = { exit: versionResult.exit, output: versionResult.stdout.trim() };
assert.equal(versionResult.exit, 0, '--version failed');
const reportedVersion = versionResult.stdout.trim().match(/^(?:opencode v)?(1\.18\.35|2\.2\.5)$/i)?.[1];
assert.equal(reportedVersion, version, 'selected executable version mismatch');
// `auth` accepts the global --standalone flag in v2. Its source path resolves
// a private server, rather than discovering/replacing a managed user service.
const auth = await command(version === '2.2.5' ? ['--standalone', 'auth', 'list'] : ['auth', 'list'], 15_000);
receipt.results.authList = { exit: auth.exit, stdout: auth.stdout.trim(), stderr: auth.stderr.trim() };
assert.equal(auth.exit, 0, 'isolated auth list failed');
const port = await freePort();
const child = spawn(exe, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverSpawnError; child.once('error', error => { serverSpawnError = error; });
child.stdout.resume(); child.stderr.resume();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const path = version === '2.2.5' ? '/api/info' : '/global/health';
  const user = version === '2.2.5' ? 'opencode' : 'threadterm';
  let response;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverSpawnError) throw new Error(`owned server could not start: ${serverSpawnError.message}`);
    if (child.exitCode !== null) throw new Error('owned server exited before health became valid');
    try { response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }, signal: AbortSignal.timeout(500) }); if (response.ok) break; } catch { /* startup polling only */ }
    await pause(50);
  }
  assert.ok(response?.ok, 'health did not become valid before the startup deadline');
  assert.match(response.headers.get('content-type') || '', /application\/json/i, 'health response is not JSON');
  const health = await response.json();
  if (version === '2.2.5') {
    assert.equal(health.version, version); assert.equal(Number.isInteger(health.pid) && health.pid >= 0, true);
    assert.equal(Array.isArray(health.urls) && health.urls.every(value => typeof value === 'string'), true); assert.equal(typeof health.paths?.tmp, 'string');
    assert.ok(inside(home, resolve(health.paths.tmp)), 'v2 reported tmp path outside supplied scratch home');
  } else {
    assert.equal(health.healthy, true); assert.equal(typeof health.version, 'string'); assert.equal(health.version, version);
  }
  receipt.results.health = { path, status: response.status, dialect: version === '2.2.5' ? 'v2' : 'legacy', validated: true };
  console.log(JSON.stringify(receipt));
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3_000))]);
}
} catch (error) {
  console.log(JSON.stringify({ scenario: scenario || null, expectedVersion: version || null, executable: exeArg || null, results: { startup: { validated: false, error: error instanceof Error ? error.message : String(error) } } }));
  process.exitCode = 1;
}

// Non-model Claude Terminal identity test. A controlled cmd shim stores a
// fixture history marker on --session-id and returns it on --resume. This
// checks ThreadTerm's exact argument/identity path, not real Claude history.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-claude-resume-fixture-'));
const bin = join(scratch, 'bin 带 空格');
const cwd = join(scratch, 'work 带 空格');
const store = join(scratch, 'native-store');
const providerHome = join(scratch, 'claude-config');
await Promise.all([mkdir(bin), mkdir(cwd), mkdir(store), mkdir(providerHome)]);
const script = join(bin, 'fake-claude.mjs');
await writeFile(script, `import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.282 fixture'); process.exit(0); }
const mode = args.includes('--session-id') ? 'new' : args.includes('--resume') ? 'resume' : null;
const flag = mode === 'new' ? '--session-id' : '--resume';
const id = mode && args[args.indexOf(flag) + 1];
if (!id || !/^[0-9a-f-]{36}$/i.test(id)) { console.error('fixture: missing native id'); process.exit(2); }
const history = join(process.env.THREADTERM_QA_NATIVE_STORE, id + '.fixture');
if (mode === 'new') {
  writeFileSync(history, 'FIXTURE_HISTORY_MARKER');
  console.log('MOCK_CLAUDE_NEW:' + id);
} else {
  if (!existsSync(history)) { console.error('fixture: no conversation found with session ID: ' + id); process.exit(3); }
  console.log('MOCK_CLAUDE_RESUME:' + id + ':FIXTURE_HISTORY_MARKER');
}
process.stdin.resume();
setInterval(() => {}, 1000);
`);
// Keep batch contents ASCII-only; %~dp0 expands the actual Unicode script
// directory without depending on the machine's batch-file codepage.
await writeFile(join(bin, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`);

// This controlled SDK host only mirrors whether the controlled CLI created
// its own fixture record. Its marker is not a user/assistant conversation and
// must never be described as real Claude model-history recovery.
const fakeSdkHost = join(bin, 'fake-claude-sdk-host.mjs');
await writeFile(fakeSdkHost, `import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const reply = payload => process.stdout.write(JSON.stringify(payload) + '\\n');
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  if (request.op === 'host.ping') return reply({ id: request.id, ok: { pid: process.pid } });
  if (request.op === 'history.read') {
    if (request.cwd !== process.env.THREADTERM_QA_CWD_CLAUDE) return reply({ id: request.id, error: { message: 'fixture cwd mismatch' } });
    const exists = existsSync(join(process.env.THREADTERM_QA_NATIVE_STORE, request.sessionId + '.fixture'));
    return reply({ id: request.id, ok: { messages: exists ? [{ fixtureHistoryPresent: true }] : [] } });
  }
  reply({ id: request.id, error: { message: 'unsupported fixture operation' } });
});
`);

const child = spawn(process.execPath, [resolve('qa/agent-terminal-resume.mjs')], {
  windowsHide: true,
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    THREADTERM_QA_PROVIDERS: 'claude',
    THREADTERM_QA_LIVE: '0',
    THREADTERM_QA_EXPECT_NATIVE_RESUME: '1',
    THREADTERM_QA_CWD_CLAUDE: cwd,
    THREADTERM_QA_NATIVE_STORE: store,
    THREADTERM_CLAUDE_SDK_HOST: fakeSdkHost,
    CLAUDE_CONFIG_DIR: providerHome,
  },
});
const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', code => resolveExit(code));
});
console.log(`QA fixture artifacts: ${scratch}`);
assert.equal(exitCode, 0, `Claude Terminal fixture regression failed with exit ${exitCode}`);

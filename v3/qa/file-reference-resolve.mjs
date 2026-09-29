// Isolated real-runtime QA for filesystem.resolve. It creates only unconnected
// Chat session records; no Agent is started and no model request is sent.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connectPeer } from './pipe-client.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-file-resolve-'));
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const repo = join(scratch, '项目 一');
const nested = join(repo, 'src');
const secondTree = join(scratch, '项目 二');
const outside = join(scratch, 'outside');
const pipe = `\\\\.\\pipe\\threadterm-file-resolve-${randomUUID()}`;
await Promise.all([
  mkdir(data, { recursive: true }),
  mkdir(profile, { recursive: true }),
  mkdir(nested, { recursive: true }),
  mkdir(outside, { recursive: true }),
]);
await writeFile(join(repo, 'same.txt'), 'main tree');
await writeFile(join(repo, '中文 空格.md'), '# text');
await writeFile(join(repo, 'page.html'), '<p>source only</p>');
await writeFile(join(repo, 'vector.svg'), '<svg/>');
await writeFile(join(repo, 'pixel.png'), Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\nfixture')]));
await writeFile(join(repo, 'extensionless'), Buffer.from('GIF89afixture'));
await writeFile(join(repo, 'bad.png'), 'not an image');
await writeFile(join(repo, 'legacy.bmp'), Buffer.from('BMunsupported'));
await writeFile(join(repo, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61));
await writeFile(join(repo, 'large.png'), Buffer.concat([
  Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n')]),
  Buffer.alloc(4 * 1024 * 1024, 0x61),
]));
await writeFile(join(outside, 'secret.txt'), 'outside');

execFileSync('git', ['init'], { cwd: repo, windowsHide: true, stdio: 'ignore' });
execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo, windowsHide: true });
execFileSync('git', ['config', 'user.email', 'tests@threadterm.invalid'], { cwd: repo, windowsHide: true });
execFileSync('git', ['config', 'user.name', 'ThreadTerm Tests'], { cwd: repo, windowsHide: true });
execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true });
execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, windowsHide: true, stdio: 'ignore' });
execFileSync('git', ['branch', 'qa-second'], { cwd: repo, windowsHide: true });
execFileSync('git', ['worktree', 'add', secondTree, 'qa-second'], { cwd: repo, windowsHide: true, stdio: 'ignore' });
await mkdir(join(secondTree, 'src'), { recursive: true });
await writeFile(join(secondTree, 'same.txt'), 'second tree');

const junction = join(repo, 'escape');
await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');

const fallbackRuntime = resolve('runtime/target-qa/debug/threadterm-v3-runtime.exe');
const runtime = process.env.THREADTERM_QA_RUNTIME_EXE
  || process.env.THREADTERM_V3_RUNTIME_BIN
  || (existsSync(fallbackRuntime) ? fallbackRuntime : resolve('runtime/target/debug/threadterm-v3-runtime.exe'));
assert.ok(existsSync(runtime), `runtime binary missing: ${runtime}`);
const daemon = spawn(runtime, [], {
  windowsHide: true,
  env: {
    ...process.env,
    THREADTERM_V3_DATA: data,
    THREADTERM_V3_USER_DATA: profile,
    THREADTERM_V3_PIPE: pipe,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
daemon.stderr.on('data', chunk => { stderr += chunk.toString(); });
let peer;
const checks = [];
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const rejectCode = async (promise, code) => assert.rejects(promise, error => error?.code === code);

try {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      peer = await connectPeer(`${pipe}-control`);
      await peer.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
      break;
    } catch {
      peer?.close();
      peer = undefined;
      if (daemon.exitCode !== null) throw new Error(`runtime exited: ${stderr}`);
      await delay(50);
    }
  }
  assert.ok(peer, 'isolated runtime authenticated');
  const project = await peer.request('project.add', { path: repo, name: 'Resolve QA', operationId: randomUUID() });
  await peer.request('worktree.list', { projectId: project.id });
  const main = await peer.request('session.create', {
    projectId: project.id,
    cwd: nested,
    provider: 'codex',
    mode: 'chat',
    title: 'main resolve',
    operationId: randomUUID(),
  });
  const second = await peer.request('session.create', {
    projectId: project.id,
    cwd: join(secondTree, 'src'),
    provider: 'codex',
    mode: 'chat',
    title: 'second resolve',
    operationId: randomUUID(),
  });

  const relative = await peer.request('filesystem.resolve', {
    sessionId: main.id,
    path: '../中文 空格.md',
    line: 9,
    column: 4,
  });
  assert.deepEqual(
    { projectId: relative.projectId, path: relative.path, kind: relative.kind, line: relative.line, column: relative.column },
    { projectId: project.id, path: '中文 空格.md', kind: 'text', line: 9, column: 4 },
  );
  pass('nested cwd relative path, Chinese/spaces, line and column');

  const absolute = await peer.request('filesystem.resolve', { sessionId: main.id, path: join(repo, 'pixel.png') });
  assert.equal(absolute.path, 'pixel.png');
  assert.equal(absolute.kind, 'image');
  assert.equal((await peer.request('filesystem.resolve', { sessionId: main.id, path: '../extensionless' })).kind, 'image');
  for (const path of ['../page.html', '../vector.svg']) {
    assert.equal((await peer.request('filesystem.resolve', { sessionId: main.id, path })).kind, 'text');
  }
  pass('absolute image and HTML/SVG source classification');

  const firstNamed = await peer.request('filesystem.resolve', { sessionId: main.id, path: '../same.txt' });
  const secondNamed = await peer.request('filesystem.resolve', { sessionId: second.id, path: '../same.txt' });
  assert.equal(firstNamed.path, 'same.txt');
  assert.equal(secondNamed.path, 'same.txt');
  assert.notEqual(firstNamed.worktreePath.toLowerCase(), secondNamed.worktreePath.toLowerCase());
  pass('same relative name remains isolated between registered worktrees');

  const custom = await peer.request('session.create', {
    projectId: project.id,
    cwd: repo,
    provider: 'custom',
    mode: 'chat',
    operationId: randomUUID(),
  });
  await rejectCode(
    peer.request('filesystem.resolve', { sessionId: custom.id, path: 'same.txt' }),
    'file_reference_relative_requires_absolute',
  );
  assert.equal(
    (await peer.request('filesystem.resolve', { sessionId: custom.id, path: join(repo, 'same.txt') })).path,
    'same.txt',
  );
  pass('shell/custom relative cwd is not guessed; scoped absolute path is allowed');

  const projectless = await peer.request('session.create', {
    cwd: repo,
    provider: 'codex',
    mode: 'chat',
    operationId: randomUUID(),
  });
  const failureCases = [
    [{ sessionId: main.id, path: 'https://example.com/a.rs' }, 'file_reference_uri'],
    [{ sessionId: main.id, path: 'file:///C:/work/a.rs' }, 'file_reference_uri'],
    [{ sessionId: main.id, path: '../same.txt:alternate' }, 'file_reference_invalid_path'],
    [{ sessionId: main.id, path: '../../outside/secret.txt' }, 'file_reference_outside_scope'],
    [{ sessionId: main.id, path: join(outside, 'secret.txt') }, 'file_reference_outside_scope'],
    [{ sessionId: main.id, path: '../escape/secret.txt' }, 'file_reference_outside_scope'],
    [{ sessionId: main.id, path: '../missing.txt' }, 'file_reference_not_found'],
    [{ sessionId: main.id, path: '..' }, 'file_reference_not_file'],
    [{ sessionId: main.id, path: '../bad.png' }, 'unsupported_image'],
    [{ sessionId: main.id, path: '../legacy.bmp' }, 'unsupported_image'],
    [{ sessionId: main.id, path: '../large.txt' }, 'file_too_large'],
    [{ sessionId: main.id, path: '../large.png' }, 'image_too_large'],
    [{ sessionId: main.id, path: '../same.txt', line: 0 }, 'file_reference_invalid_position'],
    [{ sessionId: main.id, path: '../same.txt', line: 1_000_001 }, 'file_reference_invalid_position'],
    [{ sessionId: main.id, path: '../same.txt', column: 0 }, 'file_reference_invalid_position'],
    [{ sessionId: main.id, path: 'bad\0path' }, 'file_reference_invalid_path'],
    [{ sessionId: main.id, path: 'x'.repeat(16 * 1024 + 1) }, 'file_reference_invalid_path'],
    [{ sessionId: projectless.id, path: join(repo, 'same.txt') }, 'file_reference_project_missing'],
    [{ sessionId: randomUUID(), path: join(repo, 'same.txt') }, 'file_reference_session_not_found'],
  ];
  for (const [params, code] of failureCases) await rejectCode(peer.request('filesystem.resolve', params), code);
  pass('URI, traversal, junction, missing/directory/type/size, bounds and session authority errors');

  if (process.platform === 'win32') {
    const verbatim = `\\\\?\\${join(repo, 'same.txt')}`;
    assert.equal((await peer.request('filesystem.resolve', { sessionId: main.id, path: verbatim })).path, 'same.txt');
    pass('Windows drive and verbatim forms resolve without URI confusion');
  }

  console.log(`PASS file reference resolve QA (${checks.length} groups)`);
} finally {
  if (peer) {
    await peer.request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
    peer.close();
  }
  await Promise.race([
    new Promise(done => daemon.once('exit', done)),
    delay(5_000).then(() => { if (daemon.exitCode === null) daemon.kill(); }),
  ]);
}

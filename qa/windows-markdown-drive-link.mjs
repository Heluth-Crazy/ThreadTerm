// Desktop1 integration: production FileLinkedMarkdown -> an authenticated,
// private runtime pipe. It uses one unconnected synthetic custom-chat session;
// it never connects a provider or sends a model turn. The small <pre> below is
// a QA readout of the real filesystem.read result, not the full FileWorkspace.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { electron } from './lib/desktop1.mjs';
import { connectPeer } from './pipe-client.mjs';
import { PROTOCOL_CONTRACT } from '../protocol/index.ts';

assert.equal(process.platform, 'win32', 'this regression exercises Windows drive-style Markdown hrefs');
const root = resolve(import.meta.dirname, '..');
const runtime = resolve(process.env.THREADTERM_QA_RUNTIME_EXE ?? process.env.THREADTERM_V3_RUNTIME_BIN ?? 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), `release runtime binary missing: ${runtime}`);
const scratch = await mkdtemp(join(tmpdir(), 'tt-windows-markdown-link-'));
const data = join(scratch, 'data'), userData = join(scratch, 'user-data'), home = join(scratch, 'home');
const codexHome = join(home, '.codex'), appData = join(scratch, 'appdata'), localAppData = join(scratch, 'localappdata');
const profile = join(scratch, 'electron-profile'), workRoot = join(scratch, 'project with spaces');
const sourceDir = join(workRoot, 'src'), outside = join(scratch, 'outside'), output = join(root, 'qa', 'results', 'windows-markdown-drive-link');
const pipe = `\\\\.\\pipe\\tt-markdown-link-${randomUUID()}`;
const sourceText = [
  'const first = true;',
  'const second = true;',
  'const third = true;',
  'const fourth = true;',
  'const fifth = true;',
  'const sixth = true;',
  'export const WindowsMarkdownTarget = "read from the real runtime";',
].join('\n') + '\n';
const percentName = 'literal%20name.ts';
const percentText = 'literal percent survives one Markdown URL decode\n';
const mainFile = join(sourceDir, 'main.ts');
const percentFile = join(workRoot, percentName);
const outsideFile = join(outside, 'secret.ts');
const junctionFile = join(workRoot, 'escape', 'secret.ts');
const traversalFile = `${workRoot}\\..\\outside\\secret.ts`;
const report = { startedAt: new Date().toISOString(), runtime, passed: false, checks: [], screenshots: [], errors: [], viewer: 'QA-only <pre> displays bytes returned by the real filesystem.read; the production FileWorkspace/CodeMirror editor is not mounted.' };
const delay = ms => new Promise(done => setTimeout(done, ms));
const operationId = () => randomUUID();
const withoutExtendedPrefix = value => value.replace(/^\\\\\?\\/, '');
let daemon, daemonExit, peer, app, page, server, stderr = '', lastAuthError;
let runtimeSession, runtimeProject;
const pass = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const forward = value => value.replaceAll('\\', '/');
const markdownDriveHref = (path, fragment) => `/${encodeURI(forward(path))}${fragment}`;
const daemonAlive = () => Boolean(daemon && daemon.exitCode === null && daemon.signalCode === null);

async function authenticateContract12(candidate, credential) {
  const challenge = JSON.parse(await candidate.next());
  assert.equal(challenge.contract, PROTOCOL_CONTRACT, 'runtime challenge must match the current protocol contract');
  const clientId = randomUUID();
  candidate.json({ kind: 'auth', clientId, protocol: 1, contract: PROTOCOL_CONTRACT, nonce: challenge.nonce,
    hmac: createHmac('sha256', credential).update(`1:${clientId}:${challenge.nonce}`).digest('hex') });
  const proof = JSON.parse(await candidate.next());
  assert.equal(proof.kind, 'authenticated');
  assert.equal(proof.contract, PROTOCOL_CONTRACT);
  assert.equal(proof.hmac, createHmac('sha256', credential).update(`server:1:${clientId}:${challenge.nonce}`).digest('hex'));
  return clientId;
}

function isolatedEnv() {
  const safeWindowsKeys = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_LEVEL', 'NUMBER_OF_PROCESSORS'];
  const env = Object.fromEntries(safeWindowsKeys.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, {
    Path: [dirname(process.execPath), join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32')].join(';'),
    HOME: home, USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2), CODEX_HOME: codexHome,
    APPDATA: appData, LOCALAPPDATA: localAppData,
    THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: userData, THREADTERM_V3_PIPE: pipe,
    THREADTERM_V3_RUNTIME: runtime,
    TT_QA_DESKTOP: '1', TT_PARITY_PROFILE: profile,
  });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['Path'], 'inherited PATH spellings and provider environment must be stripped');
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.ANTHROPIC_API_KEY, undefined);
  return env;
}

async function connectOwnedRuntime() {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    let candidate;
    try {
      candidate = await connectPeer(`${pipe}-control`);
      const credential = (await readFile(join(data, 'runtime.credential'), 'utf8')).trim();
      await authenticateContract12(candidate, credential);
      peer = candidate;
      return;
    } catch (error) {
      candidate?.close();
      lastAuthError = error;
      if (!daemonAlive()) throw new Error(`isolated runtime exited before authentication: ${stderr || error}`);
      await delay(50);
    }
  }
  throw new Error(`timed out authenticating to the fixture-private runtime pipe; last authentication error: ${lastAuthError}; runtime stderr: ${stderr || '(empty)'}`);
}

async function verifyPipeClosed() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const unexpected = await connectPeer(`${pipe}-control`);
      unexpected.close();
      await delay(100);
    } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error?.code)) { pass('fixture-private runtime control pipe is closed after shutdown'); return; }
      throw error;
    }
  }
  throw new Error('fixture-private runtime pipe remained available after shutdown');
}

async function stopOwnedRuntime() {
  if (peer && daemonAlive()) {
    const snapshot = await peer.request('runtime.snapshot', {});
    const sessionIds = snapshot.sessions.map(item => item.id);
    if (runtimeSession) assert.deepEqual(sessionIds, [runtimeSession.id], 'only the known synthetic session exists in the runtime being stopped');
    else assert.deepEqual(sessionIds, [], 'only an empty runtime may be stopped after fixture setup failed early');
    await peer.request('runtime.shutdown', { operationId: operationId() });
  }
  peer?.close(); peer = undefined;
  if (daemon) {
    let exit = await Promise.race([daemonExit, delay(8_000).then(() => undefined)]);
    if (!exit) {
      // Fallback targets only the exact process created by this harness.
      daemon.kill();
      exit = await Promise.race([daemonExit, delay(5_000).then(() => undefined)]);
      if (!exit) {
        execFileSync('taskkill', ['/PID', String(daemon.pid), '/F'], { stdio: 'ignore' });
        exit = await Promise.race([daemonExit, delay(5_000).then(() => undefined)]);
      }
      if (!exit) throw new Error(`fixture runtime PID ${daemon.pid} did not exit after authenticated shutdown and exact-PID fallback`);
      throw new Error(`fixture runtime required exact-PID fallback termination (pid=${daemon.pid}, exit=${JSON.stringify(exit)})`);
    }
    assert.ok(daemon.exitCode !== null || daemon.signalCode !== null, 'owned runtime exit event must agree with child state');
    pass(`owned runtime child exited (pid=${daemon.pid}, code=${daemon.exitCode}, signal=${daemon.signalCode})`);
  }
}

try {
  if (relative(resolve(tmpdir()), resolve(scratch)).startsWith('..')) throw new Error('scratch directory escaped the system temp directory');
  await Promise.all([data, userData, home, codexHome, appData, localAppData, profile, sourceDir, outside, output].map(path => mkdir(path, { recursive: true })));
  await Promise.all([
    writeFile(mainFile, sourceText),
    writeFile(percentFile, percentText),
    writeFile(outsideFile, 'outside root secret\n'),
  ]);
  await symlink(outside, join(workRoot, 'escape'), 'junction');

  const absoluteMain = forward(mainFile);
  const absolutePercent = forward(percentFile);
  const absoluteOutside = forward(outsideFile);
  const absoluteJunction = forward(junctionFile);
  const markdown = [
    `<p><a href="${markdownDriveHref(mainFile, '#L7C3')}">Windows drive file</a></p>`,
    `<p><a href="${markdownDriveHref(percentFile, '#L1')}">Literal percent file</a></p>`,
    `<p><a href="${markdownDriveHref(outsideFile, '#L1')}">Outside absolute file</a></p>`,
    `<p><a href="${markdownDriveHref(traversalFile, '#L1')}">Outside traversal file</a></p>`,
    `<p><a href="${markdownDriveHref(junctionFile, '#L1')}">Junction escape file</a></p>`,
    '<p><a href="https://example.invalid/path.ts">External website</a></p>',
    '<p><a href="javascript:window.__pwned=1">Unsafe javascript</a></p>',
    '<p><a href="/home/user/src/file.ts#L2">Unix absolute path</a> <a href="//server.invalid/share/file.ts#L3">UNC path</a></p>',
    '<p>Plain command prose: /usage /status /src/ stays text.</p>',
  ].join('');

  const fixtureSource = `
    import React from 'react'; import { createRoot } from 'react-dom/client'; import DOMPurify from 'dompurify';
    import { FileLinkedMarkdown, FileReferenceScopeProvider } from ${JSON.stringify(join(root, 'renderer/src/components/FileReferenceText.tsx'))};
    import ${JSON.stringify(join(root, 'renderer/src/styles.css'))};
    const rawMarkdown = ${JSON.stringify(markdown)};
    const safeHtml = DOMPurify.sanitize(rawMarkdown);
    const sessionId = ${JSON.stringify('RUNTIME_SESSION_ID')};
    const canonicalRoot = ${JSON.stringify(workRoot)};
    window.__qaCalls = []; window.__pwned = 0;
    window.threadterm = {
      onEvent: () => () => {},
      request: async (method, params = {}) => {
        if (!['filesystem.resolve', 'filesystem.read'].includes(method)) throw new Error('blocked fixture bridge method: '+method);
        window.__qaCalls.push({ method, params });
        const reply = await window.__runtimeFilesystemRequest(method, params);
        if (!reply.ok) throw Object.assign(new Error(reply.message), { code: reply.code });
        return reply.result;
      },
    };
    function Fixture(){
      const [opened,setOpened]=React.useState(undefined),[issue,setIssue]=React.useState(undefined);
      const openFile=async reference=>{
        setOpened(undefined); setIssue(undefined);
        try {
          const resolved=await window.threadterm.request('filesystem.resolve',{sessionId,...reference});
          const document=await window.threadterm.request('filesystem.read',{projectId:resolved.projectId,worktreePath:resolved.worktreePath,path:resolved.path});
          setOpened({reference,resolved,document});
        } catch(error) { setIssue({code:error.code??'',message:String(error.message??error)}); }
      };
      return <FileReferenceScopeProvider sourceSessionId={sessionId} canonicalRoot={canonicalRoot}>
        <main><FileLinkedMarkdown sanitizedHtml={safeHtml} openFile={openFile}/>
          {issue&&<p role="alert" data-error-code={issue.code}>{issue.code}: {issue.message}</p>}
          {opened&&<section data-testid="qa-opened-file"><b>{opened.document.path}</b><pre>{opened.document.content}</pre><output data-line={opened.reference.line} data-column={opened.reference.column}>Line {opened.reference.line}, column {opened.reference.column}</output></section>}
        </main>
      </FileReferenceScopeProvider>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `;

  // Compile only after the authenticated runtime has returned its session id.
  const entryPath = join(scratch, 'entry.tsx');
  const serverFile = join(scratch, 'index.html');
  await writeFile(serverFile, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/qa.js"></script></body></html>');
  const builtPath = join(scratch, 'qa.js');
  const builtCss = join(scratch, 'qa.css');

  const baseEnv = isolatedEnv();
  daemon = spawn(runtime, [], { windowsHide: true, env: baseEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  daemonExit = new Promise(resolveExit => daemon.once('exit', (code, signal) => resolveExit({ code, signal })));
  daemon.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await connectOwnedRuntime();
  runtimeProject = await peer.request('project.add', { path: workRoot, name: 'Windows Markdown QA', operationId: operationId() });
  const createdSession = await peer.request('session.create', { projectId: runtimeProject.id, cwd: workRoot, provider: 'custom', mode: 'chat', title: 'Unconnected file-link fixture', operationId: operationId() });
  runtimeSession = createdSession.session ?? createdSession;
  assert.equal(runtimeSession.provider, 'custom');
  assert.equal(runtimeSession.mode, 'chat');
  const snapshot = await peer.request('runtime.snapshot', {});
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].id, runtimeSession.id);
  assert.equal(snapshot.sessions[0].status, runtimeSession.status);
  report.runtimeSha256 = createHash('sha256').update(await readFile(runtime)).digest('hex');
  report.runtimeSession = { id: runtimeSession.id, provider: runtimeSession.provider, mode: runtimeSession.mode, status: runtimeSession.status };
  pass('release runtime accepted exactly one unconnected synthetic custom-chat session; no provider process or chat.connect was started');

  // Prove the original browser-style path fails at the runtime boundary; only
  // the Markdown parser is allowed to remove the one URL-style leading slash.
  const rawDrivePath = `/${absoluteMain}`;
  await assert.rejects(peer.request('filesystem.resolve', { sessionId: runtimeSession.id, path: rawDrivePath, line: 7, column: 3 }), error => error?.code === 'file_reference_invalid_path');
  pass('un-normalized /<drive>:/ path is rejected by the actual runtime as file_reference_invalid_path');

  await writeFile(entryPath, fixtureSource.replaceAll('RUNTIME_SESSION_ID', runtimeSession.id));
  await build({ entryPoints: [entryPath], bundle: true, outfile: builtPath, nodePaths: [join(root, 'node_modules')], jsx: 'automatic', platform: 'browser', target: 'chrome120', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'error' });
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const target = pathname === '/' ? serverFile : pathname === '/qa.js' ? builtPath : pathname === '/qa.css' ? builtCss : undefined;
    if (!target) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const body = await readFile(target);
      response.writeHead(200, { 'Content-Type': target.endsWith('.js') ? 'text/javascript; charset=utf-8' : target.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  const origin = `http://127.0.0.1:${server.address().port}`;

  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(root, 'qa', 'parity', 'electron-static.cjs')], env: { ...baseEnv, TT_PARITY_PROFILE: profile }, timeout: 30_000 });
  page = await app.firstWindow({ timeout: 20_000 }); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => report.errors.push(String(error)));
  await page.exposeFunction('__runtimeFilesystemRequest', async (method, params) => {
    if (!['filesystem.resolve', 'filesystem.read'].includes(method)) throw new Error(`fixture RPC forbids ${method}`);
    if (method === 'filesystem.resolve' && params.sessionId !== runtimeSession.id) throw new Error('fixture RPC session scope mismatch');
    if (method === 'filesystem.read' && params.projectId !== runtimeProject.id) throw new Error('fixture RPC project scope mismatch');
    try { return { ok: true, result: await peer.request(method, params) }; }
    catch (error) { return { ok: false, code: error?.code ?? '', message: error?.message ?? String(error) }; }
  });
  await page.goto(origin);

  await page.getByRole('button', { name: 'Windows drive file', exact: true }).click();
  await page.getByTestId('qa-opened-file').waitFor();
  const driveCall = await page.evaluate(() => window.__qaCalls.filter(call => call.method === 'filesystem.resolve').at(-1));
  assert.deepEqual(driveCall.params, { sessionId: runtimeSession.id, path: absoluteMain, line: 7, column: 3 });
  const opened = await page.getByTestId('qa-opened-file').evaluate(node => ({ path: node.querySelector('b').textContent, content: node.querySelector('pre').textContent, line: node.querySelector('output').dataset.line, column: node.querySelector('output').dataset.column }));
  assert.equal(opened.path, 'src/main.ts');
  assert.equal(opened.content, sourceText);
  assert.equal(opened.line, '7'); assert.equal(opened.column, '3');
  const readCall = await page.evaluate(() => window.__qaCalls.filter(call => call.method === 'filesystem.read').at(-1));
  assert.equal(readCall.params.projectId, runtimeProject.id);
  assert.equal(withoutExtendedPrefix(readCall.params.worktreePath).toLowerCase(), withoutExtendedPrefix(workRoot).toLowerCase(), 'runtime may canonicalize Windows roots with the extended-length path prefix');
  assert.equal(readCall.params.path, 'src/main.ts');
  pass('production FileLinkedMarkdown normalizes /<drive>:/, preserves line 7/column 3, and displays actual runtime-resolved/read content');
  await page.screenshot({ path: join(output, 'drive-file-opened.png') }); report.screenshots.push('drive-file-opened.png');

  await page.getByRole('button', { name: 'Literal percent file', exact: true }).click();
  await page.getByTestId('qa-opened-file').waitFor();
  const percentCall = await page.evaluate(() => window.__qaCalls.filter(call => call.method === 'filesystem.resolve').at(-1));
  assert.deepEqual(percentCall.params, { sessionId: runtimeSession.id, path: absolutePercent, line: 1 });
  assert.equal(await page.locator('[data-testid="qa-opened-file"] pre').innerText(), percentText);
  pass('Markdown URL decoding occurs once; a literal %20 filename resolves and reads unchanged');

  for (const [label, expected] of [
    ['Outside absolute file', 'file_reference_outside_scope'],
    ['Outside traversal file', 'file_reference_outside_scope'],
    ['Junction escape file', 'file_reference_outside_scope'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('alert').waitFor();
    const error = await page.getByRole('alert').evaluate(node => ({ code: node.getAttribute('data-error-code'), text: node.textContent }));
    assert.equal(error.code, expected, `${label} must be denied by runtime containment`);
    assert.equal(await page.getByTestId('qa-opened-file').count(), 0, `${label} must never render file contents`);
  }
  pass('normalized absolute, parent traversal, and Windows junction escape are rejected by actual runtime root containment');

  assert.equal(await page.getByRole('link', { name: 'External website', exact: true }).getAttribute('href'), 'https://example.invalid/path.ts');
  assert.equal(await page.getByRole('button', { name: 'External website', exact: true }).count(), 0, 'web link is not converted to a local-file button');
  assert.equal(await page.getByRole('button', { name: 'Unsafe javascript', exact: true }).count(), 0, 'DOMPurify and Markdown linking do not make JavaScript executable or local');
  const unixAndUnc = await page.locator('button[data-file-reference]').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.textContent, JSON.parse(node.getAttribute('data-file-reference')).path])));
  assert.equal(unixAndUnc['Unix absolute path'], '/home/user/src/file.ts', 'Unix absolute target remains literal on Windows');
  assert.equal(unixAndUnc['UNC path'], '//server.invalid/share/file.ts', 'UNC target keeps both leading slashes and is never rewritten as a drive path');
  assert.equal(await page.getByRole('button', { name: /\/usage|\/status|\/src\// }).count(), 0, 'slash-command prose remains ordinary text');
  assert.match(await page.locator('main').innerText(), /Plain command prose: \/usage \/status \/src\//);
  assert.equal(await page.evaluate(() => window.__pwned), 0);
  assert.deepEqual(report.errors, []);
  pass('HTTPS remains external; JavaScript stays inert; Unix/UNC hrefs preserve spelling; slash commands remain text');
  await page.screenshot({ path: join(output, 'link-guards.png') }); report.screenshots.push('link-guards.png');
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(report.errors.at(-1));
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) {
    const electronProcess = app.process();
    const electronExit = new Promise(resolveExit => {
      if (electronProcess.exitCode !== null || electronProcess.signalCode !== null) resolveExit();
      else electronProcess.once('exit', resolveExit);
    });
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    try { await app.close(); } catch (error) {
      report.errors.push(`Electron close: ${error.message}`); report.passed = false;
      // On a failed QA close, terminate only this fixture's child and still
      // wait for its exit before shutting down the authenticated runtime.
      if (electronProcess.exitCode === null && electronProcess.signalCode === null) electronProcess.kill();
    }
    await electronExit;
    if (electronProcess.exitCode === null && electronProcess.signalCode === null) throw new Error(`Electron PID ${electronProcess.pid} close returned before its process exited`);
  }
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  try { await stopOwnedRuntime(); } catch (error) { report.errors.push(`runtime shutdown: ${error instanceof Error ? error.message : String(error)}`); report.passed = false; }
  if (daemon) await verifyPipeClosed().catch(error => { report.errors.push(`pipe closure: ${error instanceof Error ? error.message : String(error)}`); report.passed = false; });
  const resolvedScratch = resolve(scratch), resolvedTemp = resolve(tmpdir()), safeRelative = relative(resolvedTemp, resolvedScratch);
  if (!safeRelative.startsWith('..') && !safeRelative.includes(`..${sep}`) && basename(resolvedScratch).startsWith('tt-windows-markdown-link-')) {
    await rm(resolvedScratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(error => { report.errors.push(`scratch cleanup: ${error.message}`); report.passed = false; });
  }
  await mkdir(output, { recursive: true });
  report.completedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\r\n');
  console.log(report.passed ? 'WINDOWS MARKDOWN DRIVE LINK QA PASSED' : `WINDOWS MARKDOWN DRIVE LINK QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));

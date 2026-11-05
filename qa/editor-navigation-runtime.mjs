// Real, isolated editor-navigation runtime harness. It intentionally never installs
// a language server: set THREADTERM_NAVIGATION_TOOLS to a JSON manifest (or provide
// the researched qa-tools/tools.json) containing executable paths before running.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connectPeer } from './pipe-client.mjs';

const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const scratch = await mkdtemp(join(tmpdir(), 'threadterm-editor-navigation-'));
const data = join(scratch, 'data'), project = join(scratch, 'project');
const pipe = `\\\\.\\pipe\\threadterm-navigation-${randomUUID()}`;
const report = { passed: false, runtime, project, checks: [], skipped: [], failures: [], cleanup: [] };
const reportPath = resolve('.trellis/tasks/11-05-editor-navigation-lsp/editor-navigation-runtime-last-report.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let daemon, peer, foreign;
const caseContexts = new Set();

function processTreeSample(rootPid) {
  if (process.platform !== 'win32' || !rootPid) return { supported: false };
  const script = `$ErrorActionPreference='Stop'; $all=Get-CimInstance Win32_Process; $ids=@(${rootPid}); for($i=0;$i -lt $ids.Count;$i++){ $ids += @($all|Where-Object {$_.ParentProcessId -eq $ids[$i]}|ForEach-Object ProcessId) }; $rows=@(Get-Process -Id $ids -ErrorAction SilentlyContinue|ForEach-Object {[pscustomobject]@{pid=$_.Id;rss=$_.WorkingSet64;cpu=$_.CPU;name=$_.ProcessName}}); ConvertTo-Json -InputObject $rows -Compress; exit 0`;
  try { const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' }).trim(); const processes = raw ? (Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [JSON.parse(raw)]) : []; return { supported: true, processes }; }
  catch (error) { return { supported: true, error: String(error) }; }
}

function toolValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.path === 'string') return value.path;
  return undefined;
}
async function toolsManifest() {
  const candidates = [
    process.env.THREADTERM_NAVIGATION_TOOLS,
    '.trellis/tasks/11-05-editor-navigation-lsp/qa-tools/tools.json',
    'qa-tools/tools.json',
  ].filter(Boolean).map(file => resolve(file));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const source = raw.tools && typeof raw.tools === 'object' ? raw.tools : raw;
    const tools = {
      typescript: toolValue(source.typescript?.server ?? source.typescript),
      rust: toolValue(source.rust?.server ?? source.rust),
      python: toolValue(source.python?.server ?? source.python),
      java: toolValue(source.java?.javaExecutable ?? source.java),
      // JDT LS receives a server directory; the manager supplies no caller args.
      jdtls: toolValue(source.java?.jdtlsDirectory ?? source.jdtls),
    };
    report.toolsManifest = file;
    return tools;
  }
  report.toolsManifest = undefined;
  return {};
}
async function until(action, label, timeout = 15_000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const value = await action(); if (value) return value; last = value; } catch (error) { last = error; }
    await delay(75);
  }
  throw Error(`${label} timed out${last ? `: ${String(last)}` : ''}`);
}
async function start() {
  await mkdir(project, { recursive: true });
  daemon = spawn(runtime, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: join(scratch, 'user-data'), THREADTERM_V3_PIPE: pipe } });
  peer = await until(async () => {
    try { const candidate = await connectPeer(`${pipe}-control`); await candidate.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim()); return candidate; }
    catch { if (daemon.exitCode !== null) throw Error(`runtime exited: ${daemon.exitCode}`); return undefined; }
  }, 'isolated runtime');
  foreign = await connectPeer(`${pipe}-control`); await foreign.auth((await readFile(join(data, 'runtime.credential'), 'utf8')).trim());
}
async function writeFixture(name, files) {
  const root = join(project, name); await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) { const output = join(root, path); await mkdir(dirname(output), { recursive: true }); await writeFile(output, content); }
  return root;
}
const cases = [
  { id: 'typescript', language: 'typescript', tool: 'typescript', source: 'src/app.ts', target: 'src/target.ts', readyMs: 30_000, symbol: 'value',
    files: { 'tsconfig.json': '{"compilerOptions":{"target":"ES2022","module":"commonjs"}}', 'src/target.ts': 'export function dirtyTarget(): number { return 7; }\nexport const currentSymbol = 1;\n', 'src/app.ts': "import { dirtyTarget } from './target';\nconst value = dirtyTarget();\n" }, needle: 'dirtyTarget', overlay: 'dirtyOverlayTarget' },
  { id: 'javascript', language: 'javascript', tool: 'typescript', source: 'src/app.js', target: 'src/target.js', readyMs: 30_000, symbol: 'value',
    files: { 'jsconfig.json': '{"compilerOptions":{"checkJs":true}}', 'src/target.js': 'export function dirtyTarget() { return 7; }\nexport const currentSymbol = 1;\n', 'src/app.js': "import { dirtyTarget } from './target.js';\nconst value = dirtyTarget();\n" }, needle: 'dirtyTarget', overlay: 'dirtyOverlayTarget' },
  { id: 'rust', language: 'rust', tool: 'rust', source: 'src/main.rs', target: 'src/lib.rs', readyMs: 70_000, symbol: 'main',
    files: { 'Cargo.toml': '[package]\nname="navigation_fixture"\nversion="0.1.0"\nedition="2021"\n', 'src/lib.rs': 'pub fn dirty_target() -> i32 { 7 }\npub fn current_symbol() {}\n', 'src/main.rs': 'use navigation_fixture::dirty_target;\nfn main() { let _ = dirty_target(); }\n' }, needle: 'dirty_target', overlay: 'dirty_overlay_target' },
  { id: 'python', language: 'python', tool: 'python', source: 'app.py', target: 'target.py', readyMs: 30_000, symbol: 'value',
    files: { 'target.py': 'def dirty_target():\n    return 7\n\ndef current_symbol():\n    return None\n', 'app.py': 'from target import dirty_target\nvalue = dirty_target()\n' }, needle: 'dirty_target', overlay: 'dirty_overlay_target' },
  { id: 'java', language: 'java', tool: 'jdtls', source: 'src/demo/App.java', target: 'src/demo/Target.java', readyMs: 130_000, symbol: 'value',
    files: { '.project': '<?xml version="1.0"?><projectDescription><name>navigation-fixture</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>', '.classpath': '<?xml version="1.0"?><classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21"/><classpathentry kind="output" path="bin"/></classpath>', 'src/demo/Target.java': 'package demo; public class Target { public static int dirtyTarget(){ return 7; } public static void currentSymbol(){} }\n', 'src/demo/App.java': 'package demo; public class App { int value = Target.dirtyTarget(); }\n' }, needle: 'dirtyTarget', overlay: 'dirtyOverlayTarget' },
];
async function runCase(tools, spec) {
  if (!tools[spec.tool]) { report.skipped.push({ language: spec.id, reason: `missing configured ${spec.tool} tool` }); return; }
  const observed = { language: spec.id, stage: 'prepare' }; report.checks.push(observed);
  const root = await writeFixture(spec.id, spec.files);
  const registered = await peer.request('project.add', { path: root, name: `Navigation ${spec.id}`, operationId: randomUUID() });
  const projectId = registered.id;
  const configured = await peer.request('editorNavigation.configure', { enabled: true, tools });
  assert.equal(configured.enabled, true, `${spec.id}: configuration accepted`);
  const coldStartupSample = processTreeSample(daemon.pid); const preparedAt = Date.now();
  const preparation = await peer.request('editorNavigation.prepare', { projectId, bufferGroup: `qa-${spec.id}`, language: spec.language });
  assert.ok(Date.now() - preparedAt < 1_000, `${spec.id}: prepare is background admission`);
  const health = await peer.request('runtime.health'); assert.ok(health.result?.epoch || health.epoch, `${spec.id}: health answers while startup is pending`);
  const contextId = preparation.result?.contextId ?? preparation.contextId;
  assert.ok(contextId, `${spec.id}: context token returned`);
  caseContexts.add(contextId);
  const status = await until(async () => {
    const reply = await peer.request('editorNavigation.status', { contextId });
    const value = reply.result ?? reply; return value.state === 'preparing' ? undefined : value;
  }, `${spec.id} server readiness`, spec.readyMs);
  assert.equal(status.state, 'ready', `${spec.id}: ${status.message ?? 'language service failed'}`);
  const coldReadyMs = Date.now() - preparedAt;
  const readySample = processTreeSample(daemon.pid);
  Object.assign(observed, { stage: 'definition', state: status.state, coldPrepareReadyMs: coldReadyMs, processTreeObserved: { startup: coldStartupSample, ready: readySample } });
  assert.ok(!coldStartupSample.error && !readySample.error, `${spec.id}: resource sampling failed`);
  const docs = await Promise.all([spec.source, spec.target].map(async path => ({ path, content: await readFile(join(root, path), 'utf8'), version: 1 })));
  const dirty = docs.find(document => document.path === spec.target);
  // Deliberately differs from disk: the query must see a full dirty target
  // snapshot rather than recovering the target through filesystem reads.
  dirty.content = dirty.content.replaceAll(spec.needle, spec.overlay) + (spec.language === 'python'
    ? `\n# threadterm dirty target ${randomUUID()}\n`
    : `\n/* threadterm dirty target ${randomUUID()} */\n`);
  const sourceDoc = docs.find(document => document.path === spec.source);
  const comment = spec.language === 'python' ? '# α Unicode / CRLF navigation fixture' : '// α Unicode / CRLF navigation fixture';
  sourceDoc.content = `${comment}\r\n${sourceDoc.content.replaceAll(spec.needle, spec.overlay).replaceAll('\n', '\r\n')}`;
  if (spec.language === 'typescript' || spec.language === 'javascript') sourceDoc.content = sourceDoc.content.replace('const value =', 'const unicode = "😀"; const value =');
  else if (spec.language === 'rust') sourceDoc.content = sourceDoc.content.replace('fn main() {', 'fn main() { let unicode = "😀";');
  else if (spec.language === 'python') sourceDoc.content = sourceDoc.content.replace('value =', 'unicode = "😀"; value =');
  else sourceDoc.content = sourceDoc.content.replace('int value =', 'String unicode = "😀"; int value =');
  await peer.request('editorNavigation.sync', { contextId, documents: docs });
  const source = sourceDoc.content;
  const offset = source.lastIndexOf(spec.overlay); const line = source.slice(0, offset).split('\n').length; const column = offset - source.lastIndexOf('\n', offset - 1);
  const definition = await peer.request('editorNavigation.definition', { contextId, path: spec.source, version: 1, line, column, requestId: `${spec.id}-definition` });
  const definitionValue = definition.result ?? definition;
  observed.definition = { line, column, ...definitionValue };
  assert.ok(definitionValue.targets?.some(target => target.path === spec.target && target.line === 1), `${spec.id}: cross-file dirty overlay definition: ${JSON.stringify(definitionValue)}`);
  const warmDefinitionAt = Date.now();
  const warmDefinition = await peer.request('editorNavigation.definition', { contextId, path: spec.source, version: 1, line, column, requestId: `${spec.id}-warm-definition` });
  assert.ok((warmDefinition.result ?? warmDefinition).targets?.some(target => target.path === spec.target), `${spec.id}: warm definition retains the ready context`);
  const warmDefinitionMs = Date.now() - warmDefinitionAt;
  const noTarget = await peer.request('editorNavigation.definition', { contextId, path: spec.source, version: 1, line: 1, column: 4, requestId: `${spec.id}-no-target` });
  assert.equal((noTarget.result ?? noTarget).targets.length, 0, `${spec.id}: comment position has no definition target`);
  const symbols = await peer.request('editorNavigation.documentSymbols', { contextId, path: spec.source, version: 1, requestId: `${spec.id}-symbols` });
  const symbolsValue = symbols.result ?? symbols;
  assert.ok(symbolsValue.symbols?.some(symbol => symbol.name === spec.symbol), `${spec.id}: current-file symbol ${spec.symbol}`);
  // Add a lexical local with the same identifier after the imported/qualified
  // target use; querying this later occurrence must resolve to the source file.
  let shadowCall;
  if (spec.language === 'typescript' || spec.language === 'javascript') {
    sourceDoc.content = sourceDoc.content.replace(`{ ${spec.overlay} }`, `{ ${spec.overlay} as importedTarget }`).replace(`value = ${spec.overlay}()`, 'value = importedTarget()') + `\nconst ${spec.overlay} = () => 0;\nconst shadowValue = ${spec.overlay}();\n`;
    shadowCall = spec.overlay;
  } else if (spec.language === 'python') {
    sourceDoc.content = sourceDoc.content.replace(`import ${spec.overlay}`, `import ${spec.overlay} as imported_target`).replaceAll(`${spec.overlay}()`, 'imported_target()') + `\ndef ${spec.overlay}():\n    return 0\nshadow_value = ${spec.overlay}()\n`;
    shadowCall = spec.overlay;
  } else if (spec.language === 'rust') {
    sourceDoc.content = sourceDoc.content.replace(`use navigation_fixture::${spec.overlay};`, `use navigation_fixture::${spec.overlay} as imported_target;`).replaceAll(`${spec.overlay}()`, 'imported_target()') + `\nfn ${spec.overlay}() -> i32 { 0 }\nfn shadow_value() { let _ = ${spec.overlay}(); }\n`;
    shadowCall = spec.overlay;
  } else {
    sourceDoc.content = sourceDoc.content.replace(/}\s*$/, ` int ${spec.overlay}(){ return 0; } int shadowValue = ${spec.overlay}(); }\n`);
    shadowCall = spec.overlay;
  }
  await peer.request('editorNavigation.sync', { contextId, documents: docs.map(document => document.path === spec.source ? { ...document, content: sourceDoc.content, version: 2 } : document) });
  const shadowOffset = sourceDoc.content.lastIndexOf(shadowCall); const shadowLine = sourceDoc.content.slice(0, shadowOffset).split('\n').length; const shadowColumn = shadowOffset - sourceDoc.content.lastIndexOf('\n', shadowOffset - 1);
  const shadow = await peer.request('editorNavigation.definition', { contextId, path: spec.source, version: 2, line: shadowLine, column: shadowColumn, requestId: `${spec.id}-shadow` });
  assert.ok((shadow.result ?? shadow).targets?.some(target => target.path === spec.source), `${spec.id}: lexical shadow resolves locally`);
  const cancelled = await peer.request('editorNavigation.cancel', { contextId, requestId: `${spec.id}-unknown-cancel` }); assert.equal((cancelled.result ?? cancelled).accepted, true, `${spec.id}: unknown cancel is idempotent`);
  // This request is deliberately sent before its cancellation on the same
  // authenticated control stream. The reply loop records whether a server won
  // the race; the cancellation must still target a live manager request id.
  const inFlightId = `${spec.id}-inflight-cancel`;
  peer.json({ v: 1, id: inFlightId, method: 'editorNavigation.definition', params: { contextId, path: spec.source, version: 2, line: shadowLine, column: shadowColumn, requestId: inFlightId } });
  peer.json({ v: 1, id: `${inFlightId}-cancel`, method: 'editorNavigation.cancel', params: { contextId, requestId: inFlightId } });
  const cancelReplies = new Map();
  while (cancelReplies.size < 2) { const frame = JSON.parse(await peer.next(10_000)); if (typeof frame.event !== 'string' && (frame.id === inFlightId || frame.id === `${inFlightId}-cancel`)) cancelReplies.set(frame.id, frame); }
  assert.equal(cancelReplies.get(`${inFlightId}-cancel`)?.result?.accepted, true, `${spec.id}: in-flight cancel acknowledged`);
  const queryError = cancelReplies.get(inFlightId)?.error;
  assert.ok(!queryError || /cancel|stale_request/.test(`${queryError.code} ${queryError.message}`), `${spec.id}: query failed before cancellation: ${JSON.stringify(queryError)}`);
  const beforeRelease = processTreeSample(daemon.pid);
  Object.assign(observed, { stage: 'release', targets: definitionValue.targets.length, symbols: symbolsValue.symbols.length, warmDefinitionMs, cancellation: { query: cancelReplies.get(inFlightId)?.error?.code ?? 'completed', cancel: 'accepted' } });
  observed.processTreeObserved.beforeRelease = beforeRelease;
  assert.ok(!beforeRelease.error, `${spec.id}: pre-release resource sampling failed`);
  const released = await peer.request('editorNavigation.release', { contextId }); assert.equal((released.result ?? released).accepted, true);
  caseContexts.delete(contextId);
  const afterRelease = await until(() => {
    const sample = processTreeSample(daemon.pid);
    observed.processTreeObserved.lastReleaseSample = sample;
    const baseline = new Set(coldStartupSample.processes?.map(process => `${process.pid}:${process.name}`));
    return !sample.error && (!sample.supported || sample.processes.every(process => baseline.has(`${process.pid}:${process.name}`))) ? sample : undefined;
  }, `${spec.id} released process tree`, 10_000);
  observed.processTreeObserved.afterRelease = afterRelease; observed.stage = 'passed';
}
async function securityAndBounds(projectId, tools) {
  const invalid = async (client, method, params) => {
    try { await client.request(method, params); throw Error(`${method} unexpectedly succeeded`); }
    catch (error) { assert.ok(error.code, `${method} must return a typed runtime error`); return error.code; }
  };
  const unknownParams = await invalid(peer, 'editorNavigation.prepare', { projectId, bufferGroup: 'bad', language: 'typescript', extra: true });
  if (!tools.typescript) { report.skipped.push({ security: 'foreign-token/root-escape/bounds need a configured TypeScript context' }); return; }
  const prepared = await peer.request('editorNavigation.prepare', { projectId, bufferGroup: 'security', language: 'typescript' });
  const contextId = prepared.contextId;
  const foreignToken = await invalid(foreign, 'editorNavigation.status', { contextId });
  const rootEscape = await invalid(peer, 'editorNavigation.sync', { contextId, documents: [{ path: '../escape.ts', content: 'x', version: 0 }] });
  const bounds = await invalid(peer, 'editorNavigation.sync', { contextId, documents: Array.from({ length: 129 }, (_, i) => ({ path: `src/d${i}.ts`, content: 'x', version: 0 })) });
  await peer.request('editorNavigation.release', { contextId });
  report.checks.push({ security: { unknownParams, foreignToken, rootEscape, bounds } });
}
try {
  if (!existsSync(runtime)) throw Error(`runtime binary missing: ${runtime}; build it before running this harness`);
  const tools = await toolsManifest();
  await start();
  const added = await peer.request('project.add', { path: project, name: 'Navigation QA', operationId: randomUUID() });
  const projectId = (added.result ?? added).id; assert.ok(projectId, 'project registered');
  const selectedCases = process.env.THREADTERM_NAVIGATION_CASE ? cases.filter(spec => spec.id === process.env.THREADTERM_NAVIGATION_CASE) : cases;
  assert.ok(selectedCases.length, 'requested language fixture exists');
  report.scope = selectedCases.length === cases.length ? 'full-five-language-matrix' : `focused-${selectedCases[0].id}`;
  for (const spec of selectedCases) {
    console.log(`Checking real ${spec.id} navigation...`);
    try { await runCase(tools, spec); } catch (error) { report.failures.push({ language: spec.id, error: String(error) }); }
    finally { for (const contextId of caseContexts) { await peer.request('editorNavigation.release', { contextId }).catch(() => {}); caseContexts.delete(contextId); } }
  }
  await securityAndBounds(projectId, tools);
  report.passed = report.failures.length === 0
    && report.skipped.length === 0
    && selectedCases.every(spec => report.checks.some(check => check.language === spec.id && check.stage === 'passed'));
  if (!report.passed) throw Error(`editor navigation incomplete: ${JSON.stringify({ failures: report.failures, skipped: report.skipped })}`);
} finally {
  if (peer && !peer.closed) {
    try { await peer.request('runtime.shutdown', { operationId: randomUUID() }, 5_000); report.cleanup.push('runtime shutdown acknowledged'); }
    catch (error) { report.cleanup.push(`runtime shutdown acknowledgement failed: ${String(error)}`); }
  }
  for (let i = 0; daemon?.exitCode === null && i < 50; i++) await delay(100);
  if (daemon?.exitCode === null) { daemon.kill(); report.cleanup.push('runtime force-killed after bounded graceful shutdown'); }
  report.cleanupProcessTree = processTreeSample(daemon?.pid);
  if (report.cleanupProcessTree.error || report.cleanupProcessTree.processes?.length) {
    report.failures.push({ cleanup: 'Runtime process-tree cleanup did not verify', observed: report.cleanupProcessTree });
    report.passed = false; process.exitCode = 1;
  }
  peer?.close(); foreign?.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true }).catch(error => report.cleanup.push(`scratch retained: ${String(error)}`));
}

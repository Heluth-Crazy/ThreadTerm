import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
// Keep the compiler external when the standard QA runner bundles this test as ESM.
const ts = require('typescript');

function bootRepair(log = { text: '' }, source = readFileSync(resolve('qa/fixtures/fake-codex-repair.cjs'), 'utf8')) {
  const messages = [];
  let receive;
  const require = name => {
    if (name === 'node:fs') return { appendFileSync: (_path, text) => { log.text += text; }, readFileSync: () => log.text };
    if (name === 'node:readline') return { createInterface: () => ({ on: (_event, callback) => { receive = callback; } }) };
    throw new Error(`Unexpected fixture dependency ${name}`);
  };
  const process = {
    argv: ['node', 'fixture.cjs', '-c', 'mcp_servers.qa.enabled=true', 'app-server', '--stdio'],
    env: { THREADTERM_QA_CODEX_REPAIR_LOG: 'memory', THREADTERM_QA_CODEX_REPAIR_CWD: 'fixture-work' },
    stdin: {}, stdout: { write: line => messages.push(JSON.parse(line)) },
    exit: code => { throw new Error(`Unexpected fixture exit ${code}`); },
  };
  runInNewContext(source, { require, process });
  return {
    request: value => receive(JSON.stringify(value)),
    response: id => messages.find(value => value.id === id),
    messages,
  };
}

test('repair fixture verifies an empty new chat from a separate app-server using the requested ID', () => {
  const log = { text: '' };
  const worker = bootRepair(log);
  worker.request({ id: 1, method: 'thread/start' });
  const nativeId = worker.response(1).result.thread.id;
  worker.request({ id: 2, method: 'thread/inject_items', params: { threadId: nativeId, items: [] } });
  assert.deepEqual(worker.response(2).result, {});
  const reader = bootRepair(log);
  for (const [id, method, threadId] of [[3, 'thread/read', nativeId], [4, 'thread/read', 'another-requested-id'], [5, 'thread/resume', 'another-requested-id']]) {
    reader.request({ id, method, params: { threadId, includeTurns: true } });
    assert.deepEqual(reader.response(id).result.thread, { id: threadId, cwd: 'fixture-work', model: 'qa-repair-model', status: { type: 'idle' }, turns: [] });
  }
});

test('repair fixture preserves native transcript and Stop after a turn across helper processes', () => {
  const log = { text: '' };
  const worker = bootRepair(log);
  worker.request({ id: 1, method: 'thread/start' });
  const nativeId = worker.response(1).result.thread.id;
  worker.request({ id: 2, method: 'turn/start', params: { threadId: nativeId } });
  const turnId = worker.response(2).result.turn.id;
  assert.ok(worker.messages.some(value => value.method === 'item/commandExecution/requestApproval'));
  worker.request({ id: 3, method: 'turn/interrupt', params: { threadId: nativeId, turnId } });
  assert.ok(worker.messages.some(value => value.method === 'turn/completed' && value.params.turn.status === 'interrupted'));
  const reader = bootRepair(log);
  reader.request({ id: 4, method: 'thread/read', params: { threadId: nativeId, includeTurns: true } });
  assert.deepEqual(reader.response(4).result.thread.turns[0].items.map(item => [item.id, item.type]), [
    ['qa-repair-native-user', 'userMessage'], ['qa-repair-native-tool', 'commandExecution'], ['qa-repair-native-assistant', 'agentMessage'],
  ]);
  reader.request({ id: 5, method: 'thread/read', params: { threadId: 'unrelated-thread', includeTurns: true } });
  assert.deepEqual(reader.response(5).result.thread.turns, []);
});

test('reclaim generated Electron entry uses runtime APIs and an isolated profile', async () => {
  const source = readFileSync(resolve('qa/opencode-reclaim-visual.mjs'), 'utf8');
  // Execute the actual generated main entry; resolving a filesystem Electron
  // package would return its executable path rather than the runtime API.
  const template = source.match(/writeFile\(join\(scratch, 'main\.cjs'\), (`[^\n]+`)\);/u)?.[1];
  assert.ok(template, 'generated main entry is present');
  const entry = runInNewContext(template, { scratch: 'isolated', root: 'repository', join: (...parts) => parts.join('/') });
  const calls = [];
  let loaded;
  runInNewContext(entry, { require: name => {
    assert.equal(name, 'electron');
    return {
      app: { setPath: (...args) => calls.push(args), whenReady: () => Promise.resolve() },
      BrowserWindow: class { loadFile(path) { loaded = path; } },
    };
  } });
  await Promise.resolve();
  assert.deepEqual(calls, [['userData', 'isolated/profile']]);
  assert.equal(loaded, 'isolated/index.html');
});

// Execute the real matrix driver without launching Electron or a provider.
async function reclaimMatrix({ failCell, failBuild = false } = {}) {
  const source = readFileSync(resolve('qa/opencode-reclaim-visual.mjs'), 'utf8');
  const writes = new Map(), screenshots = [], visited = [];
  let current;
  const geometry = { bounds: { left: 0, right: 500 }, rects: [{ left: 5, right: 31 }], overlaps: [], overflow: false,
    tokens: Object.fromEntries(['background', 'surface', 'text', 'muted', 'accent', 'border'].map(key => [key, 'installed'])) };
  const page = {
    on() {}, waitForFunction: async () => {},
    keyboard: { press: async () => {} }, mouse: { move: async () => {} },
    evaluate: async (_callback, value) => {
      if (value?.theme) {
        current = `${value.theme}/${value.width}/${value.issue ? 'lease-error' : value.lost ? 'lease-lost' : 'provider-failed'}`;
        visited.push(current);
      }
    },
    locator: () => ({ evaluate: async () => geometry }),
    getByRole: () => ({ click: async () => {}, waitFor: async () => {} }),
    screenshot: async ({ path }) => screenshots.push(path),
  };
  const process = { cwd: () => 'repository', env: {}, execPath: 'node.exe' };
  const script = `(async () => { ${source.slice(source.indexOf('const root = process.cwd();'))} })()`;
  await runInNewContext(script, {
    // Playwright serializes evaluated values; normalize the test double's realms too.
    assert: { ...assert, deepEqual: (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message) },
    process, console: { log() {} },
    resolve: (...parts) => parts.join('/'), join: (...parts) => parts.join('/'), dirname: () => '.', tmpdir: () => 'temp',
    mkdir: async () => {}, mkdtemp: async () => 'isolated', writeFile: async (path, text) => writes.set(path, text),
    build: async () => { if (failBuild) throw new Error('injected build failure'); },
    electron: { launch: async () => ({ firstWindow: async () => page, close: async () => {} }) },
    checkControlConsistency: async () => {
      if (current === failCell) throw new Error('injected cell failure');
      return { checked: 6, violations: [] };
    },
    assertNoControlViolations: result => assert.equal(result.violations.length, 0),
  });
  return { report: JSON.parse(writes.get('qa/results/browser-chat-followups/OC1/opencode-reclaim-visual/report.json')), screenshots, visited, process };
}

test('reclaim matrix records 18 individual passes on success', async () => {
  const { report, screenshots, process } = await reclaimMatrix();
  assert.deepEqual(report.summary, { passed: 18, failed: 0, notRun: 0 });
  assert.equal(report.passed, true);
  assert.ok(report.cells.every(cell => cell.passed === true && cell.status === 'passed' && cell.errors.length === 0));
  assert.equal(screenshots.length, 18);
  assert.equal(process.exitCode, undefined);
});

test('reclaim matrix keeps prior passes and runs later cells after one custom cell fails', async () => {
  const { report, screenshots, visited, process } = await reclaimMatrix({ failCell: 'custom/398/provider-failed' });
  assert.equal(report.passed, false);
  assert.deepEqual(report.summary, { passed: 17, failed: 1, notRun: 0 });
  assert.ok(report.cells.slice(0, 12).every(cell => cell.passed === true));
  assert.equal(report.cells[12].status, 'failed');
  assert.match(report.cells[12].errors[0], /custom\/398\/provider-failed.*injected cell failure/s);
  assert.ok(report.cells.slice(13).every(cell => cell.passed === true));
  assert.equal(report.errors.length, 1);
  assert.equal(visited.length, 18);
  assert.equal(screenshots.length, 18, 'failed cells are also captured');
  assert.equal(process.exitCode, 1);
});

test('reclaim setup failure marks all cells unrun, without fabricating cell failures', async () => {
  const { report, screenshots, visited, process } = await reclaimMatrix({ failBuild: true });
  assert.equal(report.passed, false);
  assert.deepEqual(report.summary, { passed: 0, failed: 0, notRun: 18 });
  assert.ok(report.cells.every(cell => cell.passed === null && cell.status === 'not-run'));
  assert.equal(visited.length, 0);
  assert.equal(screenshots.length, 0);
  assert.match(report.errors[0], /injected build failure/);
  assert.equal(process.exitCode, 1);
});

test('reclaim fixture applies and clears a complete palette through production theme initialization', () => {
  const source = readFileSync(resolve('qa/opencode-reclaim-visual.mjs'), 'utf8');
  const template = source.match(/const entry = (`[\s\S]*?`);/u)?.[1];
  assert.ok(template);
  const entry = runInNewContext(template);
  const compiled = ts.transpileModule(entry, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } });
  const calls = [], dataset = {}, window = {};
  runInNewContext(compiled.outputText, {
    exports: {}, window, document: { documentElement: { dataset }, getElementById() {} },
    require: name => {
      if (name === 'react') return { default: { createElement() {} } };
      if (name === 'react-dom/client') return { createRoot: () => ({ render() {} }) };
      if (name === './renderer/src/themes') return { applyThemeTokens: (...args) => calls.push(args) };
      return {};
    },
  });
  window.setCell({ width: 398, theme: 'custom', lost: false, issue: false });
  const [tokens, base] = calls.at(-1);
  assert.equal(base, 'dark');
  assert.deepEqual(Object.keys(tokens).sort(), ['accent', 'background', 'border', 'muted', 'surface', 'text']);
  assert.ok(Object.values(tokens).every(value => /^#[0-9a-f]{6}$/i.test(value)));
  assert.equal(dataset.customTheme, 'true');
  window.setCell({ width: 398, theme: 'light', lost: false, issue: false });
  assert.deepEqual(calls.at(-1), [undefined, 'light']);
  assert.equal(dataset.customTheme, 'false');
});

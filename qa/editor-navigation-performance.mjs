// Controlled renderer-only comparison for AC3.  It is deliberately opt-in:
// THREADTERM_RUN_ELECTRON_PERF=1 node qa/editor-navigation-performance.mjs
//
// The two builds share the working tree's desktop entry points, Vite, node_modules,
// fixture, and runtime.  The baseline replaces just CodeEditor.tsx with HEAD's
// version at Vite resolution time; its local imports are rewritten to the current
// tree so dependency drift is not accidentally measured as an editor regression.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildQaApp } from './lib/qa-app.mjs';
import { electron } from './lib/desktop1.mjs';
import { acquireElectronQaLock } from './lib/electron-lock.mjs';

if (process.env.THREADTERM_RUN_ELECTRON_PERF !== '1') {
  console.log('Not run. Set THREADTERM_RUN_ELECTRON_PERF=1 after reserving the Electron slot.');
  process.exit(0);
}

const root = resolve(import.meta.dirname, '..');
const codeEditor = join(root, 'renderer/src/components/CodeEditor.tsx');
const runtime = resolve(process.env.THREADTERM_V3_RUNTIME_BIN ?? join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const baselineSource = execFileSync('git', ['show', `${revision}:renderer/src/components/CodeEditor.tsx`], { cwd: root, encoding: 'utf8' });
const currentSource = await readFile(codeEditor, 'utf8');
const scratch = await mkdtemp(join(tmpdir(), 'tt-editor-navigation-perf-'));
const fixtureRoot = join(scratch, 'renderer'), project = join(scratch, 'project');
let data, pipe;
const out = join(root, 'qa/results', `editor-navigation-performance-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const rounds = Number(process.env.THREADTERM_EDITOR_PERF_ROUNDS ?? 7);
const report = {
  passed: false,
  scope: 'Electron renderer FileWorkspace CodeEditor mount and fixed-payload typing; excludes build, app boot, runtime RPC, and language-service work.',
  baseline: { revision, codeEditorSha256: digest(baselineSource) },
  current: { codeEditorSha256: digest(currentSource) },
  rounds,
  variants: {},
  limitations: [
    'This is a controlled source comparison, not an installed-package or full application startup benchmark.',
    'The baseline intentionally shares current non-CodeEditor renderer dependencies; it isolates the CodeEditor source delta.',
    'Electron timing varies with host scheduling. Compare medians from the same run, not a single sample or runs on different machines.',
  ],
  errors: [],
};
let daemon, app, releaseLock, qaApp, baselineIntercepts = 0;

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function median(values) { const sorted = [...values].sort((left, right) => left - right); return sorted[Math.floor(sorted.length / 2)]; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function until(probe, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await probe()) return; await sleep(100); }
  throw Error(`${label} timed out`);
}
function environment() {
  return {
    ...process.env,
    TEMP: scratch, TMP: scratch,
    THREADTERM_V3_DATA: data,
    THREADTERM_V3_USER_DATA: join(scratch, 'profile'),
    THREADTERM_V3_PIPE: pipe,
    THREADTERM_V3_RUNTIME: runtime,
    THREADTERM_V3_RUNTIME_BIN: runtime,
  };
}
function absoluteImport(specifier) {
  return resolve(dirname(codeEditor), specifier).split('\\').join('/');
}
function currentDependencyImports(source) {
  // Only relative imports are re-targeted. Package imports remain the same shared node_modules.
  return source.replace(/(from\s*|import\s*)(["'])((?:\.\.\/|\.\/)[^"']+)\2/g, (_all, prefix, quote, specifier) => `${prefix}${quote}${absoluteImport(specifier)}${quote}`);
}
function baselinePlugin() {
  const id = join(fixtureRoot, 'head-code-editor.tsx');
  return {
    name: 'threadterm-head-code-editor-only',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer && resolve(importer) === join(root, 'renderer/src/components/FileWorkspace.tsx') && source === './CodeEditor') { baselineIntercepts += 1; return id; }
      return null;
    },
    load(source) { return source === id ? currentDependencyImports(baselineSource) : null; },
  };
}
async function writeFixture() {
  await mkdir(fixtureRoot, { recursive: true });
  // The fixture is its own Vite root, so its bare React imports need the same
  // dependency lookup as the repository renderer without copying dependencies.
  await symlink(join(root, 'node_modules'), join(fixtureRoot, 'node_modules'), 'junction');
  await writeFile(join(fixtureRoot, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/src.tsx"></script>');
  await writeFile(join(fixtureRoot, 'src.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { FileWorkspace } from ${JSON.stringify(join(root, 'renderer/src/components/FileWorkspace.tsx'))};
    import { I18nProvider } from ${JSON.stringify(join(root, 'renderer/src/i18n.tsx'))};
    import ${JSON.stringify(join(root, 'renderer/src/styles.css'))};
    const host = createRoot(document.getElementById('root'));
    let nonce = 0;
    window.__editorPerformance = {
      mount(projectId) {
        const started = performance.now();
        host.render(<I18nProvider locale="en"><FileWorkspace key={++nonce} projectId={projectId} worktreePath=${JSON.stringify(project)} rootPath=${JSON.stringify(project)} initialPath="sample.ts" initialView="file" editorId="editor-performance" /></I18nProvider>);
        return new Promise(resolve => { const poll = () => document.querySelector('.cm-content[contenteditable=true]:not([aria-readonly=true])') ? resolve(performance.now() - started) : requestAnimationFrame(poll); requestAnimationFrame(poll); });
      },
      clear() { host.render(null); },
    };
  `);
}
async function startRuntime() {
  daemon = spawn(runtime, [], { windowsHide: true, stdio: 'ignore', env: environment() });
  await until(() => existsSync(join(data, 'runtime.credential')) || daemon.exitCode !== null, 'isolated runtime credential');
  if (daemon.exitCode !== null) throw Error(`runtime exited during fixture boot (${daemon.exitCode})`);
}
async function stopRuntime() {
  if (daemon?.exitCode === null) {
    const exited = new Promise(resolve => daemon.once('exit', resolve));
    daemon.kill();
    await exited;
  }
  daemon = undefined;
}
async function memorySample() {
  const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());
  const renderer = metrics.filter(metric => metric.type === 'Tab' || metric.type === 'Renderer');
  return {
    electronProcesses: metrics.length,
    rendererWorkingSetKB: renderer.reduce((total, metric) => total + (metric.memory?.workingSetSize ?? 0), 0),
    rendererPrivateKB: renderer.reduce((total, metric) => total + (metric.memory?.privateBytes ?? 0), 0),
  };
}
async function runVariant(name, viteOptions = {}) {
  // File reads are part of mounting FileWorkspace, so do not let one variant inherit
  // a project/document cache from the other.
  data = join(scratch, `data-${name}`);
  pipe = `\\\\.\\pipe\\tt-editor-navigation-perf-${name}-${randomUUID()}`;
  await startRuntime();
  qaApp = await buildQaApp({ root, outDir: join(scratch, `app-${name}`), viteOptions: { root: fixtureRoot, ...viteOptions } });
  if (name === 'baseline') { report.baseline.interceptedImports = baselineIntercepts; assert.ok(baselineIntercepts > 0, 'baseline build must actually replace CodeEditor'); }
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', qaApp.appDir], cwd: root, env: environment(), timeout: 60_000 });
  const page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => typeof window.threadterm?.request === 'function' && typeof window.__editorPerformance?.mount === 'function');
  const added = await page.evaluate(path => window.threadterm.request('project.add', { path, name: 'Editor performance fixture', operationId: crypto.randomUUID() }), project);
  const mounts = [], typing = [];
  const payload = `// editor-perf-${'x'.repeat(480)}`;
  for (let round = 0; round < rounds; round += 1) {
    await page.evaluate(() => window.__editorPerformance.clear());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    mounts.push(await page.evaluate(projectId => window.__editorPerformance.mount(projectId), added.id));
    const editor = page.locator('.cm-content[contenteditable=true]:not([aria-readonly=true])');
    await editor.click();
    await page.keyboard.press('Control+A');
    const started = performance.now();
    await page.keyboard.insertText(payload);
    try {
      await page.waitForFunction(expected => document.querySelector('.cm-content')?.textContent?.endsWith(expected), payload);
    } catch (error) {
      report.failure = { variant: name, round, pageErrors, dom: await page.evaluate(() => ({
        activeElement: document.activeElement?.outerHTML?.slice(0, 3000),
        contents: [...document.querySelectorAll('.cm-content')].map(element => ({ text: element.textContent, editable: element.getAttribute('contenteditable') })),
        page: document.body.innerText.slice(-4000),
      })) };
      await page.screenshot({ path: join(out, `${name}-failure.png`) });
      throw error;
    }
    typing.push(performance.now() - started);
  }
  const result = { mountMs: mounts, typingMs: typing, mountMedianMs: median(mounts), typingMedianMs: median(typing), memory: await memorySample() };
  assert.deepEqual(pageErrors, [], `${name} fixture reported renderer errors`);
  await app.close(); app = undefined;
  await qaApp.cleanup(); qaApp = undefined;
  await stopRuntime();
  return result;
}

try {
  if (!existsSync(runtime)) throw Error(`Missing runtime binary: ${runtime}. Build/copy it before reserving this benchmark.`);
  if (!Number.isInteger(rounds) || rounds < 3 || rounds > 25) throw Error(`THREADTERM_EDITOR_PERF_ROUNDS must be an integer in 3..25, got ${rounds}`);
  await mkdir(out, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'sample.ts'), `export const fixtureValue = ${JSON.stringify('stable editor payload '.repeat(400))};\n`);
  await writeFixture();
  releaseLock = await acquireElectronQaLock();
  report.variants.baseline = await runVariant('baseline', { plugins: [baselinePlugin()] });
  report.variants.current = await runVariant('current');
  report.delta = {
    mountMedianMs: report.variants.current.mountMedianMs - report.variants.baseline.mountMedianMs,
    typingMedianMs: report.variants.current.typingMedianMs - report.variants.baseline.typingMedianMs,
    rendererWorkingSetKB: report.variants.current.memory.rendererWorkingSetKB - report.variants.baseline.memory.rendererWorkingSetKB,
    rendererPrivateKB: report.variants.current.memory.rendererPrivateKB - report.variants.baseline.memory.rendererPrivateKB,
  };
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => report.errors.push(`Electron cleanup: ${error.message}`));
  await qaApp?.cleanup().catch(error => report.errors.push(`app cleanup: ${error.message}`));
  await releaseLock?.();
  await stopRuntime();
  report.finishedAt = new Date().toISOString();
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true }).catch(error => report.errors.push(`scratch cleanup: ${error.message}`));
  console.log(JSON.stringify({ out, passed: report.passed, delta: report.delta, errors: report.errors }, null, 2));
  if (!report.passed || report.errors.length) process.exitCode = 1;
}

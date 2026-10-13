// Isolated Pi extension-UI multiline editor regression. It bundles the actual
// production ChatQuestionCard and stylesheet only; no runtime, provider, model,
// notifications, or user profile is ever opened.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import { electron } from './lib/desktop1.mjs';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'tt-pi-question-editor-'));
const fixture = join(scratch, 'fixture');
const renderer = join(scratch, 'renderer');
const profiles = join(scratch, 'profiles');
const isolatedHome = join(scratch, 'home');
const isolatedCodexHome = join(isolatedHome, '.codex');
const isolatedAppData = join(scratch, 'appdata');
const isolatedLocalAppData = join(scratch, 'localappdata');
const isolatedData = join(scratch, 'data');
const isolatedUserData = join(scratch, 'user-data');
const isolatedPipe = `\\\\.\\pipe\\tt-pi-question-editor-${randomUUID()}`;
const outFlag = process.argv.indexOf('--out');
const out = resolve(outFlag >= 0 ? process.argv[outFlag + 1] : join(root, 'qa', 'results', 'chat-parity', 'D3', 'pi-question-editor'));
const report = { passed: false, baseline: { status: 'not-run', note: 'The multiline implementation was already present before this isolated fixture was created.' }, checks: [], layouts: [], screenshots: [], errors: [] };
let server, app, page, electronProcess;
const check = label => { report.checks.push(label); console.log(`PASS ${label}`); };

function fixtureSource() {
  const questionCard = join(root, 'renderer/src/components/ChatQuestionCard.tsx').replaceAll('\\', '/');
  const i18n = join(root, 'renderer/src/i18n.tsx').replaceAll('\\', '/');
  const styles = join(root, 'renderer/src/styles.css').replaceAll('\\', '/');
  return `import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatQuestionCard } from '${questionCard}';
import { I18nProvider } from '${i18n}';
import '${styles}';
const editor = multiline => ({ kind: 'form', message: 'Provide the exact editor content.', fields: [
  { id: 'value', title: 'Editor', type: 'string', required: false, default: 'line1\\nline2', multiline },
  { id: 'ordinary', title: 'Ordinary', type: 'string', required: false, default: 'plain' },
  { id: 'secret', title: 'Secret', type: 'string', required: false, secret: true, default: 'hidden' }
] });
const responses = [];
function App() {
  const [locale, setLocale] = React.useState('en');
  const [submitting, setSubmitting] = React.useState(false);
  const [writable, setWritable] = React.useState(true);
  const [multiline, setMultiline] = React.useState(true);
  const [generation, setGeneration] = React.useState(0);
  window.__piEditorQA = {
    responses: () => structuredClone(responses),
    reset: () => { responses.length = 0; setSubmitting(false); setWritable(true); setGeneration(value => value + 1); },
    setLocale, setSubmitting, setWritable, setMultiline
  };
  const copy = (en, zh) => locale === 'zh-CN' ? zh : en;
  return <I18nProvider locale={locale}><main className="chat-view v3-session-chat"><div className="chat-scroll v3-chat-log"><div className="v3-chat-message is-native assistant"><ChatQuestionCard key={generation} form={editor(multiline)} answerable={true} resolved={false} writable={writable} submitting={submitting} copy={copy} onAnswer={answer => responses.push(answer)} /></div></div></main></I18nProvider>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
}

async function inspectLayout(width, locale, theme) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.evaluate(([nextLocale, nextTheme]) => { window.__piEditorQA.reset(); window.__piEditorQA.setLocale(nextLocale); document.documentElement.dataset.theme = nextTheme; }, [locale, theme]);
  await page.waitForFunction(() => document.querySelector('textarea')?.disabled === false);
  const card = page.locator('.chat-question-card');
  await card.waitFor();
  const geometry = await card.evaluate(node => {
    const own = node.getBoundingClientRect();
    const editor = node.querySelector('textarea');
    const submit = [...node.querySelectorAll('button')].find(button => /Submit|提交/.test(button.textContent ?? ''));
    const bounds = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }; };
    return { card: bounds(node), editor: bounds(editor), submit: bounds(submit), viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth };
  });
  assert.equal(geometry.viewport.width, width, `${locale}/${theme}/${width} uses the requested viewport`);
  assert.ok(geometry.card.left >= 0 && geometry.card.right <= width + 1, `${locale}/${theme}/${width} card is not horizontally clipped`);
  assert.ok(geometry.editor.left >= geometry.card.left && geometry.editor.right <= geometry.card.right + 1, `${locale}/${theme}/${width} editor is contained by its card`);
  assert.ok(geometry.submit.bottom <= geometry.viewport.height + 1, `${locale}/${theme}/${width} submit control is visible`);
  assert.ok(geometry.scrollWidth <= width + 1, `${locale}/${theme}/${width} has no horizontal page overflow`);
  assertNoControlViolations(await checkControlConsistency(page, '.chat-question-card'), `${locale}/${theme}/${width} Pi question card`);
  report.layouts.push({ width, locale, theme, ...geometry });
}

try {
  await Promise.all([fixture, renderer, profiles, isolatedHome, isolatedCodexHome, isolatedAppData, isolatedLocalAppData, isolatedData, isolatedUserData, out].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(fixture, 'entry.tsx'), fixtureSource());
  await viteBuild({ root: fixture, configFile: false, plugins: [react()], resolve: { alias: [
    { find: /^react$/, replacement: join(root, 'node_modules/react/index.js') },
    { find: /^react-dom\/client$/, replacement: join(root, 'node_modules/react-dom/client.js') },
    { find: /^react\/jsx-runtime$/, replacement: join(root, 'node_modules/react/jsx-runtime.js') },
    { find: '@threadterm/protocol', replacement: join(root, 'protocol/index.ts') },
  ] }, build: { outDir: renderer, emptyOutDir: true, rollupOptions: { input: join(fixture, 'index.html') } } });

  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const curatedPath = [dirname(process.execPath), join(systemRoot, 'System32')].join(';');
  Object.assign(childEnv, { Path: curatedPath, HOME: isolatedHome, USERPROFILE: isolatedHome, HOMEDRIVE: isolatedHome.slice(0, 2), HOMEPATH: isolatedHome.slice(2), CODEX_HOME: isolatedCodexHome, APPDATA: isolatedAppData, LOCALAPPDATA: isolatedLocalAppData, THREADTERM_V3_DATA: isolatedData, THREADTERM_V3_USER_DATA: isolatedUserData, THREADTERM_V3_PIPE: isolatedPipe, TT_QA_DESKTOP: '1', TT_PARITY_PROFILE: profiles });
  assert.equal(childEnv.Path, curatedPath, 'Electron receives only the curated executable path');
  for (const value of [childEnv.HOME, childEnv.USERPROFILE, childEnv.CODEX_HOME, childEnv.APPDATA, childEnv.LOCALAPPDATA, childEnv.THREADTERM_V3_DATA, childEnv.THREADTERM_V3_USER_DATA, childEnv.TT_PARITY_PROFILE]) assert.ok(value.startsWith(scratch), 'all Electron profiles are private scratch paths');

  server = await startReadonlyReferenceServer(renderer);
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(root, 'qa/parity/electron-static.cjs')], env: childEnv, timeout: 30000 });
  electronProcess = app.process();
  page = await app.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.errors.push(String(error)));
  await page.goto(`${server.origin}/`);
  await page.waitForFunction(() => Boolean(window.__piEditorQA));
  await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__lane2Clipboard=value;},readText:async()=>window.__lane2Clipboard??''}}));

  await page.evaluate(() => { window.__piEditorQA.setMultiline(false); window.__piEditorQA.reset(); });
  const baselineEditor = page.getByLabel('Editor');
  assert.equal(await baselineEditor.evaluate(node => node.tagName), 'INPUT', 'baseline string field uses an input');
  assert.equal(await baselineEditor.inputValue(), 'line1line2', 'baseline input strips newline characters from the default');
  report.baseline = { status: 'captured', control: 'INPUT:text', defaultValue: await baselineEditor.inputValue(), finding: 'A plain string input removes line breaks from the multiline default.' };

  await page.evaluate(() => { window.__piEditorQA.setMultiline(true); window.__piEditorQA.reset(); });
  const editor = page.getByLabel('Editor');
  assert.equal(await editor.evaluate(node => node.tagName), 'TEXTAREA', 'multiline string field mounts an actual textarea');
  assert.equal(await editor.inputValue(), 'line1\nline2', 'textarea preserves the multiline default verbatim');
  assert.equal(await page.getByLabel('Ordinary').evaluate(node => `${node.tagName}:${node.getAttribute('type')}`), 'INPUT:text', 'ordinary string field remains a text input');
  assert.equal(await page.getByLabel('Secret').evaluate(node => `${node.tagName}:${node.getAttribute('type')}`), 'INPUT:password', 'secret string field remains a password input');
  await editor.fill('first line\nsecond line\nthird line');
  await page.getByRole('button', { name: 'Submit' }).click();
  assert.deepEqual(await page.evaluate(() => window.__piEditorQA.responses()), [{ action: 'submit', values: { value: 'first line\nsecond line\nthird line', ordinary: 'plain', secret: 'hidden' } }], 'submit preserves the exact multiline value');
  check('actual textarea preserves default and edited newlines; ordinary and secret fields retain input controls');

  await page.evaluate(() => window.__piEditorQA.reset());
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'line1\nline2');
  assert.equal(await editor.inputValue(), 'line1\nline2', 'reset fixture mounts the original multiline default');
  await page.getByRole('button', { name: 'Dismiss' }).click();
  assert.deepEqual(await page.evaluate(() => window.__piEditorQA.responses()), [{ action: 'dismiss' }], 'Dismiss does not submit or change the editor value');
  assert.equal(await editor.inputValue(), 'line1\nline2', 'Dismiss retains the original multiline draft');
  check('Dismiss leaves the multiline draft unchanged');

  await page.evaluate(() => window.__piEditorQA.setSubmitting(true));
  await page.waitForFunction(() => document.querySelector('textarea')?.disabled === true);
  assert.equal(await editor.isDisabled(), true, 'submitting disables the textarea');
  assert.equal(await page.getByRole('button', { name: /Submitting|提交中/ }).isDisabled(), true, 'submitting disables Submit');
  await page.evaluate(() => { window.__piEditorQA.setSubmitting(false); window.__piEditorQA.setWritable(false); });
  await page.waitForFunction(() => document.querySelector('textarea')?.disabled === true);
  assert.equal(await editor.isDisabled(), true, 'readonly state disables the textarea');
  assert.equal(await page.getByRole('button', { name: /Submit|提交/ }).isDisabled(), true, 'readonly state disables Submit');
  check('submitting and readonly states disable the editor and actions');

  for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) for (const width of [1280, 390]) {
    await inspectLayout(width, locale, theme);
    if ((width === 1280 && locale === 'en' && theme === 'light') || (width === 390 && locale === 'zh-CN' && theme === 'dark')) {
      const name = `pi-editor-${width}-${locale}-${theme}.png`;
      await page.screenshot({ path: join(out, name), animations: 'disabled' });
      report.screenshots.push(name);
    }
  }
  check('eight English/Chinese light/dark wide/narrow layouts keep the editor and actions unclipped');
  assert.deepEqual(report.errors, [], `fixture page errors:\n${report.errors.join('\n')}`);
  report.passed = true;
  await rm(join(out, 'failure.png'), { force: true });
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png'), animations: 'disabled' }).catch(() => {});
  process.exitCode = 1;
} finally {
  let childExited = true;
  if (app) {
    await app.close().catch(error => report.errors.push(`Electron close failed: ${String(error)}`));
    if (electronProcess?.exitCode == null) await Promise.race([new Promise(resolve => electronProcess.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    childExited = electronProcess?.exitCode != null;
    if (!childExited) report.errors.push('Electron child did not exit after app.close(); retained scratch directory for inspection.');
  }
  app = undefined;
  await server?.close().catch(error => report.errors.push(`Reference server close failed: ${String(error)}`));
  report.passed = report.passed && report.errors.length === 0;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const resolvedScratch = resolve(scratch), resolvedTemp = resolve(tmpdir());
  if (childExited && dirname(resolvedScratch).toLowerCase() === resolvedTemp.toLowerCase() && basename(resolvedScratch).startsWith('tt-pi-question-editor-')) await rm(resolvedScratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));

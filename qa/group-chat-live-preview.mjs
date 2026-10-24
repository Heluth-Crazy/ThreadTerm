// Recheck a recorded real output without another model turn or any real CLI on PATH.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';

const run = process.argv[2];
assert.match(run || '', /^independent-tt-group-live-[a-z0-9]+$/);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'qa/results/group-chat-live', run);
const recorded = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
assert.equal(recorded.passed, true, 'Use a completed independent workflow');
const temp = resolve(process.env.TEMP || process.env.TMP || tmpdir());
const scratch = resolve(recorded.scratch);
assert.ok(relative(temp, scratch) && !relative(temp, scratch).startsWith('..'), 'Recorded scratch is under TEMP');
const lock = join(temp, 'qa-electron.lock');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const delay = ms => new Promise(done => setTimeout(done, ms));
let app, page, held = false;
const evidence = { passed: false, realModelTurns: 0, sourceRun: run, errors: [] };
const request = (method, params = {}) => page.evaluate(([method, params]) => window.threadterm.request(method, params), [method, params]);
try {
  const deadline = Date.now() + 2400000;
  for (;;) { try { await mkdir(lock); held = true; break; } catch (error) { if (error.code !== 'EEXIST') throw error; if (Date.now() > deadline) throw Error('Electron QA lock timeout'); await delay(15000); } }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path' && !/^(THREADTERM_|CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|ELECTRON_RUN_AS_NODE)/i.test(key)));
  env.PATH = [dirname(process.execPath), ...(process.env.SystemRoot ? [join(process.env.SystemRoot, 'System32')] : [])].join(delimiter);
  Object.assign(env, { TEMP: temp, TMP: temp, THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-group-preview-${randomUUID()}`, THREADTERM_V3_PLUGIN_DIRS: join(scratch, 'no-plugins') });
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', join(scratch, 'app')], cwd: join(scratch, 'work'), env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(20000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
  let file = page.locator('.file-workspace:visible').last();
  if (!await file.count()) {
    const host = recorded.group.members[0].sessionId;
    await request('session.present', { sessionId: host, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
    await page.getByTestId(`session-chat-${host}`).waitFor({ state: 'visible' });
    await page.locator(`.group-row[data-group-id="${recorded.groupId}"]`).click();
    const group = page.locator(`[data-testid=group-view][data-group-id="${recorded.groupId}"]:visible`);
    await group.waitFor();
    const reply = [...recorded.group.messages].reverse().find(message => message.author === 'member' && message.handle === 'codex');
    await group.locator(`[data-message-id="${reply.id}"] [data-output-path]`).first().click();
    file = page.locator('.file-workspace:visible').last();
  }
  await file.waitFor();
  const reload = file.getByRole('button', { name: 'Reload from disk', exact: true });
  if (await reload.count()) {
    await reload.click();
    const discard = page.getByRole('button', { name: 'Discard changes', exact: true });
    if (await discard.isVisible()) await discard.click();
    evidence.reloadedAfterAgentRevision = true;
  }
  if (!await page.locator('.file-preview:visible').count()) await file.getByRole('button', { name: 'Preview', exact: true }).click();
  const frame = file.frameLocator('iframe');
  await frame.getByRole('heading', { level: 1 }).waitFor({ state: 'visible', timeout: 30000 });
  evidence.heading = await frame.getByRole('heading', { level: 1 }).innerText();
  evidence.body = (await frame.locator('body').innerText()).slice(0, 700);
  evidence.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  assert.match(evidence.body, /Lantern Notes|private|offline/i);
  await page.screenshot({ path: join(out, 'run1-output-preview-painted-1280.png'), animations: 'disabled' });
  evidence.passed = true;
  console.log('PASS real HTML output paints its heading and content in the app preview without another model turn');
} catch (error) {
  evidence.errors.push(String(error.stack || error));
  await page?.screenshot({ path: join(out, 'preview-recheck-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (page) await Promise.race([request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {}), delay(5000)]);
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await Promise.race([app.close().catch(() => {}), delay(3000)]); try { app.process()?.kill(); } catch {} }
  if (held) await rm(lock, { recursive: true, force: true });
  await writeFile(join(out, 'preview-recheck.json'), JSON.stringify(evidence, null, 2));
}

// Repaint a completed live review with the current renderer; no provider CLI or model turn.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';

const run = process.argv[2];
assert.match(run || '', /^sequence-tt-group-live-[a-z0-9]+$/);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'qa/results/group-chat-gc4', run);
const recorded = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
assert.equal(recorded.passed, true);
const temp = resolve(process.env.TEMP || process.env.TMP || tmpdir());
const scratch = resolve(recorded.scratch), inside = relative(temp, scratch);
assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
const lock = join(temp, 'qa-electron.lock'), appDir = join(scratch, 'app');
const delay = ms => new Promise(done => setTimeout(done, ms));
const evidence = { passed: false, realModelTurns: 0, errors: [] };
let app, page, held = false;
const request = (method, params = {}) => page.evaluate(([method, params]) => window.threadterm.request(method, params), [method, params]);
try {
  const deadline = Date.now() + 2400000;
  for (;;) { try { await mkdir(lock); held = true; break; } catch (error) { if (error.code !== 'EEXIST' || Date.now() > deadline) throw error; await delay(15000); } }
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path' && !/^(THREADTERM_|CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|ELECTRON_RUN_AS_NODE)/i.test(key)));
  env.PATH = [dirname(process.execPath), ...(process.env.SystemRoot ? [join(process.env.SystemRoot, 'System32')] : [])].join(delimiter);
  Object.assign(env, { TEMP: temp, TMP: temp, THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_RUNTIME: join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-group-gc4-capture-${randomUUID()}`, THREADTERM_V3_PLUGIN_DIRS: join(scratch, 'no-plugins') });
  app = await electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', appDir], cwd: join(scratch, 'work'), env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(20000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 60000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
  const host = recorded.group.members[0].sessionId;
  await request('session.present', { sessionId: host, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await page.getByTestId(`session-chat-${host}`).waitFor({ state: 'visible' });
  const row = page.locator(`.group-row[data-group-id="${recorded.groupId}"]`);
  await row.click();
  const group = page.locator(`[data-testid=group-view][data-group-id="${recorded.groupId}"]:visible`);
  await group.waitFor();
  const reply = [...recorded.group.messages].reverse().find(message => message.author === 'member' && message.handle === 'grok');
  const card = group.locator(`[data-message-id="${reply.id}"]`);
  await card.scrollIntoViewIfNeeded();
  await row.filter({ hasText: 'Idle' }).waitFor();
  evidence.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  evidence.group = await request('group.read', { id: recorded.groupId });
  assert.ok(evidence.group.members.every(member => member.state !== 'needs_user'));
  evidence.body = await card.locator('.gc-reply-body').innerText();
  assert.ok(evidence.body.startsWith(reply.body.split('\n')[0]));
  await page.screenshot({ path: join(out, 'run2-final-current-renderer-1280.png'), animations: 'disabled' });
  evidence.passed = true;
  console.log('PASS final Grok review repaints with compact references and idle completed Group; zero model turns');
} catch (error) {
  evidence.errors.push(String(error.stack || error)); process.exitCode = 1;
  await page?.screenshot({ path: join(out, 'gc4-capture-failure.png') }).catch(() => {});
} finally {
  if (page) await Promise.race([request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {}), delay(5000)]);
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await Promise.race([app.close().catch(() => {}), delay(3000)]); try { app.process()?.kill(); } catch {} }
  if (held) await rm(lock, { recursive: true, force: true });
  await writeFile(join(out, 'current-renderer-recheck.json'), JSON.stringify(evidence, null, 2));
}

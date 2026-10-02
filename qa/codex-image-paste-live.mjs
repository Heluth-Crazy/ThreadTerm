// Real Electron + real Codex image-paste QA. Run only after the QA runtime and renderer are rebuilt.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const wait = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const qaDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(qaDir, '..');
const runtime = process.env.THREADTERM_V3_RUNTIME_BIN ?? resolve(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
if (!/runtime[\\/]target-qa[\\/]debug[\\/]threadterm-v3-runtime\.exe$/iu.test(runtime.replace(/\\/gu, '/'))) {
  throw new Error(`Refusing non-QA runtime: ${runtime}`);
}

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-codex-image-paste-'));
const workspace = join(scratch, 'workspace');
const data = join(scratch, 'data');
const profile = join(scratch, 'profile');
const codexHome = join(scratch, 'codex-home');
const pipe = `\\\\.\\pipe\\threadterm-codex-image-paste-${randomUUID()}`;
const report = { passed: false, runtime, scratch, checks: [], observations: {} };
let app;
let page;
let savedClipboard;

const redact = (value, key = '') => {
  if (/(?:email|account|token|secret|auth)/iu.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
};

async function request(method, params = {}) {
  return page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
}
async function updateSettings(patch) {
  const snapshot = await request('runtime.snapshot');
  await request('settings.update', { patch, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
}
async function waitFor(check, description, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(150);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function waitComposer(sessionId) {
  const textarea = page.locator('.chat-compose-shell textarea');
  await textarea.waitFor({ state: 'visible', timeout: 90_000 });
  await waitFor(async () => {
    const ui = await request('chat.options', { sessionId });
    return ui.inputCapabilities?.images === true && !(await textarea.isDisabled());
  }, 'an image-capable writable Codex composer', 90_000);
  return textarea;
}
async function waitImagePreview(count = 1) {
  const draft = page.locator('.chat-image-draft');
  await draft.waitFor({ state: 'visible' });
  await waitFor(async () => (await draft.locator('img').count()) === count, `${count} image preview${count === 1 ? '' : 's'}`);
  return draft;
}
async function pasteNativeClipboard(textarea) {
  await textarea.focus();
  await page.keyboard.press('Control+v');
  await waitImagePreview();
}
async function waitTurn(sessionId, previousUserIds, predicate, description, timeout = 120_000) {
  return waitFor(async () => {
    const items = await request('chat.read', { sessionId });
    const user = [...items].reverse().find(item => item.role === 'user' && !previousUserIds.has(item.id));
    if (!user?.turnId || !predicate(user)) return undefined;
    const assistant = items.find(item => item.role === 'assistant' && item.turnId === user.turnId && item.parts.some(part => typeof part.text === 'string' && part.text.trim()));
    const snapshot = await request('runtime.snapshot');
    const idle = snapshot.sessions.find(candidate => candidate.id === sessionId)?.status === 'idle';
    return assistant && idle ? { user, assistant, items } : undefined;
  }, description, timeout);
}
async function priorUserIds(sessionId) {
  return new Set((await request('chat.read', { sessionId })).filter(item => item.role === 'user').map(item => item.id));
}
async function putImageOnClipboard(dataURL) {
  await app.evaluate(async ({ clipboard, nativeImage, ClipboardItem }, url) => {
    const image = nativeImage.createFromDataURL(url);
    if (image.isEmpty()) throw new Error('Generated QA image decoded as empty nativeImage');
    const png = new Uint8Array(image.toPNG());
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  }, dataURL);
}
async function restoreClipboard() {
  if (!savedClipboard || !app) return;
  await app.evaluate(async ({ clipboard, ClipboardItem }, saved) => {
    const restored = saved.map(item => new ClipboardItem(Object.fromEntries(item.entries.map(entry => {
      if (entry.kind === 'bookmark') return [entry.type, entry.value];
      return [entry.type, new Blob([new Uint8Array(entry.bytes)], { type: entry.mime || entry.type })];
    }))));
    await clipboard.write(restored);
  }, savedClipboard);
}

try {
  await Promise.all([mkdir(workspace), mkdir(data), mkdir(profile), mkdir(codexHome)]);
  await copyFile(join(process.env.USERPROFILE ?? '', '.codex', 'auth.json'), join(codexHome, 'auth.json'));
  const banned = new Set(['codex_home', 'threadterm_v3_data', 'threadterm_v3_user_data', 'threadterm_v3_pipe', 'threadterm_v3_runtime']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !banned.has(key.toLowerCase())));
  Object.assign(env, { CODEX_HOME: codexHome, THREADTERM_V3_DATA: data, THREADTERM_V3_USER_DATA: profile, THREADTERM_V3_PIPE: pipe, THREADTERM_V3_RUNTIME: runtime });

  app = await electron.launch({ args: [root], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('.app-shell').waitFor();
  savedClipboard = await app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read();
    const saved = [];
    for (const item of items) {
      const entries = [];
      for (const type of item.types) {
        const value = await item.getType(type);
        if (type === 'electron application/bookmark') entries.push({ type, kind: 'bookmark', value });
        else {
          const blob = value;
          entries.push({ type, kind: 'blob', mime: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) });
        }
      }
      saved.push({ entries });
    }
    return saved;
  });
  const dataURL = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 300; canvas.height = 160;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.fillStyle = '#e53935'; context.fillRect(0, 0, 150, 160);
    context.fillStyle = '#1e88e5'; context.fillRect(150, 0, 150, 160);
    return canvas.toDataURL('image/png');
  });
  await putImageOnClipboard(dataURL);
  report.observations.imagePrefix = dataURL.slice(0, 32);

  await updateSettings({ language: 'en', theme: 'light' });
  await request('project.add', { path: workspace, name: 'Codex image paste live QA', operationId: randomUUID() });
  const session = await request('session.create', { cwd: workspace, provider: 'codex', mode: 'chat', title: 'Codex image paste live QA', operationId: randomUUID() });
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const textarea = await waitComposer(session.id);
  report.checks.push('real Codex Chat composer advertised native image input capability');

  await pasteNativeClipboard(textarea);
  let draft = await waitImagePreview();
  const pastedDataURL = await expectPreview(draft);
  report.observations.pastedImagePrefix = pastedDataURL.slice(0, 32);
  await draft.getByRole('button', { name: 'Remove image 1', exact: true }).click();
  await draft.waitFor({ state: 'hidden' });
  await pasteNativeClipboard(textarea);
  draft = await waitImagePreview();
  assert.equal(await expectPreview(draft), pastedDataURL, 're-paste did not preserve the clipboard image data URL');
  report.checks.push('actual Control+V clipboard paste displayed a removable image thumbnail');

  await page.reload();
  await page.waitForFunction(() => Boolean(window.threadterm));
  // Session presentation is a device-local renderer route, so restore the same live
  // session after reload before checking the independently persisted attachment draft.
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  const reloadedTextarea = await waitComposer(session.id);
  draft = await waitImagePreview();
  assert.equal(await expectPreview(draft), pastedDataURL, 'reloaded device-local draft differs from the pasted image');
  report.checks.push('unsubmitted image attachment survived renderer reload as a device-local draft');

  for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) for (const width of [1280, 1440, 1920]) {
    await updateSettings({ language: locale, theme });
    await page.waitForFunction(expected => document.documentElement.lang === expected, locale);
    await page.setViewportSize({ width, height: 960 });
    await waitImagePreview();
    const label = locale === 'en' ? 'Image attachments' : '图片附件';
    await page.getByLabel(label).waitFor();
    await page.screenshot({ path: join(scratch, `draft-${locale}-${theme}-${width}.png`), fullPage: true });
  }
  report.checks.push('captured visible image thumbnails in English and Chinese light/dark at 1280, 1440, and 1920px');

  await updateSettings({ language: 'en', theme: 'light' });
  const send = page.locator('.chat-compose-send');
  await waitFor(async () => !(await send.isDisabled()), 'enabled image-only Send button');
  const firstPrior = await priorUserIds(session.id);
  await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
  const first = await waitTurn(session.id, firstPrior, user => user.parts.some(part => Array.isArray(part.data?.images) && part.data.images.includes(pastedDataURL)), 'image-only real Codex turn');
  assert.ok(first.assistant.parts.some(part => typeof part.text === 'string' && part.text.trim()), 'image-only turn did not receive a real assistant reply');
  const persistedImages = first.user.parts.flatMap(part => Array.isArray(part.data?.images) ? part.data.images : []);
  assert.deepEqual(persistedImages, [pastedDataURL], 'persisted user image differs from the actual pasted data URL');
  await page.locator('.chat-message-images img').last().waitFor({ state: 'visible' });
  assert.equal(await expectPreview(page.locator('.chat-message-images').last()), pastedDataURL, 'transcript thumbnail differs from persisted pasted image');
  await waitFor(async () => (await page.locator('.chat-image-draft').count()) === 0, 'cleared image draft after successful send');
  report.checks.push('image-only send was enabled, persisted its native data URL, rendered in the transcript, and completed with real Codex');

  await waitComposer(session.id);
  await putImageOnClipboard(dataURL);
  await pasteNativeClipboard(reloadedTextarea);
  await reloadedTextarea.fill('What two colors are shown in this image? Answer with both color names.');
  const secondPrior = await priorUserIds(session.id);
  await page.locator('.chat-compose-shell').evaluate(form => form.requestSubmit());
  const second = await waitTurn(session.id, secondPrior, user => user.parts.some(part => part.text?.includes('What two colors')) && user.parts.some(part => Array.isArray(part.data?.images) && part.data.images.includes(pastedDataURL)), 'text plus image real Codex turn');
  const answer = second.assistant.parts.map(part => part.text ?? '').join(' ');
  assert.match(answer, /red/iu, `visual answer omitted red: ${answer}`);
  assert.match(answer, /blue/iu, `visual answer omitted blue: ${answer}`);
  report.checks.push('text plus image native Codex turn identified the deterministic red and blue clipboard image');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: join(scratch, 'failure.png'), fullPage: true }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  try {
    await restoreClipboard();
    report.checks.push('restored every saved system clipboard item atomically');
  } catch (error) {
    report.clipboardRestoreError = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  }
  try { if (page) await request('runtime.shutdown', { operationId: randomUUID() }); } catch {}
  if (app) {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  await writeFile(join(scratch, 'report.json'), `${JSON.stringify(redact(report), null, 2)}\n`);
  process.stdout.write(`Codex image paste QA ${report.passed ? 'passed' : 'failed'}; report: ${join(scratch, 'report.json')}\n`);
}

async function expectPreview(container) {
  const source = await container.locator('img').first().getAttribute('src');
  assert.match(source ?? '', /^data:image\/png;base64,/u, 'preview is not a PNG data URL from the system clipboard');
  const colors = await container.locator('img').first().evaluate(image => new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) return reject(new Error('Canvas 2D context is unavailable'));
    context.drawImage(image, 0, 0);
    const sample = (x, y) => [...context.getImageData(x, y, 1, 1).data];
    resolve({ width: image.naturalWidth, height: image.naturalHeight, left: sample(Math.floor(image.naturalWidth / 4), Math.floor(image.naturalHeight / 2)), right: sample(Math.floor(image.naturalWidth * 3 / 4), Math.floor(image.naturalHeight / 2)) });
  }));
  assert.deepEqual(colors, { width: 300, height: 160, left: [229, 57, 53, 255], right: [30, 136, 229, 255] }, 'preview pixels differ from the red/blue native clipboard image');
  return source;
}

// Round-5 production CompanionApp browser fixture: attention semantics plus
// left-edge interactive back behavior. This is Expo-web evidence only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const app = join(root, 'mobile', 'qa', 'app');
const out = join(app, '.qa-export');
const shots = join(root, '.trellis', 'tasks', '11-06-mobile-companion', 'qa-round5');
mkdirSync(shots, { recursive: true });
if (!process.env.TT_QA_SKIP_EXPORT) execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'npx', process.platform === 'win32' ? ['/d', '/s', '/c', 'npx expo export --platform web --output-dir .qa-export'] : ['expo', 'export', '--platform', 'web', '--output-dir', '.qa-export'], { cwd: app, stdio: 'inherit', windowsHide: true });

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://qa').pathname;
  const file = normalize(join(out, pathname === '/' ? 'index.html' : pathname.slice(1)));
  if (!file.startsWith(out) || !existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream');
  response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light', locale: 'en-US' });
const errors = [];
page.setDefaultTimeout(10_000);
page.on('pageerror', error => errors.push(String(error)));
const screenshot = async name => { if (!process.env.TT_QA_NO_SHOTS) await page.screenshot({ path: join(shots, name), fullPage: true }); };
const surface = () => page.getByTestId('edge-back-surface');
const cdp = await page.context().newCDPSession(page);

async function edgeSwipe({ from = 8, to = 180, y = 240, steps = 8, pause = 20 } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y, id: 1 }] });
  for (let index = 1; index <= steps; index += 1) {
    const x = from + ((to - from) * index) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
    if (pause) await page.waitForTimeout(pause);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(320);
}
async function verticalEdgeDrag() {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 8, y: 240, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 12, y: 390, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(320);
}
async function edgeCancelWithVisibleProgress() {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 8, y: 240, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 88, y: 240, id: 1 }] });
  await page.waitForTimeout(40);
  const transform = await surface().evaluate(node => getComputedStyle(node).transform);
  assert.notEqual(transform, 'none', 'the pushed surface follows the finger before release');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await page.waitForTimeout(320);
}
async function beginEdgePreview({ from = 8, to = 220, y = 240 } = {}) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y, id: 1 }] });
  // The first move grants PanResponder; a second move reaches its active
  // onPanResponderMove callback. The grant itself must still follow the
  // winning move immediately, so a held first move has visible feedback.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: (from + to) / 2, y, id: 1 }] });
  await page.waitForTimeout(40);
  assert.ok((await surface().boundingBox())?.x, 'the responder-grant move visibly displaces the surface');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: to, y, id: 1 }] });
  await page.waitForTimeout(50);
}
async function cancelEdgePreview() {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await page.waitForTimeout(320);
}

try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.getByText('Choose QA mode').first().waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'small phone has no horizontal overflow');
  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'landscape has no horizontal overflow');
  await page.setViewportSize({ width: 390, height: 844 });

  // A settled reply has an unread reply inbox row but cannot enter Needs You
  // or acquire the generic Approval label.
  assert.equal(await page.getByText('Completed reply').count(), 0, 'settled reply is absent from Needs You');
  assert.equal(await page.getByText('Approval', { exact: true }).count(), 0, 'a known question is never relabelled Approval');
  await screenshot('01-needs-question.png');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByText('Unread reply', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Completed reply, Control PC', exact: true }).click();
  await page.getByText('Finished reply from Codex.').waitFor();
  await page.getByText('Unread reply', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0, 'settled awaiting_input does not expose Stop');
  assert.equal(await page.getByText('Needs you', { exact: true }).count(), 0, 'settled awaiting_input has no Needs you chip');
  await screenshot('02-finished-reply.png');

  // A short release cancels in place, while a completed edge drag returns to
  // the chat list. The responder must be present only on pushed content.
  await surface().waitFor();
  await edgeCancelWithVisibleProgress();
  assert.equal(await page.getByText('Finished reply from Codex.').count(), 1, 'interrupted edge gesture restores the current screen');
  await edgeSwipe({ to: 28, steps: 2, pause: 100 });
  assert.equal(await page.getByText('Finished reply from Codex.').count(), 1, 'short edge gesture cancels');
  await edgeSwipe();
  await page.getByRole('button', { name: 'Completed reply, Control PC', exact: true }).waitFor();

  await page.getByRole('tab', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Control PC', exact: true }).click();
  await page.getByRole('button', { name: 'Project alpha', exact: true }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await page.getByText('fixture file from alpha').waitFor();
  const callsBeforePreview = await page.evaluate(() => globalThis.__TT_MOBILE_QA_CALLS__.length);
  await beginEdgePreview();
  const preview = page.getByTestId('edge-back-preview');
  await preview.waitFor();
  const previewTitle = preview.getByText('Files', { exact: true });
  await previewTitle.waitFor();
  assert.ok((await previewTitle.boundingBox())?.width, 'the predecessor title is laid out during the drag');
  assert.equal(await preview.evaluate(node => getComputedStyle(node).pointerEvents), 'none', 'predecessor preview cannot accept touches');
  assert.equal(await page.evaluate(() => globalThis.__TT_MOBILE_QA_CALLS__.length), callsBeforePreview, 'mounting the preview makes no NativePort call');
  const interactiveGeometry = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="edge-back-surface"]')?.getBoundingClientRect();
    const preview = document.querySelector('[data-testid="edge-back-preview"]')?.getBoundingClientRect();
    return { surface, preview };
  });
  assert.ok((interactiveGeometry.surface?.x ?? 0) > 100, 'the document surface is visibly displaced before capture');
  assert.ok((interactiveGeometry.preview?.width ?? 0) > 0, 'the predecessor preview is visible before capture');
  await page.waitForTimeout(180);
  await screenshot('04-interactive-back.png');
  await cancelEdgePreview();
  await preview.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => globalThis.__TT_MOBILE_QA_CALLS__.length), callsBeforePreview, 'cancelling the preview makes no NativePort call');
  await edgeSwipe();
  await page.getByText('Files', { exact: true }).waitFor();

  // A gesture beginning outside the edge stays with the file screen.
  await edgeSwipe({ from: 90, to: 260 });
  assert.equal(await page.getByText('Files', { exact: true }).count(), 1, 'non-edge horizontal drag does not pop');
  await verticalEdgeDrag();
  assert.equal(await page.getByText('Files', { exact: true }).count(), 1, 'vertical edge drag does not pop');
  await edgeSwipe();
  await page.getByText('Project alpha', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('button', { name: 'Working', exact: true }).click();
  await page.getByText('after', { exact: true }).waitFor();
  await edgeSwipe();
  await page.getByText('Changes', { exact: true }).waitFor();
  // Git tabs replace their history: one more edge Back leaves Git, not a prior tab.
  await edgeSwipe();
  await page.getByText('Project alpha', { exact: true }).waitFor();

  // The terminal remains horizontally pannable away from the edge, while the
  // session itself still has the normal pop gesture at the left boundary.
  await page.getByRole('button', { name: 'Build terminal', exact: true }).click();
  const terminalFrameElement = page.locator('iframe[title="Terminal"]');
  await terminalFrameElement.waitFor();
  const terminalFrame = await terminalFrameElement.contentFrame();
  const terminalPan = terminalFrame.locator('#pan');
  await terminalPan.waitFor();
  await terminalPan.evaluate(node => { node.scrollLeft = 0; });
  await terminalPan.hover();
  await page.mouse.wheel(120, 0);
  assert.ok(await terminalPan.evaluate(node => node.scrollLeft) > 0, 'terminal pans horizontally within its own viewport');
  const terminalBox = await terminalFrameElement.boundingBox();
  assert.ok(terminalBox, 'terminal iframe has a screen position');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: terminalBox.x + 100, y: terminalBox.y + 100, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: terminalBox.x + 230, y: terminalBox.y + 100, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(320);
  assert.equal(await terminalFrameElement.count(), 1, 'off-edge terminal drag does not pop its session');
  await edgeSwipe();
  await page.getByText('Project alpha', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Review alpha', exact: true }).click();
  await page.getByText('Which verification mode should run?').waitFor();
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('first edge gesture');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => globalThis.__TT_MOBILE_QA_CALLS__.some(call => call.method === 'chat.send'));
  await edgeSwipe({ to: 100, steps: 2, pause: 0 }); // fast fling completes below distance threshold.
  await page.getByText('Project alpha', { exact: true }).waitFor();
  await screenshot('03-git-and-chat-back.png');

  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add computer', exact: true }).click();
  assert.equal(await page.getByTestId('edge-back-strip').count(), 0, 'a settings sheet does not gain an edge-pop strip');

  assert.deepEqual(errors, [], `page errors:\n${errors.join('\n')}`);
  console.log('Round 5 Expo-web QA passed: settled reply semantics, short/cancel/non-edge/completed edge gestures, files, Git replace and chat Send.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

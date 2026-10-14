// Isolated-renderer visual QA for the inline mention highlight layer (M3).
//
// Mounts the production ChatView (real React 19, real CSS) in an isolated
// Electron renderer with the QA bridge fixture, then:
//   * screenshots the composer highlight matrix (420/700/1100 px × light/dark/
//     custom × en/zh-CN, plus zoom 100 %/125 % at 700 px);
//   * screenshots the special states (wrapped draft, line positions, trailing
//     newline, long quoted token, tabs, scrolled draft, growing/shrinking
//     scrollbar, narrow pane);
//   * runs an alignment oracle from screenshot pixels — glyph registration and
//     badge coverage — in CSS pixels with devicePixelRatio applied;
//   * measures per-keystroke latency and long tasks with and without mentions;
//   * asserts the layer is absent when no mention resolves and that
//     checkControlConsistency reports zero violations.
//
// No runtime, provider, Desktop or system clipboard is used.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { electron } from './lib/desktop1.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), 'tt-inline-mentions-visual-'));
const out = join(root, 'qa/results/inline-mentions/visual');
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(root, 'qa/fixtures/composer-mentions-dom.tsx')],
  bundle: true,
  outfile: join(scratch, 'qa.js'),
  jsx: 'automatic',
  logLevel: 'error',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
});
await writeFile(join(scratch, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>
html,body,#root{height:100%;margin:0}
#root{display:flex;flex-direction:column}
#root > *{flex:1;min-height:0;height:100%}
.chat-view.v3-session-chat{position:relative;height:100%;display:flex;flex-direction:column}
body{background:var(--bg);color:var(--text)}
</style><div id="root"></div><script src="qa.js"></script>`);
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(scratch, 'index.html'))});win.showInactive();});`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
Object.assign(env, { PATH: [dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';') });

const report = { passed: false, checks: [], screenshots: [], alignment: {}, latency: {}, errors: [] };
let app; let page;
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = value => { report.checks.push(value); };
const ok = value => { check(value); console.log(`PASS ${value}`); };

// --- fixture data -----------------------------------------------------------
const draftV2 = (text, mentions) => `[ThreadTerm draft v2]\n${JSON.stringify({ text, mentions })}`;
const fileEntry = (token, path) => ({ token, item: { kind: 'file', id: `file:${path}`, path } });
const sessionEntry = (token, sessionId, title) => ({ token, item: { kind: 'session', id: `session:${sessionId}`, sessionId, title, provider: 'codex' } });
const commitEntry = (token, sha, subject) => ({ token, item: { kind: 'commit', id: `commit:${sha}`, sha, subject } });
const agentEntry = (token, provider) => ({ token, item: { kind: 'agent', id: `agent:${provider}`, provider } });
const skillEntry = (token, name, invocation) => ({ token, item: { kind: 'skill', id: `skill:${name}`, name, invocation } });

const MIX_TEXT = 'Review @cart.ts, ask @other-chat and @6e0f22b about @codex plus @review.';
const MIX_CATALOGUE = [
  fileEntry('@cart.ts', 'src/cart.ts'),
  sessionEntry('@other-chat', 'other-chat-1', 'Other chat'),
  commitEntry('@6e0f22b', '6e0f22b1234567890abcdef1234567890abcdef1', 'Fix cart totals'),
  agentEntry('@codex', 'codex'),
  skillEntry('@review', 'review', '/skill:review'),
];

// --- page helpers -----------------------------------------------------------
const scope = id => page.locator(`[data-testid="session-chat-${id}"]`);
const inputBox = async id => {
  const box = await scope(id).locator('.chat-compose-input').boundingBox();
  return { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) };
};
const shellBox = async id => {
  const box = await scope(id).locator('.chat-compose-shell').boundingBox();
  return { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) };
};

async function mountState(id, { text, mentions, locale = 'en' }) {
  await page.evaluate(([sessionId, draft, lang]) => window.qa.reset({ sessionId, draft, locale: lang }), [id, draftV2(text, mentions), locale]);
  await scope(id).locator('.chat-compose-input textarea').waitFor({ timeout: 15_000 });
  await page.waitForFunction(sessionId => {
    const field = document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-input textarea`);
    return field && !field.disabled && field.value.length > 0;
  }, id, { timeout: 15_000 });
  if (mentions.length) {
    await scope(id).locator('.chat-compose-highlights').waitFor({ timeout: 15_000 });
  } else {
    await delay(150);
    assert.equal(await scope(id).locator('.chat-compose-highlights').count(), 0, 'no layer without mentions');
  }
}

async function applyTheme(theme) {
  await page.evaluate(next => {
    const style = document.documentElement.style;
    for (const key of ['background', 'surface', 'text', 'muted', 'accent', 'border']) style.removeProperty(`--custom-${key}`);
    if (next === 'custom') {
      document.documentElement.dataset.theme = 'dark';
      document.documentElement.dataset.customTheme = 'true';
      const tokens = { background: '#1a120b', surface: '#241a10', text: '#f5e9dc', muted: '#c9b8a4', accent: '#b45309', border: '#5a442b' };
      for (const [key, value] of Object.entries(tokens)) style.setProperty(`--custom-${key}`, value);
    } else {
      document.documentElement.dataset.theme = next;
      document.documentElement.dataset.customTheme = 'false';
    }
  }, theme);
}

async function capture(name, box) {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, clip: box });
  report.screenshots.push(file);
  return file;
}

// --- screenshot-pixel decoding (Electron nativeImage) -----------------------
async function screenshotBitmap(box) {
  const png = await page.screenshot({ clip: box });
  return app.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    const size = image.getSize();
    return { width: size.width, height: size.height, bitmap: image.toBitmap().toString('base64') };
  }, png.toString('base64'));
}

function backgroundOf(image) {
  const counts = new Map();
  const step = Math.max(1, Math.floor(Math.min(image.width, image.height) / 40));
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const i = (y * image.width + x) * 4;
      const key = `${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = '0,0,0'; let bestCount = -1;
  for (const [key, value] of counts) if (value > bestCount) { bestCount = value; best = key; }
  const [b, g, r] = best.split(',').map(Number);
  return { r, g, b };
}

function glyphStats(image, background, region) {
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(image.width, Math.ceil(region.x + region.width));
  const y1 = Math.min(image.height, Math.ceil(region.y + region.height));
  let count = 0; let sx = 0; let sy = 0; let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * image.width + x) * 4;
      const distance = Math.max(
        Math.abs(image.data[i] - background.b),
        Math.abs(image.data[i + 1] - background.g),
        Math.abs(image.data[i + 2] - background.r),
      );
      if (distance > 42) {
        count += 1; sx += x; sy += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return count === 0 ? { count } : { count, cx: sx / count, cy: sy / count, minX, minY, maxX, maxY };
}

async function readMetrics(id) {
  return page.evaluate(sessionId => {
    const scopeNode = document.querySelector(`[data-testid="session-chat-${sessionId}"]`);
    const area = scopeNode.querySelector('.chat-compose-input textarea');
    const layer = scopeNode.querySelector('.chat-compose-highlights-scroll');
    const pick = node => {
      const style = getComputedStyle(node);
      return {
        fontSize: style.fontSize, lineHeight: style.lineHeight, fontFamily: style.fontFamily,
        letterSpacing: style.letterSpacing, paddingTop: style.paddingTop, paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom, paddingLeft: style.paddingLeft, boxSizing: style.boxSizing,
        whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, wordBreak: style.wordBreak,
        tabSize: style.tabSize, textAlign: style.textAlign,
      };
    };
    return { area: pick(area), layer: pick(layer), areaScrollHeight: area.scrollHeight, layerScrollHeight: layer.scrollHeight, areaClientWidth: area.clientWidth, layerClientWidth: layer.clientWidth };
  }, id);
}

try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs'), '--disable-gpu', '--in-process-gpu', '--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], env });
  page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(`console: ${message.text()}`); });
  await page.waitForFunction(() => Boolean(window.qa));
  await page.addStyleTag({
    content: `
      .qa-mention-native .chat-compose-highlights { visibility: hidden !important; }
      .qa-mention-layer .chat-compose-input textarea { color: transparent !important; caret-color: transparent !important; }
      .qa-mention-layer .chat-mention-badge { background: transparent !important; box-shadow: none !important; color: var(--text) !important; }
    `,
  });

  // --- 1. Special states ----------------------------------------------------
  const fileOnly = fileEntry('@cart.ts', 'src/cart.ts');
  await mountState('vis-file', { text: 'Please review @cart.ts before shipping.', mentions: [fileOnly] });
  await capture('state-one-file', await shellBox('vis-file'));
  ok('one file mention renders a badge');

  await mountState('vis-kinds', { text: MIX_TEXT, mentions: MIX_CATALOGUE });
  await capture('state-all-kinds', await shellBox('vis-kinds'));
  const kindCount = await scope('vis-kinds').locator('.chat-mention-badge').evaluateAll(nodes => nodes.map(node => node.dataset.kind));
  assert.deepEqual(kindCount.sort(), ['agent', 'commit', 'file', 'session', 'skill'], 'one badge per kind');
  ok('one of each mention kind renders');

  const wrapped = 'First line has several words before @cart.ts and then it keeps going with more and more words until it finally wraps. '
    + 'Second line starts here and continues running until @other-chat appears somewhere past the middle of this deliberately long sentence. '
    + 'Third line then mentions @codex near its end after several more words of filler text to guarantee three wrapped lines.';
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(420, 900));
  await delay(60);
  await mountState('vis-wrap', { text: wrapped, mentions: MIX_CATALOGUE });
  const lines = await scope('vis-wrap').locator('.chat-mention-badge').evaluateAll(nodes => [...new Set(nodes.flatMap(node => [...node.getClientRects()].map(rect => Math.round(rect.top))))]);
  assert.ok(lines.length >= 3, `mentions wrap across three lines (${lines.length} distinct lines)`);
  await capture('state-wrapped', await shellBox('vis-wrap'));
  ok(`a wrapped draft shows mentions on ${lines.length} lines`);

  await mountState('vis-zh', { text: '请看@cart.ts。然后问@other-chat，提交@6e0f22b。', mentions: MIX_CATALOGUE, locale: 'zh-CN' });
  for (const width of [420, 700, 1100]) {
    await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth, 900), width);
    await delay(60);
    await capture(`state-zh-${width}`, await shellBox('vis-zh'));
  }
  ok('zh-CN CJK-adjacent tokens and full-width punctuation render');

  const positions = '@cart.ts starts the line\nends the line @codex\n\n@other-chat after a blank line';
  await mountState('vis-positions', { text: positions, mentions: MIX_CATALOGUE });
  await capture('state-line-positions', await shellBox('vis-positions'));
  ok('tokens at line start, line end and after a newline render');

  await mountState('vis-trailing', { text: 'A draft with @cart.ts that ends with a newline\n', mentions: [fileOnly] });
  const trailingMetrics = await readMetrics('vis-trailing');
  // The textarea has a 44 px min-height and does not grow for a trailing empty line, while the layer keeps
  // the zero-width-space line; both still register their glyphs at the same y, so allow one line of slack.
  const heightSlack = parseFloat(trailingMetrics.area.lineHeight) + 2;
  assert.ok(Math.abs(trailingMetrics.areaScrollHeight - trailingMetrics.layerScrollHeight) <= heightSlack, `trailing newline stays within one line of the textarea (${trailingMetrics.areaScrollHeight}/${trailingMetrics.layerScrollHeight})`);
  await capture('state-trailing-newline', await shellBox('vis-trailing'));
  ok('a trailing newline keeps the layer height aligned');

  const quoted = fileEntry('@"a very long quoted file name that needs quoting.ts"', 'src/a very long quoted file name that needs quoting.ts');
  await mountState('vis-quoted', { text: 'Open @"a very long quoted file name that needs quoting.ts" please.', mentions: [quoted] });
  await capture('state-long-quoted', await shellBox('vis-quoted'));
  ok('a long quoted token renders one badge');

  await mountState('vis-tabs', { text: 'Col1\tCol2 with @cart.ts\tanother column', mentions: [fileOnly] });
  await capture('state-tabs', await shellBox('vis-tabs'));
  ok('tabs keep the badge registered');

  // Scrolled draft beyond the 200 px max height.
  const filler = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the long scrolled draft.`).join('\n');
  const scrolledText = `${filler}\nReview @cart.ts at the very end.`;
  await mountState('vis-scroll', { text: scrolledText, mentions: [fileOnly] });
  const scrolled = scope('vis-scroll').locator('.chat-compose-input textarea');
  const scrollInfo = await scrolled.evaluate(node => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }));
  assert.ok(scrollInfo.scrollHeight > scrollInfo.clientHeight + 20, 'long draft overflows the 200 px max height');
  await page.evaluate(sessionId => { document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-input textarea`).scrollTop = Math.floor(document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-input textarea`).scrollHeight / 2); }, 'vis-scroll');
  await page.waitForFunction(sessionId => {
    const area = document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-input textarea`);
    const layer = document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-highlights-scroll`);
    return area.scrollTop > 0 && layer.scrollTop === area.scrollTop;
  }, 'vis-scroll', { timeout: 5000 });
  await capture('state-scrolled-middle', await shellBox('vis-scroll'));
  await page.evaluate(sessionId => { const area = document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-input textarea`); area.scrollTop = area.scrollHeight; }, 'vis-scroll');
  await delay(80);
  await capture('state-scrolled-end', await shellBox('vis-scroll'));
  ok('a draft longer than 200 px scrolls with the layer mirrored');

  // Scrollbar appears and disappears as the text grows and shrinks.
  await mountState('vis-grow', { text: 'short @cart.ts', mentions: [fileOnly] });
  const shortOffset = await page.evaluate(sessionId => {
    const area = document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-input textarea`);
    return area.offsetWidth - area.clientWidth;
  }, 'vis-grow');
  await page.evaluate(sessionId => { const area = document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-input textarea`); area.focus(); area.setSelectionRange(area.value.length, area.value.length); }, 'vis-grow');
  await page.keyboard.type(' more text '.repeat(150));
  await delay(120);
  const grew = await page.evaluate(sessionId => {
    const area = document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-input textarea`);
    return { scrollHeight: area.scrollHeight, clientHeight: area.clientHeight };
  }, 'vis-grow');
  assert.ok(grew.scrollHeight > grew.clientHeight + 20, 'growing the draft makes the textarea scroll');
  const longOffset = await page.evaluate(sessionId => {
    const area = document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-input textarea`);
    return area.offsetWidth - area.clientWidth;
  }, 'vis-grow');
  await capture('state-scrollbar-shown', await shellBox('vis-grow'));
  assert.equal(shortOffset, longOffset, 'scrollbar-gutter keeps the content width stable while the draft grows');
  assert.equal(await scope('vis-grow').locator('.chat-compose-highlights').count(), 1, 'the layer stays with the grown draft');
  ok('scrollbar-gutter keeps the content width stable as a draft grows');

  await mountState('vis-narrow', { text: MIX_TEXT, mentions: MIX_CATALOGUE });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 900));
  await delay(60);
  const wideBefore = await inputBox('vis-narrow');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(420, 900));
  await delay(120);
  const narrowAfter = await inputBox('vis-narrow');
  assert.notEqual(wideBefore.width, narrowAfter.width, 'resizing narrows the input');
  await capture('state-narrow-resized', await shellBox('vis-narrow'));
  ok('resizing the pane narrower keeps the layer aligned');

  // --- 2. Matrix ------------------------------------------------------------
  for (const theme of ['light', 'dark', 'custom']) {
    await applyTheme(theme);
    for (const width of [420, 700, 1100]) {
      await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth, 900), width);
      await delay(60);
      for (const locale of ['en', 'zh-CN']) {
        const id = `vis-matrix-${theme}-${width}-${locale}`;
        const text = locale === 'zh-CN' ? '请看@cart.ts。然后问@other-chat，提交@6e0f22b。' : MIX_TEXT;
        await mountState(id, { text, mentions: MIX_CATALOGUE, locale });
        await capture(`matrix-${theme}-${width}-${locale}`, await shellBox(id));
      }
    }
  }
  await applyTheme('light');
  ok('matrix: 420/700/1100 × light/dark/custom × en/zh-CN screenshots captured');

  // Zoom 100 % and 125 % at 700 px. A taller window keeps the whole composer inside the zoomed viewport.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(700, 1600));
  await mountState('vis-zoom', { text: MIX_TEXT, mentions: MIX_CATALOGUE });
  for (const factor of [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(next), factor);
    await delay(180);
    // Playwright screenshots do not apply page zoom to the capture rect; Electron's own capturePage does.
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
      return image.toPNG().toString('base64');
    });
    const file = join(out, `zoom-${Math.round(factor * 100)}.png`);
    await writeFile(file, Buffer.from(png, 'base64'));
    report.screenshots.push(file);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  ok('zoom 100 % and 125 % screenshots captured');

  // --- 3. Alignment oracle --------------------------------------------------
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(700, 900));
  await applyTheme('light');
  await mountState('vis-oracle', { text: MIX_TEXT, mentions: MIX_CATALOGUE });
  await page.evaluate(sessionId => {
    const area = document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-input textarea`);
    area.scrollTop = 0; area.blur();
  }, 'vis-oracle');
  await delay(80);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const oracleBox = await inputBox('vis-oracle');
  const fragments = await scope('vis-oracle').locator('.chat-mention-badge').evaluateAll(nodes => nodes.map(node => ({
    token: node.dataset.token,
    rects: [...node.getClientRects()].map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })),
  })));
  const metrics = await readMetrics('vis-oracle');
  for (const key of Object.keys(metrics.area)) {
    assert.equal(metrics.area[key], metrics.layer[key], `layer shares the textarea metric ${key}`);
  }
  assert.equal(metrics.areaClientWidth, metrics.layerClientWidth, 'layer and textarea share the same content width');
  assert.ok(Math.abs(metrics.areaScrollHeight - metrics.layerScrollHeight) <= parseFloat(metrics.area.lineHeight) + 2, 'layer and textarea report compatible scroll heights');

  await page.evaluate(id => document.querySelector(`[data-testid="session-chat-${id}"] .chat-compose-shell`).classList.add('qa-mention-native'), 'vis-oracle');
  await delay(80);
  const nativeShot = await screenshotBitmap(oracleBox);
  await capture('oracle-native', oracleBox);
  await page.evaluate(id => {
    const shell = document.querySelector(`[data-testid="session-chat-${id}"] .chat-compose-shell`);
    shell.classList.remove('qa-mention-native');
    shell.classList.add('qa-mention-layer');
  }, 'vis-oracle');
  await delay(80);
  const layerShot = await screenshotBitmap(oracleBox);
  await capture('oracle-layer', oracleBox);
  await page.evaluate(id => {
    const shell = document.querySelector(`[data-testid="session-chat-${id}"] .chat-compose-shell`);
    shell.classList.remove('qa-mention-layer'); shell.classList.remove('qa-mention-native');
  }, 'vis-oracle');

  const nativeImage = { width: nativeShot.width, height: nativeShot.height, data: Buffer.from(nativeShot.bitmap, 'base64') };
  const layerImage = { width: layerShot.width, height: layerShot.height, data: Buffer.from(layerShot.bitmap, 'base64') };
  const scaleX = nativeImage.width / oracleBox.width;
  const scaleY = nativeImage.height / oracleBox.height;
  const nativeBg = backgroundOf(nativeImage);
  const layerBg = backgroundOf(layerImage);
  let worstRegistration = 0; let worstBadge = 0; let checkedFragments = 0;
  for (const fragment of fragments) {
    for (const rect of fragment.rects) {
      const region = { x: (rect.x - oracleBox.x) * scaleX, y: (rect.y - oracleBox.y) * scaleY, width: rect.width * scaleX, height: rect.height * scaleY };
      const nativeStats = glyphStats(nativeImage, nativeBg, region);
      const layerStats = glyphStats(layerImage, layerBg, region);
      assert.ok(nativeStats.count > 0 && layerStats.count > 0, `fragment of ${fragment.token} has glyph pixels in both modes`);
      const registration = Math.hypot(nativeStats.cx - layerStats.cx, nativeStats.cy - layerStats.cy) / scaleX;
      worstRegistration = Math.max(worstRegistration, registration);
      const badgeRegion = { x: region.x, y: region.y, width: rect.width * scaleX, height: rect.height * scaleY };
      const leftGap = nativeStats.minX - badgeRegion.x;
      const rightGap = (badgeRegion.x + badgeRegion.width) - nativeStats.maxX;
      const slack = parseFloat(metrics.area.lineHeight) - parseFloat(metrics.area.fontSize);
      const topGap = nativeStats.minY - badgeRegion.y;
      const bottomGap = (badgeRegion.y + badgeRegion.height) - nativeStats.maxY;
      const horizontalMiss = Math.max(0, -leftGap, -rightGap) / scaleX;
      const verticalMiss = Math.max(0, -topGap, -bottomGap) / scaleY - slack;
      worstBadge = Math.max(worstBadge, horizontalMiss, verticalMiss);
      checkedFragments += 1;
    }
  }
  assert.ok(checkedFragments >= 5, `the oracle checked ${checkedFragments} badge fragments`);
  assert.ok(worstRegistration <= 1, `glyph registration displacement ${worstRegistration.toFixed(3)} CSS px ≤ 1`);
  assert.ok(worstBadge <= 1, `badge coverage overrun ${worstBadge.toFixed(3)} CSS px ≤ 1`);
  report.alignment = { devicePixelRatio: dpr, fragments: checkedFragments, worstRegistration, worstBadge };
  ok(`alignment oracle: ${checkedFragments} fragments, registration ${worstRegistration.toFixed(3)} px, coverage overrun ${worstBadge.toFixed(3)} px`);

  // --- 4. Zero cost without mentions ---------------------------------------
  await mountState('vis-none', { text: MIX_TEXT, mentions: [] });
  assert.equal(await scope('vis-none').locator('.chat-compose-highlights').count(), 0, 'no layer when nothing resolves');
  assert.equal(await scope('vis-none').locator('.chat-mention-badge').count(), 0, 'no badge when nothing resolves');
  ok('the layer is absent from the DOM when no mention resolves');

  // --- 5. Latency -----------------------------------------------------------
  async function installLatency(id) {
    await page.evaluate(sessionId => {
      const area = document.querySelector(`[data-testid="session-chat-${sessionId}"] .chat-compose-input textarea`);
      window.__lat = [];
      window.__long = [];
      if (!window.__longObserver) {
        window.__longObserver = true;
        try { new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__long.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask' }); } catch { /* longtask unsupported */ }
      }
      if (!area.__latInstalled) {
        area.__latInstalled = true;
        area.addEventListener('keydown', event => { window.__lastKey = event.timeStamp; }, true);
        area.addEventListener('input', () => {
          const start = window.__lastKey;
          requestAnimationFrame(stamp => window.__lat.push(stamp - start));
        }, true);
      }
    }, id);
  }
  async function typeKeys(id, count) {
    const area = scope(id).locator('.chat-compose-input textarea');
    await area.click();
    await page.keyboard.press('End');
    await installLatency(id);
    for (let index = 0; index < count; index += 1) {
      const before = await page.evaluate(() => window.__lat.length);
      await page.keyboard.press('a');
      await page.waitForFunction(expected => window.__lat.length > expected, before, { timeout: 3000 }).catch(() => undefined);
    }
    return page.evaluate(() => ({ lat: window.__lat.slice(), long: window.__long.slice() }));
  }
  function summarize(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    return { mean, p95, n: sorted.length };
  }

  const latencyMentions = Array.from({ length: 10 }, (_, index) => fileEntry(`@f${index}`, `src/module-${index}.ts`));
  let latencyBase = '';
  for (let index = 0; index < 10; index += 1) latencyBase += `Please inspect ${latencyMentions[index].token} in section ${index}. `;
  latencyBase += 'lorem ipsum '.repeat(Math.ceil((5000 - latencyBase.length) / 12));
  latencyBase = latencyBase.slice(0, 5000);

  let withSamples = []; let withoutSamples = [];
  for (const variant of ['with', 'without']) {
    const id = `vis-latency-${variant}`;
    await mountState(id, { text: latencyBase, mentions: variant === 'with' ? latencyMentions : [] });
    for (let run = 0; run < 3; run += 1) {
      const result = await typeKeys(id, 100);
      if (variant === 'with') withSamples = withSamples.concat(result.lat);
      else withoutSamples = withoutSamples.concat(result.lat);
      assert.ok(result.long.length === 0, `no longtask > 50 ms during the ${variant} typing run (${JSON.stringify(result.long)})`);
    }
  }
  const withStats = summarize(withSamples);
  const withoutStats = summarize(withoutSamples);
  const meanDelta = withStats.mean - withoutStats.mean;
  report.latency = { with: withStats, without: withoutStats, meanDelta };
  assert.ok(withStats.mean <= 16, `mean latency with mentions ${withStats.mean.toFixed(2)} ms ≤ 16`);
  assert.ok(withStats.p95 <= 33, `p95 latency with mentions ${withStats.p95.toFixed(2)} ms ≤ 33`);
  assert.ok(Math.abs(meanDelta) <= 3, `mean latency delta ${meanDelta.toFixed(2)} ms ≤ 3`);
  ok(`latency: with mentions mean ${withStats.mean.toFixed(2)} ms p95 ${withStats.p95.toFixed(2)} ms; without mean ${withoutStats.mean.toFixed(2)} ms p95 ${withoutStats.p95.toFixed(2)} ms`);

  // --- 6. VC check ----------------------------------------------------------
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(700, 900));
  await mountState('vis-vc', { text: MIX_TEXT, mentions: MIX_CATALOGUE });
  const consistency = await checkControlConsistency(page, `[data-testid="session-chat-vis-vc"] .chat-compose-shell`);
  assertNoControlViolations(consistency, 'composer with mentions');
  ok(`zero visual-consistency violations (${consistency.checked} controls)`);

  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  report.completedAt = new Date().toISOString();
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(report.passed ? `INLINE MENTIONS VISUAL QA PASSED (${report.screenshots.length} screenshots)` : `INLINE MENTIONS VISUAL QA FAILED\n${report.errors.join('\n')}`);
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));

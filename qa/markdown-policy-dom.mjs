// Isolated regression QA for the shared hostile-Markdown policy (F03) and its inert remote images (F17).
// Desktop1 opens one static fixture page built from the real marked + DOMPurify + renderer/src/markdownPolicy.ts.
// No runtime, provider or user profile is involved: the page only renders Markdown into app-styled containers.
// A loopback image server counts requests, so "rendering text never fetches its URLs" is measured, not assumed.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build as esbuild } from 'esbuild';
import { electron } from './lib/desktop1.mjs';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'qa', 'results', 'markdown-policy');
const tempRoot = resolve(process.env.TEMP || tmpdir());
const lock = join(tempRoot, 'qa-electron.lock');
const scratch = await mkdtemp(join(tempRoot, 'tt-markdown-policy-'));
const fixture = join(scratch, 'fixture'), renderer = join(scratch, 'renderer'), profile = join(scratch, 'profile');
const isolatedHome = join(scratch, 'home'), isolatedAppData = join(scratch, 'appdata'), isolatedLocalAppData = join(scratch, 'localappdata');
let app, server, imageServer, locked = false;
const report = { passed: false, checks: [], screenshots: [], errors: [] };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const check = label => { report.checks.push(label); console.log(`PASS ${label}`); };

// One 1x1 PNG: every hit on this server is a request the rendered text asked for.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const hits = new Map();
const hitCount = path => hits.get(path) ?? 0;
const totalHits = () => [...hits.values()].reduce((sum, count) => sum + count, 0);
const resetHits = () => hits.clear();
async function waitForHit(path, expected, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && hitCount(path) < expected) await sleep(100);
  return hitCount(path);
}

// The block starts with prose so DOMPurify's document parse keeps the <style> in <body> instead of hoisting it to <head>.
const hostileFor = origin => [
  'Release is ready. <style>button{display:none!important}#outside-approve{visibility:hidden}</style>',
  '<div style="position:fixed;inset:0;z-index:9999;background:red">overlay</div>',
  '<span class="btn btn-primary chat-compose-send" id="root" name="outside-approve">Spoofed send</span>',
  '<iframe src="https://example.invalid/frame"></iframe>',
  '<form action="https://example.invalid/"><input name="field"><button type="submit">Submit</button></form>',
  `<img src="${origin}/tracker.png" alt="remote">`,
  '<a href="javascript:window.__pwned=1">bad link</a>',
  '<svg><text>svg</text></svg><audio src="https://example.invalid/a.mp3"></audio>',
  '<script>window.__pwned = true</script>',
].join('\n\n');

// Every other spelling of "load this URL while rendering": the policy must leave none of them able to fetch.
const remoteFor = (origin, protocolRelative) => [
  `![Release chart](${origin}/markdown.png)`,
  `<picture><source srcset="${origin}/picture-source.png"><img src="${origin}/picture.png" alt="picture"></picture>`,
  `<img srcset="${origin}/srcset.png" alt="srcset">`,
  `<svg><image href="${origin}/svg.png"></image></svg>`,
  `<div style="background-image:url(${origin}/css.png)">styled</div>`,
  `<img src="//${protocolRelative}/protocol.png" alt="protocol relative">`,
].join('\n\n');

const benign = [
  '# Release notes',
  '| item | state |\n| --- | --- |\n| markdown | ok |',
  '```ts\nconst total = 1;\n```',
  '```mermaid\ngraph TD; A-->B\n```',
  '```json\n{"answer":42}\n```',
  'Read [src/app.ts](src/app.ts) and the [docs](https://example.com/docs).',
].join('\n\n');

const entry = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { parseChatMarkdown } from '${join(root, 'renderer/src/chatMath.ts').replaceAll('\\', '/')}';
import { parseMarkdownFileReference } from '${join(root, 'renderer/src/fileReferences.ts').replaceAll('\\', '/')}';
import { sanitizeMarkdownHtml } from '${join(root, 'renderer/src/markdownPolicy.ts').replaceAll('\\', '/')}';
import { ChatMarkdown } from '${join(root, 'renderer/src/components/ChatMarkdownExtras/index.tsx').replaceAll('\\', '/')}';
import '${join(root, 'renderer/src/styles.css').replaceAll('\\', '/')}';

// The last uncaught page error with its application stack, so a failure inside a render is diagnosable.
const state = window as unknown as { __markdownQAError?: string };
window.addEventListener('error', event => { state.__markdownQAError = (event as ErrorEvent).error?.stack ?? (event as ErrorEvent).message; });

// Same file-reference decoration the live Chat and group surfaces run before sanitizing.
function decorate(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of Array.from(template.content.querySelectorAll('[data-threadterm-file-reference]'))) element.removeAttribute('data-threadterm-file-reference');
  for (const anchor of Array.from(template.content.querySelectorAll('a[href]'))) {
    const reference = parseMarkdownFileReference(anchor.getAttribute('href') ?? '');
    if (!reference) continue;
    anchor.removeAttribute('href');
    anchor.setAttribute('data-threadterm-file-reference', JSON.stringify(reference));
  }
  return template.innerHTML;
}

// One entry per production call site: ChatView.renderCodexMarkdown, HistoryTranscript, PlanApprovalCard, GroupMarkdown.
const pipelines: Record<string, (text: string, zh: boolean) => string> = {
  live: (text, zh) => sanitizeMarkdownHtml(decorate(String(parseChatMarkdown(text))), { zh }),
  history: (text, zh) => sanitizeMarkdownHtml(String(marked.parse(text, { gfm: true, breaks: true, async: false })), { forbidFileReferences: true, zh }),
  plan: (text, zh) => sanitizeMarkdownHtml(String(marked.parse(text, { async: false })), { zh }),
  group: (text, zh) => sanitizeMarkdownHtml(decorate(String(parseChatMarkdown(text))), { forbidImages: true, zh }),
  // FilePreview.tsx markdown branch: sanitize, then resolve workspace-relative images and drop other hrefs.
  file: (text, zh) => {
    const safe = sanitizeMarkdownHtml(String(marked.parse(text, { gfm: true, async: false })), { zh });
    const fragment = new DOMParser().parseFromString(safe, 'text/html');
    for (const image of Array.from(fragment.querySelectorAll('img'))) {
      // The fixture has no runtime, so a workspace image cannot be read; it is marked unavailable, as FilePreview does.
      const source = image.getAttribute('src') ?? '';
      image.removeAttribute('src');
      image.removeAttribute('srcset');
      image.alt = image.alt || (/^(?:[a-z][a-z0-9+.-]*:[\\\\/]|[\\\\/]{1,2})/i.test(source) ? 'Image is outside this workspace' : 'Image unavailable: ' + source);
    }
    for (const anchor of Array.from(fragment.querySelectorAll('a'))) {
      const href = anchor.getAttribute('href') ?? '';
      if (!/^https?:\\/\\//i.test(href) && !href.startsWith('#')) anchor.removeAttribute('href');
    }
    return fragment.body.innerHTML;
  },
};

// The production React path: ChatMarkdown maps an extras-bearing message into elements, so RemoteImage renders it.
const reactRoots = new Map<string, ReturnType<typeof createRoot>>();
function renderReact(surface: string, text: string, zh: boolean): void {
  const host = container(surface);
  let chatRoot = reactRoots.get(surface);
  if (!chatRoot) { chatRoot = createRoot(host); reactRoots.set(surface, chatRoot); }
  const html = sanitizeMarkdownHtml(decorate(String(parseChatMarkdown(text))), { zh });
  chatRoot.render(createElement(ChatMarkdown, { sanitizedHtml: html, copy: (en: string, cn: string) => (zh ? cn : en) }));
}

// The pre-fix options, kept only to prove this fixture really attacks controls and really fetches when no policy is applied.
function legacy(surface: string, text: string): string {
  if (surface === 'plan') return DOMPurify.sanitize(String(marked.parse(text, { async: false })));
  return DOMPurify.sanitize(decorate(String(parseChatMarkdown(text))), {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base', 'svg', 'math', 'audio', 'video', 'source', 'track'],
    FORBID_ATTR: ['style', 'srcset', 'background', 'poster'],
    SANITIZE_NAMED_PROPS: true,
  });
}

function container(surface: string): HTMLElement { return document.querySelector('[data-surface="' + surface + '"]') as HTMLElement; }

const api = {
  render: (surface: string, text: string, zh = false) => {
    if (surface === 'chat-react') { renderReact(surface, text, zh); return; }
    container(surface).innerHTML = pipelines[surface](text, zh);
  },
  inspect: (surface: string) => {
    const node = container(surface);
    return {
      // Our own placeholder markup is inserted after sanitizing; these checks are about what untrusted text kept.
      tags: Array.from(node.querySelectorAll('*')).filter(element => !element.closest('[data-remote-image]')).map(element => element.tagName.toLowerCase()),
      styleElements: node.querySelectorAll('style').length,
      styleAttributes: node.querySelectorAll('[style]').length,
      // Our own placeholder markup is inserted after sanitizing; these checks are about what untrusted text kept.
      classNames: Array.from(node.querySelectorAll('[class]')).filter(element => !element.closest('[data-remote-image]')).flatMap(element => Array.from(element.classList)),
      ids: Array.from(node.querySelectorAll('[id]')).map(element => element.id),
      names: Array.from(node.querySelectorAll('[name]')).map(element => element.getAttribute('name')),
      images: node.querySelectorAll('img').length,
      imageSources: Array.from(node.querySelectorAll('img')).map(element => element.getAttribute('src') ?? ''),
      remoteImages: Array.from(node.querySelectorAll('[data-remote-image]')).map(element => ({
        source: element.getAttribute('data-remote-image') ?? '',
        host: element.getAttribute('data-remote-image-host') ?? '',
        label: element.getAttribute('aria-label') ?? '',
        alt: element.querySelector('.md-remote-image-alt')?.textContent ?? '',
        hostText: element.querySelector('.md-remote-image-host')?.textContent ?? '',
        action: element.querySelector('[data-remote-image-load]')?.textContent ?? '',
        actionTitle: element.querySelector('[data-remote-image-load]')?.getAttribute('title') ?? '',
        src: element.querySelector('[src]')?.getAttribute('src') ?? '',
      })),
      activeUrls: Array.from(node.querySelectorAll('[href],[src]')).map(element => element.getAttribute('href') ?? element.getAttribute('src') ?? '').filter(value => /^javascript:/i.test(value)),
      fileReferences: node.querySelectorAll('[data-threadterm-file-reference]').length,
    };
  },
  outside: () => Array.from(document.querySelectorAll('[data-outside]')).map(node => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return { id: (node as HTMLElement).id, display: style.display, visibility: style.visibility, opacity: style.opacity, position: style.position, rect: [rect.x, rect.y, rect.width, rect.height].map(Math.round), text: node.textContent };
  }),
  legacy: (surface: string, text: string) => legacy(surface, text),
  lastError: () => state.__markdownQAError,
  // Insert pre-fix output into a scratch container and report whether it hides or covers the app control.
  legacyLeaks: (html: string) => {
    const box = document.getElementById('legacy') as HTMLElement;
    box.hidden = false;
    box.innerHTML = html;
    const button = document.getElementById('outside-approve') as HTMLElement, style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const leaked = { hidden: style.display === 'none' || style.visibility === 'hidden', covered: hit !== button && !button.contains(hit) };
    box.innerHTML = '';
    box.hidden = true;
    return leaked;
  },
  // Keep pre-fix output live for a moment: proves the request counter sees what that pipeline would fetch.
  legacyFetch: (html: string) => {
    const box = document.getElementById('legacy') as HTMLElement;
    box.hidden = false;
    box.innerHTML = html;
    return new Promise<number>(done => setTimeout(() => { const images = box.querySelectorAll('img').length; box.innerHTML = ''; box.hidden = true; done(images); }, 600));
  },
  content: (surface: string) => {
    const node = container(surface);
    return {
      heading: node.querySelector('h1')?.textContent ?? '',
      cells: Array.from(node.querySelectorAll('th,td')).map(cell => cell.textContent),
      code: node.querySelector('code')?.textContent ?? '',
      codeClass: node.querySelector('code')?.className ?? '',
      pre: node.querySelectorAll('pre').length,
      link: node.querySelector('a[href="https://example.com/docs"]')?.textContent ?? '',
      references: Array.from(node.querySelectorAll('[data-threadterm-file-reference]')).map(element => JSON.parse(element.getAttribute('data-threadterm-file-reference') ?? '""')),
    };
  },
  setTheme: (theme: string) => { document.documentElement.dataset.theme = theme; },
  setLanguage: (language: string) => { document.documentElement.lang = language; },
};
(window as unknown as { __markdownQA: typeof api }).__markdownQA = api;
`;

async function takeLock() {
  const deadline = Date.now() + 40 * 60 * 1000;
  for (;;) {
    try { await mkdir(lock); locked = true; return; } catch (error) { if (error.code !== 'EEXIST' || Date.now() > deadline) throw error; console.log('Waiting for shared Electron QA lock'); await sleep(15_000); }
  }
}

async function capture(name) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'));
  const png = await app.evaluate(async ({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; const [width, height] = window.getContentSize(); return (await window.webContents.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true })).toPNG().toString('base64'); });
  await writeFile(join(out, name), Buffer.from(png, 'base64'));
  report.screenshots.push(name);
}

try {
  await takeLock();
  await Promise.all([fixture, renderer, profile, isolatedHome, isolatedAppData, isolatedLocalAppData, out].map(path => mkdir(path, { recursive: true })));
  // Loopback image server: a hit is one request a rendered message made on its own.
  imageServer = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (/\.png$/.test(path)) {
      hits.set(path, hitCount(path) + 1);
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store, no-cache', 'content-length': PIXEL.length });
      response.end(PIXEL);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not an image path');
  });
  await new Promise(done => imageServer.listen(0, '127.0.0.1', done));
  const imageOrigin = `http://127.0.0.1:${imageServer.address().port}`;
  const imageHost = `127.0.0.1:${imageServer.address().port}`;
  const hostile = hostileFor(imageOrigin);
  console.log(`image server ${imageOrigin}`);
  await writeFile(join(fixture, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head>
<body><main class="markdown-policy-fixture">
<section class="fixture-controls" aria-label="App controls outside the message"><button id="outside-approve" class="btn btn-primary" data-outside="approve">Approve &amp; build</button><button id="outside-send" class="btn chat-compose-send" data-outside="send">Send</button></section>
<section class="fixture-messages">
<div class="v3-chat-message is-codex assistant"><div class="v3-message-text codex-markdown" data-surface="live"></div></div>
<div class="history-transcript-item history-message-assistant"><div class="v3-message-text codex-markdown" data-surface="history"></div></div>
<div class="chat-approval-card chat-plan-approval pending"><div class="codex-markdown" data-surface="plan"></div></div>
<div class="gc-markdown" data-surface="group"></div>
<div class="markdown-preview tt-preview-markdown" data-surface="file"></div>
<section class="v3-chat-message is-codex assistant"><div data-surface="chat-react"></div></section>
</section>
<div id="legacy" hidden></div>
</main><script type="module" src="/app.js"></script></body></html>`);
  await writeFile(join(fixture, 'entry.ts'), entry);
  await writeFile(join(fixture, 'fixture.css'), `.markdown-policy-fixture{display:grid;gap:12px;padding:12px;max-width:760px;font:13px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--text)}
.fixture-controls{display:flex;gap:8px}
.fixture-messages{display:grid;gap:10px}
[data-surface]{padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}\n`);
  // The renderer bundle imports KaTeX's stylesheet, whose web fonts are copied beside it (never displayed here).
  await esbuild({ entryPoints: [join(fixture, 'entry.ts')], bundle: true, format: 'esm', target: 'chrome120', outdir: renderer, entryNames: 'app', nodePaths: [join(root, 'node_modules')], absWorkingDir: root, logLevel: 'error', jsx: 'automatic', loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.otf': 'file', '.eot': 'file' } });
  await esbuild({ entryPoints: [join(fixture, 'fixture.css')], bundle: true, outfile: join(renderer, 'fixture.css'), logLevel: 'error' });
  await writeFile(join(renderer, 'index.html'), await readFile(join(fixture, 'index.html'), 'utf8'));
  // styles.css is bundled into app.css by the entry import; append the fixture layout.
  await writeFile(join(renderer, 'app.css'), `${await readFile(join(renderer, 'app.css'), 'utf8').catch(() => '')}\n${await readFile(join(renderer, 'fixture.css'), 'utf8')}`);
  server = await startReadonlyReferenceServer(renderer);
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|appdata|localappdata|codex_home|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  Object.assign(childEnv, {
    Path: [dirname(process.execPath), join(systemRoot, 'System32')].join(';'), HOME: isolatedHome, USERPROFILE: isolatedHome,
    APPDATA: isolatedAppData, LOCALAPPDATA: isolatedLocalAppData, TT_PARITY_PROFILE: profile, TT_QA_DESKTOP: '1',
  });
  app = await electron.launch({ args: ['--disable-gpu', '--no-sandbox', '--disable-features=CalculateNativeWinOcclusion', join(root, 'qa/parity/electron-static.cjs')], env: childEnv, timeout: 30000 });
  const page = await app.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(`after ${report.checks.length} checks: ${error?.stack ?? String(error)}`));
  await page.goto(`${server.origin}/`);
  await page.waitForFunction(() => Boolean(window.__markdownQA));
  const outside = () => page.evaluate(() => window.__markdownQA.outside());
  const inspect = surface => page.evaluate(surface => window.__markdownQA.inspect(surface), surface);
  const initial = await outside();
  assert.equal(initial.length, 2);
  for (const control of initial) assert.ok(control.rect[2] > 0 && control.rect[3] > 0, `outside control ${control.id} starts visible`);
  check('fixture starts with two visible app controls outside every message');

  // Without this the containment checks below would prove nothing: the same hostile text must defeat the pre-fix options.
  resetHits();
  const legacyChat = await page.evaluate(text => window.__markdownQA.legacy('chat', text), hostile);
  const legacyPlan = await page.evaluate(text => window.__markdownQA.legacy('plan', text), hostile);
  assert.match(legacyChat, /<style/i, 'pre-fix ChatView options retain the style element');
  assert.match(legacyPlan, /style="[^"]*position:\s*fixed/i, 'pre-fix PlanApprovalCard defaults retain inline styles');
  assert.match(legacyChat, new RegExp(`<img[^>]+src="${imageOrigin}/tracker\\.png"`), 'pre-fix options retain the remote image URL');
  const chatLeak = await page.evaluate(html => window.__markdownQA.legacyLeaks(html), legacyChat);
  const planLeak = await page.evaluate(html => window.__markdownQA.legacyLeaks(html), legacyPlan);
  assert.equal(chatLeak.hidden, true, 'pre-fix ChatView options let hostile Markdown hide a control outside the message');
  assert.equal(planLeak.covered, true, 'pre-fix plan defaults let hostile Markdown cover a control outside the message');
  assert.deepEqual(await outside(), initial, 'the scratch probe leaves the app controls untouched');
  check('the hostile fixture hides and covers an outside control through the pre-fix ChatView and plan options');
  // The same pre-fix pipeline must be measurable here, or "0 requests" below would only mean the counter is blind.
  await sleep(800);
  await page.evaluate(html => window.__markdownQA.legacyFetch(html), legacyChat.replaceAll('/tracker.png', '/legacy-fetch.png'));
  assert.equal(await waitForHit('/legacy-fetch.png', 1), 1, 'the pre-fix pipeline does fetch the remote image');
  check(`the request counter sees the pre-fix pipeline fetch ${imageOrigin}/legacy-fetch.png exactly once`);

  resetHits();
  await sleep(500);
  resetHits();
  const forbidden = ['script', 'style', 'iframe', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'svg', 'math', 'dialog', 'object', 'embed'];
  for (const surface of ['live', 'history', 'plan', 'group', 'file']) {
    const before = await outside();
    await page.evaluate(([surface, text]) => window.__markdownQA.render(surface, text), [surface, hostile]);
    assert.deepEqual(await outside(), before, `${surface}: hostile Markdown must not change any control outside the message`);
    const dom = await inspect(surface);
    // A remote image is inert everywhere now (F17): the message keeps no live image element and makes no request.
    assert.deepEqual(dom.tags.filter(tag => forbidden.includes(tag)), [], `${surface}: no active or styling elements survive`);
    assert.equal(dom.styleElements, 0, `${surface}: no style element`);
    assert.equal(dom.styleAttributes, 0, `${surface}: no inline style attribute`);
    assert.deepEqual(dom.activeUrls, [], `${surface}: no javascript: url`);
    assert.ok(dom.ids.every(id => id.startsWith('user-content-')), `${surface}: ids are namespace-prefixed: ${dom.ids.join(',')}`);
    assert.ok(dom.names.every(name => name === null || name.startsWith('user-content-')), `${surface}: names are namespace-prefixed`);
    assert.ok(dom.classNames.every(name => /^(?:language-[a-z0-9+#._-]{1,32}|task-list|task-list-item|contains-task-list)$/i.test(name)), `${surface}: only renderer-generated classes remain: ${dom.classNames.join(',')}`);
    assert.equal(dom.images, 0, `${surface}: a remote image never becomes a live <img>`);
    assert.equal(dom.remoteImages.length, surface === 'group' ? 0 : 1, `${surface}: ${surface === 'group' ? 'group chat drops images' : 'the remote image is an inert placeholder'}`);
    if (surface !== 'group') {
      const [placeholder] = dom.remoteImages;
      assert.equal(placeholder.host, imageHost, `${surface}: the placeholder names the origin`);
      assert.equal(placeholder.alt, 'remote', `${surface}: the placeholder shows the alt text`);
      assert.equal(placeholder.src, '', `${surface}: the placeholder carries no src`);
      assert.match(placeholder.action, /^(?:Load image|载入图片)$/, `${surface}: the placeholder offers one load action`);
    }
    assert.equal(dom.fileReferences, 0, `${surface}: no untrusted file-reference metadata`);
    check(`${surface}: hostile Markdown cannot restyle, spoof or hide controls outside the message`);
  }
  assert.equal(totalHits(), 0, `rendering hostile Markdown made no request (${[...hits.keys()].join(',')})`);
  check('live, history, plan, group and file-preview rendering of hostile Markdown makes 0 network requests');

  await page.evaluate(text => window.__markdownQA.render('history', text), 'See <a href="/x" data-threadterm-file-reference="{&quot;path&quot;:&quot;secret.txt&quot;}">meta</a>.');
  assert.equal((await inspect('history')).fileReferences, 0, 'history drops model-injected file-reference metadata');
  check('history ignores file-reference metadata a model wrote into the Markdown');

  await page.evaluate(text => window.__markdownQA.render('live', text), benign);
  const content = await page.evaluate(() => window.__markdownQA.content('live'));
  assert.equal(content.heading, 'Release notes');
  assert.deepEqual(content.cells, ['item', 'state', 'markdown', 'ok']);
  assert.match(content.code, /const total = 1;/);
  assert.match(content.codeClass, /(?:^|\s)language-ts(?:\s|$)/);
  assert.ok(content.pre >= 1, 'code block keeps its pre');
  assert.equal(content.link, 'docs');
  assert.deepEqual(content.references.map(reference => reference.path), ['src/app.ts']);
  const extras = await page.evaluate(() => window.__markdownQA.inspect('live').classNames);
  assert.ok(extras.includes('language-ts') && extras.includes('language-mermaid') && extras.includes('language-json'), `extras keep their language classes: ${extras.join(',')}`);
  check('benign Markdown keeps headings, tables, typed code blocks, extras fences, links and file references');

  // F17: every other spelling of a remote asset stays inert until the reader loads that one image.
  resetHits();
  for (const surface of ['live', 'history', 'plan', 'file']) {
    await page.evaluate(([surface, text]) => window.__markdownQA.render(surface, text), [surface, remoteFor(imageOrigin, imageHost)]);
    const dom = await inspect(surface);
    assert.equal(dom.images, 0, `${surface}: no image element is reachable through any attribute spelling`);
    assert.equal(dom.remoteImages.length, 3, `${surface}: markdown, picture and protocol-relative images each keep a placeholder: ${dom.remoteImages.map(image => image.source).join(',')}`);
    for (const placeholder of dom.remoteImages) {
      assert.equal(placeholder.src, '', `${surface}: placeholder ${placeholder.source} has no src`);
      assert.match(placeholder.action, /^Load image$/, `${surface}: placeholder ${placeholder.source} offers a load action`);
      assert.equal(placeholder.host, imageHost, `${surface}: placeholder ${placeholder.source} names the origin`);
    }
    assert.equal(dom.remoteImages[0].alt, 'Release chart');
    assert.equal(dom.remoteImages[0].source, `${imageOrigin}/markdown.png`);
    await sleep(200);
    assert.equal(totalHits(), 0, `${surface}: rendering remote assets made no request (${[...hits.keys()].join(',')})`);
    check(`${surface}: img, srcset, picture, svg image and CSS url() cannot fetch while rendering`);
  }
  // Local images keep working: a data: source stays a real image with its src intact.
  await page.evaluate(text => window.__markdownQA.render('live', text), 'Kept: ![inline](data:image/png;base64,iVBORw0KGgo=)');
  const local = await inspect('live');
  assert.equal(local.images, 1, 'a data: image stays an image');
  assert.equal(local.imageSources[0], 'data:image/png;base64,iVBORw0KGgo=', 'a data: image keeps its source');
  assert.equal(local.remoteImages.length, 0, 'a data: image gets no placeholder');
  assert.equal(totalHits(), 0, 'a data: image needs no network');
  await page.evaluate(text => window.__markdownQA.render('live', text), 'Kept: ![workspace](assets/logo.png)');
  const workspace = await inspect('live');
  assert.equal(workspace.images, 1, 'a workspace-relative image is left to the surface that resolves it');
  assert.equal(workspace.imageSources[0], 'assets/logo.png', 'a workspace-relative image keeps its source');
  check('data: and workspace-relative images keep working exactly as before');

  // One click, one request: the placeholder is the only way an image URL is ever fetched.
  await page.evaluate(text => window.__markdownQA.render('live', text), `Remote: ![chart](${imageOrigin}/chart.png)`);
  resetHits();
  await page.click('[data-surface="live"] [data-remote-image-load]');
  await page.waitForFunction(() => Boolean(document.querySelector('[data-surface="live"] img.md-remote-image-loaded')));
  assert.equal(await waitForHit('/chart.png', 1), 1, 'the click fetches exactly the one image the reader asked for');
  const loaded = await inspect('live');
  assert.equal(loaded.remoteImages.length, 0, 'the loaded image replaces its placeholder');
  assert.deepEqual(loaded.imageSources, [`${imageOrigin}/chart.png`], 'the loaded image uses the authored source');
  assert.equal(loaded.images, 1, 'exactly one image appeared');
  await sleep(300);
  assert.equal(totalHits(), 1, 'nothing else is fetched');
  check('clicking Load image fetches exactly that one image, once');
  // Not persisted: the next render of the same text is inert again.
  await page.evaluate(text => window.__markdownQA.render('history', text), `Remote: ![chart](${imageOrigin}/chart.png)`);
  const replay = await inspect('history');
  assert.equal(replay.images, 0, 'a replay of the same text is inert again');
  assert.equal(replay.remoteImages.length, 1, 'a replay shows the placeholder again');
  await sleep(200);
  assert.equal(totalHits(), 1, 'a replay makes no new request: loading is not remembered');
  check('loading is per image and per view: a replay is inert again');

  // The production React path (ChatMarkdown maps extras-bearing messages into elements).
  resetHits();
  await page.evaluate(text => window.__markdownQA.render('chat-react', text), `Flow:\n\n![flow](${imageOrigin}/react.png)\n\n\`\`\`json\n{"ok":true}\n\`\`\``);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-surface="chat-react"] .md-remote-image')));
  const reactBefore = await inspect('chat-react');
  assert.equal(reactBefore.images, 0, 'the React renderer also shows no image element');
  assert.equal(reactBefore.remoteImages.length, 1, 'the React renderer shows the same placeholder');
  assert.equal(reactBefore.remoteImages[0].host, imageHost);
  assert.equal(await page.evaluate(() => window.__markdownQA.lastError()), undefined, 'the React render raises no page error');
  await sleep(200);
  assert.equal(totalHits(), 0, 'the React renderer makes no request');
  await page.click('[data-surface="chat-react"] [data-remote-image-load]');
  await page.waitForFunction(() => Boolean(document.querySelector('[data-surface="chat-react"] img.md-remote-image-loaded')));
  assert.equal(await waitForHit('/react.png', 1), 1, 'the React load action fetches exactly one image');
  await sleep(300);
  assert.equal(totalHits(), 1, 'the React path fetches nothing else');
  // Not global: a different image in the same view mounts inert again.
  await page.evaluate(text => window.__markdownQA.render('chat-react', text), `Flow:\n\n![other](${imageOrigin}/react-second.png)\n\n\`\`\`json\n{"ok":true}\n\`\`\``);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-surface="chat-react"] .md-remote-image')));
  const reactAfter = await inspect('chat-react');
  assert.equal(reactAfter.images, 0, 'another image in the same view starts inert');
  assert.deepEqual(reactAfter.remoteImages.map(image => image.source), [`${imageOrigin}/react-second.png`]);
  await sleep(300);
  assert.equal(totalHits(), 1, 'the next image is not fetched without its own click');
  check('the React Markdown renderer keeps remote images inert through its own component');

  // Placeholder copy and provenance in English and Chinese, light and dark.
  const screenshotText = `Remote image: ![Release chart](${imageOrigin}/screenshot.png)`;
  await page.evaluate(text => window.__markdownQA.render('live', text), screenshotText);
  await capture('markdown-policy-light.png');
  await page.evaluate(() => window.__markdownQA.setTheme('dark'));
  await capture('markdown-policy-dark.png');
  await page.evaluate(() => window.__markdownQA.setTheme('light'));
  await page.evaluate(() => window.__markdownQA.setLanguage('zh-CN'));
  await page.evaluate(text => window.__markdownQA.render('live', text, true), `远端图片：![构建图表](${imageOrigin}/screenshot.png)`);
  const zhPlaceholder = (await inspect('live')).remoteImages[0];
  assert.equal(zhPlaceholder.action, '载入图片', 'the load action is translated');
  assert.equal(zhPlaceholder.hostText, imageHost, 'the host is shown in both languages');
  assert.equal(zhPlaceholder.label, `远端图片 ${imageHost}`);
  await capture('markdown-policy-remote-image-zh-light.png');
  await page.evaluate(() => window.__markdownQA.setTheme('dark'));
  await capture('markdown-policy-remote-image-zh-dark.png');
  await page.evaluate(() => { window.__markdownQA.setTheme('light'); window.__markdownQA.setLanguage('en'); });
  await page.evaluate(text => window.__markdownQA.render('live', text), screenshotText);
  await capture('markdown-policy-remote-image-en-light.png');
  await page.evaluate(() => window.__markdownQA.setTheme('dark'));
  await capture('markdown-policy-remote-image-en-dark.png');
  await page.evaluate(() => window.__markdownQA.setTheme('light'));
  check('the placeholder shows alt text, origin and a translated load action in light and dark');

  assert.equal(await page.evaluate(() => window.__pwned === undefined), true, 'no injected script ran');
  assert.deepEqual(report.errors, [], 'fixture has no page errors');
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  console.error(report.errors.at(-1));
  process.exitCode = 1;
} finally {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\r\n');
  await app?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (imageServer) { imageServer.closeAllConnections?.(); imageServer.close(); }
  if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {});
  const resolved = resolve(scratch);
  if (dirname(resolved).toLowerCase() === tempRoot.toLowerCase() && basename(resolved).startsWith('tt-markdown-policy-')) await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));

// Isolated regression QA for the shared hostile-Markdown policy (F03).
// Desktop1 opens one static fixture page built from the real marked + DOMPurify + renderer/src/markdownPolicy.ts.
// No runtime, provider or user profile is involved: the page only renders Markdown into app-styled containers.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
let app, server, locked = false;
const report = { passed: false, checks: [], screenshots: [], errors: [] };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const check = label => { report.checks.push(label); console.log(`PASS ${label}`); };

// The block starts with prose so DOMPurify's document parse keeps the <style> in <body> instead of hoisting it to <head>.
const hostile = [
  'Release is ready. <style>button{display:none!important}#outside-approve{visibility:hidden}</style>',
  '<div style="position:fixed;inset:0;z-index:9999;background:red">overlay</div>',
  '<span class="btn btn-primary chat-compose-send" id="root" name="outside-approve">Spoofed send</span>',
  '<iframe src="https://example.invalid/frame"></iframe>',
  '<form action="https://example.invalid/"><input name="field"><button type="submit">Submit</button></form>',
  '<img src="https://example.invalid/tracker.png" alt="remote">',
  '<a href="javascript:window.__pwned=1">bad link</a>',
  '<svg><text>svg</text></svg><audio src="https://example.invalid/a.mp3"></audio>',
  '<script>window.__pwned = true</script>',
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
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { parseChatMarkdown } from '${join(root, 'renderer/src/chatMath.ts').replaceAll('\\', '/')}';
import { parseMarkdownFileReference } from '${join(root, 'renderer/src/fileReferences.ts').replaceAll('\\', '/')}';
import { sanitizeMarkdownHtml } from '${join(root, 'renderer/src/markdownPolicy.ts').replaceAll('\\', '/')}';
import '${join(root, 'renderer/src/styles.css').replaceAll('\\', '/')}';

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
const pipelines: Record<string, (text: string) => string> = {
  live: text => sanitizeMarkdownHtml(decorate(String(parseChatMarkdown(text)))),
  history: text => sanitizeMarkdownHtml(String(marked.parse(text, { gfm: true, breaks: true, async: false })), { forbidFileReferences: true }),
  plan: text => sanitizeMarkdownHtml(String(marked.parse(text, { async: false }))),
  group: text => sanitizeMarkdownHtml(decorate(String(parseChatMarkdown(text))), { forbidImages: true }),
};

// The pre-fix options, kept only to prove this fixture really attacks controls when no policy is applied.
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
  render: (surface: string, text: string) => { const node = container(surface); node.innerHTML = pipelines[surface](text); },
  inspect: (surface: string) => {
    const node = container(surface);
    return {
      tags: Array.from(node.querySelectorAll('*')).map(element => element.tagName.toLowerCase()),
      styleElements: node.querySelectorAll('style').length,
      styleAttributes: node.querySelectorAll('[style]').length,
      classNames: Array.from(node.querySelectorAll('[class]')).flatMap(element => Array.from(element.classList)),
      ids: Array.from(node.querySelectorAll('[id]')).map(element => element.id),
      names: Array.from(node.querySelectorAll('[name]')).map(element => element.getAttribute('name')),
      images: node.querySelectorAll('img').length,
      activeUrls: Array.from(node.querySelectorAll('[href],[src]')).map(element => element.getAttribute('href') ?? element.getAttribute('src') ?? '').filter(value => /^javascript:/i.test(value)),
      fileReferences: node.querySelectorAll('[data-threadterm-file-reference]').length,
    };
  },
  outside: () => Array.from(document.querySelectorAll('[data-outside]')).map(node => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return { id: (node as HTMLElement).id, display: style.display, visibility: style.visibility, opacity: style.opacity, position: style.position, rect: [rect.x, rect.y, rect.width, rect.height].map(Math.round), text: node.textContent };
  }),
  legacy: (surface: string, text: string) => legacy(surface, text),
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
  await writeFile(join(fixture, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head>
<body><main class="markdown-policy-fixture">
<section class="fixture-controls" aria-label="App controls outside the message"><button id="outside-approve" class="btn btn-primary" data-outside="approve">Approve &amp; build</button><button id="outside-send" class="btn chat-compose-send" data-outside="send">Send</button></section>
<section class="fixture-messages">
<div class="v3-chat-message is-codex assistant"><div class="v3-message-text codex-markdown" data-surface="live"></div></div>
<div class="history-transcript-item history-message-assistant"><div class="v3-message-text codex-markdown" data-surface="history"></div></div>
<div class="chat-approval-card chat-plan-approval pending"><div class="codex-markdown" data-surface="plan"></div></div>
<div class="gc-markdown" data-surface="group"></div>
</section>
<div id="legacy" hidden></div>
</main><script type="module" src="/app.js"></script></body></html>`);
  await writeFile(join(fixture, 'entry.ts'), entry);
  await writeFile(join(fixture, 'fixture.css'), `.markdown-policy-fixture{display:grid;gap:12px;padding:12px;max-width:760px;font:13px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--text)}
.fixture-controls{display:flex;gap:8px}
.fixture-messages{display:grid;gap:10px}
[data-surface]{padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}\n`);
  await esbuild({ entryPoints: [join(fixture, 'entry.ts')], bundle: true, format: 'esm', target: 'chrome120', outfile: join(renderer, 'app.js'), nodePaths: [join(root, 'node_modules')], absWorkingDir: root, logLevel: 'error' });
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
  page.on('pageerror', error => report.errors.push(String(error)));
  await page.goto(`${server.origin}/`);
  await page.waitForFunction(() => Boolean(window.__markdownQA));
  const outside = () => page.evaluate(() => window.__markdownQA.outside());
  const initial = await outside();
  assert.equal(initial.length, 2);
  for (const control of initial) assert.ok(control.rect[2] > 0 && control.rect[3] > 0, `outside control ${control.id} starts visible`);
  check('fixture starts with two visible app controls outside every message');

  // Without this the containment checks below would prove nothing: the same hostile text must defeat the pre-fix options.
  const legacyChat = await page.evaluate(text => window.__markdownQA.legacy('chat', text), hostile);
  const legacyPlan = await page.evaluate(text => window.__markdownQA.legacy('plan', text), hostile);
  assert.match(legacyChat, /<style/i, 'pre-fix ChatView options retain the style element');
  assert.match(legacyPlan, /style="[^"]*position:\s*fixed/i, 'pre-fix PlanApprovalCard defaults retain inline styles');
  const chatLeak = await page.evaluate(html => window.__markdownQA.legacyLeaks(html), legacyChat);
  const planLeak = await page.evaluate(html => window.__markdownQA.legacyLeaks(html), legacyPlan);
  assert.equal(chatLeak.hidden, true, 'pre-fix ChatView options let hostile Markdown hide a control outside the message');
  assert.equal(planLeak.covered, true, 'pre-fix plan defaults let hostile Markdown cover a control outside the message');
  assert.deepEqual(await outside(), initial, 'the scratch probe leaves the app controls untouched');
  check('the hostile fixture hides and covers an outside control through the pre-fix ChatView and plan options');

  const forbidden = ['script', 'style', 'iframe', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'svg', 'math', 'dialog', 'object', 'embed'];
  for (const surface of ['live', 'history', 'plan', 'group']) {
    const before = await outside();
    await page.evaluate(([surface, text]) => window.__markdownQA.render(surface, text), [surface, hostile]);
    assert.deepEqual(await outside(), before, `${surface}: hostile Markdown must not change any control outside the message`);
    const dom = await page.evaluate(surface => window.__markdownQA.inspect(surface), surface);
    assert.deepEqual(dom.tags.filter(tag => forbidden.includes(tag)), [], `${surface}: no active or styling elements survive`);
    assert.equal(dom.styleElements, 0, `${surface}: no style element`);
    assert.equal(dom.styleAttributes, 0, `${surface}: no inline style attribute`);
    assert.deepEqual(dom.activeUrls, [], `${surface}: no javascript: url`);
    assert.ok(dom.ids.every(id => id.startsWith('user-content-')), `${surface}: ids are namespace-prefixed: ${dom.ids.join(',')}`);
    assert.ok(dom.names.every(name => name === null || name.startsWith('user-content-')), `${surface}: names are namespace-prefixed`);
    assert.ok(dom.classNames.every(name => /^(?:language-[a-z0-9+#._-]{1,32}|task-list|task-list-item|contains-task-list)$/i.test(name)), `${surface}: only renderer-generated classes remain: ${dom.classNames.join(',')}`);
    assert.equal(dom.images, surface === 'group' ? 0 : 1, `${surface}: ${surface === 'group' ? 'group chat drops images' : 'images stay (inert remote images remain F17)'}`);
    assert.equal(dom.fileReferences, 0, `${surface}: no untrusted file-reference metadata`);
    check(`${surface}: hostile Markdown cannot restyle, spoof or hide controls outside the message`);
  }

  await page.evaluate(text => window.__markdownQA.render('history', text), 'See <a href="/x" data-threadterm-file-reference="{&quot;path&quot;:&quot;secret.txt&quot;}">meta</a>.');
  assert.equal(await page.evaluate(() => window.__markdownQA.inspect('history').fileReferences), 0, 'history drops model-injected file-reference metadata');
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
  await capture('markdown-policy-light.png');
  await page.evaluate(() => window.__markdownQA.setTheme('dark'));
  await capture('markdown-policy-dark.png');
  await page.evaluate(() => window.__markdownQA.setTheme('light'));

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
  if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {});
  const resolved = resolve(scratch);
  if (dirname(resolved).toLowerCase() === tempRoot.toLowerCase() && basename(resolved).startsWith('tt-markdown-policy-')) await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));

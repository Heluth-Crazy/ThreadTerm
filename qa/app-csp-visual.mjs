// Real-app check of the app-document Content-Security-Policy (task 10-23 R3d, review F03/F17 follow-up):
//   1. a production renderer build of the app (vite.config.ts → desktop/src/appCsp.ts) boots with zero CSP violations,
//   2. the inline pre-paint launch-screen script runs under its build-time sha256, and the app's own CSS/images load,
//   3. the mechanisms rich Markdown needs (style elements, style attributes, data: images) are still allowed,
//   4. hostile content in the app document cannot run inline script, fetch remote script/style, submit a form, set a
//      base URL or embed an object — proven by violation events and by the loopback server never being contacted
//      (the only remote source the policy deliberately allows is an image, which F17 keeps user-triggered),
//   5. the policy header the main process sets is live (the app cannot be framed) and the Vite dev server still works
//      under its documented dev-only relaxation (HMR websocket + inline preamble, zero violations).
// Isolated Electron (own data, profile and pipe; app bundle cached in the git-ignored runtime/target-qa folder) via
// qa/lib/desktop1.mjs; PATH holds only node and System32, so no agent CLI can start. Every CSP violation is recorded
// by qa/lib/csp-audit-preload.cjs through TT_QA_CSP_AUDIT (QA-only, not shipped).
//   node qa/app-csp-visual.mjs [--rebuild] [--keep]
// Screenshots: qa/results/app-csp/.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild, createServer as createDevServer } from 'vite';
import { electron } from './lib/desktop1.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
assert.ok(existsSync(runtime), `missing ${runtime}`);
const keep = process.argv.includes('--keep');
const scratch = await mkdtemp(join(tmpdir(), 'tt-app-csp-'));
const appDir = join(root, 'runtime/target-qa/app-csp-qa-app');
const out = join(root, 'qa/results/app-csp');
const report = { passed: false, checks: [], shots: [], violations: [], requests: [], errors: [] };
const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const delay = ms => new Promise(done => setTimeout(done, ms));
let app, page, server, devServer, cspLog, loopbackHits = [], consoleMessages = [], responses = [];

/** Loopback origin that hostile content points at; nothing here may be reached except the image the policy allows. */
async function startLoopback() {
  const hits = [];
  server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (request.url === '/evil.js') { response.setHeader('Content-Type', 'text/javascript'); response.end('window.__remoteScriptRan = 1;'); return; }
    if (request.url === '/evil.css') { response.setHeader('Content-Type', 'text/css'); response.end('body { display: none !important; }'); return; }
    // 1×1 transparent PNG.
    response.setHeader('Content-Type', 'image/png');
    response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}

async function prepare() {
  const rebuild = process.argv.includes('--rebuild') || !existsSync(join(appDir, 'renderer', 'index.html'));
  if (!rebuild) { console.log(`reusing the QA app bundle in ${appDir} (--rebuild to rebuild)`); return; }
  console.log('building the QA app bundle…');
  await mkdir(appDir, { recursive: true });
  for (const name of ['main', 'preload']) {
    await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  }
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'threadterm-v3-app-csp-qa', version: '0.1.0', main: 'main.cjs' }));
}

function environment(extra = {}) {
  const dropped = /^(path|claudecode|claude_code_.*|claude_pid|claude_effort|threadterm_.*|electron_run_as_node|tt_qa_.*)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !dropped.test(key)));
  return Object.assign(env, {
    // Only node and System32: no agent CLI can be discovered by accident.
    Path: [dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';'),
    TEMP: scratch, TMP: scratch,
    THREADTERM_CLAUDE_NODE: process.execPath,
    TT_QA_CSP_AUDIT: '1',
  }, extra);
}

async function launchApp(label, { devUrl } = {}) {
  const name = devUrl ? 'dev' : 'production';
  cspLog = join(scratch, `csp-${name}.jsonl`);
  consoleMessages = [];
  responses = [];
  app = await electron.launch({
    args: ['--disable-features=CalculateNativeWinOcclusion', appDir],
    cwd: root,
    env: environment({
      THREADTERM_V3_DATA: join(scratch, name, 'data'), THREADTERM_V3_USER_DATA: join(scratch, name, 'profile'),
      THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-app-csp-${name}-${randomUUID()}`, THREADTERM_V3_RUNTIME: runtime,
      TT_QA_CSP_LOG: cspLog, ...(devUrl ? { THREADTERM_V3_DEV_SERVER_URL: devUrl } : {}),
    }),
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.errors.push(`${label}: ${error.message}`));
  page.on('console', message => consoleMessages.push(message.text()));
  page.on('response', response => { if (response.request().resourceType() === 'document') responses.push({ url: response.url(), headers: response.headers() }); });
  return page;
}

async function closeApp() {
  if (!app) return;
  if (page) await page.evaluate(() => window.threadterm?.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => {});
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await Promise.race([app.close(), delay(5000)]).catch(() => {});
  try { app.process()?.kill(); } catch { /* already gone */ }
  app = undefined; page = undefined;
}

async function boot() {
  await page.waitForFunction(() => Boolean(document.querySelector('.app-shell .content.main')), null, { timeout: 60000 });
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30000 });
  await delay(400);
}

async function violations() {
  try {
    const text = await readFile(cspLog, 'utf8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch { return []; }
}
const devOrigin = () => { try { return new URL(appUrl).origin; } catch { return undefined; } };
let appUrl = '';
const appDocument = entry => entry.where.includes('/app-csp-qa-app/renderer/index.html') || (appUrl && entry.where.startsWith(`${devOrigin()}/`));
const appViolations = async () => (await violations()).filter(appDocument);
const waitForViolation = async (directive, timeout = 8000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const match = (await violations()).find(entry => entry.directive === directive);
    if (match) return match;
    await delay(100);
  }
  return undefined;
};
/** Polls a sync read until it is truthy or the timeout expires. */
const waitFor = async (read, timeout) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = read();
    if (value) return value;
    await delay(100);
  }
  return undefined;
};
const shot = async name => { await page.screenshot({ path: join(out, name) }); report.shots.push(name); };

/** A framed document must never be the app itself: frame-ancestors lives in the header, not in the meta tag. */
async function assertFramingRefused(label) {
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'qa-self-frame'; frame.src = location.href; document.body.appendChild(frame); });
  const refused = await waitFor(() => consoleMessages.find(text => /frame-ancestors 'none'/i.test(text)), 8000);
  await delay(800);
  const framedUrl = await page.evaluate(() => { const frame = document.getElementById('qa-self-frame'); return frame?.contentDocument?.URL ?? 'no-document'; });
  await page.evaluate(() => document.getElementById('qa-self-frame')?.remove());
  assert.ok(framedUrl !== page.url() && !framedUrl.startsWith(devOrigin() ?? 'http://none'), `${label}: the app document cannot be framed (got ${framedUrl})`);
  return { framedUrl, refused };
}

try {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await prepare();
  const loopback = await startLoopback();
  loopbackHits = loopback.hits;
  report.loopback = loopback.origin;

  // ---------------------------------------------------------------- production build (file:// document)
  await launchApp('production');
  appUrl = page.url();
  report.document = appUrl;
  await boot();
  assert.deepEqual(await appViolations(), [], 'the packaged app document loads with no CSP violation');
  check('the production app boots with zero CSP violations (launch screen, app shell, app CSS and bundle)');

  const policy = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
  report.meta = policy;
  const directives = policy.split('; ');
  for (const directive of ["style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: http: https:", "font-src 'self' data:", "connect-src 'self'", "media-src 'self' data: blob:", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(directives.includes(directive), `the built document carries ${directive}`);
  }
  // R3d2: no frame governance here — a frame list in the embedding document also governs the sandboxed HTTP/HTML
  // previews' own navigations (desktop/src/appCsp.ts explains why); the previews' own policies own frames.
  for (const name of ['default-src', 'frame-src', 'child-src']) {
    assert.ok(!directives.some(directive => directive.startsWith(`${name} `)), `the app policy leaves frames alone (no ${name})`);
  }
  assert.match(policy, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'(;|$)/, 'script-src is self plus the boot-script hash');
  assert.doesNotMatch(policy, /script-src[^;]*unsafe/, 'production never relaxes script-src');
  assert.doesNotMatch(policy, /frame-ancestors/, 'the meta tag leaves frame-ancestors to the header');
  check('the built document carries the reviewed policy with the boot-script sha256');
  const appCss = await page.evaluate(() => ({ sheets: document.styleSheets.length, background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), scripts: [...document.querySelectorAll('script[type=module][src]')].map(node => node.getAttribute('src')) }));
  assert.ok(appCss.sheets > 0, 'the app stylesheet is loaded under style-src');
  assert.ok(appCss.background.length > 0, 'the app CSS custom properties resolved');
  assert.ok(appCss.scripts.length > 0, 'the app bundle is a self module script');
  check(`app CSS (${appCss.sheets} sheet(s), --bg ${appCss.background}) and the module bundle load under 'self'`);
  await shot('01-app-under-csp.png');

  // The inline pre-paint script must run: it is the only inline script production allows, by hash.
  await page.evaluate(() => localStorage.setItem('threadterm.v3.boot-appearance', JSON.stringify({ theme: 'dark', locale: 'zh-CN' })));
  await page.reload({ waitUntil: 'commit' });
  await page.waitForFunction(() => Boolean(document.getElementById('boot-splash')?.dataset.theme), null, { timeout: 20000 });
  const splash = await page.evaluate(() => { const node = document.getElementById('boot-splash'); return { theme: node.dataset.theme, lang: node.lang }; });
  assert.deepEqual(splash, { theme: 'dark', lang: 'zh-CN' }, 'the hashed pre-paint script applied the remembered appearance');
  await shot('02-boot-splash-hash-ok.png');
  await boot();
  assert.deepEqual(await appViolations(), [], 'no violation during the reload with the hashed inline script');
  check('the inline pre-paint script runs under its build-time sha256 (dark + zh-CN from the first frame)');

  // Rich Markdown's mechanisms: KaTeX/Mermaid write <style> elements, React/CodeMirror write style attributes.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '#qa-inline-host { color: rgb(1, 2, 3); }';
    document.head.appendChild(style);
    const host = document.createElement('div');
    host.id = 'qa-inline-host';
    host.setAttribute('style', 'background-color: rgb(4, 5, 6)');
    document.body.appendChild(host);
    const image = new Image();
    image.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    document.body.appendChild(image);
  });
  await delay(500);
  const mechanisms = await page.evaluate(() => {
    const host = document.getElementById('qa-inline-host');
    return { color: getComputedStyle(host).color, background: getComputedStyle(host).backgroundColor, pixels: [...document.images].filter(image => image.src.startsWith('data:')).map(image => image.naturalWidth) };
  });
  assert.equal(mechanisms.color, 'rgb(1, 2, 3)', 'an inline <style> element still applies');
  assert.equal(mechanisms.background, 'rgb(4, 5, 6)', 'an inline style attribute still applies');
  assert.ok(mechanisms.pixels.includes(1), 'a data: image still loads');
  assert.deepEqual(await appViolations(), [], 'the mechanisms rich Markdown uses raise no violation');
  check('style elements, style attributes and data: images — what KaTeX, Mermaid, CodeMirror and React need — still work');

  // Hostile content in the app document: nothing below may run, load or submit; the loopback server must stay quiet.
  const inlineRan = await page.evaluate(origin => {
    const inline = document.createElement('script');
    inline.textContent = 'window.__inlineScriptRan = 1;';
    document.body.appendChild(inline);
    const remote = document.createElement('script');
    remote.src = `${origin}/evil.js`;
    document.body.appendChild(remote);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${origin}/evil.css`;
    document.head.appendChild(link);
    const object = document.createElement('object');
    object.data = `${origin}/evil-object`;
    object.type = 'text/html';
    document.body.appendChild(object);
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `${origin}/post`;
    document.body.appendChild(form);
    form.submit();
    return window.__inlineScriptRan;
  }, loopback.origin);
  assert.equal(inlineRan, undefined, 'a script injected into the app document does not run');
  const scriptViolation = await waitForViolation('script-src-elem');
  assert.ok(scriptViolation, 'the blocked inline script reports a script-src-elem violation');
  const styleViolation = await waitForViolation('style-src-elem');
  assert.ok(styleViolation, 'the remote stylesheet reports a style-src-elem violation');
  const objectViolation = await waitForViolation('object-src');
  assert.ok(objectViolation, 'the object element reports an object-src violation');
  const formViolation = await waitForViolation('form-action');
  assert.ok(formViolation, 'the form submission reports a form-action violation');
  await delay(1200);
  const remoteEffects = await page.evaluate(() => ({ script: window.__remoteScriptRan, hidden: getComputedStyle(document.body).display === 'none' }));
  assert.equal(remoteEffects.script, undefined, 'the remote script never executed');
  assert.equal(remoteEffects.hidden, false, 'the remote stylesheet never applied');
  assert.deepEqual(loopbackHits.filter(hit => !hit.endsWith('/evil.png')), [], `hostile content made no network request: ${loopbackHits.join(', ')}`);
  check(`inline script, remote script, remote stylesheet, object and form are blocked (${[scriptViolation, styleViolation, objectViolation, formViolation].map(entry => entry.directive).join(', ')}), zero requests reached ${loopback.origin}`);
  await shot('03-hostile-blocked.png');

  // base-uri 'none': a hostile <base> must not retarget the document's relative URLs.
  assert.equal(await page.evaluate(origin => { const base = document.createElement('base'); base.href = `${origin}/`; document.head.appendChild(base); return Boolean(document.querySelector('base')); }, loopback.origin), true, 'the base element was inserted for the test');
  assert.ok(await waitForViolation('base-uri'), 'a hostile base URL reports a base-uri violation');
  await page.evaluate(() => document.querySelector('base')?.remove());
  check("base-uri 'none' stops a hostile <base> from retargeting the document");

  // The one remote source the policy allows: an image the reader explicitly asks for (F17 keeps the decision in the UI).
  const image = await page.evaluate(origin => new Promise(done => {
    const probe = new Image();
    probe.onload = () => done({ loaded: true, width: probe.naturalWidth });
    probe.onerror = () => done({ loaded: false });
    probe.src = `${origin}/evil.png`;
  }), loopback.origin);
  assert.equal(image.loaded, true, 'a remote image is allowed once the renderer actually requests it');
  assert.ok(loopbackHits.includes('GET /evil.png'), 'the image request reached the loopback server');
  assert.equal((await violations()).find(entry => entry.directive.startsWith('img-src')), undefined, 'no img-src violation for the explicitly loaded image');
  check('img-src keeps the deliberate http(s) allowance: only an explicit image request leaves the app (F17)');

  const framed = await assertFramingRefused('production');
  check(`frame-ancestors 'none' from the main-process header blocks the app being framed (frame stayed ${framed.framedUrl})`);

  const unexpected = (await appViolations()).filter(entry => !['script-src-elem', 'style-src-elem', 'object-src', 'form-action', 'base-uri', 'frame-ancestors'].includes(entry.directive));
  assert.deepEqual(unexpected, [], `only the expected hostile-vector violations were reported: ${JSON.stringify(unexpected)}`);
  await shot('04-app-still-healthy.png');
  await closeApp();

  // ---------------------------------------------------------------- dev server (http document, HMR)
  devServer = await createDevServer({ configFile: join(root, 'vite.config.ts'), root: join(root, 'renderer'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' });
  await devServer.listen();
  const devUrl = devServer.resolvedUrls?.local?.[0];
  assert.ok(devUrl, 'the Vite dev server reported its address');
  await launchApp('dev', { devUrl });
  appUrl = page.url();
  report.devDocument = appUrl;
  await boot();
  assert.deepEqual(await appViolations(), [], `the dev app boots with no CSP violation: ${JSON.stringify(await appViolations())}`);
  const devPolicy = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
  report.devMeta = devPolicy;
  assert.match(devPolicy, /script-src [^;]*'sha256-[A-Za-z0-9+/=]+' [^;]*'unsafe-inline' 'unsafe-eval'/, 'the dev document gets the documented dev-only relaxation');
  assert.match(devPolicy, /connect-src 'self' ws: wss:/, 'dev keeps the HMR websocket reachable');
  assert.doesNotMatch(devPolicy, /frame-ancestors/, 'dev meta matches production in leaving frame-ancestors to the header');
  const hmr = await waitFor(() => consoleMessages.find(text => /\[vite\] connect|connected/i.test(text)), 15000);
  assert.ok(hmr, `the HMR client connected under connect-src (${consoleMessages.slice(-3).join(' | ')})`);
  check(`the dev server document runs under the dev-only policy: HMR connected, zero violations (${hmr.slice(0, 60)})`);
  await shot('05-dev-server-under-csp.png');
  const devFramed = await assertFramingRefused('dev');
  const devHeader = responses.map(entry => entry.headers['content-security-policy']).find(Boolean);
  report.devHeader = devHeader ?? null;
  assert.match(devHeader ?? '', /frame-ancestors 'none'/, `the dev document response carries the policy header (${JSON.stringify(responses.map(entry => entry.url))})`);
  check(`the dev document response carries the policy header and refuses to be framed (frame stayed ${devFramed.framedUrl})`);
  assert.deepEqual(await appViolations(), [], 'no violation during the dev-server run');
  await closeApp();
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(error);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  await closeApp();
  if (devServer) await devServer.close().catch(() => {});
  if (server) { server.closeAllConnections?.(); await new Promise(done => server.close(done)).catch(() => {}); }
  report.violations = await violations().catch(() => []);
  report.requests = server ? loopbackHits : [];
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (!keep) await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  console.log(report.passed && !report.errors.length ? 'APP CSP QA PASSED' : `APP CSP QA FAILED\n${report.errors.join('\n')}`);
  process.exit(report.passed && !report.errors.length ? 0 : 1);
}

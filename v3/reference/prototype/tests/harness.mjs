import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export { assert };
export const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(prototypeRoot, '..');
export const outputRoot = resolve(prototypeRoot, 'preview', 'v3');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

export async function startHarness() {
  await mkdir(outputRoot, { recursive: true });
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let path = resolve(sourceRoot, `.${pathname}`);
      if (!path.startsWith(sourceRoot + sep)) throw new Error('Out-of-scope path');
      if (pathname.endsWith('/')) path = resolve(path, 'index.html');
      const body = await readFile(path);
      response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const results = [];
  return {
    origin, browser, results,
    async newPage(options = {}) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
      const page = await context.newPage();
      const errors = [];
      const requests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('request', (request) => { if (!request.url().startsWith(origin + '/') && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) requests.push(request.url()); });
      page.setDefaultTimeout(5000);
      return { page, context, errors, requests };
    },
    async scenario(name, callback) {
      const started = Date.now();
      try {
        await callback();
        results.push({ name, status: 'passed', durationMs: Date.now() - started });
        process.stdout.write(`PASS ${name}\n`);
      } catch (error) {
        results.push({ name, status: 'failed', durationMs: Date.now() - started, error: error.stack });
        process.stderr.write(`FAIL ${name}: ${error.message}\n`);
      }
    },
    async finish(name = 'verification-results.json') {
      await writeFile(resolve(outputRoot, name), JSON.stringify({ generatedAt: new Date().toISOString(), browser: 'Chromium', results }, null, 2) + '\n');
      await browser.close();
      await new Promise((resolveClosed) => server.close(resolveClosed));
      if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
    },
  };
}

export async function enter(page, origin, source = 'threadterm-app-v3') {
  await page.goto(`${origin}/${source}/`);
  const welcome = page.getByRole('button', { name: '开始体验', exact: true });
  if (await welcome.count()) await welcome.click();
}

export async function act(page, action, attrs = {}) {
  let selector = `[data-action="${action}"]`;
  for (const [name, value] of Object.entries(attrs)) selector += `[data-${name}="${value}"]`;
  await page.locator(selector).filter({ visible: true }).first().click();
}

export async function assertBody(page, value) {
  await page.getByText(value, { exact: false }).first().waitFor({ state: 'visible' });
}

export async function screenshot(page, name) {
  await page.screenshot({ path: resolve(outputRoot, `${name}.png`), fullPage: true, animations: 'disabled' });
}

export async function assertHealthy(page, errors, requests) {
  assert.deepEqual(errors, [], 'Browser errors');
  assert.deepEqual(requests, [], 'Unexpected external requests');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'Page has horizontal overflow');
}

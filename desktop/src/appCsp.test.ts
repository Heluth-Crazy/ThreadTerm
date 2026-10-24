import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { appCspDirectives, buildAppCsp, cspScriptHashes, injectAppCspMeta } from './appCsp.js';

// The desktop test runner bundles this file to CJS and runs it from the repo root (scripts/check.mjs).
const repo = process.cwd();
const sourceHtml = readFileSync(join(repo, 'renderer', 'index.html'), 'utf8');
const sha256 = (text: string) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

/** The directive list a policy string carries, by name. */
function directives(policy: string): Map<string, string> {
  return new Map(policy.split(';').map(part => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources.join(' ')];
  }));
}

test('hashes every inline script and only the inline ones', () => {
  const html = '<script type="module" src="/src/main.tsx"></script>\n<script>a()</script>\n<script src="./x.js"></script>\n<script>b()</script>';
  assert.deepEqual(cspScriptHashes(html), [sha256('a()'), sha256('b()')]);
});

test('hashes the script text the HTML parser sees, not the raw file bytes', () => {
  // Chromium normalises CRLF/CR to LF in the input stream before tokenizing, so a CRLF file must hash as LF.
  assert.deepEqual(cspScriptHashes('<script>one();\r\ntwo();\r\n</script>'), [sha256('one();\ntwo();\n')]);
  assert.deepEqual(cspScriptHashes('<script>one();\rtwo();</script>'), [sha256('one();\ntwo();')]);
});

test('the production policy is the reviewed one, with a hash for the app boot script', () => {
  const meta = injectAppCspMeta(sourceHtml);
  const content = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(meta)?.[1];
  assert.ok(content, 'the built document carries a CSP meta tag');
  const policy = directives(content);
  const script = policy.get('script-src') ?? '';
  assert.match(script, /^'self' 'sha256-[A-Za-z0-9+/=]+'$/);
  assert.doesNotMatch(script, /unsafe-inline|unsafe-eval|http/, 'production never relaxes script-src');
  assert.equal(policy.get('style-src'), "'self' 'unsafe-inline'");
  assert.equal(policy.get('img-src'), "'self' data: blob: http: https:");
  assert.equal(policy.get('font-src'), "'self' data:");
  assert.equal(policy.get('connect-src'), "'self'");
  assert.equal(policy.get('media-src'), "'self' data: blob:");
  assert.equal(policy.get('worker-src'), "'self' blob:");
  assert.equal(policy.get('object-src'), "'none'");
  assert.equal(policy.get('base-uri'), "'none'");
  assert.equal(policy.get('form-action'), "'none'");
  // Regression (R3d2): the app policy must not govern frames. Chromium enforces frame-src in the embedding document for
  // every navigation of its child frame, so a frame list here governed the sandboxed HTML preview too and replaced a
  // preview page with an error page whenever it navigated itself to mailto: or a custom scheme. The preview's own
  // policy and the runtime grant checks own frames (qa/html-preview-sandbox-visual.mjs proves it end to end).
  for (const name of ['default-src', 'frame-src', 'child-src']) {
    assert.equal(policy.get(name), undefined, `the app document policy does not govern frames (${name})`);
  }
  assert.equal(policy.get('frame-ancestors'), undefined, 'meta-delivered frame-ancestors would be ignored');
  assert.equal(directives(buildAppCsp(cspScriptHashes(sourceHtml))).get('frame-ancestors'), "'none'", 'the header carries it');
});

test('the injected hash matches the boot script in the document it was written into', () => {
  const meta = injectAppCspMeta(sourceHtml);
  const inline = [...sourceHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(match => !/\bsrc\s*=/i.test(match[1]));
  assert.equal(inline.length, 1, 'exactly one inline script (the pre-paint launch-screen script)');
  assert.match(inline[0][2], /boot-splash/, 'the hashed script is the launch-screen one');
  const hashed = /'sha256-([A-Za-z0-9+/=]+)'/.exec(meta)?.[1];
  assert.equal(`sha256-${hashed}`, sha256(inline[0][2].replace(/\r\n?/g, '\n')), 'the meta hash is the script the browser hashes');
});

test('the meta tag lands before any script, style or image and is injected once', () => {
  const meta = injectAppCspMeta(sourceHtml);
  const at = meta.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(at > meta.indexOf('<meta charset'), 'after the charset declaration');
  assert.ok(at < meta.indexOf('<link rel="stylesheet"'), 'before the stylesheet');
  assert.ok(at < meta.indexOf('boot-splash'), 'before the launch screen');
  assert.ok(at < meta.indexOf('/src/main.tsx'), 'before the app bundle');
  assert.equal(injectAppCspMeta(meta), meta, 'injection is idempotent');
});

test('the dev policy is the only relaxation and it stays out of production', () => {
  const dev = directives(buildAppCsp([], { dev: true }));
  assert.equal(dev.get('script-src'), "'self' 'unsafe-inline' 'unsafe-eval'");
  assert.equal(dev.get('connect-src'), "'self' ws: wss:");
  assert.equal(dev.get('frame-src'), undefined, 'the dev policy keeps frames out of the app document policy too');
  assert.equal(dev.get('object-src'), "'none'");
  assert.deepEqual(appCspDirectives([], { dev: false }).filter(part => part.includes('unsafe')), ["style-src 'self' 'unsafe-inline'"]);
});

test('a built renderer, when present, carries the same policy as its source document', () => {
  let built: string;
  try { built = readFileSync(join(repo, 'desktop-dist', 'renderer', 'index.html'), 'utf8'); } catch { return; }
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(built)?.[1];
  assert.ok(meta, 'desktop-dist/renderer/index.html carries the policy (rebuild with npm run build:renderer)');
  assert.equal(meta, appCspDirectives(cspScriptHashes(built), { meta: true }).join('; '), 'hash matches the built script');
});

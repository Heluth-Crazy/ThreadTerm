import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync('desktop/src/browser/devServer.ts', 'utf8');
const code = ts.transpileModule(source, { compilerOptions:{ module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports:{} };
vm.runInNewContext(`(function(exports,module){${code}\n})(module.exports,module)`, { module });
const { MAX_DEV_SERVER_LINE_BYTES, MAX_REMEMBERED_DEV_SERVER_OFFERS, claimDevServerOffer, devServerOffer, createDevServerLineDetector } = module.exports;

test('recognizes loopback framework banners, including ANSI output', () => {
  const cases = [
    ['VITE v6.0.0  ready in 120 ms\n  ➜  Local:   http://localhost:5173/', 'http://localhost:5173'],
    ['▲ Next.js 15.0.0\n- Local:        http://localhost:3000', 'http://localhost:3000'],
    ['webpack 5 compiled successfully\n  Local: http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)', 'http://127.0.0.1:8000'],
    ['=> Booting Puma\n=> Rails 8 application starting in development\n=> Listening on http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['info: Microsoft.Hosting.Lifetime[14]\n      Now listening on: http://localhost:5108', 'http://localhost:5108'],
    ['\x1b[1m\x1b[32m  ➜  Local:\x1b[0m \x1b[36mhttp://localhost:4173/\x1b[0m', 'http://localhost:4173'],
    ['Now listening on: https://[::1]:7243', 'https://[::1]:7243'],
  ];
  for (const [line, expected] of cases) assert.equal(devServerOffer(line)?.url, expected, line);
});

test('rejects non-loopback, malformed and credential-bearing output', () => {
  for (const line of ['http://0.0.0.0:5173', 'http://192.168.1.5:3000', 'https://example.com:443', 'http://localhost.attacker:5173', 'http://localhost:5173.attacker', 'http://localhost:5173@attacker.test', 'http://user@localhost:5173', 'localhost without a port', 'http://localhost:0', 'http://localhost:65536', 'http://localhost:999999999999', 'Local: 5173']) assert.equal(devServerOffer(line), undefined, line);
});

test('handles PTY chunk boundaries without inspecting unfinished lines', () => {
  const offers = [], detector = createDevServerLineDetector(offer => offers.push(offer.url));
  detector.push('\x1b[32m  ➜  Local: http://local');
  assert.deepEqual(offers, []);
  detector.push('host:5173/\x1b[0m\r\nNext line\n');
  assert.deepEqual(offers, ['http://localhost:5173']);
  detector.reset(); detector.push('Now listening on: http://127.0.0.1:8000\n');
  assert.deepEqual(offers, ['http://localhost:5173', 'http://127.0.0.1:8000']);
});

test('does not consume disabled offers and deduplicates session plus port across remounts', () => {
  const seen = new Set(), localhost = devServerOffer('http://localhost:5173'), ipv4 = devServerOffer('http://127.0.0.1:5173');
  assert.equal(claimDevServerOffer(seen, 'session-a', localhost, false), false);
  assert.equal(claimDevServerOffer(seen, 'session-a', localhost, true), true);
  assert.equal(claimDevServerOffer(seen, 'session-a', ipv4, true), false);
  assert.equal(claimDevServerOffer(seen, 'session-b', localhost, true), true);
});

test('reassembles ANSI escapes split at a PTY chunk boundary', () => {
  const offers = [], detector = createDevServerLineDetector(offer => offers.push(offer.url));
  detector.push('\x1b[3'); detector.push('2mLocal:\x1b[0m http://localhost:4321\n');
  assert.deepEqual(offers, ['http://localhost:4321']);
});

test('bounds an unterminated line and never joins its discarded suffix into a URL', () => {
  const offers = [], detector = createDevServerLineDetector(offer => offers.push(offer.url));
  detector.push(`${'x'.repeat(MAX_DEV_SERVER_LINE_BYTES)}http://local`);
  detector.push('host:5173\nhttp://localhost:5174\n');
  assert.deepEqual(offers, ['http://localhost:5174']);
});

test('caps remembered session-port keys without evicting an existing key', () => {
  const seen = new Set();
  for (let port = 1; port <= MAX_REMEMBERED_DEV_SERVER_OFFERS; port += 1) assert.equal(claimDevServerOffer(seen, 'many-ports', { url:`http://localhost:${port}`, host:'localhost', port }, true), true);
  assert.equal(seen.size, MAX_REMEMBERED_DEV_SERVER_OFFERS);
  assert.equal(claimDevServerOffer(seen, 'many-ports', { url:'http://localhost:4000', host:'localhost', port:4000 }, true), false);
  assert.equal(claimDevServerOffer(seen, 'many-ports', { url:'http://localhost:1', host:'localhost', port:1 }, true), false);
  assert.equal(seen.size, MAX_REMEMBERED_DEV_SERVER_OFFERS);
});

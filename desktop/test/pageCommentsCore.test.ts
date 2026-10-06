import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { clipPageRect, pageCaptureRect, pageImageSize, pageRect, pageShotPath, sanitizePagePick, sanitizePageTargetRef, validPageFrameName, validPageShotId } from '../src/pageCommentsCore.js';

function elementPick() {
  return { url: 'http://localhost:5173/cart', title: 'Cart', viewport: { width: 800, height: 600 }, target: {
    type: 'element', selector: '#save', tag: 'button', label: 'button "Save"', text: 'Save', attributes: { id: 'save', 'data-testid': 'save-btn' },
    html: '<button id="save">Save</button>', rect: { x: 40, y: 100, width: 136, height: 43 },
    source: { file: 'src/Cart.tsx', line: 42, column: 3, framework: 'react' }, components: ['CartFooter', 'Cart'],
  } };
}

test('valid element data survives validation without mutation', () => {
  const raw = elementPick();
  const result = sanitizePagePick(raw);
  assert.deepEqual(result, raw);
  assert.notEqual(result?.target, raw.target);
  assert.equal(sanitizePagePick(null), null);
});

test('valid area data and viewport clipping', () => {
  const raw = { url: 'https://example.com/', title: '', viewport: { width: 800, height: 600 }, target: { type: 'area', rect: { x: -10, y: 590, width: 900, height: 50 }, elements: ['header "Shop"', 'nav "Main"'] } };
  assert.deepEqual(sanitizePagePick(raw)?.target.rect, { x: 0, y: 590, width: 800, height: 10 });
  assert.deepEqual(raw.target.rect, { x: -10, y: 590, width: 900, height: 50 });
});

const invalid: Array<[string, (pick: ReturnType<typeof elementPick>) => void]> = [
  ['non-http URL', p => { p.url = 'file:///secrets'; }],
  ['malformed URL', p => { p.url = 'http://'; }],
  ['URL too long', p => { p.url = 'https://example.com/' + 'x'.repeat(2048); }],
  ['title too long', p => { p.title = 'x'.repeat(201); }],
  ['selector too long', p => { p.target.selector = 'x'.repeat(501); }],
  ['empty selector', p => { p.target.selector = ' '; }],
  ['label too long', p => { p.target.label = 'x'.repeat(161); }],
  ['text too long', p => { p.target.text = 'x'.repeat(301); }],
  ['HTML too long', p => { p.target.html = 'x'.repeat(601); }],
  ['attribute value too long', p => { p.target.attributes.id = 'x'.repeat(301); }],
  ['value attribute', p => { Object.assign(p.target.attributes, { value: 'secret' }); }],
  ['unknown attribute', p => { Object.assign(p.target.attributes, { onclick: 'run()' }); }],
  ['password attributes', p => { p.target.tag = 'input'; Object.assign(p.target.attributes, { type: 'password' }); }],
  ['components count', p => { p.target.components = Array(7).fill('Cart'); }],
  ['component too long', p => { p.target.components = ['x'.repeat(81)]; }],
  ['source file too long', p => { p.target.source.file = 'x'.repeat(401); }],
  ['source line zero', p => { p.target.source.line = 0; }],
  ['source column fractional', p => { p.target.source.column = 1.5; }],
  ['source position unsafe', p => { p.target.source.line = Number.MAX_SAFE_INTEGER + 1; }],
  ['source framework', p => { p.target.source.framework = 'unknown'; }],
  ['viewport over limit', p => { p.viewport.width = 10001; }],
  ['viewport zero', p => { p.viewport.height = 0; }],
  ['non-finite number', p => { p.target.rect.x = NaN; }],
  ['negative dimensions', p => { p.target.rect.width = -1; }],
  ['unknown target', p => { p.target.type = 'pin'; }],
  ['malformed tag', p => { p.target.tag = '<script>'; }],
  ['injected shot', p => { Object.assign(p, { shot: { path: 'C:\\secret' } }); }],
];
for (const [name, change] of invalid) test(`sanitiser rejects ${name}`, () => {
  const raw = elementPick();
  change(raw);
  assert.throws(() => sanitizePagePick(raw));
});

test('every string boundary rejects control characters and invalid types', () => {
  const paths = ['url', 'title', 'target.selector', 'target.tag', 'target.label', 'target.text', 'target.html', 'target.attributes.id', 'target.source.file', 'target.components.0'];
  for (const path of paths) {
    for (const bad of ['a\u0000b', 'a\nb', 'a\u007fb', 'a\u0085b', 7, null, {}]) {
      const raw = elementPick();
      const parts = path.split('.');
      let current: Record<string, unknown> = raw;
      for (const key of parts.slice(0, -1)) current = current[key] as Record<string, unknown>;
      current[parts.at(-1)!] = bad;
      assert.throws(() => sanitizePagePick(raw), path);
    }
  }
  for (const bad of [undefined, [], 4, { url: 'https://example.com' }, { ...elementPick(), viewport: [] }]) assert.throws(() => sanitizePagePick(bad));
  const raw = elementPick();
  Object.assign(raw.target.rect, { x: '40' });
  assert.throws(() => sanitizePagePick(raw));
});

test('area labels are bounded by eight and 160 characters each', () => {
  const raw = { ...elementPick(), target: { type: 'area', rect: { x: 0, y: 0, width: 800, height: 600 }, elements: Array(8).fill('x'.repeat(160)) } };
  assert.ok(sanitizePagePick(raw));
  raw.target.elements.push('ninth');
  assert.throws(() => sanitizePagePick(raw));
  raw.target.elements = ['x'.repeat(161)];
  assert.throws(() => sanitizePagePick(raw));
  raw.target.elements = ['line\nbreak'];
  assert.throws(() => sanitizePagePick(raw));
  Object.assign(raw.target, { elements: 'not an array' });
  assert.throws(() => sanitizePagePick(raw));
});

test('maximum allowed string lengths, list counts, and viewport are accepted', () => {
  const raw = elementPick();
  raw.url = 'https://example.com/' + 'x'.repeat(2048 - 20);
  raw.title = 't'.repeat(200);
  Object.assign(raw.target, { selector: 's'.repeat(500), label: 'l'.repeat(160), text: 't'.repeat(300), html: 'h'.repeat(600), components: Array(6).fill('c'.repeat(80)) });
  raw.target.attributes.id = 'a'.repeat(300);
  raw.target.source.file = 'f'.repeat(400);
  raw.viewport = { width: 10000, height: 10000 };
  assert.ok(sanitizePagePick(raw));
});

test('optional element metadata and a redacted password input are valid', () => {
  const raw = { ...elementPick(), target: { type: 'element', tag: 'input', label: 'input', selector: 'body > input:nth-of-type(1)', attributes: {}, html: '<input>', rect: { x: 1, y: 2, width: 10, height: 20 } } };
  assert.deepEqual(sanitizePagePick(raw), raw);
});

test('preview names are confined to the exact namespace and length', () => {
  for (const name of ['tt-preview-abcdefgh', 'tt-preview-' + randomUUID(), 'tt-preview-' + 'a'.repeat(64)]) assert.equal(validPageFrameName(name), true);
  for (const name of ['tt-preview-1234567', 'tt-preview-' + 'a'.repeat(65), 'tt-preview-ABCDefgh', 'tt-preview-abc_defg', 'tt-preview-abcdefgh\n', 'other-abcdefgh', null, {}]) assert.equal(validPageFrameName(name), false);
});

test('capture rect offsets, zoom, clipping, and rounding use window coordinates', () => {
  const frame = { x: 100, y: 50, width: 800, height: 600 };
  const size = { width: 800, height: 600 };
  const content = { width: 1200, height: 900 };
  assert.deepEqual(pageCaptureRect(frame, { x: 40, y: 100, width: 136, height: 43 }, size, 1.25, content), { x: 175, y: 188, width: 170, height: 54 });
  assert.deepEqual(pageCaptureRect(frame, { x: -10, y: 590, width: 900, height: 100 }, size, 1, content), { x: 100, y: 640, width: 800, height: 10 });
  assert.deepEqual(pageCaptureRect({ ...frame, x: -30, y: -20 }, { x: 10, y: 10, width: 100, height: 100 }, size, 1, content), { x: 0, y: 0, width: 80, height: 90 });
  assert.deepEqual(pageCaptureRect({ ...frame, x: 1150, y: 850 }, { x: 0, y: 0, width: 100, height: 100 }, size, 1, content), { x: 1150, y: 850, width: 50, height: 50 });
  assert.deepEqual(pageCaptureRect({ ...frame, width: 100, height: 80 }, { x: 90, y: 70, width: 100, height: 100 }, size, 1, content), { x: 190, y: 120, width: 10, height: 10 });
});

test('capture skips tiny, empty, and outside rectangles; invalid bounds reject', () => {
  const frame = { x: 0, y: 0, width: 800, height: 600 };
  const size = { width: 800, height: 600 };
  for (const rect of [{ x: 0, y: 0, width: 1, height: 8 }, { x: 800, y: 0, width: 5, height: 5 }, { x: 0, y: 0, width: 0, height: 0 }]) assert.equal(pageCaptureRect(frame, rect, size, 1, size), null);
  assert.deepEqual(pageCaptureRect(frame, { x: 0, y: 0, width: 2, height: 2 }, size, 1, size), { x: 0, y: 0, width: 2, height: 2 });
  for (const zoom of [0, -1, Infinity, NaN]) assert.throws(() => pageCaptureRect(frame, frame, size, zoom, size));
  assert.throws(() => pageRect({ ...frame, height: -1 }));
  assert.deepEqual(clipPageRect({ x: 900, y: -50, width: 10, height: 20 }, 800, 600), { x: 800, y: 0, width: 0, height: 0 });
});

test('shot ids and generated paths cannot escape the storage directory', () => {
  const id = randomUUID();
  const directory = resolve('desktop-dist', 'shots');
  assert.equal(validPageShotId(id), true);
  assert.equal(validPageShotId(id.toUpperCase()), true);
  assert.equal(pageShotPath(directory, id.toUpperCase(), 'png'), resolve(directory, `${id}.png`));
  for (const bad of ['../' + id, id + '.png', id + '\n', 'C:\\secret', '..\\' + id, '%2e%2e', '', null]) {
    assert.equal(validPageShotId(bad), false);
    assert.throws(() => pageShotPath(directory, bad, 'jpg'));
  }
  assert.throws(() => pageShotPath(directory, id, '../png' as 'png'));
  if (process.platform === 'win32') assert.equal(win32.dirname(pageShotPath('C:\\App Data\\page-comments', id, 'jpg')), 'C:\\App Data\\page-comments');
});

test('image scaling respects the long-side limit without enlarging', () => {
  assert.deepEqual(pageImageSize(3200, 1800, 1600), { width: 1600, height: 900 });
  assert.deepEqual(pageImageSize(900, 1600, 240), { width: 135, height: 240 });
  assert.deepEqual(pageImageSize(100, 40, 240), { width: 100, height: 40 });
  assert.deepEqual(pageImageSize(1, 10000, 240), { width: 1, height: 240 });
  assert.throws(() => pageImageSize(0, 20, 240));
});

test('mark references accept selector/rect and reject empty or unbounded data', () => {
  assert.equal(sanitizePageTargetRef(undefined), undefined);
  assert.deepEqual(sanitizePageTargetRef({ selector: '#save' }), { selector: '#save' });
  const rect = { x: -10, y: 0, width: 40, height: 50 };
  assert.deepEqual(sanitizePageTargetRef({ rect }), { rect });
  for (const bad of [{}, null, { selector: 'x'.repeat(501) }, { selector: '#x\n' }, { rect: { ...rect, x: Infinity } }, { selector: '#x', extra: 1 }]) assert.throws(() => sanitizePageTargetRef(bad));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { pagePickerSource } from '../src/pagePickerScript.js';

type InputEvent = { type: string; clientX: number; clientY: number; pointerId: number; key: string; deltaX: number; deltaY: number; deltaMode: number; prevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void };
class MockTarget {
  listeners = new Map<string, Array<{ handler: (event: InputEvent) => void; options: unknown }>>();
  addEventListener(type: string, handler: (event: InputEvent) => void, options?: unknown) {
    this.listeners.set(type, [...this.listeners.get(type) || [], { handler, options }]);
  }
  removeEventListener(type: string, handler: (event: InputEvent) => void) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.handler !== handler));
  }
  fire(type: string, values: Partial<InputEvent> = {}) {
    const event: InputEvent = { type, clientX: 50, clientY: 50, pointerId: 1, key: '', deltaX: 0, deltaY: 0, deltaMode: 0, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    for (const { handler } of this.listeners.get(type) || []) handler(event);
    return event;
  }
}
class MockElement extends MockTarget {
  style: Record<string, string> = { cssText: '' };
  parentElement: MockElement | null = null;
  children: MockElement[] = [];
  attributes: Record<string, string> = {};
  textContent = '';
  isConnected = true;
  display = 'block';
  overflowX = 'visible'; overflowY = 'visible';
  scrollTop = 0; scrollLeft = 0; scrollWidth = 100; scrollHeight = 100; clientWidth = 100; clientHeight = 100;
  bounds = { left: 10.25, top: 20.5, width: 136, height: 43 };
  shadowMode = ''; shadowRoot = null;
  focus() {}
  parts = new Map<string, MockElement>();
  constructor(public tagName = 'DIV') { super(); }
  get id() { return this.attributes.id || ''; }
  get classList() { return (this.attributes.class || '').split(' ').filter(Boolean); }
  getAttribute(name: string) { if (name === 'value') throw new Error('Do not read input value'); return this.attributes[name] ?? null; }
  getBoundingClientRect() { return this.bounds; }
  append(child: MockElement) { this.children.push(child); child.parentElement = this; }
  contains(child: MockElement): boolean { return child === this || this.children.some(node => node.contains(child)); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.isConnected = false; }
  attachShadow(options: { mode: string }) {
    this.shadowMode = options.mode;
    for (const id of ['cover', 'box', 'chip', 'area']) this.parts.set(`#${id}`, new MockElement());
    return { innerHTML: '', querySelector: (selector: string) => this.parts.get(selector) };
  }
  setPointerCapture() {}
  scrollIntoView() { this.bounds = { ...this.bounds, top: 100 }; }
}

async function withPage(run: (fixture: ReturnType<typeof mockPage>) => Promise<void>) {
  const fixture = mockPage();
  const saved = new Map(Object.keys(fixture.globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(fixture.globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  try { await run(fixture); } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}
function mockPage() {
  const html = new MockElement('HTML'), body = new MockElement('BODY'), card = new MockElement(), button = new MockElement('BUTTON');
  html.append(body); body.append(card); card.append(button);
  card.attributes = { id: 'card', class: 'card' }; button.attributes = { id: 'save' }; button.textContent = 'Save & confirm';
  let pointer = button;
  const frames: Array<() => void> = [];
  const pageWindow = Object.assign(new MockTarget(), { CSS: { escape: (value: string) => value }, scrollBy: (values: { top: number; left: number }) => { body.scrollTop += values.top; body.scrollLeft += values.left; } });
  const all = () => [html, body, card, ...card.children];
  const matches = (selector: string) => all().filter(element => {
    if (selector.startsWith('#')) return element.id === selector.slice(1);
    const attribute = /^\[([^=]+)="([^"]+)"\]$/.exec(selector);
    if (attribute) return element.attributes[attribute[1]] === attribute[2];
    return element.tagName.toLowerCase() === selector;
  });
  const document = { documentElement: html, activeElement: button, title: 'Test page', createElement: () => {
    const element = new MockElement(); element.focus = () => { document.activeElement = element; }; return element;
  }, querySelectorAll: matches, querySelector: (selector: string) => matches(selector)[0] || null,
    elementsFromPoint: () => [pointer, card, body, html] };
  button.focus = () => { document.activeElement = button; };
  return { html, body, card, button, pageWindow, frames, setPointer: (element: MockElement) => { pointer = element; },
    overlay: () => html.children.at(-1)!,
    flushFrame: () => { for (const callback of frames.splice(0)) callback(); },
    globals: { window: pageWindow, document, Element: MockElement, HTMLElement: MockElement, innerWidth: 800, innerHeight: 600, location: { href: 'https://example.com/' }, requestAnimationFrame: (callback: () => void) => { frames.push(callback); }, getComputedStyle: (element: MockElement) => ({ display: element.display, overflowX: element.overflowX, overflowY: element.overflowY }) },
  };
}
function execute(action: 'pick' | 'cancel' | 'mark' | 'at', target?: { selector?: string; rect?: { x: number; y: number; width: number; height: number } }, flash?: boolean, point?: { x: number; y: number }) {
  const source = pagePickerSource(action, target, flash, point);
  return new Function(`return ${source};`)();
}

test('pointer pick returns the element under the context-menu coordinate without adding an overlay', async () => withPage(async fixture => {
  const pick = execute('at', undefined, undefined, { x: 50, y: 50 }) as { target: { selector: string; text: string } };
  assert.equal(pick.target.selector, '#save');
  assert.equal(pick.target.text, 'Save & confirm');
  assert.equal(fixture.html.children.length, 1);
}));

test('closed overlay swallows events, selects keyboard parent and waits two clean frames', async () => withPage(async fixture => {
  const picking = execute('pick') as Promise<{ target: { selector: string; label: string } }>;
  const overlay = fixture.overlay();
  assert.equal(document.activeElement, overlay);
  assert.equal(overlay.shadowMode, 'closed'); assert.equal(overlay.shadowRoot, null);
  const cover = overlay.parts.get('#cover')!;
  const moved = cover.fire('pointermove'); assert.equal(moved.prevented, true); assert.equal(moved.stopped, true);
  const up = fixture.pageWindow.fire('keydown', { key: 'ArrowUp' }); assert.equal(up.stopped, true);
  cover.fire('pointermove'); // Synthetic movement at the same coordinates must preserve the keyboard parent.
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup']) {
    const event = cover.fire(type); assert.equal(event.prevented, true, type); assert.equal(event.stopped, true, type);
  }
  assert.equal(overlay.isConnected, false);
  assert.equal(document.activeElement, fixture.button);
  const tail = fixture.pageWindow.fire('click'); assert.equal(tail.prevented, true); assert.equal(tail.stopped, true);
  let settled = false; void picking.then(() => { settled = true; });
  fixture.flushFrame(); await Promise.resolve(); assert.equal(settled, false);
  fixture.flushFrame();
  const result = await picking; assert.equal(result.target.selector, '#card'); assert.equal(result.target.label, 'div#card.card');
  assert.equal(fixture.pageWindow.listeners.get('click')?.length, 0);
  assert.equal((fixture.pageWindow as unknown as Record<symbol, unknown>)[Symbol.for('threadterm.pagePicker')], undefined);
}));

test('ArrowDown steps toward pointer, wheel scrolls ancestor and suppresses page defaults', async () => withPage(async fixture => {
  const picking = execute('pick'); const cover = fixture.overlay().parts.get('#cover')!;
  cover.fire('pointermove'); fixture.pageWindow.fire('keydown', { key: 'ArrowUp' }); fixture.pageWindow.fire('keydown', { key: 'ArrowUp' });
  fixture.pageWindow.fire('keydown', { key: 'ArrowDown' });
  cover.fire('pointerdown'); cover.fire('pointerup'); fixture.flushFrame(); fixture.flushFrame();
  assert.equal((await picking).target.selector, '#card');
  fixture.card.overflowY = 'auto'; fixture.card.scrollHeight = 1500;
  const next = execute('pick'); const wheelCover = fixture.overlay().parts.get('#cover')!;
  const wheel = wheelCover.fire('wheel', { deltaY: 2, deltaX: 1, deltaMode: 1 });
  assert.equal(wheel.prevented, true); assert.equal(wheel.stopped, true);
  assert.equal(fixture.card.scrollTop, 32); assert.equal(fixture.card.scrollLeft, 16);
  fixture.pageWindow.fire('keydown', { key: 'Escape' }); fixture.flushFrame(); fixture.flushFrame(); assert.equal(await next, null);
}));

test('element metadata escapes HTML and bounds source hints without reading values', async () => withPage(async fixture => {
  fixture.button.attributes['aria-label'] = 'Save changes'; fixture.button.attributes.class = 'primary';
  Object.assign(fixture.button, { __reactFiber$test: { type: { name: 'SaveButton' }, _debugSource: { fileName: 'src/Save.tsx', lineNumber: 12, columnNumber: 3 }, return: { type: { displayName: 'Cart' } } } });
  const picking = execute('pick'); const cover = fixture.overlay().parts.get('#cover')!;
  cover.fire('pointerdown'); cover.fire('pointerup'); fixture.flushFrame(); fixture.flushFrame();
  const result = (await picking).target;
  assert.equal(result.selector, '#save'); assert.equal(result.label, 'button "Save changes"');
  assert.equal(result.text, 'Save & confirm'); assert.match(result.html, /Save &amp; confirm/);
  assert.deepEqual(result.components, ['SaveButton', 'Cart']);
  assert.deepEqual(result.source, { framework: 'react', file: 'src/Save.tsx', line: 12, column: 3 });
  assert.equal(result.rect.x, 10.25); assert.equal('value' in result.attributes, false);
}));

test('password picks omit names, attributes, text, value and source metadata', async () => withPage(async fixture => {
  fixture.button.tagName = 'INPUT'; fixture.button.textContent = 'PRIVATE';
  fixture.button.attributes = { type: 'password', id: 'PRIVATE_ID', 'aria-label': 'PRIVATE_LABEL', placeholder: 'PRIVATE_PLACEHOLDER' };
  Object.defineProperty(fixture.button, '__svelte_meta', { get() { throw new Error('Password metadata must not be inspected'); } });
  const picking = execute('pick'); const cover = fixture.overlay().parts.get('#cover')!;
  cover.fire('pointerdown'); cover.fire('pointerup'); fixture.flushFrame(); fixture.flushFrame();
  const result = (await picking).target;
  assert.equal(result.selector, 'input'); assert.equal(result.label, 'input'); assert.equal(result.html, '<input>');
  assert.deepEqual(result.attributes, {}); assert.equal('text' in result, false); assert.equal('source' in result, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
}));

test('drag threshold, area sampling deduplication and inline climbing', async () => withPage(async fixture => {
  fixture.button.tagName = 'SPAN'; fixture.button.display = 'inline';
  const picking = execute('pick'); const cover = fixture.overlay().parts.get('#cover')!;
  cover.fire('pointerdown', { clientX: 20, clientY: 30 }); cover.fire('pointermove', { clientX: 80, clientY: 90 }); cover.fire('pointerup', { clientX: 80, clientY: 90 });
  fixture.flushFrame(); fixture.flushFrame();
  const result = (await picking).target; assert.equal(result.type, 'area');
  assert.deepEqual(result.rect, { x: 20, y: 30, width: 60, height: 60 }); assert.deepEqual(result.elements, ['div#card.card']);
  const next = execute('pick'); const tiny = fixture.overlay().parts.get('#cover')!;
  tiny.fire('pointerdown', { clientX: 20, clientY: 30 }); tiny.fire('pointerup', { clientX: 23, clientY: 34 });
  fixture.flushFrame(); fixture.flushFrame(); assert.equal((await next).target.type, 'element');
}));

test('a replacement pick resolves the old pick without deleting the new controller', async () => withPage(async fixture => {
  const first = execute('pick'); const second = execute('pick');
  fixture.flushFrame(); fixture.flushFrame(); assert.equal(await first, null);
  assert.ok((fixture.pageWindow as unknown as Record<symbol, unknown>)[Symbol.for('threadterm.pagePicker')]);
  execute('cancel'); fixture.flushFrame(); fixture.flushFrame(); assert.equal(await second, null);
}));

test('test attributes and duplicate ids use a verified unique selector', async () => withPage(async fixture => {
  const duplicate = new MockElement('BUTTON'); duplicate.attributes.id = 'save'; fixture.card.append(duplicate);
  fixture.button.attributes['data-testid'] = 'save-button';
  const picking = execute('pick'); const cover = fixture.overlay().parts.get('#cover')!;
  cover.fire('pointerdown'); cover.fire('pointerup'); fixture.flushFrame(); fixture.flushFrame();
  assert.equal((await picking).target.selector, '[data-testid="save-button"]');
}));

test('Vue, Svelte and code-inspector source hints use bounded dev metadata', async () => {
  const cases = [
    { property: '__vueParentComponent', value: { type: { __name: 'SaveButton', __file: 'src/Save.vue' } }, expected: { file: 'src/Save.vue', framework: 'vue' } },
    { property: '__svelte_meta', value: { loc: { file: 'src/Save.svelte', line: 7, column: 2 } }, expected: { file: 'src/Save.svelte', framework: 'svelte', line: 7, column: 2 } },
    { attributes: { 'data-inspector-relative-path': 'src/Button.tsx', 'data-inspector-line': '42', 'data-inspector-column': '3' }, expected: { file: 'src/Button.tsx', framework: 'attribute', line: 42, column: 3 } },
    { attributes: { 'data-v-inspector': 'C:\\project\\Button.vue:12:4' }, expected: { file: 'C:\\project\\Button.vue', framework: 'attribute', line: 12, column: 4 } },
    { attributes: { 'data-source-file': 'src/Button.tsx', 'data-source-line': '0' }, expected: { file: 'src/Button.tsx', framework: 'attribute' } },
  ];
  for (const item of cases) await withPage(async fixture => {
    if (item.property) Object.assign(fixture.button, { [item.property]: item.value });
    if (item.attributes) Object.assign(fixture.button.attributes, item.attributes);
    const picking = execute('pick'); const cover = fixture.overlay().parts.get('#cover')!;
    cover.fire('pointerdown'); cover.fire('pointerup'); fixture.flushFrame(); fixture.flushFrame();
    const result = (await picking).target; assert.deepEqual(result.source, item.expected);
    if (item.property === '__vueParentComponent') assert.deepEqual(result.components, ['SaveButton']);
  });
});

test('marker follows scroll/resize, clears its own host, and refuses missing selectors', async () => withPage(async fixture => {
  assert.equal(execute('mark', { selector: '#missing' }), false);
  assert.equal(execute('mark', { selector: '#save' }), true);
  const marker = fixture.overlay(); assert.equal(marker.style.top, '20.5px');
  fixture.button.bounds.top = 80; fixture.pageWindow.fire('scroll'); assert.equal(marker.style.top, '80px');
  fixture.button.isConnected = false; fixture.pageWindow.fire('resize'); assert.equal(marker.style.display, 'none');
  execute('mark'); assert.equal(marker.isConnected, false);
  assert.equal(execute('mark', { rect: { x: 2, y: 3, width: 4, height: 5 } }), true);
  assert.equal(fixture.overlay().style.left, '2px'); execute('mark');
}));

test('page picker source is standalone and parses after bundling', async () => {
  const source = pagePickerSource('cancel');
  const run = new Function(`return ${source};`);
  const saved = new Map(['window', 'document', 'HTMLElement', 'innerWidth', 'innerHeight', 'location', 'requestAnimationFrame'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    assert.equal(run(), true);
    const cover = { style: { cssText: '' }, textContent: '', addEventListener(): void {}, setPointerCapture(): void {}, remove(): void {} };
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: MockElement });
    const host = { focus(): void {}, style: { cssText: '' }, attachShadow: () => ({ innerHTML: '', querySelector: (selector: string) => selector === '#cover' ? cover : { style: { cssText: '', display: '' }, textContent: '' } }), remove(): void {}, contains(): boolean { return false; } };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      createElement: () => host, documentElement: { append(): void {} }, elementsFromPoint: () => [], getElementById: () => null,
    } });
    Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(globalThis, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://example.test/' } });
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: () => void) => callback() });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener(): void {}, removeEventListener(): void {} } });
    const picking = new Function(`return ${pagePickerSource('pick')};`)() as Promise<unknown>;
    const controller = (globalThis.window as Record<symbol, { cancel(): void }>)[Symbol.for('threadterm.pagePicker')];
    controller.cancel();
    assert.equal(await picking, null);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

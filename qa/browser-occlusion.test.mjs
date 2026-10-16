import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The ESM QA bundle must let Node load the compiler's CommonJS dependencies.
const ts = createRequire(import.meta.url)('typescript');

function loadOcclusion(overrides = {}) {
  const source = readFileSync(new URL('../renderer/src/browserOcclusion.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (id) => id === 'react' ? { useLayoutEffect: overrides.effect ?? (() => {}) } : id === './bridge' ? { browserCommand: overrides.command ?? (() => Promise.resolve()) } : (() => { throw new Error(`Unexpected module ${id}`); })(),
    ...overrides.globals,
  });
  return module.exports;
}

test('browser occlusion leases emit only at the first acquire and final release', () => {
  const events = [];
  const ledger = loadOcclusion().createBrowserOcclusionLedger((active) => events.push(active));
  const first = ledger.acquire();
  const second = ledger.acquire();
  assert.equal(ledger.count, 2);
  first();
  assert.equal(ledger.count, 1);
  assert.deepEqual(events, [true]);
  first();
  second();
  assert.equal(ledger.count, 0);
  assert.deepEqual(events, [true, false]);
});

test('passive notices occlude only positive-area intersections with a visible page', () => {
  const { browserOverlayIntersectsPage: intersects } = loadOcclusion();
  const page = { x: 100, y: 100, width: 400, height: 300 };
  const notice = { x: 10, y: 10, width: 80, height: 30 };
  assert.equal(intersects(notice, [page]), false);
  assert.equal(intersects({ ...notice, x: 20, width: 80, y: 110 }, [page]), false, 'touching edge');
  assert.equal(intersects({ ...notice, x: 499, y: 399 }, [page]), true, 'one-pixel overlap');
  assert.equal(intersects({ ...notice, x: 120, y: 120 }, [page]), true, 'contained notice');
  assert.equal(intersects({ x: 0, y: 0, width: 800, height: 600 }, [page]), true, 'notice contains page');
  assert.equal(intersects({ ...page, width: 0 }, [page]), false);
  assert.equal(intersects(page, [{ ...page, height: 0 }]), false);
  assert.equal(intersects(page, []), false, 'no visible pages');
  assert.equal(intersects(page, [notice, page]), true, 'any visible page');
});

function watcherFixture(command = () => Promise.resolve()) {
  const commands = [], mutations = [], resizes = [], effects = [], frames = new Map(), listeners = new Map();
  const passive = [], coarse = [];
  let frameId = 0;
  class Element {
    constructor(rect, isPassive = false) { this.rect = rect; this.passive = isPassive; this.hidden = false; }
    getAttribute(name) { return name === 'aria-hidden' ? this.ariaHidden : null; }
    getClientRects() { return this.hidden ? [] : [this.rect]; }
    getBoundingClientRect() { return this.rect; }
    closest() { return this.passive ? this : null; }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); mutations.push(this); }
    observe(element) { this.targets.add(element); }
    disconnect() { this.targets.clear(); }
  }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); resizes.push(this); }
    observe(element) { this.targets.add(element); }
    unobserve(element) { this.targets.delete(element); }
    disconnect() { this.targets.clear(); }
  }
  const document = {
    body: {},
    querySelectorAll(selector) { return selector.startsWith('.toast') ? passive : coarse; },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const api = loadOcclusion({
    effect: callback => effects.push(callback()),
    command: value => { commands.push(value.active); return command(value); },
    globals: { Element, KeyboardEvent: class {}, document, MutationObserver, ResizeObserver,
      requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame(id) { frames.delete(id); },
    },
  });
  return { api, Element, commands, passive, coarse, mutations, resizes, effects, listeners,
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); },
  };
}

test('passive toast mount, resize, page movement and dismissal update the lease without polling', () => {
  const f = watcherFixture();
  const page = new f.Element({ x: 200, y: 100, width: 400, height: 300 });
  const toast = new f.Element({ x: 0, y: 0, width: 100, height: 40 }, true);
  f.api.usePassiveBrowserOcclusion({ current: toast });
  assert.equal(f.resizes.length, 0, 'no observer without a visible page');
  f.passive.push(toast);
  const stop = f.api.watchBrowserOverlays(page);
  assert.deepEqual(f.commands, [], 'non-overlapping toast leaves page live');
  assert.equal(f.resizes[0].targets.has(toast), true);
  toast.rect = { x: 0, y: 0, width: 300, height: 180 };
  f.resizes[0].callback(); f.flush();
  assert.deepEqual(f.commands, [true], 'toast resize overlaps page');
  page.rect = { ...page.rect, x: 500 };
  f.api.updateBrowserOverlayBounds();
  assert.deepEqual(f.commands, [true, false], 'moving page away restores it');
  page.rect = { ...page.rect, x: 200 };
  f.api.updateBrowserOverlayBounds();
  assert.deepEqual(f.commands, [true, false, true]);
  toast.rect = { ...toast.rect, x: 800 };
  f.mutations[1].callback(); f.flush();
  assert.deepEqual(f.commands, [true, false, true, false], 'style-only reposition restores it');
  toast.rect = { ...toast.rect, x: 0 };
  f.resizes[0].callback(); f.flush();
  f.effects[0](); // React layout cleanup precedes removal from the DOM.
  f.passive.length = 0; f.flush();
  assert.deepEqual(f.commands, [true, false, true, false, true, false], 'dismissal releases after DOM removal');
  stop();
  assert.equal(f.listeners.size, 0);
  assert.ok(f.resizes.every(observer => observer.targets.size === 0));
  assert.ok(f.mutations.every(observer => observer.targets.size === 0));
});

test('coarse user overlays retain their lease when passive overlap ends', () => {
  const f = watcherFixture();
  const page = new f.Element({ x: 100, y: 100, width: 400, height: 300 });
  const toast = new f.Element({ x: 120, y: 120, width: 80, height: 40 }, true);
  const stop = f.api.watchBrowserOverlays(page);
  const release = f.api.acquireBrowserOcclusion();
  f.passive.push(toast); f.mutations[0].callback([{ type: 'childList' }]);
  assert.deepEqual(f.commands, [true]);
  toast.hidden = true; f.resizes[0].callback(); f.flush();
  assert.deepEqual(f.commands, [true], 'coarse lease still held');
  release(); assert.deepEqual(f.commands, [true, false]);
  f.coarse.push(new f.Element({ x: 0, y: 0, width: 10, height: 10 }));
  f.mutations[0].callback([{ type: 'childList' }]);
  assert.deepEqual(f.commands, [true, false, true], 'user menu occludes even away from page');
  stop(); assert.deepEqual(f.commands, [true, false, true, false]);
});

test('a nested notice registers when mounted and releases when its active state ends', () => {
  const f = watcherFixture();
  const page = new f.Element({ x: 100, y: 100, width: 400, height: 300 });
  const notice = new f.Element({ x: 120, y: 120, width: 100, height: 30 }, true);
  const stop = f.api.watchBrowserOverlays(page);
  f.api.usePassiveBrowserOcclusion({ current: notice }, false);
  assert.deepEqual(f.commands, [], 'inactive hidden preview notice has no lease');
  // No body portal mutation or generic DOM match: the nested hook owns discovery.
  f.api.usePassiveBrowserOcclusion({ current: notice }, true);
  assert.deepEqual(f.commands, [true]);
  f.effects.at(-1)(); f.flush();
  assert.deepEqual(f.commands, [true, false]);
  stop();
});

test('passive overlap follows the remaining visible page when another surface closes', () => {
  const f = watcherFixture();
  const left = new f.Element({ x: 100, y: 100, width: 200, height: 300 });
  const right = new f.Element({ x: 400, y: 100, width: 200, height: 300 });
  f.passive.push(new f.Element({ x: 420, y: 120, width: 100, height: 30 }, true));
  const stopLeft = f.api.watchBrowserOverlays(left);
  assert.deepEqual(f.commands, []);
  const stopRight = f.api.watchBrowserOverlays(right);
  assert.deepEqual(f.commands, [true]);
  stopRight();
  assert.deepEqual(f.commands, [true, false], 'the remaining page is outside the notice');
  stopLeft();
  assert.ok(f.mutations.every(observer => observer.targets.size === 0));
});


test('passive overlap rechecks retain one lease while capture is pending and dismissal releases it', async () => {
  let finish;
  const f = watcherFixture(value => value.active ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
  const page = new f.Element({ x: 100, y: 100, width: 400, height: 300 });
  const toast = new f.Element({ x: 120, y: 120, width: 100, height: 40 }, true);
  const stop = f.api.watchBrowserOverlays(page);
  f.passive.push(toast); f.mutations[0].callback([{ type: 'childList' }]);
  for (let check = 0; check < 3; check++) {
    f.api.updateBrowserOverlayBounds(); f.resizes[0].callback(); f.mutations[1].callback(); f.flush();
  }
  assert.deepEqual(f.commands, [true], 'rechecks must not release or start another capture');
  toast.hidden = true; f.mutations[1].callback(); f.flush();
  assert.deepEqual(f.commands, [true, false], 'dismissal restores without waiting for the capture');
  finish(); await Promise.resolve();
  assert.deepEqual(f.commands, [true, false], 'late completion cannot re-acquire the dismissed overlay');
  stop();
});

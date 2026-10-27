import assert from 'node:assert/strict';
import test from 'node:test';
import { discardUnreferencedImports, pruneRemovedBackgrounds, withBackgroundMutation } from './appearance/backgroundMutation';
import type { ThemeTokens } from './themes';

const id = (letter: string) => letter.repeat(64);
const theme = (image: string): ThemeTokens => ({
  background: '#101112', surface: '#202122', text: '#f0f1f2', muted: '#a0a1a2', accent: '#4455ee', border: '#303132',
  backgrounds: { window: { image, opacity: 100, blur: 0, overlay: 0, fit: 'cover', focusX: 50, focusY: 50, scale: 100 } },
});

function installBridge(options: { themes?: Record<string, ThemeTokens>; records?: string[] } = {}) {
  const pruned: string[][] = [], removed: string[] = [];
  Object.assign(globalThis, { window: { threadterm: {
    request: async (method: string) => {
      assert.equal(method, 'runtime.snapshot');
      return { settings: { customThemes: options.themes ?? {} } };
    },
    storeBackgroundImage: async () => undefined,
    listBackgroundImages: async () => (options.records ?? []).map(value => ({ id: value })),
    pruneBackgroundImages: async (keep: string[]) => { pruned.push(keep); },
    removeBackgroundImage: async (value: string) => { removed.push(value); },
  } } });
  return { pruned, removed };
}

test('background mutation queue serializes later work after a failure', async () => {
  const order: string[] = [];
  const first = withBackgroundMutation(async () => { order.push('first'); throw Error('expected'); });
  const second = withBackgroundMutation(async () => { order.push('second'); return 'done'; });
  await assert.rejects(first, /expected/);
  assert.equal(await second, 'done');
  assert.deepEqual(order, ['first', 'second']);
});

test('pruning keeps unrelated library and pending-import records plus fresh theme references', async () => {
  const removed = id('a'), replacement = id('b'), fresh = id('c'), library = id('d');
  const bridge = installBridge({ themes: { Fresh: theme(fresh) }, records: [removed, replacement, fresh, library] });
  await pruneRemovedBackgrounds({ Before: theme(removed) }, { After: theme(replacement) });
  assert.equal(bridge.pruned.length, 1);
  assert.deepEqual(new Set(bridge.pruned[0]), new Set([replacement, fresh, library]));
  assert.equal(bridge.pruned[0].includes(removed), false);
});

test('failed import cleanup removes only newly imported ids that no fresh theme references', async () => {
  const orphan = id('a'), retained = id('b');
  const bridge = installBridge({ themes: { Saved: theme(retained) } });
  await discardUnreferencedImports([orphan, retained]);
  assert.deepEqual(bridge.removed, [orphan]);
});

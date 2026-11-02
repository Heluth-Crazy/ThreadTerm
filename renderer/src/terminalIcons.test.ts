import assert from 'node:assert/strict';
import { test } from 'node:test';
import { iconFileName, iconFileProblem, parseTerminalIcons, uniqueIconId, withoutUnusedImages } from './terminalIcons';

const image = (id: string) => ({ id, name: id, src: 'data:image/png;base64,iVBORw0KGgo=' });

test('a missing or malformed setting reads as no rules and no images', () => {
  assert.deepEqual(parseTerminalIcons(undefined), { rules: [], images: [] });
  assert.deepEqual(parseTerminalIcons({ rules: [{ id: 1 }, { id: 'a', match: 'copilot', icon: 'codex' }], images: 'x' }), {
    rules: [{ id: 'a', match: 'copilot', icon: 'codex' }],
    images: [],
  });
});

test('ids are readable and never collide', () => {
  assert.equal(uniqueIconId('GitHub Copilot', []), 'github-copilot');
  assert.equal(uniqueIconId('copilot', [{ id: 'copilot' }, { id: 'copilot-2' }]), 'copilot-3');
  assert.equal(uniqueIconId('@@@', []), 'icon');
});

test('images no rule uses any more are dropped on save', () => {
  const kept = withoutUnusedImages({ rules: [{ id: 'r', match: 'copilot', icon: 'image:a' }, { id: 's', match: 'aider', icon: 'claude' }], images: [image('a'), image('b')] });
  assert.deepEqual(kept.images.map(item => item.id), ['a']);
});

test('only small images can be icons', () => {
  assert.equal(iconFileProblem({ type: 'image/svg+xml', size: 900 }), undefined);
  assert.equal(iconFileProblem({ type: 'image/png', size: 64 * 1024 }), undefined);
  assert.equal(iconFileProblem({ type: 'image/png', size: 64 * 1024 + 1 }), 'size');
  assert.equal(iconFileProblem({ type: 'text/html', size: 10 }), 'type');
  assert.equal(iconFileName('copilot-logo.svg'), 'copilot-logo');
  assert.equal(iconFileName('.svg'), 'Icon');
});

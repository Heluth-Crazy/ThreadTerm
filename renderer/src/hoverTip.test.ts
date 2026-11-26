import assert from 'node:assert/strict';
import test from 'node:test';
import { placeTip, tipShortcut, tipText, type TipCandidate } from './hoverTip';

const element = (tagName: string, attributes: Record<string, string>, text = ''): TipCandidate => ({
  tagName, textContent: text,
  getAttribute: name => attributes[name] ?? null,
  hasAttribute: name => name in attributes,
});

test('an icon-only button says its label; a button that shows its words gets no tip', () => {
  assert.equal(tipText(element('BUTTON', { 'aria-label': '设置' })), '设置');
  assert.equal(tipText(element('DIV', { role: 'button', 'aria-label': 'Toggle sidebar' })), 'Toggle sidebar');
  assert.equal(tipText(element('BUTTON', { 'aria-label': 'Send' }, 'Send')), undefined);
  assert.equal(tipText(element('BUTTON', {})), undefined, 'nothing to say');
  assert.equal(tipText(element('SPAN', { 'aria-label': 'status' })), undefined, 'only buttons');
});

test('the title the tip took off the element still names it; data-tip names anything', () => {
  assert.equal(tipText(element('BUTTON', {}), 'Copy path'), 'Copy path');
  assert.equal(tipText(element('BUTTON', { title: 'Copy commit hash' })), 'Copy commit hash');
  assert.equal(tipText(element('SPAN', { 'data-tip': 'Branch main' }, 'main')), 'Branch main');
  assert.equal(tipText(element('SPAN', { 'data-tip': ' ' })), undefined);
});

test('shortcuts read the way people type them', () => {
  assert.equal(tipShortcut(element('BUTTON', { 'aria-keyshortcuts': 'Control+P' })), 'Ctrl+P');
  assert.equal(tipShortcut(element('BUTTON', { 'aria-keyshortcuts': 'Control+Shift+F Meta+Shift+F' })), 'Ctrl+Shift+F');
  assert.equal(tipShortcut(element('BUTTON', {})), undefined);
});

test('the tip sits centred below its button, above it near the bottom, and inside the window', () => {
  const viewport = { width: 800, height: 600 };
  const tip = { width: 60, height: 24 };
  assert.deepEqual(placeTip({ left: 100, top: 10, width: 28, height: 28 }, tip, viewport), { left: 84, top: 44, side: 'below' });
  assert.deepEqual(placeTip({ left: 100, top: 560, width: 28, height: 28 }, tip, viewport), { left: 84, top: 530, side: 'above' });
  assert.equal(placeTip({ left: 0, top: 10, width: 28, height: 28 }, tip, viewport).left, 6, 'the left edge keeps a margin');
  assert.equal(placeTip({ left: 790, top: 10, width: 10, height: 28 }, tip, viewport).left, 734, 'the right edge too');
});

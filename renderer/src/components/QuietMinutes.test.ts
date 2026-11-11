import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { createRequire } from 'node:module';
Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import('react-dom/server');
import { QuietMinutes } from './QuietMinutes';
import { delegationQuietLabel, quietMinutesText } from '../delegation';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const en = (text: string) => text;
const zh = (_en: string, cn: string) => cn;

test('a quiet delegate reads how long it has been silent, in both languages', () => {
  assert.equal(delegationQuietLabel(ago(12), en), 'No activity for 12 min');
  assert.equal(delegationQuietLabel(ago(12), zh), '\u65e0\u6d3b\u52a8 12 \u5206\u949f');
  // Under a minute never reads as "0 min".
  assert.equal(delegationQuietLabel(ago(0), en), 'No activity for under 1 min');
  assert.equal(quietMinutesText(59, zh), '\u4e0d\u5230 1 \u5206\u949f');
  assert.equal(delegationQuietLabel('not a time', en), 'No activity for under 1 min');
});

test('the minutes tick in their own small component, not in the card', () => {
  const markup = renderToStaticMarkup(createElement(QuietMinutes, { since: ago(12), copy: en }));
  assert.match(markup, /class="delegate-quiet"/);
  assert.match(markup, />No activity for 12 min</);
  assert.match(markup, /aria-live="off"/, 'a per-minute change must not interrupt a screen reader');
  const chinese = renderToStaticMarkup(createElement(QuietMinutes, { since: ago(62), copy: zh }));
  assert.match(chinese, />\u65e0\u6d3b\u52a8 62 \u5206\u949f</);
});

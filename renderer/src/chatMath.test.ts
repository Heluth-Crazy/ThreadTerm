import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatMarkdown } from './chatMath';
test('inline and display math are marked without loading KaTeX', () => {
  const html = String(parseChatMarkdown('$E=mc^2$\n\n$$\nx^2\n$$'));
  assert.match(html, /data-threadterm-math="inline"/);
  assert.match(html, /data-threadterm-math="display"/);
  assert.match(String(parseChatMarkdown('Display here: $$x^2$$')), /data-threadterm-math="display"/);
});
test('math remains literal inside code spans and fenced code', () => {
  const html = String(parseChatMarkdown('`$x$`\n\n```text\n$$x$$\n```'));
  assert.doesNotMatch(html, /data-threadterm-math/);
  assert.match(html, /<code>\$x\$<\/code>/);
});
test('math source cannot escape its inert text placeholder', () => {
  const html = String(parseChatMarkdown('$<img src=x onerror=alert(1)>$'));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

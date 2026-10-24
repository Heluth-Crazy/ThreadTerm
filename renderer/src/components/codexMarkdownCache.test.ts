import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the module-level renderer without mounting ChatView or loading its UI imports.
const source = readFileSync(resolve('renderer/src/components/ChatView.tsx'), 'utf8');
const start = source.indexOf('const codexMarkdownCache =');
const end = source.indexOf('\nfunction CodexToolPart', start);
assert.ok(start >= 0 && end > start);

function harness() {
  let parses = 0, sanitizes = 0;
  const code = stripTypeScriptTypes(source.slice(start, end));
  const render = runInNewContext(`${code}\nrenderCodexMarkdown`, {
    parseChatMarkdown: (text: string) => { parses += 1; return `<p>${text}</p>`; },
    document: { createElement: () => ({ innerHTML: '', content: { querySelectorAll: () => [] }, querySelectorAll: () => [] }) },
    sanitizeMarkdownHtml: (html: string) => { sanitizes += 1; return html === '<p></p>' ? '' : `safe:${html}`; },
    parseMarkdownFileReference: () => undefined,
  }) as (text: string) => string;
  return { render, parses: () => parses, sanitizes: () => sanitizes };
}

test('Codex Markdown reuses the sanitized output for identical text, including empty output', () => {
  const cache = harness();
  assert.equal(cache.render('hello'), 'safe:<p>hello</p>');
  assert.equal(cache.render('hello'), 'safe:<p>hello</p>');
  assert.equal(cache.render(''), '');
  assert.equal(cache.render(''), '');
  assert.equal(cache.parses(), 2);
  assert.equal(cache.sanitizes(), 2);
});

test('Codex Markdown retains at most 300 texts and evicts the oldest', () => {
  const cache = harness();
  for (let index = 0; index < 300; index += 1) cache.render(`text-${index}`);
  cache.render('text-0');
  assert.equal(cache.parses(), 300);
  cache.render('text-300');
  cache.render('text-1');
  assert.equal(cache.parses(), 301);
  assert.equal(cache.render('text-0'), 'safe:<p>text-0</p>');
  assert.equal(cache.parses(), 302);
  assert.equal(cache.sanitizes(), 302);
});

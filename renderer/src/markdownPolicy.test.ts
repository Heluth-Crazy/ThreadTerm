import assert from 'node:assert/strict';
import test from 'node:test';
import { filterMarkdownClasses, inertRemoteImage, markdownClassNameAllowed, markdownPolicyRules, remoteImageLoadUrl, remoteImagePlaceholderHtml } from './markdownPolicy';

// Node has no DOM, so the containment and the actual placeholder inside sanitized HTML are proven in
// qa/markdown-policy-dom.mjs with the real marked + DOMPurify. Everything the policy decides is data or a pure
// function and is tested here.

test('untrusted Markdown cannot introduce stylesheets, active elements or inline styling', () => {
  for (const tag of ['style', 'script', 'iframe', 'frame', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'dialog', 'svg', 'math']) {
    assert.ok(markdownPolicyRules.forbiddenTags.includes(tag), `${tag} is forbidden`);
  }
  for (const attribute of ['style', 'srcset', 'background', 'poster', 'formaction', 'ping', 'srcdoc']) {
    assert.ok(markdownPolicyRules.forbiddenAttributes.includes(attribute), `${attribute} is forbidden`);
  }
  // Images stay: remote ones become placeholders in the policy, and the Markdown preview rewrites local ones to
  // data URLs, so neither needs the tag forbidden.
  assert.equal(markdownPolicyRules.forbiddenTags.includes('img'), false);
});

test('a remote image becomes an inert placeholder that names its origin', () => {
  const image = inertRemoteImage('https://cdn.example.com/build/chart.png', 'build chart', false);
  assert.ok(image);
  assert.equal(image.host, 'cdn.example.com');
  assert.equal(image.loadUrl, 'https://cdn.example.com/build/chart.png');
  assert.equal(image.alt, 'build chart');
  assert.equal(image.label, 'Load image');
  const html = remoteImagePlaceholderHtml(image);
  assert.doesNotMatch(html, /\ssrc=/i, 'the placeholder carries no src attribute');
  assert.doesNotMatch(html, /<img/i, 'the placeholder is not an image element');
  assert.match(html, /data-remote-image="https:\/\/cdn\.example\.com\/build\/chart\.png"/);
  assert.match(html, /data-remote-image-host="cdn\.example\.com"/);
  assert.match(html, />build chart</, 'the alt text is shown');
  assert.match(html, />cdn\.example\.com</, 'the host is shown');
  assert.match(html, /data-remote-image-load/, 'loading is one explicit action');
  assert.match(html, /class="btn btn-sm md-remote-image-load"/, 'the load action uses the shared button style');

  const chinese = inertRemoteImage('https://cdn.example.com/a.png', '', true);
  assert.ok(chinese);
  assert.equal(chinese.alt, '图片');
  assert.equal(chinese.label, '载入图片');
  assert.match(remoteImagePlaceholderHtml(chinese), />图片</);
  assert.match(remoteImagePlaceholderHtml(chinese), /aria-label="远端图片 cdn\.example\.com"/);
});

test('protocol-relative and malformed remote sources stay inert', () => {
  const relative = inertRemoteImage('//cdn.example.com/a.png', 'proto', false);
  assert.ok(relative);
  assert.equal(relative.host, 'cdn.example.com');
  assert.equal(relative.loadUrl, 'https://cdn.example.com/a.png', 'no borrowed app scheme');
  assert.ok(inertRemoteImage('http:/cdn.example.com/a.png', '', false), 'a single-slash http source is still remote');
  const malformed = inertRemoteImage('//', 'broken', false);
  assert.ok(malformed, 'an unparsable remote source is still not an image element');
  assert.equal(malformed.loadUrl, undefined);
  assert.equal(remoteImagePlaceholderHtml(malformed).includes('data-remote-image-load'), false);
});

test('data, blob, file and workspace-relative images are untouched', () => {
  for (const source of ['data:image/png;base64,iVBORw0KGgo=', 'blob:https://app/1234', 'file:///tmp/a.png', './assets/a.png', '/assets/a.png', 'a.png', '']) {
    assert.equal(inertRemoteImage(source, 'local', false), undefined, source);
    assert.equal(remoteImageLoadUrl(source), undefined, source);
  }
  assert.equal(inertRemoteImage(undefined, undefined, false), undefined);
});

test('placeholder markup escapes whatever the untrusted attributes held', () => {
  const image = inertRemoteImage('https://cdn.example.com/a.png?x="y"', '<img src=x onerror=alert(1)>', false);
  assert.ok(image);
  const html = remoteImagePlaceholderHtml(image);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<[a-z][^>]*\sonerror=/i, 'no event handler survives as an attribute');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-remote-image="https:\/\/cdn\.example\.com\/a\.png\?x=&quot;y&quot;"/);
});

test('only renderer-generated classes survive sanitization', () => {
  for (const allowed of ['language-ts', 'language-c++', 'language-objective-c', 'language-threadterm-ui', 'task-list-item']) {
    assert.equal(markdownClassNameAllowed(allowed), true, allowed);
  }
  for (const hostile of ['btn', 'btn-primary', 'chat-compose-send', 'v3-chat-message', 'codex-markdown', 'md-code-block', 'is-codex', 'language-', 'language-a"onmouseover=x', 'language-ts btn-primary']) {
    assert.equal(markdownClassNameAllowed(hostile), false, hostile);
  }
  assert.equal(filterMarkdownClasses('language-ts  btn btn-primary chat-compose-send'), 'language-ts');
  assert.equal(filterMarkdownClasses('   '), '');
});

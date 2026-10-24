import assert from 'node:assert/strict';
import test from 'node:test';
import { filterMarkdownClasses, markdownClassNameAllowed, markdownPolicyRules } from './markdownPolicy';

// Node has no DOM, so the containment itself is proven in qa/markdown-policy-dom.mjs with the real marked + DOMPurify.
// Everything the policy decides is data or a pure function and is tested here.

test('untrusted Markdown cannot introduce stylesheets, active elements or inline styling', () => {
  for (const tag of ['style', 'script', 'iframe', 'frame', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'dialog', 'svg', 'math']) {
    assert.ok(markdownPolicyRules.forbiddenTags.includes(tag), `${tag} is forbidden`);
  }
  for (const attribute of ['style', 'srcset', 'background', 'poster', 'formaction', 'ping', 'srcdoc']) {
    assert.ok(markdownPolicyRules.forbiddenAttributes.includes(attribute), `${attribute} is forbidden`);
  }
  // Images stay for now: inert remote images are F17, and the Markdown preview rewrites local ones to data URLs.
  assert.equal(markdownPolicyRules.forbiddenTags.includes('img'), false);
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

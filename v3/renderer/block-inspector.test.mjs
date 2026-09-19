import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_EXPLAIN_SELECTION, buildExplainPrompt, isExplainProvider } from './src/components/explainSelection.ts';

test('buildExplainPrompt retains selection and safely truncates oversized text', () => {
  assert.throws(() => buildExplainPrompt(' \n '), /Select terminal text/);
  assert.match(buildExplainPrompt('fatal: branch missing'), /fatal: branch missing/);
  const long = 'x'.repeat(MAX_EXPLAIN_SELECTION + 1);
  const prompt = buildExplainPrompt(long);
  assert.match(prompt, /Selection truncated/);
  assert.equal(prompt.includes(long), false);
});
test('only installed, authenticated structured-chat providers are eligible', () => {
  assert.equal(isExplainProvider({ installed: true, chat: true, auth: 'authenticated' }), true);
  assert.equal(isExplainProvider({ installed: true, chat: true, auth: 'unauthenticated' }), false);
  assert.equal(isExplainProvider({ installed: false, chat: true, auth: 'authenticated' }), false);
});

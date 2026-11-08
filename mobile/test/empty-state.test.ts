import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('no-computer Needs You offers pairing directly and hides empty project filters',()=>{
  const needs=readFileSync('mobile/src/ui/NeedsYouScreen.tsx','utf8');
  assert.match(needs,/onAddComputer/);
  assert.match(needs,/Add a computer to start/);
  assert.match(needs,/projects\.length > 0 &&/);
  assert.doesNotMatch(needs,/Waiting for an up-to-date snapshot in this scope/);
  const app=readFileSync('mobile/App.tsx','utf8');
  assert.match(app,/<NeedsYouScreen[^>]*onAddComputer=\{addComputer\}/);
});

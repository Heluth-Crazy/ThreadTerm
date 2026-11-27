import assert from 'node:assert/strict';
import test from 'node:test';
import { rankSlash, skillText, slashItems, slashScore } from './slashMenu';

const items = slashItems(
  [{ name: 'stop', description: 'Stop this turn' }, { name: 'code-review', description: 'Review changes in a fresh agent…' }],
  [{ name: '/compact', description: 'Summarise the conversation' }, { name: 'status' }, { name: 'model', description: 'Switch model' }, { name: 'stop', description: 'agent stop' }],
  [{ name: 'deploy', description: 'Ship to staging', invocation: '$deploy' }, { name: 'compact', description: 'same as the command', invocation: '/compact' }],
);

test('the menu lists ThreadTerm, then the agent, then skills, each name once', () => {
  assert.deepEqual(items.map(item => `${item.source}:${item.name}`), ['app:stop', 'app:code-review', 'agent:compact', 'agent:status', 'agent:model', 'skill:deploy']);
  assert.equal(items.find(item => item.name === 'stop')?.description, 'Stop this turn', 'ThreadTerm owns /stop');
});

test('a word inside a name matches: "/rev" finds code-review, which a prefix-only match missed', () => {
  assert.deepEqual(rankSlash(items, 'rev').map(item => item.name), ['code-review']);
  assert.deepEqual(rankSlash(items, 'st').map(item => item.name), ['stop', 'status', 'deploy'], 'deploy matches its description "Ship to staging"');
});

test('names that start with the query come first, then words, then text, then letters in order', () => {
  assert.ok(slashScore({ name: 'status' }, 'st')! < slashScore({ name: 'code-review' }, 'rev')!);
  assert.ok(slashScore({ name: 'code-review' }, 'rev')! < slashScore({ name: 'preview' }, 'rev')!);
  assert.ok(slashScore({ name: 'preview' }, 'rev')! < slashScore({ name: 'deploy', description: 'previews first' }, 'rev')!);
  assert.equal(slashScore({ name: 'deploy', description: 'Ship to staging' }, 'staging'), 5, 'the description counts');
  assert.ok(slashScore({ name: 'code-review' }, 'cr')! >= 8, 'letters in order');
  assert.equal(slashScore({ name: 'model' }, 'zz'), undefined);
  assert.deepEqual(rankSlash(items, '').map(item => item.name), items.map(item => item.name), 'an empty query keeps the order');
});

test('a skill writes its own invocation into the composer', () => {
  assert.equal(skillText(items.find(item => item.source === 'skill')!), '$deploy ');
});

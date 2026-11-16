import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatPart } from '@threadterm/protocol';
import { clockText, islandAsk, islandWords } from './words';
import type { IslandItem } from './model';

/* The task island's wording, built from the approval shapes the renderer already classifies. */

const approval = (data: Record<string, unknown>, title = 'Permission'): ChatPart =>
  ({ type: 'approval', approvalId: 'a1', status: 'pending', data: { approvalId: 'a1', title, ...data } });
const item = (overrides: Partial<IslandItem> = {}): IslandItem => ({
  key: 'local\u0000s1', machineId: 'local', sessionId: 's1', title: 'Fix the build', provider: 'codex', providerName: 'Codex',
  state: 'approval', since: 0, ...overrides,
});

test('the elapsed clock shows minutes below an hour and hours longer', () => {
  assert.equal(clockText(0), '0:00');
  assert.equal(clockText(9_400), '0:09');
  assert.equal(clockText(61_000), '1:01');
  assert.equal(clockText(600_000), '10:00');
  assert.equal(clockText(3_661_000), '1:01:01');
  assert.equal(clockText(-5_000), '0:00');
});

test('a command approval reads as the command it wants to run', () => {
  assert.deepEqual(islandAsk(approval({ details: { command: 'npm run build', cwd: 'project' } }, 'Run command'), false),
    { kind: 'command', text: 'npm run build' });
});

test('a single file edit names the file it wants to change', () => {
  const card = approval({ details: { toolName: 'Edit', input: { file_path: 'src/app.ts', old_string: 'before', new_string: 'after' } } }, 'Review edits');
  assert.deepEqual(islandAsk(card, false), { kind: 'edit', text: 'app.ts' });
  assert.deepEqual(islandAsk(card, true), { kind: 'edit', text: 'app.ts' });
});

test('two files are listed in both languages and more are counted', () => {
  const changes = (paths: string[]) => approval({ details: { changes: paths.map(path => ({ path, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-before\n+after' })) } }, 'Review edits');
  const two = changes(['src/a.ts', 'src/b.ts']);
  assert.deepEqual(islandAsk(two, false), { kind: 'edit', text: 'a.ts, b.ts' });
  assert.deepEqual(islandAsk(two, true), { kind: 'edit', text: 'a.ts、b.ts' });
  const three = changes(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(islandAsk(three, false), { kind: 'edit', text: 'a.ts, b.ts and 1 more' });
  assert.deepEqual(islandAsk(three, true), { kind: 'edit', text: 'a.ts、b.ts 等 3 个文件' });
});

test('a question shows the agent’s own words, one line', () => {
  const card = approval({ interaction: 'userInput', title: 'Needs your answer', form: { kind: 'questions', questions: [{ id: 'q1', question: 'Which  branch\nshould I use?' }] } });
  assert.deepEqual(islandAsk(card, false), { kind: 'question', text: 'Which branch should I use?' });
  const elicitation = approval({ interaction: 'elicitation', title: 'Pick a region', form: { kind: 'questions', questions: [{ id: 'q1', question: '  ' }] } });
  assert.deepEqual(islandAsk(elicitation, false), { kind: 'question', text: 'Pick a region' }, 'a question with no text falls back to the card title');
});

test('a plan approval asks for a review rather than showing the plan', () => {
  const card = approval({ interaction: 'plan', plan: '# Plan\n\n1. Add tests' }, 'Review the plan');
  assert.deepEqual(islandAsk(card, false), { kind: 'other', text: 'A plan to review' });
  assert.deepEqual(islandAsk(card, true), { kind: 'other', text: '计划等你确认' });
});

test('an approval the classifier does not recognise falls back to its title, and no approval means no ask', () => {
  assert.deepEqual(islandAsk(approval({}, 'Permission'), false), { kind: 'other', text: 'Permission' });
  assert.deepEqual(islandAsk(approval({ details: null }, '  '), false), undefined);
  assert.equal(islandAsk(undefined, false), undefined);
});

test('the island speaks both languages, naming the action it wants from the user', () => {
  const zh = islandWords(true), en = islandWords(false);
  assert.equal(en.later, 'Later');
  assert.equal(zh.later, '稍后');
  assert.equal(en.go(item(), undefined), 'Review');
  assert.equal(zh.go(item(), undefined), '去批准');
  assert.equal(en.go(item({ state: 'input' }), undefined), 'Reply');
  assert.equal(en.go(item(), { kind: 'question', text: 'Which branch?' }), 'Reply');
  assert.equal(en.waitingCompact(item(), undefined), 'Needs approval');
  assert.equal(en.waitingCompact(item({ state: 'input' }), undefined), 'Waiting for you');
  assert.equal(en.waitingTitle(item(), undefined), 'Codex needs approval');
  assert.equal(en.more(2), '2 more waiting');
  assert.equal(en.finishedTitle(item({ state: 'error' })), 'Codex failed');
  assert.equal(en.took(65_000), 'took 1:05');
});

test('a place line names the session, project and other computer only when they exist', () => {
  const en = islandWords(false);
  assert.equal(en.place(item()), 'Fix the build');
  assert.equal(en.place(item({ project: 'ThreadTerm', machineName: 'Orbit' })), 'Fix the build · ThreadTerm · Orbit');
  assert.equal(en.meta(item()), 'Codex');
});

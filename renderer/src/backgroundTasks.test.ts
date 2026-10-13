import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatBackgroundTask, ChatItem } from '@threadterm/protocol';
import { backgroundElapsed, backgroundHasOutput, backgroundOutputTarget } from './backgroundTasks';

const task = (extra: Partial<ChatBackgroundTask> = {}): ChatBackgroundTask => ({ id: 'process', title: 'Build', status: 'running', canStop: true, startedAt: '2026-10-13T00:00:00Z', ...extra });
test('render-time elapsed uses event start/end, preserves zero and rejects invalid dates', () => {
  assert.equal(backgroundElapsed(task(), Date.parse('2026-10-13T00:02:10Z')), 130_000);
  const done = task({ status: 'completed', endedAt: '2026-10-13T00:00:10Z' });
  assert.equal(backgroundElapsed(done, Date.parse('2026-10-13T00:10:00Z')), 10_000);
  assert.equal(backgroundElapsed(task({ startedAt: 'bad' }), Date.now()), undefined);
  assert.equal(backgroundElapsed(task({ startedAt: undefined }), Date.now()), undefined);
  assert.equal(backgroundElapsed(task({ status: 'stopped' }), Date.now()), undefined);
  assert.equal(backgroundElapsed(task({ endedAt: '2026-10-12T23:59:00Z' }), Date.now()), 0);
});
test('output capability follows exact tool/subagent identity, not command or provider', () => {
  const item: ChatItem = { id: 'a', role: 'assistant', createdAt: 'now', parts: [{ type: 'tool', toolId: 'build' }, { type: 'subagent', data: { key: 'child' } }] };
  assert.equal(backgroundHasOutput(task({ toolId: 'build' }), [item]), true);
  assert.equal(backgroundHasOutput(task({ toolId: 'child' }), [item]), true);
  assert.equal(backgroundHasOutput(task({ id: 'child' }), [item]), true);
  assert.equal(backgroundHasOutput(task({ title: 'build', command: 'build' }), [item]), false);
});
test('output DOM lookup compares identity verbatim without constructing selectors from native IDs', () => {
  const wanted = { dataset: { toolId: 'a"] [data-secret]' } };
  const root = { querySelectorAll: () => [{ dataset: { toolId: 'unrelated' } }, wanted] } as unknown as HTMLElement;
  assert.equal(backgroundOutputTarget(root, task({ toolId: 'a"] [data-secret]' })), wanted);
  assert.equal(backgroundOutputTarget(root, task()), undefined);
});

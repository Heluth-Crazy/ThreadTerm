import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenQuestionTool, toolEntriesForItems } from './toolActivity';

test('app-hosted asks use the question card without a duplicate transport row', () => {
  for (const part of [
    { type: 'tool' as const, toolName: 'mcp__threadterm__ask_user' },
    { type: 'tool' as const, toolName: 'threadterm__ask_user' },
    { type: 'tool' as const, data: { server: 'threadterm', tool: 'ask_user' } },
  ]) {
    assert.equal(hiddenQuestionTool(part), true);
    assert.deepEqual(toolEntriesForItems([{ id: 'i', role: 'assistant', createdAt: 'now', parts: [part] }]), []);
  }
  for (const part of [
    { type: 'tool' as const, toolName: 'mcp__threadterm__ask_user_shell' },
    { type: 'tool' as const, data: { server: 'foreign', tool: 'ask_user' } },
    { type: 'tool' as const, toolName: 'mcp__threadterm__feedback_check' },
  ]) assert.equal(hiddenQuestionTool(part), false);
});

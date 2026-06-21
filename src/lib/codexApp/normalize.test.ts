import { describe, expect, it } from 'vitest';
import {
  appendDelta,
  extractThreadItems,
  normalizeCodexItem,
  threadBindingFromThread,
  upsertItem,
} from './normalize';

describe('codex app normalizer', () => {
  it('extracts thread binding fields', () => {
    expect(
      threadBindingFromThread({
        id: 'thread-1',
        sessionId: 'session-1',
        path: '/tmp/thread.jsonl',
      }),
    ).toEqual({
      threadId: 'thread-1',
      sessionId: 'session-1',
      threadPath: '/tmp/thread.jsonl',
    });
  });

  it('normalizes user and assistant items from turns', () => {
    const items = extractThreadItems({
      turns: [
        {
          items: [
            {
              type: 'userMessage',
              id: 'u1',
              content: [{ type: 'text', text: 'hello' }],
            },
            { type: 'agentMessage', id: 'a1', text: 'hi' },
          ],
        },
      ],
    });

    expect(items.map((item) => [item.kind, item.body])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi'],
    ]);
  });

  it('normalizes command status and output', () => {
    expect(
      normalizeCodexItem({
        type: 'commandExecution',
        id: 'cmd1',
        command: 'npm test',
        aggregatedOutput: 'ok',
        status: 'completed',
      }),
    ).toMatchObject({
      id: 'cmd1',
      kind: 'command',
      title: 'npm test',
      body: 'ok',
      status: 'completed',
    });
  });

  it('appends deltas and preserves streamed body on completed upsert', () => {
    const streamed = appendDelta([], 'a1', 'hel', 'assistant', 'Codex');
    const complete = upsertItem(streamed, { type: 'agentMessage', id: 'a1', text: '' });
    expect(complete[0]).toMatchObject({ id: 'a1', body: 'hel' });
  });
});

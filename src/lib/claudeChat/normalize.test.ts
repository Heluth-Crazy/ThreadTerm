import { describe, expect, it } from 'vitest';
import {
  applyClaudeSdkMessage,
  assistantPreviewFromMessage,
} from './normalize';

describe('Claude SDK message normalization', () => {
  it('replaces the streaming placeholder with assistant, thinking, and tool items', () => {
    const streaming = applyClaudeSdkMessage([], {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hel' },
      },
    });
    expect(streaming).toMatchObject([
      { kind: 'assistant', status: 'streaming' },
    ]);

    const items = applyClaudeSdkMessage(streaming, {
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [
          { type: 'thinking', thinking: 'Inspect the project.' },
          { type: 'text', text: 'I found the issue.' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'src/App.tsx' },
          },
        ],
      },
    });

    expect(items).toEqual([
      expect.objectContaining({
        id: 'msg-1:thinking:0',
        kind: 'thinking',
        body: 'Inspect the project.',
      }),
      expect.objectContaining({
        id: 'msg-1:text:1',
        kind: 'assistant',
        body: 'I found the issue.',
      }),
      expect.objectContaining({
        id: 'tool-1',
        kind: 'tool',
        title: 'Read',
        status: 'running',
      }),
    ]);
  });

  it('settles a tool card from a tool_result and records the final result', () => {
    const withTool = applyClaudeSdkMessage([], {
      type: 'assistant',
      message: {
        id: 'msg-2',
        content: [
          {
            type: 'tool_use',
            id: 'tool-2',
            name: 'Bash',
            input: { command: 'npm test' },
          },
        ],
      },
    });
    const settled = applyClaudeSdkMessage(withTool, {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-2',
            content: '36 tests passed',
            is_error: false,
          },
        ],
      },
    });
    const completed = applyClaudeSdkMessage(settled, {
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      duration_ms: 42,
      num_turns: 2,
      total_cost_usd: 0.0123,
    });

    expect(completed[0]).toMatchObject({
      id: 'tool-2',
      status: 'ok',
    });
    expect(completed[0].body).toContain('36 tests passed');
    expect(completed[1]).toMatchObject({
      kind: 'result',
      title: 'success',
      status: 'ok',
    });
    expect(completed[1].body).toContain('2 turns');
    expect(completed[1].body).toContain('$0.0123');
  });

  it('normalizes init metadata, extracts previews, and ignores unknown messages', () => {
    const init = applyClaudeSdkMessage([], {
      type: 'system',
      subtype: 'init',
      session_id: 'session-2',
      model: 'claude-sonnet',
    });
    expect(init[0]).toMatchObject({
      kind: 'system',
      title: 'Session ready',
      body: 'session-2 · claude-sonnet',
    });

    const assistant = {
      type: 'assistant',
      message: {
        id: 'msg-3',
        content: [
          { type: 'text', text: 'First line' },
          { type: 'text', text: 'Second line' },
        ],
      },
    };
    expect(assistantPreviewFromMessage(assistant)).toBe(
      'First line\nSecond line',
    );
    expect(applyClaudeSdkMessage(init, { type: 'future_message' })).toBe(init);
  });
});

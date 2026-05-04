import { describe, expect, it } from 'vitest';
import {
  getAiSessionExportFilename,
  renderAiSessionMarkdown,
  type AiSessionExportSource,
} from './exportAiSession';

describe('AI session Markdown export', () => {
  it('renders block AI thread metadata and ordered prompt/reply content', () => {
    const source: AiSessionExportSource = {
      title: 'Explain failed build',
      userIntent: 'fix',
      provider: 'claude',
      sessionId: 'block:blk-1',
      startedAt: '2026-05-04T01:00:00.000Z',
      endedAt: '2026-05-04T01:00:03.000Z',
      sourceContext: {
        kind: 'block',
        cardId: 'card-1',
        blockId: 'blk-1',
        projectName: 'ThreadTerm',
        projectPath: '/repo/threadterm',
        cwd: '/repo/threadterm',
        command: 'npm run build',
      },
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          provider: 'claude',
          content: 'Run this:\n```bash\nnpm run typecheck\n```',
          createdAt: '2026-05-04T01:00:03.000Z',
          state: 'ok',
        },
        {
          id: 'q1',
          role: 'user',
          content: 'Why did this build fail?',
          createdAt: '2026-05-04T01:00:00.000Z',
          state: 'ok',
        },
      ],
    };

    expect(renderAiSessionMarkdown(source)).toMatchInlineSnapshot(`
      "# Explain failed build

      ## Metadata

      - User intent: fix
      - Provider: claude
      - Session id: block:blk-1
      - Start time: 2026-05-04T01:00:00.000Z
      - End time: 2026-05-04T01:00:03.000Z
      - Source: block; project ThreadTerm; path /repo/threadterm; cwd /repo/threadterm; command npm run build; card card-1; block blk-1

      ## Conversation

      ### 1. Prompt

      _2026-05-04T01:00:00.000Z_

      Why did this build fail?

      ### 2. Reply

      _provider: claude · 2026-05-04T01:00:03.000Z_

      \`\`\`\`markdown
      Run this:
      \`\`\`bash
      npm run typecheck
      \`\`\`
      \`\`\`\`

      "
    `);
  });

  it('exports useful AI card metadata when no conversation entries exist', () => {
    const markdown = renderAiSessionMarkdown({
      userIntent: 'review',
      provider: 'codex',
      sessionId: 'codex-session-1',
      startedAt: '2026-05-04T02:00:00.000Z',
      endedAt: '2026-05-04T02:10:00.000Z',
      sourceContext: {
        kind: 'card',
        cardId: 'card-codex',
        projectName: 'ThreadTerm',
        projectPath: '/repo/threadterm',
        launchAction: 'resume',
        launchCommand: 'codex resume codex-session-1 --no-alt-screen',
      },
      messages: [],
    });

    expect(markdown).toContain('- Provider: codex');
    expect(markdown).toContain('- Session id: codex-session-1');
    expect(markdown).toContain('_No prompt or reply content is available for this session._');
  });

  it('uses stable dated filenames', () => {
    expect(
      getAiSessionExportFilename(
        {
          provider: 'claude',
          sourceContext: { kind: 'block', blockId: 'Block 1/Unsafe' },
        },
        new Date('2026-05-04T12:00:00.000Z'),
      ),
    ).toBe('threadterm-ai-claude-block-1-unsafe-2026-05-04.md');
  });
});

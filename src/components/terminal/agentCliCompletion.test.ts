import { describe, expect, it } from 'vitest';
import type { TerminalCard } from '../../types/terminal';
import {
  AGENT_CLI_COMPATIBILITY_IDLE_MS,
  AGENT_CLI_MIN_RUNNING_MS,
  AGENT_CLI_PROMPT_SETTLE_MS,
  getAgentCliCompletionAdapter,
  getAgentCliCompletionFingerprint,
  detectAgentCliPrompt,
  getAgentCliPromptAdapter,
  isAgentCliCompatibilityCandidate,
  normalizeAgentCliPreview,
} from './agentCliCompletion';

function card(terminalType: TerminalCard['terminalType'], executionMode?: TerminalCard['executionMode']): TerminalCard {
  return {
    id: `${terminalType}-card`,
    ptyId: `${terminalType}-card`,
    projectPath: '/tmp/repo',
    projectName: 'repo',
    terminalType,
    executionMode,
    status: 'idle',
    createdAt: 1,
    lastActivity: 1,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 1,
    events: [],
    unread: false,
  };
}

describe('agent CLI compatibility contract', () => {
  it('keeps the timing contract explicit', () => {
    expect(AGENT_CLI_PROMPT_SETTLE_MS).toBe(500);
    expect(AGENT_CLI_COMPATIBILITY_IDLE_MS).toBe(8_000);
    expect(AGENT_CLI_MIN_RUNNING_MS).toBe(1_500);
  });

  it.each([
    ['claude', '\u001b[32manswer\u001b[0m\n> '],
    ['codex', 'done\ncodex> '],
    ['opencode', 'done\n› '],
    ['gemini', 'done\ngemini> '],
    ['kimi', 'done\nkimi> '],
    ['grok', 'done\ngrok> '],
  ] as const)('recognizes the %s provider prompt only at the rendered tail', (provider, output) => {
    const expectedPrompt = {
      claude: '>',
      codex: 'codex>',
      opencode: '›',
      gemini: 'gemini>',
      kimi: 'kimi>',
      grok: 'grok>',
    }[provider];
    expect(detectAgentCliPrompt(provider, output)).toBeTruthy();
    expect(detectAgentCliPrompt(provider, `${output}\nmore output`)).toBeNull();
    expect(getAgentCliCompletionFingerprint(provider, output)).toBe(
      `agent-cli:${provider}:prompt:${expectedPrompt}`,
    );
    expect(getAgentCliCompletionAdapter(provider)?.(output)).toBe(
      getAgentCliCompletionFingerprint(provider, output),
    );
  });

  it('does not treat an ordinary shell prompt as compatibility evidence', () => {
    expect(detectAgentCliPrompt('shell', 'done\n$ ')).toBeNull();
    expect(getAgentCliPromptAdapter('custom')).toBeNull();
    expect(getAgentCliCompletionFingerprint('shell', 'done\n$ ')).toBeNull();
    expect(getAgentCliCompletionAdapter('custom')).toBeNull();
  });

  it('strips terminal control sequences before matching', () => {
    expect(normalizeAgentCliPreview('\u001b[2K\r\u001b[32mcodex>\u001b[0m')).toBe('codex>');
    expect(getAgentCliPromptAdapter('codex')?.('codex> ')).toBe('codex>');
    expect(getAgentCliCompletionFingerprint('codex', 'working\rready\ncodex> ')).toBe(
      'agent-cli:codex:prompt:codex>',
    );
  });

  it('normalizes repeated redraws but changes the fingerprint for a renewed prompt', () => {
    const first = getAgentCliCompletionFingerprint('codex', 'answer\n❯ ');
    const redraw = getAgentCliCompletionFingerprint('codex', '\u001b[2K\r❯ ');
    const renewed = getAgentCliCompletionFingerprint('codex', 'answer\ncodex> ');

    expect(redraw).toBe(first);
    expect(renewed).not.toBe(first);
    expect(renewed).toBe('agent-cli:codex:prompt:codex>');
  });

  it('bounds adapter input without letting older output affect the fingerprint', () => {
    const oldPrompt = `${'x'.repeat(9_000)}\nold> `;
    expect(getAgentCliCompletionFingerprint('codex', oldPrompt)).toBeNull();
    expect(getAgentCliCompletionFingerprint('codex', `${oldPrompt}\ncodex> `)).toBe(
      'agent-cli:codex:prompt:codex>',
    );
  });

  it('excludes one-shot and non-agent cards while accepting all known providers', () => {
    expect(isAgentCliCompatibilityCandidate(card('codex'))).toBe(true);
    expect(isAgentCliCompatibilityCandidate(card('claude', 'oneShot'))).toBe(false);
    expect(isAgentCliCompatibilityCandidate(card('shell'))).toBe(false);
  });
});

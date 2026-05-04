import { beforeEach, describe, expect, it, vi } from 'vitest';
import { explainWithAi } from './aiExplain';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, payload: unknown) => invokeMock(cmd, payload),
}));

describe('explainWithAi', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, payload: { provider: string }) => {
      if (cmd !== 'ai_explain') throw new Error(`unexpected cmd ${cmd}`);
      if (payload.provider === 'claude') {
        return { stdout: 'echo lists files', stderr: '', exit_code: 0, timed_out: false };
      }
      return { stdout: '', stderr: 'boom', exit_code: 1, timed_out: false };
    });
  });

  it('returns stdout for a successful claude invocation', async () => {
    const r = await explainWithAi({ provider: 'claude', prompt: 'explain ls' });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.text).toContain('echo lists files');
  });

  it('returns an error envelope when the CLI errors', async () => {
    const r = await explainWithAi({ provider: 'codex', prompt: 'explain ls' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('boom');
  });

  it('rejects empty prompt before invoking', async () => {
    const r = await explainWithAi({ provider: 'claude', prompt: '   ' });
    expect(r.kind).toBe('error');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('returns an actionable error when a successful provider writes empty stdout', async () => {
    invokeMock.mockResolvedValue({
      stdout: '   \n',
      stderr: 'codex produced no final answer',
      exit_code: 0,
      timed_out: false,
    });

    const r = await explainWithAi({ provider: 'codex', prompt: 'explain ls' });

    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('AI provider returned no answer');
      expect(r.message).toContain('codex produced no final answer');
      expect(r.timedOut).toBe(false);
    }
  });

  it('returns an actionable error when a successful provider writes no diagnostics', async () => {
    invokeMock.mockResolvedValue({ stdout: '', stderr: '', exit_code: 0, timed_out: false });

    const r = await explainWithAi({ provider: 'gemini', prompt: 'explain ls' });

    expect(r).toEqual({
      kind: 'error',
      message: 'AI provider returned no answer.',
      timedOut: false,
    });
  });
});

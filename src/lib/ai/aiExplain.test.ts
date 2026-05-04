import { describe, expect, it, vi } from 'vitest';
import { explainWithAi } from './aiExplain';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, payload: { provider: string; prompt: string }) => {
    if (cmd !== 'ai_explain') throw new Error(`unexpected cmd ${cmd}`);
    if (payload.provider === 'claude') {
      return { stdout: 'echo lists files', stderr: '', exit_code: 0, timed_out: false };
    }
    return { stdout: '', stderr: 'boom', exit_code: 1, timed_out: false };
  }),
}));

describe('explainWithAi', () => {
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
  });
});

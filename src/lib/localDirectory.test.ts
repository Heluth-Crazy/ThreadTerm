import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLocalDirectory } from './localDirectory';

const invokeMock = vi.fn();
let tauri = true;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('./tauri-bridge', () => ({
  isTauriEnv: () => tauri,
}));

afterEach(() => {
  invokeMock.mockReset();
  tauri = true;
});

describe('openLocalDirectory', () => {
  it('invokes the local directory command in Tauri', async () => {
    invokeMock.mockResolvedValue(undefined);

    await openLocalDirectory('/Users/example/project');

    expect(invokeMock).toHaveBeenCalledWith('open_local_directory', {
      path: '/Users/example/project',
    });
  });

  it('is a no-op outside Tauri', async () => {
    tauri = false;

    await openLocalDirectory('/Users/example/project');

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('propagates command failures in Tauri', async () => {
    const error = new Error('Directory does not exist.');
    invokeMock.mockRejectedValue(error);

    await expect(openLocalDirectory('/Users/example/missing')).rejects.toThrow(
      'Directory does not exist.',
    );
    expect(invokeMock).toHaveBeenCalledWith('open_local_directory', {
      path: '/Users/example/missing',
    });
  });
});

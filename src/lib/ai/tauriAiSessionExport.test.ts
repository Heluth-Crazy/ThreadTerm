import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveAiSessionMarkdownFile } from './tauriAiSessionExport';

const saveMock = vi.fn();
const writeTextFileMock = vi.fn();

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: (...args: unknown[]) => writeTextFileMock(...args),
}));

vi.mock('../tauri-bridge', () => ({
  isTauriEnv: () => true,
}));

afterEach(() => {
  saveMock.mockReset();
  writeTextFileMock.mockReset();
});

describe('saveAiSessionMarkdownFile', () => {
  it('uses the desktop save dialog before writing Markdown to the selected path', async () => {
    saveMock.mockResolvedValue('/Users/example/Desktop/threadterm-ai.md');
    writeTextFileMock.mockResolvedValue(undefined);

    await expect(
      saveAiSessionMarkdownFile('# Session', 'threadterm-ai-session.md', {
        title: 'Export AI session Markdown',
        filterName: 'Markdown',
      }),
    ).resolves.toEqual({ kind: 'saved', path: '/Users/example/Desktop/threadterm-ai.md' });

    expect(saveMock).toHaveBeenCalledWith({
      title: 'Export AI session Markdown',
      defaultPath: 'threadterm-ai-session.md',
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      canCreateDirectories: true,
    });
    expect(writeTextFileMock).toHaveBeenCalledWith(
      '/Users/example/Desktop/threadterm-ai.md',
      '# Session',
    );
    expect(writeTextFileMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      saveMock.mock.invocationCallOrder[0],
    );
  });

  it('does not write when the save dialog is cancelled', async () => {
    saveMock.mockResolvedValue(null);

    await expect(
      saveAiSessionMarkdownFile('# Session', 'threadterm-ai-session.md'),
    ).resolves.toEqual({ kind: 'cancelled' });

    expect(writeTextFileMock).not.toHaveBeenCalled();
  });
});

import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { isTauriEnv } from '../tauri-bridge';

export type SaveAiSessionMarkdownResult =
  | { kind: 'saved'; path: string }
  | { kind: 'cancelled' };

export interface SaveAiSessionMarkdownOptions {
  title?: string;
  filterName?: string;
}

export async function saveAiSessionMarkdownFile(
  markdown: string,
  defaultPath: string,
  options: SaveAiSessionMarkdownOptions = {},
): Promise<SaveAiSessionMarkdownResult> {
  if (!isTauriEnv()) {
    throw new Error('AI session export is available only in the desktop app.');
  }

  const path = await save({
    title: options.title ?? 'Export AI session Markdown',
    defaultPath,
    filters: [{ name: options.filterName ?? 'Markdown', extensions: ['md', 'markdown'] }],
    canCreateDirectories: true,
  });
  if (!path) return { kind: 'cancelled' };

  await writeTextFile(path, markdown);
  return { kind: 'saved', path };
}

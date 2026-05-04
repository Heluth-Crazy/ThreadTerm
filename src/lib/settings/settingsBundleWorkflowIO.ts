import { join } from '@tauri-apps/api/path';
import { mkdir, readDir, readTextFile, stat, writeTextFile } from '@tauri-apps/plugin-fs';
import { isTauriEnv } from '../tauri-bridge';
import { MAX_WORKFLOW_FILE_BYTES } from '../workflows/discoverWorkflows';
import { resolveGlobalWorkflowsDir } from '../workflows/tauriFs';
import {
  sanitizeSettingsWorkflowFileName,
  type SettingsBundleWorkflowFile,
} from './settingsBundle';

function isMissingDirError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such file/i.test(message) || message.startsWith('ENOENT');
}

export async function readGlobalWorkflowBundleFiles(): Promise<SettingsBundleWorkflowFile[]> {
  if (!isTauriEnv()) return [];

  const dir = await resolveGlobalWorkflowsDir();
  let entries: Awaited<ReturnType<typeof readDir>>;
  try {
    entries = await readDir(dir);
  } catch (error) {
    if (isMissingDirError(error)) return [];
    throw error;
  }

  const files: SettingsBundleWorkflowFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const fileName = sanitizeSettingsWorkflowFileName(entry.name);
    if (!fileName) continue;

    const filePath = await join(dir, fileName);
    const metadata = await stat(filePath);
    if (Number(metadata.size) > MAX_WORKFLOW_FILE_BYTES) continue;

    files.push({
      fileName,
      yamlText: await readTextFile(filePath),
    });
  }
  return files;
}

export async function writeGlobalWorkflowBundleFiles(
  files: SettingsBundleWorkflowFile[],
): Promise<void> {
  if (!isTauriEnv()) {
    throw new Error('Workflow import is available only in the desktop app.');
  }

  const dir = await resolveGlobalWorkflowsDir();
  await mkdir(dir, { recursive: true });

  await Promise.all(
    files.map(async (file) => {
      const fileName = sanitizeSettingsWorkflowFileName(file.fileName);
      if (!fileName) throw new Error(`Invalid workflow file name: ${file.fileName}`);
      const filePath = await join(dir, fileName);
      await writeTextFile(filePath, file.yamlText);
    }),
  );
}

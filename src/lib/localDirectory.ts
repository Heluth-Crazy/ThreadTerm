import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from './tauri-bridge';

export async function openLocalDirectory(path: string): Promise<void> {
  if (!isTauriEnv()) return;
  await invoke('open_local_directory', { path });
}

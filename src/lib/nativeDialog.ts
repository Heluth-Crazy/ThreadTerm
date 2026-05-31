import { confirm as tauriConfirm, type ConfirmDialogOptions } from '@tauri-apps/plugin-dialog';
import { isTauriEnv } from './tauri-bridge';

export async function confirmDialog(
  message: string,
  options?: string | ConfirmDialogOptions,
): Promise<boolean> {
  if (!isTauriEnv()) {
    return typeof window !== 'undefined' ? window.confirm(message) : false;
  }

  try {
    return await tauriConfirm(message, options);
  } catch (error) {
    console.debug('[dialog] native confirm failed, falling back to browser confirm', error);
    return typeof window !== 'undefined' ? window.confirm(message) : false;
  }
}

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { LocalFileRouter } from './router.js';

export function registerLocalFileBackendIpc(
  ipc: Pick<IpcMain, 'handle'>,
  router: LocalFileRouter,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
  machineFor: (event: IpcMainInvokeEvent) => string,
): void {
  const assertLocal = (event: IpcMainInvokeEvent) => {
    assertTrusted(event);
    if (event.senderFrame !== event.sender.mainFrame || machineFor(event) !== 'local') {
      throw new Error('Local file settings require the local application window');
    }
  };
  ipc.handle('threadterm:local-files-get-backend', event => { assertLocal(event); return router.getBackend(); });
  ipc.handle('threadterm:local-files-set-backend', (event, backend: unknown) => { assertLocal(event); return router.setBackend(backend); });
}

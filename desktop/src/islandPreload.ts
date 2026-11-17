import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/* The task island window's only bridge: it receives its model and reports clicks, hover and drags. It cannot reach
   the runtime; main opens sessions on its behalf. */
contextBridge.exposeInMainWorld('threadtermIsland', {
  onModel(listener: (model: unknown) => void) {
    const handler = (_event: IpcRendererEvent, model: unknown) => listener(model);
    ipcRenderer.on('task-island:model', handler);
    ipcRenderer.send('task-island:ready');
    return () => { ipcRenderer.off('task-island:model', handler); };
  },
  setInteractive(on: boolean) { ipcRenderer.send('task-island:interactive', on === true); },
  onPointerLeft(listener: () => void) {
    const handler = () => listener();
    ipcRenderer.on('task-island:pointer-left', handler);
    return () => { ipcRenderer.off('task-island:pointer-left', handler); };
  },
  open(key: string) { if (typeof key === 'string') ipcRenderer.send('task-island:open', key); },
  openApp() { ipcRenderer.send('task-island:open-app'); },
  drag(phase: 'start' | 'move' | 'end', dx: number) { ipcRenderer.send('task-island:drag', { phase, dx: Number.isFinite(dx) ? dx : 0 }); },
});

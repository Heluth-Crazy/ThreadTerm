import { contextBridge, ipcRenderer } from 'electron';
import { HTML_PREVIEW_RTC_POLICY_CHANNEL } from './htmlPreviewPolicy.js';

if (ipcRenderer.sendSync(HTML_PREVIEW_RTC_POLICY_CHANNEL) === true) {
  contextBridge.executeInMainWorld({ func: () => {
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (!/^(?:webkit)?RTC/.test(name)) continue;
      Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
    }
  } });
}

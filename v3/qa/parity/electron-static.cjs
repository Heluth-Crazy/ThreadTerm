// QA-only static browser. Never imports desktop/main or starts any runtime.
const { app, BrowserWindow } = require('electron');
if (!process.env.TT_PARITY_PROFILE) throw new Error('Isolated QA profile required');
app.setPath('userData', process.env.TT_PARITY_PROFILE);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());

// Preloaded into the Electron main process by qa/lib/desktop1.mjs (`-r`). Every window is shown without activation at
// zero opacity, moved to the QA virtual desktop (TT_QA_DESKTOP_INDEX, 0-based, default Desktop 1), and only then made visible — so a
// test app never flashes on, takes focus from, or switches the desktop the user works on. Focus calls become no-ops:
// activating a window on another virtual desktop would switch the user's screen to it. When the move fails, the app
// exits instead of carrying on where the user is working.
if (process.type === 'browser' && process.env.TT_QA_VDESK) {
  const { app } = require('electron');
  const { execFileSync } = require('node:child_process');
  const desktop = process.env.TT_QA_DESKTOP_INDEX || '0';
  const placed = new WeakSet();
  const place = (window, showInactive) => {
    if (placed.has(window) || window.isDestroyed()) return;
    placed.add(window);
    window.setOpacity(0);
    showInactive();
    const handle = window.getNativeWindowHandle();
    const hwnd = (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
    try {
      execFileSync(process.env.TT_QA_VDESK, ['move', hwnd, desktop], { timeout: 10000, windowsHide: true, stdio: 'pipe' });
    } catch (error) {
      console.error(`[desktop1] could not move the window to desktop ${Number(desktop) + 1}: ${String(error.stderr || error.message).trim()}`);
      window.hide();
      app.exit(97);
      return;
    }
    window.setOpacity(1);
  };
  app.on('browser-window-created', (_event, window) => {
    const showInactive = window.showInactive.bind(window);
    window.show = () => { if (placed.has(window)) showInactive(); else place(window, showInactive); };
    window.showInactive = window.show;
    window.focus = () => {};
    window.moveTop = () => {};
  });
  app.focus = () => {};
}

// QA-only Content-Security-Policy audit (task 10-23 R3d): TT_QA_CSP_AUDIT=1 injects qa/lib/csp-audit-preload.cjs into
// every frame and appends each violation as one JSON line to TT_QA_CSP_LOG. A harness run with the audit on proves the
// app's own policy blocked nothing it needs; the preload is never part of the product.
if (process.type === 'browser' && process.env.TT_QA_CSP_AUDIT === '1') {
  const { app, ipcMain, session } = require('electron');
  const { appendFileSync } = require('node:fs');
  const { join } = require('node:path');
  const log = process.env.TT_QA_CSP_LOG;
  if (!log) console.error('[csp-audit] TT_QA_CSP_AUDIT=1 without TT_QA_CSP_LOG records nothing');
  else {
    appendFileSync(log, '');
    ipcMain.on('tt-qa-csp-violation', (_event, payload) => {
      try { appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...payload })}\n`); } catch { /* the app under test must not fail because the audit log did */ }
    });
    app.whenReady().then(() => {
      session.defaultSession.registerPreloadScript({ type: 'frame', filePath: join(__dirname, 'csp-audit-preload.cjs') });
    });
  }
}

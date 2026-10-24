// QA-only (task 10-23 R3d): records every Content-Security-Policy violation in this frame's document and hands it to
// qa/lib/desktop1-hook.cjs, which appends it to TT_QA_CSP_LOG. Registered there only when TT_QA_CSP_AUDIT=1, so it is
// never part of the shipped app; the harness (qa/app-csp-visual.mjs) asserts the log stays empty for app documents.
const { ipcRenderer } = require('electron');
window.addEventListener('securitypolicyviolation', event => {
  ipcRenderer.send('tt-qa-csp-violation', {
    directive: event.effectiveDirective || event.violatedDirective,
    blocked: String(event.blockedURI || '').slice(0, 200),
    disposition: event.disposition,
    sample: String(event.sample || '').slice(0, 200),
    source: String(event.sourceFile || '').slice(0, 200),
    where: String(location.href).slice(0, 300),
    frame: window === window.top ? 'top' : 'child',
  });
});

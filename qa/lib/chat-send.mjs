// Confirm UI submission before waiting for provider-specific output. Never
// resend a prompt whose composer cleared or whose user item reached projection.
export async function sendChatPrompt({ composer, sendButton, text, readSnapshot, readConnection, onDiagnostic, turnStartTimeout = 5_000, readyTimeout = 20_000, pollInterval = 100 }) {
  const delay = () => new Promise(done => setTimeout(done, pollInterval));
  const baseline = new Set((await readSnapshot()).items.filter(item => item.role === 'user').map(item => item.id));
  const started = async () => (await composer.inputValue()) === ''
    || (await readSnapshot()).items.some(item => item.role === 'user' && !baseline.has(item.id));
  await composer.fill(text);
  // fill dispatches input; let React commit the resulting enabled submit state.
  await composer.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1 && await started()) return;
    const readyBy = Date.now() + readyTimeout;
    while (!(await composer.isEnabled()) || !(await sendButton.isEnabled()) || (await composer.inputValue()) !== text) {
      if (Date.now() >= readyBy) throw new Error('Chat send not ready: composer must retain the committed prompt and submit must be enabled');
      await delay();
    }
    let clickError;
    try { await sendButton.click(); } catch (error) { clickError = String(error); }
    const startedBy = Date.now() + turnStartTimeout;
    for (;;) {
      if (await started()) return;
      if (Date.now() >= startedBy) break;
      await delay();
    }
    await onDiagnostic({ attempt, clickError, value: await composer.inputValue(), buttonDisabled: !(await sendButton.isEnabled()), composerDisabled: !(await composer.isEnabled()), connection: await readConnection() });
    if (attempt === 2) throw new Error('Chat turn did not start after two submit attempts; see sendDiagnostics');
  }
}

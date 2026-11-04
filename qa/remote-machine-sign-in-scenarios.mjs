// Slice 4b fake provider sign-in. All listeners/data belong to this probe.
import assert from 'node:assert/strict';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  return server.address().port;
}

export async function setupRemoteSignInProbe() {
  const servers = [], sockets = new Set();
  let clientRequests = 0, authorizationRequests = 0;
  const own = server => {
    servers.push(server);
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    return server;
  };
  const cleanup = async () => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve));
  };
  try {
    const lan = Object.values(networkInterfaces()).flat().find(row => row?.family === 'IPv4' && !row.internal)?.address;
    if (!lan) return { cleanup, get clientRequests() { return clientRequests; } };
    const client = own(http.createServer((_request, response) => { clientRequests++; response.end('CLIENT MUST NOT RECEIVE CALLBACK'); }));
    const port = await listen(client);
    // Reserve a distinct host-side port, then let the host fake CLI bind it.
    const reservation = own(http.createServer());
    const hostPort = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const authorization = own(http.createServer((request, response) => {
      const url = new URL(request.url, `http://${lan}`);
      if (url.pathname !== '/authorize') { response.writeHead(404).end(); return; }
      const target = url.searchParams.get('redirect_uri');
      assert.equal(target, `http://localhost:${port}/callback`);
      authorizationRequests++;
      response.writeHead(302, { Location: `${target}?code=QA`, 'Cache-Control': 'no-store' }).end();
    }));
    const authPort = await listen(authorization, '0.0.0.0');
    const url = `http://${lan}:${authPort}/authorize?redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}`;
    return { port, hostPort, url, portMap: `${port}:${hostPort}`, cleanup,
      get clientRequests() { return clientRequests; }, get authorizationRequests() { return authorizationRequests; } };
  } catch (error) { await cleanup(); throw error; }
}

async function records(scratch, kind) {
  try { return (await readFile(join(scratch, `${kind}-sign-in.jsonl`), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function openAccounts(page) {
  await page.getByRole('button', { name: 'Local user', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
  const accounts = page.locator('details.settings-tool-accounts');
  if (!await accounts.evaluate(node => node.open)) await accounts.locator('summary').click();
  await page.locator('#provider-settings-title').waitFor();
}

export async function runRemoteSignInProbe({ app, remotePage, localPage, rpc, until, pass, hostPeer, session, scratch, out, machine, note, fixtures }) {
  const partition = `persist:threadterm-browser-${machine.id}`;
  const native = () => app.evaluate(({ webContents, session }, partition) => webContents.getAllWebContents()
    .filter(wc => !wc.isDestroyed() && wc.session === session.fromPartition(partition) && !wc.getURL().startsWith('devtools:'))
    .map(wc => ({ id: wc.id, url: wc.getURL() })), partition);
  const terminalText = async id => {
    const output = await hostPeer.request('terminal.read', { sessionId: id, cursor: 0, limit: 65536 });
    return Buffer.from(output.data, 'base64').toString();
  };
  let hostTerminal, localTerminal;
  const receipt = {};
  await app.evaluate(({ shell }) => {
    globalThis.__signInExternal = [];
    globalThis.__signInOriginalExternal = shell.openExternal;
    shell.openExternal = async url => { globalThis.__signInExternal.push(url); };
  });
  try {
    await remotePage.evaluate(() => window.threadterm.browserCommand({ type: 'preferences', patch: { linkTarget: 'system' } }));
    await openAccounts(remotePage);
    const remoteProviders = await rpc(remotePage, 'provider.list');
    const gemini = remoteProviders.find(row => row.id === 'gemini' && row.source === 'plugin');
    const geminiText = 'Google sign-in can’t run in ThreadTerm’s browser. Use an API key, or sign in on that computer.';
    if (gemini) {
      const row = remotePage.locator('.provider-settings .tool-row').filter({ has: remotePage.getByText('Gemini', { exact: true }) });
      await row.getByText(geminiText, { exact: true }).waitFor();
      await row.screenshot({ path: join(out, 'remote-gemini-accounts.png') });
      pass('bundled Gemini remote accounts row shows its single Google guidance line');
    } else note('Gemini is not listed in this QA setup; remote-only English/Chinese guidance is covered by renderer tests');
    const remoteBefore = new Set((await rpc(remotePage, 'runtime.snapshot')).sessions.map(row => row.id));
    const codexRow = remotePage.locator('.provider-settings .tool-row').filter({ has: remotePage.getByText('Codex', { exact: true }) });
    await codexRow.getByRole('button', { name: 'Open sign-in terminal', exact: true }).click();
    receipt.remote = await until(async () => (await records(scratch, 'host')).find(row => row.event === 'login'), 'host fake Codex login');
    assert.deepEqual(receipt.remote.args, ['login', '--device-auth']);
    hostTerminal = (await rpc(remotePage, 'runtime.snapshot')).sessions.find(row => !remoteBefore.has(row.id) && row.provider === 'custom');
    assert.ok(hostTerminal, 'settings creates a custom host terminal');
    if (await remotePage.getByRole('button', { name: 'Close settings', exact: true }).count()) await remotePage.getByRole('button', { name: 'Close settings', exact: true }).click();
    pass('remote Settings → Tools → Provider accounts starts host fake codex login --device-auth');

    if (fixtures.url) {
      await until(async () => (await records(scratch, 'host')).some(row => row.event === 'listening'), 'fake CLI callback listener');
      await until(async () => (await terminalText(hostTerminal.id)).includes(fixtures.url), 'host terminal prints the sign-in link');
      // xterm renders glyphs to a canvas. The pure renderer click decision is unit-tested;
      // use the approved main bridge fallback to avoid a coordinate/hover timing assertion.
      note('Loopback callback uses remote window.threadterm.openExternal on the printed URL; the terminal click decision is covered by the renderer pure-function tests');
      await remotePage.evaluate(url => window.threadterm.openExternal(url), fixtures.url);
      const browser = remotePage.locator('.wb-side-browser .wb-web-preview:visible');
      await browser.getByLabel('Address', { exact: true }).waitFor();
      receipt.callback = await until(async () => (await records(scratch, 'host')).find(row => row.event === 'callback'), 'host fake CLI receives callback');
      assert.equal(receipt.callback.code, 'QA');
      await until(async () => (await terminalText(hostTerminal.id)).includes('Signed in'), 'host terminal prints Signed in');
      const callbackPage = await until(async () => (await native()).find(row => row.url === `http://localhost:${fixtures.port}/callback?code=QA`), 'machine panel follows authorization redirect to host callback');
      const pageText = await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.body.innerText'), callbackPage.id);
      assert.match(pageText, /Signed in on HOST/);
      assert.equal(fixtures.clientRequests, 0);
      assert.equal(fixtures.authorizationRequests, 1);
      assert.deepEqual(await app.evaluate(() => globalThis.__signInExternal), []);
      await remotePage.screenshot({ path: join(out, 'remote-sign-in-panel.png') });
      const png = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'), callbackPage.id);
      await writeFile(join(out, 'host-callback-page.png'), Buffer.from(png, 'base64'));
      pass('public LAN authorization 302 reaches host fake CLI with code=QA; panel shows HOST, terminal prints Signed in, client callback requests=0');
    } else note('No non-loopback IPv4 interface: callback check skipped; unit routing and device-command checks still run');

    const beforeGoogle = await native();
    const google = 'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback';
    const publicUrl = 'https://example.test/device';
    await remotePage.evaluate(url => window.threadterm.openExternal(url), google);
    await remotePage.evaluate(url => window.threadterm.openExternal(url), publicUrl);
    assert.deepEqual(await app.evaluate(() => globalThis.__signInExternal), [google, publicUrl]);
    assert.deepEqual(await native(), beforeGoogle, 'Google and device pages neither open nor navigate the machine panel');
    pass('Google sign-in and public device-code URLs use the stubbed system browser, leaving the machine panel unchanged');

    await remotePage.evaluate(() => window.threadterm.machineShow('local'));
    await until(async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()) === 'ThreadTerm', 'This PC shown');
    await openAccounts(localPage);
    assert.equal(await localPage.getByText(geminiText, { exact: true }).count(), 0);
    const localBefore = new Set((await rpc(localPage, 'runtime.snapshot')).sessions.map(row => row.id));
    const localCodex = localPage.locator('.provider-settings .tool-row').filter({ has: localPage.getByText('Codex', { exact: true }) });
    await localCodex.getByRole('button', { name: 'Open sign-in terminal', exact: true }).click();
    receipt.local = await until(async () => (await records(scratch, 'client')).find(row => row.event === 'login'), 'local fake Codex login');
    assert.deepEqual(receipt.local.args, ['login']);
    localTerminal = (await rpc(localPage, 'runtime.snapshot')).sessions.find(row => !localBefore.has(row.id) && row.provider === 'custom');
    assert.ok(localTerminal);
    if (await localPage.getByRole('button', { name: 'Close settings', exact: true }).count()) await localPage.getByRole('button', { name: 'Close settings', exact: true }).click();
    pass('This PC accounts button still runs fake codex login without device-auth and shows no remote Gemini guidance');
    receipt.clientRequests = fixtures.clientRequests;
    return receipt;
  } finally {
    if (hostTerminal) await hostPeer.request('session.stop', { sessionId: hostTerminal.id, operationId: randomUUID() });
    if (localTerminal) await rpc(localPage, 'session.stop', { sessionId: localTerminal.id, operationId: randomUUID() });
    await app.evaluate(({ shell }) => { shell.openExternal = globalThis.__signInOriginalExternal; delete globalThis.__signInOriginalExternal; });
    await localPage.evaluate(({ id, sessionId }) => window.threadterm.machineShow(id, sessionId), { id: machine.id, sessionId: session.id });
    await remotePage.getByTestId(`session-chat-${session.id}`).locator('textarea').waitFor();
  }
}

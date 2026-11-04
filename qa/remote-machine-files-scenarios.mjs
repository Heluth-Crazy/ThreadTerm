import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runRemoteFilesProbe({ app, remotePage, localPage, rpc, until, pass, hostPeer, hostEnv, clientEnv, hostProject, session, hostWork, clientWork, scratch, out }) {
  const added = join(scratch, 'host-added-project'); await mkdir(added);
  const choose = remotePage.evaluate(async () => {
    const path = await window.threadterm.chooseDirectory();
    if (!path) throw new Error('Host folder chooser cancelled');
    return window.threadterm.request('project.add', { path, name: 'Added through host browser', operationId: crypto.randomUUID() });
  });
  const browser = remotePage.getByRole('dialog', { name: 'Choose a folder', exact: true });
  await browser.getByLabel('Location', { exact: true }).fill(added);
  await browser.getByRole('button', { name: 'Go', exact: true }).click();
  await until(() => browser.getByRole('button', { name: 'Choose this folder', exact: true }).isEnabled(), 'host folder loaded');
  await remotePage.screenshot({ path: join(out, 'host-folder-browser.png') });
  await browser.getByRole('button', { name: 'Choose this folder', exact: true }).click();
  const project = await choose;
  assert.ok((await hostPeer.request('runtime.snapshot')).projects.some(item => item.id === project.id));
  assert.ok(!(await rpc(localPage, 'runtime.snapshot')).projects.some(item => item.id === project.id));
  assert.ok(!project.path.startsWith('\\\\?\\') && /host-added-project$/.test(project.path), `plain host project path: ${project.path}`);
  pass('host browser adds a host-only project without a client native folder dialog');

  const chat = remotePage.getByTestId(`session-chat-${session.id}`);
  await chat.getByTestId('composer-plus').click();
  await chat.getByTestId('plus-attach-files').click();
  await until(() => chat.getByText('client-attachment.log', { exact: false }).count(), 'uploaded log chip');
  await chat.locator('textarea').fill('Read the attached log.'); await chat.locator('button[type=submit]').click();
  const logged = await until(async () => {
    const rows = (await readFile(join(scratch, 'host-provider.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    return rows.find(row => row.direction === 'in' && row.method === 'turn/start' && JSON.stringify(row.params).includes('client-attachment.log'));
  }, 'fake host provider sees attachment path');
  const encoded = JSON.stringify(logged.params);
  assert.ok(encoded.includes('attachments')); assert.ok(!encoded.includes(clientWork.replaceAll('\\', '\\\\')));
  await until(() => chat.getByText('TRANSITION-SAVED-ANSWER', { exact: true }).count().then(count => count >= 2), 'attached turn completes');
  pass('client log uploads in chunks and the fake host provider receives a host-path chip');

  const external = join(scratch, 'host-external'); await mkdir(external); await writeFile(join(external, 'outside.log'), 'HOST OUTSIDE PROJECT');
  const opening = remotePage.evaluate(() => window.threadterm.openExternalFiles());
  const fileBrowser = remotePage.getByRole('dialog', { name: 'Open files', exact: true });
  await fileBrowser.getByLabel('Location', { exact: true }).fill(external); await fileBrowser.getByRole('button', { name: 'Go', exact: true }).click();
  await fileBrowser.getByRole('button', { name: /outside\.log/ }).click(); await fileBrowser.getByRole('button', { name: 'Open', exact: true }).click();
  const paths = await opening; assert.equal(paths.length, 1);
  const registered = await rpc(remotePage, 'filesystem.external.open', { path: paths[0], source: 'dialog', sessionId: session.id });
  assert.ok(registered.file?.id); assert.equal((await rpc(remotePage, 'filesystem.external.read', { id: registered.file.id })).content, 'HOST OUTSIDE PROJECT');
  pass('external-file picker browses and reads a host file outside every project');

  const html = '<!doctype html><meta charset="utf-8"><style>body{margin:24px;background:#142132;color:#fff;font:20px sans-serif}button{padding:20px}</style><h1 id="host-marker">HOST LARGE HTML</h1><button id="shot-target">Review this host element</button><!--' + 'x'.repeat(7 * 1024 * 1024) + '-->';
  await writeFile(join(hostWork, 'large.html'), html);
  await writeFile(join(clientWork, 'large.html'), '<h1>WRONG CLIENT FILE</h1>');
  const frameName = `tt-preview-files-${randomUUID()}`;
  const grant = await remotePage.evaluate(async ({ projectId, frameName }) => {
    const grant = await window.threadterm.htmlPreview({ type: 'grant', projectId, path: 'large.html', frameName, remote: false });
    const frame = document.createElement('iframe'); frame.name = frameName; frame.id = 'remote-files-preview'; frame.sandbox = 'allow-scripts allow-forms allow-popups'; frame.src = grant.url; frame.style.cssText = 'position:fixed;left:30px;top:80px;width:700px;height:360px;z-index:90;background:white'; document.body.append(frame); return grant;
  }, { projectId: hostProject.id, frameName });
  const preview = remotePage.frameLocator('#remote-files-preview'); await preview.locator('#host-marker').waitFor({ timeout: 30000 });
  assert.equal(await preview.locator('#host-marker').textContent(), 'HOST LARGE HTML');
  assert.equal(await preview.locator('body').evaluate(() => ({ bridge: typeof window.threadterm, require: typeof require })).then(value => value.bridge === 'undefined' && value.require === 'undefined'), true);
  await remotePage.screenshot({ path: join(out, 'host-large-preview.png') });
  pass('host HTML larger than 6 MiB renders through the isolated host-backed preview');

  const rect = await remotePage.locator('#remote-files-preview').boundingBox(); assert.ok(rect);
  const picking = remotePage.evaluate(({ frameName, rect }) => window.threadterm.pickPageTarget({ frameName, frameRect: rect }), { frameName, rect });
  await until(() => preview.locator('html').evaluate(() => Boolean(window[Symbol.for('threadterm.pagePicker')]?.cancel)), 'host preview picker installed');
  await preview.locator('#shot-target').click({ force: true }); const picked = await picking; assert.ok(picked?.shot, 'remote WebContentsView capture produces a client-local shot');
  assert.ok(picked.shot.path.startsWith(clientEnv.THREADTERM_V3_USER_DATA));
  const transient = await remotePage.evaluate(id => window.threadterm.readPageShot(id), picked.shot.id); assert.ok(transient?.startsWith('data:image/'));
  const asset = await remotePage.evaluate(({ id, sessionId }) => window.threadterm.persistPageShot(id, sessionId), { id: picked.shot.id, sessionId: session.id });
  assert.ok(asset.path.startsWith(hostEnv.THREADTERM_V3_DATA));
  const draftId = randomUUID(), draft = { ...picked, shot: { ...picked.shot, ...asset }, kind: 'page', id: draftId, projectId: hostProject.id, root: hostWork, body: 'Host screenshot review', createdAt: new Date().toISOString() };
  await rpc(remotePage, 'reviewDrafts.upsert', { draftId, scopeProjectId: hostProject.id, scopeRoot: hostWork, draft, assetPaths: [asset.path], expectedRevision: 0, operationId: randomUUID() });
  const childPromise = app.waitForEvent('window', { predicate: page => page !== localPage && page !== remotePage, timeout: 15000 });
  await remotePage.evaluate(sessionId => window.threadterm.openWindow({ sessionId }), session.id);
  const child = await childPromise;
  try {
    await child.waitForFunction(() => Boolean(window.threadterm));
    const review = await rpc(child, 'reviewDrafts.list', { scopeProjectId: hostProject.id, scopeRoot: hostWork }); assert.equal(review.drafts.find(row => row.draftId === draftId).draft.shot.path, asset.path);
    const read = await child.evaluate(id => window.threadterm.readPageShot(id), asset.id); assert.equal(read, transient);
    pass('review persists a host screenshot and a second controller reads its full bytes');
  } finally { await child.evaluate(() => window.threadterm.windowAction('close')).catch(() => {}); }
  await remotePage.evaluate(async id => { await window.threadterm.htmlPreview({ type: 'revoke', id }); document.querySelector('#remote-files-preview')?.remove(); }, grant.id);

  await app.evaluate(({ dialog }, folder) => { globalThis.__remoteFilesSave = dialog.showSaveDialog; dialog.showSaveDialog = async (...args) => ({ canceled: false, filePath: folder + '/' + args.at(-1).defaultPath }); }, clientWork);
  try {
    const conversation = await rpc(remotePage, 'chat.read', { sessionId: session.id });
    const saved = await remotePage.evaluate(({ title, markdown }) => window.threadterm.exportChatMarkdown({ title, markdown }), { title: 'host-conversation', markdown: '# Host conversation\n\n' + JSON.stringify(conversation) });
    assert.ok(saved.startsWith(clientWork)); assert.ok((await readFile(saved, 'utf8')).includes('TRANSITION-SAVED-ANSWER'));
    const expectedSettings = await rpc(remotePage, 'settings.export', {});
    const settings = await remotePage.evaluate(() => window.threadterm.exportFile('settings')); assert.ok(settings.path.startsWith(clientWork));
    const savedSettings = JSON.parse(await readFile(settings.path, 'utf8')); assert.ok(Number.isFinite(Date.parse(savedSettings.exportedAt))); assert.deepEqual({ ...savedSettings, exportedAt: expectedSettings.exportedAt }, expectedSettings);
    pass('host conversation and settings exports save on the client');
  } finally { await app.evaluate(({ dialog }) => { dialog.showSaveDialog = globalThis.__remoteFilesSave; delete globalThis.__remoteFilesSave; }); }

  await remotePage.evaluate(({ sessionId }) => window.threadterm.revealFile(sessionId, 'large.html'), { sessionId: session.id });
  const panel = remotePage.getByTestId('host-files-panel'); await panel.getByRole('button', { name: /large\.html/ }).waitFor();
  await until(() => panel.locator('.cmd-row.active').filter({ hasText: 'large.html' }).count(), 'Reveal selects the host file');
  await remotePage.screenshot({ path: join(out, 'host-files-reveal.png') }); await panel.getByRole('button', { name: 'Close Files', exact: true }).click();
  pass('remote Reveal opens the host Files panel at the selected item');
  // Restore the original harness Chat before its child/lease/revoke regressions.
  await remotePage.evaluate(sessionId => window.threadterm.onDesktopNavigate ? window.threadterm.request('session.present', { sessionId, placement: 'workspace', presentation: 'focused', operationId: crypto.randomUUID() }) : undefined, session.id);
  await chat.locator('textarea').waitFor();
}

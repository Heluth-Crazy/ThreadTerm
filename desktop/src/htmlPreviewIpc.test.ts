import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { RuntimeClient } from './runtime-client.js';
import { createHtmlPreviewHandler, parseHtmlPreviewCommand } from './htmlPreviewIpc.js';
import { HtmlPreviewGrantManager } from './htmlPreview.js';

test('preview IPC accepts only bounded grant and revoke commands', () => {
  const grant = { type: 'grant', projectId: 'project', path: 'site/index.html', frameName: 'tt-preview-fixture123', remote: false };
  assert.deepEqual(parseHtmlPreviewCommand(grant), grant);
  assert.deepEqual(parseHtmlPreviewCommand({ type: 'selectAll', frameName: 'tt-preview-fixture123' }), { type: 'selectAll', frameName: 'tt-preview-fixture123' });
  assert.deepEqual(parseHtmlPreviewCommand({ type: 'revoke', id: 'a'.repeat(32) }), { type: 'revoke', id: 'a'.repeat(32) });
  for (const input of [null, [], {}, { ...grant, root: '/private' }, { ...grant, remote: 'yes' },
    { ...grant, path: '' }, { ...grant, path: 'a'.repeat(16385) }, { ...grant, projectId: 'x\0y' },
    { ...grant, frameName: 'other-frame' }, { ...grant, worktreePath: 1 },
    { type: 'revoke', id: '../grant' }, { type: 'revoke', id: 'a'.repeat(32), owner: 2 }]) {
    assert.throws(() => parseHtmlPreviewCommand(input), /Invalid preview command/);
  }
});

test('preview IPC requires a trusted main frame and fences grant ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tt-html-ipc-'));
  await writeFile(join(root, 'index.html'), '<h1>Fixture</h1>');
  const manager = new HtmlPreviewGrantManager();
  let destroyed = false;
  const frame = { detached: false, framesInSubtree: [] };
  const sender = { id: 1, mainFrame: frame, isDestroyed: () => destroyed };
  const event = { sender, senderFrame: frame, trusted: true };
  const invokeEvent = (value: unknown) => value as IpcMainInvokeEvent;
  const runtime = { request: async () => ({ projects: [{ id: 'project', path: root }] }) } as unknown as RuntimeClient;
  const handler = createHtmlPreviewHandler(manager, value => {
    if (!(value as unknown as { trusted: boolean }).trusted) throw new Error('Untrusted renderer');
  }, () => runtime);
  const command = { type: 'grant', projectId: 'project', path: 'index.html', frameName: 'tt-preview-fixture123', remote: false };
  const unavailable = createHtmlPreviewHandler(manager, () => {}, () => runtime, () => false);
  await assert.rejects(unavailable(invokeEvent(event), command), /safety preload is unavailable/);
  await assert.rejects(handler(invokeEvent({ ...event, trusted: false }), command), /Untrusted/);
  await assert.rejects(handler(invokeEvent({ ...event, senderFrame: { detached: false } }), command), /main frame/);
  const grant = await handler(invokeEvent(event), command);
  assert.ok(grant?.id);
  await handler(invokeEvent({ ...event, sender: { ...sender, id: 2 } }), { type: 'revoke', id: grant.id });
  assert.ok(manager.get(grant.id), 'another owner cannot revoke the grant');
  await handler(invokeEvent(event), { type: 'revoke', id: grant.id });
  assert.equal(manager.get(grant.id), undefined);
  destroyed = true;
  await assert.rejects(handler(invokeEvent(event), command), /main frame/);
  assert.equal(manager.listForOwner(1).length, 0);
});

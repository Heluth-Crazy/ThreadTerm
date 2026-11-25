import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogVisibility, Session } from '@threadterm/protocol';
import { autoSettleCandidates, autoSettleDays, sessionWorking, settleBlockedReason, settledSessions, settleGroup } from './sessionSettle';
import { panelPagesForWorkspace } from './panelBrowser';
import { BROWSER_NEW_TAB_URL } from './browserNewTab';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, title: id, projectId: 'p', provider: 'codex', mode: 'chat', status: 'exited', createdAt: daysAgo(30), updatedAt: daysAgo(10), ...patch,
} as Session);
const archived = (id: string, revision = 1): CatalogVisibility => ({ kind: 'session', id, visibility: 'archived', revision });
const options = (patch: Partial<Parameters<typeof autoSettleCandidates>[2]> = {}) =>
  ({ now: NOW, days: 7, projectActive: () => true, canRelease: () => true, ...patch });

test('the setting takes the offered choices and defaults to 7 days', () => {
  assert.equal(autoSettleDays(undefined), 7);
  assert.equal(autoSettleDays(0), 0);
  assert.equal(autoSettleDays(14), 14);
  assert.equal(autoSettleDays(5), 7);
  assert.equal(autoSettleDays('3'), 7);
});

test('working means a turn runs or someone is waiting; an idle shell is not working', () => {
  assert.equal(sessionWorking(session('a', { status: 'running' })), true);
  assert.equal(sessionWorking(session('a', { status: 'waiting' })), true);
  assert.equal(sessionWorking(session('a', { status: 'starting', mode: 'terminal' })), true);
  assert.equal(sessionWorking(session('a', { status: 'running', mode: 'terminal' })), false);
  assert.equal(sessionWorking(session('a', { status: 'idle', activity: { state: 'awaiting_input', revision: 1 } })), true);
  assert.equal(sessionWorking(session('a', { delegation: { id: 'd', parentSessionId: 'x', workspace: 'shared', state: 'running' } })), true);
  assert.equal(sessionWorking(session('a', { status: 'idle' })), false);
  assert.equal(sessionWorking(session('a', { status: 'running', readOnly: true })), false);
});

test('a session settles with the delegates it started, and theirs', () => {
  const delegate = (id: string, parent: string) => session(id, { delegation: { id: `d-${id}`, parentSessionId: parent, workspace: 'shared', state: 'completed' } });
  const sessions = [session('root'), delegate('kid', 'root'), delegate('grandkid', 'kid'), session('other'), delegate('stranger', 'other')];
  assert.deepEqual(settleGroup('root', sessions).map(row => row.id), ['root', 'kid', 'grandkid']);
  assert.deepEqual(settleGroup('missing', sessions), []);
});

test('the shelf lists settled sessions, newest first, without delegates whose parent is listed', () => {
  const sessions = [
    session('old', { updatedAt: daysAgo(20) }), session('new', { updatedAt: daysAgo(1) }), session('live'),
    session('kid', { delegation: { id: 'd', parentSessionId: 'new', workspace: 'shared', state: 'completed' } }),
    session('elsewhere', { projectId: 'archived-project' }),
  ];
  const shelf = settledSessions(sessions, [archived('old'), archived('new'), archived('kid'), archived('elsewhere')], id => id === 'p');
  assert.deepEqual(shelf.map(row => row.id), ['new', 'old']);
});

test('auto-settle picks quiet sessions in the tree and leaves pinned, followed, working and recent ones', () => {
  const sessions = [
    session('quiet'),
    session('recent', { updatedAt: daysAgo(2) }),
    session('pinned', { pinned: true }),
    session('followed', { followed: true }),
    session('working', { status: 'running' }),
    session('settled'),
    session('parent'),
    session('busy-kid', { delegation: { id: 'd', parentSessionId: 'parent', workspace: 'shared', state: 'running' } }),
    session('shell', { mode: 'terminal', status: 'running', provider: 'shell' }),
  ];
  const picked = autoSettleCandidates(sessions, [archived('settled')], options({ canRelease: row => row.id !== 'shell' }));
  assert.deepEqual(picked.map(row => row.id), ['quiet']);
  assert.deepEqual(autoSettleCandidates(sessions, [], options({ days: 0 })), [], 'off');
  assert.deepEqual(autoSettleCandidates([session('quiet')], [], options({ projectActive: () => false })), [], 'archived project');
  assert.deepEqual(autoSettleCandidates([session('quiet', { updatedAt: 'not a date' })], [], options()), []);
});

test('settling by hand is refused while a member works, naming it', () => {
  assert.equal(settleBlockedReason([session('a'), session('b')], true), undefined);
  assert.match(settleBlockedReason([session('a'), session('b', { status: 'running' })], true) ?? '', /^b 正在工作/);
  assert.match(settleBlockedReason([session('b', { status: 'running' })], false) ?? '', /^b is working/);
});

test('the side-bar pages saved with a workspace are loaded http(s) pages with bounded titles', () => {
  const id = (n: number) => `workspace-browser:0f8e1c1e-6a52-4d36-9d0e-6f3f7b6d2a${String(n).padStart(2, '0')}`;
  const pages = panelPagesForWorkspace([
    { tabId: id(1), url: 'http://localhost:5173/', title: 'Vite\u0007 app' },
    { tabId: id(2), url: BROWSER_NEW_TAB_URL },
    { tabId: id(3), url: 'https://example.test/', title: '页'.repeat(300) },
    { tabId: id(4), url: 'file:///C:/x' },
  ]);
  assert.deepEqual(pages.map(page => page.id), [id(1), id(3)]);
  assert.equal(pages[0].title, 'Vite  app');
  assert.ok(new TextEncoder().encode(pages[1].title).length <= 512);
  assert.equal(panelPagesForWorkspace(Array.from({ length: 25 }, (_, n) => ({ tabId: id(n), url: 'http://localhost/' }))).length, 20);
});

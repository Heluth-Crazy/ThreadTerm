import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import type { PairedDevice } from '@threadterm/protocol';
import { devicesForProfile, settingsPageVisible } from './machines';
import { MachineRowsView } from './components/MachineRows';
import { machineTreeKey } from './machineTypes';
import type { MachineSnapshot, MachineTreeFeed } from './machineTypes';

test('Computers and Phones are both available on This PC; Computers holds the preview switch', () => {
  assert.equal(settingsPageVisible('computers', false), true);
  assert.equal(settingsPageVisible('mobile', false), true);
});
test('phone rows stay in Phones and desktop rows stay in Computers, preserving legacy phones', () => {
  const rows = [{ id: 'phone', profile: 'phone' }, { id: 'pc', profile: 'desktop' }, { id: 'legacy-phone' }] as PairedDevice[];
  assert.deepEqual(devicesForProfile(rows, 'phone').map(row => row.id), ['phone', 'legacy-phone']);
  assert.deepEqual(devicesForProfile(rows, 'desktop').map(row => row.id), ['pc']);
});
test('remote views hide data backup/restore/relocation and both device administration pages', () => {
  for (const tab of ['data', 'mobile', 'computers']) assert.equal(settingsPageVisible(tab, true), false);
  for (const tab of ['appearance', 'controls', 'terminal', 'browser', 'tools', 'plugins', 'usage']) assert.equal(settingsPageVisible(tab, true), true);
});
test('machine rows appear only with the gate and a paired computer, with names, states and current selection', () => {
  const snapshot: MachineSnapshot = { enabled: false, currentId: 'local', machines: [{ id: 'local', name: 'This PC', color: '#888888', state: 'local' }, { id: 'office', name: 'Office PC', color: '#3fb8a6', state: 'disconnected' }] };
  const render = () => renderToStaticMarkup(createElement(MachineRowsView, { zh: false, snapshot }));
  assert.equal(render(), '');
  snapshot.enabled = true;
  const html = render();
  assert.match(html, /aria-label="Computers"/); assert.match(html, /Office PC/); assert.match(html, /Disconnected/); assert.match(html, /aria-current="true"/);
  snapshot.machines.pop(); assert.equal(render(), '');
});

const treeFixture = () => {
  const snapshot: MachineSnapshot = { enabled: true, currentId: 'local', machines: [{ id: 'local', name: 'This PC', color: '#888888', state: 'local' }, { id: 'office', name: 'Office-PC', color: '#3fb8a6', state: 'connected' }] };
  const session = { id: 'same', title: 'Remote approval', provider: 'codex', mode: 'chat', status: 'waiting', createdAt: 'now', updatedAt: 'now' } as const;
  const feed: MachineTreeFeed = { expanded: {}, machines: [
    { machine: snapshot.machines[0], projects: [{ id: 'local-project', name: 'STALE OWN FEED', path: 'C:/local', createdAt: 'now' }], worktrees: [], sessions: [{ session: { ...session, title: 'STALE OWN SESSION' }, needsYou: 0 }], needsYou: 0 },
    { machine: snapshot.machines[1], projects: [{ id: 'remote-project', name: 'Host project', path: 'C:/host', createdAt: 'now' }], worktrees: [{ id: 'branch', projectId: 'remote-project', path: 'C:/host', branch: 'main', head: '', isMain: true, locked: false, missing: false }], sessions: [{ session: { ...session, projectId: 'remote-project', worktreePath: 'C:/host' }, needsYou: 2 }], needsYou: 2 },
  ] };
  return { snapshot, feed };
};
test('machine tree uses own snapshot children and the other machine feed, with attention counts', () => {
  const { snapshot, feed } = treeFixture();
  const html = renderToStaticMarkup(createElement(MachineRowsView, { zh: false, snapshot, feed }, createElement('div', { 'data-own-snapshot': true }, 'OWN LIVE SNAPSHOT')));
  assert.match(html, /OWN LIVE SNAPSHOT/); assert.doesNotMatch(html, /STALE OWN/);
  assert.match(html, /Host project/); assert.match(html, />main</); assert.match(html, /Remote approval/);
  assert.match(html, /aria-label="2 needs you"/); assert.equal((html.match(/data-session-id="same"/g) ?? []).length, 2);
  assert.ok(html.indexOf('Add a computer') > html.indexOf('Remote approval'));
});
test('online rows show only counts; a plain-directory project lists its sessions without a branch row', () => {
  const { snapshot, feed } = treeFixture();
  feed.machines[1].worktrees = [];
  const html = renderToStaticMarkup(createElement(MachineRowsView, { zh: false, snapshot, feed }));
  assert.doesNotMatch(html, />Connected<|>Local</);
  assert.match(html, /Remote approval/); assert.doesNotMatch(html, /Local directory/);
  feed.expanded[machineTreeKey('office', 'project', 'remote-project')] = false;
  const collapsed = renderToStaticMarkup(createElement(MachineRowsView, { zh: false, snapshot, feed }));
  assert.doesNotMatch(collapsed, /Remote approval/);
  assert.equal((collapsed.match(/aria-label="2 needs you"/g) ?? []).length, 2, 'machine row and collapsed project row');
});
test('offline machine renders only its row and never a stale subtree', () => {
  const { snapshot, feed } = treeFixture(); feed.machines[1].machine.state = 'disconnected';
  const html = renderToStaticMarkup(createElement(MachineRowsView, { zh: false, snapshot, feed }));
  assert.match(html, /Office-PC/); assert.match(html, /Disconnected/); assert.doesNotMatch(html, /Host project|Remote approval/);
});
test('gate off or no paired computer leaves the existing sidebar content unchanged', () => {
  const { snapshot, feed } = treeFixture(); snapshot.enabled = false;
  const own = createElement('div', { className: 'project-catalog' }, 'unchanged own interactions');
  const expected = renderToStaticMarkup(own);
  assert.equal(renderToStaticMarkup(createElement(MachineRowsView, { zh: false, snapshot, feed }, own)), expected);
  snapshot.enabled = true; snapshot.machines = snapshot.machines.slice(0, 1);
  assert.equal(renderToStaticMarkup(createElement(MachineRowsView, { zh: false, snapshot, feed }, own)), expected);
});
test('shared machine, project and branch expansion applies in every view and includes machine identity', () => {
  const { snapshot, feed } = treeFixture();
  feed.expanded[machineTreeKey('office', 'branch', 'C:/host')] = false;
  const render = () => renderToStaticMarkup(createElement(MachineRowsView, { zh: false, snapshot, feed }));
  assert.match(render(), /Host project/); assert.doesNotMatch(render(), /Remote approval/);
  feed.expanded[machineTreeKey('office', 'project', 'remote-project')] = false;
  assert.doesNotMatch(render(), />main</);
  assert.notEqual(machineTreeKey('local', 'session', 'same'), machineTreeKey('office', 'session', 'same'));
});

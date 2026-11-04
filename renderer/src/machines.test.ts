import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import type { PairedDevice } from '@threadterm/protocol';
import { devicesForProfile, settingsPageVisible } from './machines';
import { MachineRowsView } from './components/MachineRows';
import type { MachineSnapshot } from './machineTypes';

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

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import type { RemoteAccessStatus } from '@threadterm/protocol';
import { CrossNetworkControl } from './CrossNetworkSetting';
import { userErrorText } from '../runtimeError';

const status = (patch: Partial<RemoteAccessStatus>): RemoteAccessStatus => ({ enabled: true, tailscaleOnly: false, tlsFingerprint: 'AA', irohEnabled: false, ...patch });
const render = (zh: boolean, value: RemoteAccessStatus) => renderToStaticMarkup(createElement(CrossNetworkControl, { zh, status: value, busy: false, onChange: () => {} }));

test('Connect across networks is off by default, bilingual, and hides the relay until it is on', () => {
  for (const zh of [false, true]) {
    const off = render(zh, status({}));
    assert.match(off, /role="switch"/); assert.match(off, /aria-checked="false"/);
    assert.ok(off.includes(zh ? '跨网络连接' : 'Connect across networks'));
    assert.ok(off.includes(zh ? '开启后请重新配对' : 'Pair again after turning this on'));
    assert.ok(!off.includes(zh ? '中继服务器' : 'Relay server'));
    const on = render(zh, status({ irohEnabled: true, irohError: 'Connecting across networks is unavailable: no route' }));
    assert.match(on, /aria-checked="true"/);
    assert.ok(on.includes(zh ? '中继服务器' : 'Relay server'));
    assert.ok(on.includes('no route'), 'a start-up failure is shown while the switch is on');
  }
});

test('Tailscale-only turns crossing networks off and says how to use it', () => {
  for (const zh of [false, true]) {
    const html = render(zh, status({ tailscaleOnly: true, irohEnabled: true }));
    assert.match(html, /aria-checked="false"/);
    assert.match(html, /disabled=""/);
    assert.ok(html.includes(zh ? '请先关闭“仅接受我的 Tailscale 网络中的设备”' : 'Turn off “Only accept devices on my Tailscale network”'));
  }
});

test('Computers mounts the setting next to Tailscale-only with one shared status, and its errors read as sentences', () => {
  const source = readFileSync('renderer/src/components/MachineSettings.tsx', 'utf8');
  assert.match(source, /<TailscaleOnlySetting zh=\{zh\} onStatus=\{setRemoteStatus\} \/>/);
  assert.match(source, /<CrossNetworkSetting zh=\{zh\} status=\{remoteStatus\} onStatus=\{setRemoteStatus\} \/>/);
  const wrapped = new Error("Error invoking remote method 'threadterm:machine-prepare': Error: iroh_unreachable: the other computer did not answer");
  assert.match(userErrorText(wrapped, 'fallback', false), /^Couldn’t reach that computer across networks\./);
  assert.match(userErrorText(wrapped, 'fallback', true), /^无法跨网络连接到那台电脑/);
});

test('Phones independently exposes the same cross-network host setting', () => {
  const source = readFileSync('renderer/src/components/DeviceSettings.tsx', 'utf8');
  assert.match(source, /<TailscaleOnlySetting zh=\{zh\} active=\{active\} onStatus=\{setStatus\} \/>/);
  assert.match(source, /<CrossNetworkSetting zh=\{zh\} status=\{status\} onStatus=\{setStatus\} \/>/);
});

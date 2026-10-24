import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import { RemoteIdentityRecovery } from './RemoteIdentityRecovery';

const en = (_cn: string, value: string) => value;
const zh = (value: string) => value;

// F01: an unusable optional TLS identity must be visible, actionable and never
// repaired silently for devices that were already paired.
test('a damaged remote identity shows the exact error with an explicit reset', () => {
  const error = 'Remote access unavailable: remote TLS certificate/key pair is incomplete: remote-access-key.pem is missing';
  const html = renderToStaticMarkup(createElement(RemoteIdentityRecovery, { error, busy: false, text: en, onReset: () => {} }));
  assert.match(html, /role="alert"/);
  assert.match(html, /remote TLS certificate\/key pair is incomplete: remote-access-key\.pem is missing/);
  assert.match(html, /<button class="btn btn-sm btn-danger"[^>]*>Reset remote identity<\/button>/);
  assert.match(html, /every paired device must pair again/);
  assert.doesNotMatch(html, /disabled/);
});

test('the reset button waits for a running device action and is bilingual', () => {
  const html = renderToStaticMarkup(createElement(RemoteIdentityRecovery, { error: 'unavailable', busy: true, text: zh, onReset: () => {} }));
  assert.match(html, /<button class="btn btn-sm btn-danger" disabled=""[^>]*>重置远程身份<\/button>/);
  assert.match(html, /要求所有已配对设备重新配对/);
});

test('Devices settings wire the error state to the persisted reset operation', () => {
  const source = readFileSync(resolve('renderer/src/components/DeviceSettings.tsx'), 'utf8');
  assert.match(source, /status\?\.identityError && <RemoteIdentityRecovery/);
  assert.match(source, /request\("device\.identity\.reset", \{ operationId: operationId\(\) \}\)/);
  assert.match(source, /device\.identity\.reset[\s\S]*setConfirmingReset\(false\)/);
  assert.match(source, /setNotice\(text\("远程身份已更换，所有设备都需要重新配对。"/);
});

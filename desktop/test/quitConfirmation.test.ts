import assert from 'node:assert/strict';
import test from 'node:test';
import { hostingQuitContext, hostingQuitChoice, hostingQuitQaChoice, hostingQuitOptions, quitConfirmationOptions, quitConfirmationPreapproved } from '../src/quitConfirmation';

test('only the explicit QA flag pre-approves quitting', () => {
  assert.equal(quitConfirmationPreapproved({ THREADTERM_V3_QA_AUTO_CONFIRM_QUIT: '1' }), true);
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
    assert.equal(quitConfirmationPreapproved({ THREADTERM_V3_QA_AUTO_CONFIRM_QUIT: value }), false, `value ${JSON.stringify(value)}`);
  }
  assert.equal(quitConfirmationPreapproved({}), false);
});

const device = (profile = 'desktop', connected = false, name = 'Laptop', revokedAt?: string) => ({ profile, connected, name, revokedAt }) as import('@threadterm/protocol').PairedDevice;
test('hosting quit applies to a live runtime with an enabled eligible host profile', () => {
  assert.equal(hostingQuitContext(false, true, false, [device()]), undefined);
  assert.equal(hostingQuitContext(true, false, false, [device()]), undefined);
  assert.equal(hostingQuitContext(true, false, false, [device('mobile')]), undefined);
  assert.equal(hostingQuitContext(true, true, false, [device('mobile')]), undefined, 'Computers does not make mobile credentials host the runtime');
  assert.equal(hostingQuitContext(true, false, true, [device('desktop')]), undefined, 'desktop pairing remains behind the Computers preview');
  for (const rows of [[], [device('phone')], [device('desktop', true, 'Removed', 'now')]]) assert.equal(hostingQuitContext(true, true, true, rows), undefined);
  assert.deepEqual(hostingQuitContext(true, true, false, [device()]), { connectedNames: [] });
  assert.deepEqual(hostingQuitContext(true, false, true, [device('mobile')]), { connectedNames: [] }, 'mobile-only hosting does not depend on the Computers preview');
  assert.deepEqual(hostingQuitContext(true, false, true), { connectedNames: [] }, 'unreadable eligible list on a running host must ask');
  assert.deepEqual(hostingQuitContext(true, true, true, [device('desktop', true, 'Laptop'), device('desktop', false, 'Offline'), device('mobile', true, 'Phone'), device('phone', true, 'Legacy')]), { connectedNames: ['Laptop', 'Phone'] });
  assert.deepEqual(hostingQuitContext(true, false, true, [device('future' as 'desktop', true, 'Unknown')]), { connectedNames: ['Unknown'] }, 'unknown explicit profiles are conservative');
  assert.deepEqual([0,1,2,-1].map(hostingQuitChoice), ['keep','stop','cancel','cancel']);
});
test('hosting dialog has bilingual prototype copy and safe default/Escape choices; old dialog unchanged', () => {
  const icon = {} as import('electron').NativeImage;
  for (const zh of [false,true]) {
    const result = hostingQuitOptions(zh, icon, { connectedNames: ['Laptop'] });
    assert.deepEqual(result.buttons, zh ? ['退出，保持运行','全部停止','取消'] : ['Quit, keep running','Stop everything','Cancel']);
    assert.equal(result.defaultId, 0); assert.equal(result.cancelId, 2);
    assert.equal(result.message, zh ? 'Laptop 正在使用本机' : 'Laptop is using this PC');
    assert.match(result.detail!, /Laptop/);
    assert.equal(hostingQuitOptions(zh, icon, { connectedNames: [] }).message, zh ? '其他电脑可以使用本机' : 'Other computers can use this PC');
    assert.deepEqual(quitConfirmationOptions(zh, icon).buttons, zh ? ['继续运行','退出应用'] : ['Keep running','Exit application']);
    assert.equal(quitConfirmationOptions(zh, icon).cancelId, 0);
  }
  assert.equal(hostingQuitOptions(false, icon, { connectedNames: ['Laptop','Office'] }).message, 'Laptop, Office are using this PC');
  assert.match(hostingQuitOptions(false, icon, { connectedNames: ['Laptop'] }).detail!, /so Laptop keeps working/);
  assert.match(hostingQuitOptions(false, icon, { connectedNames: [] }).detail!, /so other computers keep working/);
});
test('hosting QA choice is exact and never reads the variable in packaged apps', () => {
  for (const choice of ['keep','stop']) assert.equal(hostingQuitQaChoice(false,{THREADTERM_V3_QA_HOST_QUIT_CHOICE:choice}),choice);
  for (const choice of [undefined,'cancel','KEEP',' keep','1']) assert.equal(hostingQuitQaChoice(false,{THREADTERM_V3_QA_HOST_QUIT_CHOICE:choice}),undefined);
  const env = Object.defineProperty({}, 'THREADTERM_V3_QA_HOST_QUIT_CHOICE', { get() { throw Error('must not read packaged QA environment'); } });
  assert.equal(hostingQuitQaChoice(true,env),undefined);
});

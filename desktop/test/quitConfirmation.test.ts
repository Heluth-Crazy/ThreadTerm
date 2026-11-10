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
test('hosting quit applies only to a live runtime with Computers enabled and an unrevoked desktop', () => {
  assert.equal(hostingQuitContext(false, true, [device()]), undefined);
  assert.equal(hostingQuitContext(true, false, [device()]), undefined);
  for (const rows of [[], [device('phone')], [device('desktop', true, 'Removed', 'now')]]) assert.equal(hostingQuitContext(true, true, rows), undefined);
  assert.deepEqual(hostingQuitContext(true, true, [device()]), { connectedNames: [], known: true });
  assert.deepEqual(hostingQuitContext(true, true), { connectedNames: [], known: false }, 'unreadable list on a running host must ask');
  assert.deepEqual(hostingQuitContext(true, true, [device('desktop', true, 'Laptop'), device('desktop', false, 'Offline'), device('desktop', true, 'Office')]), { connectedNames: ['Laptop', 'Office'], known: true });
  assert.deepEqual([0,1,2,-1].map(hostingQuitChoice), ['keep','stop','cancel','cancel']);
});
test('hosting dialog has bilingual prototype copy and safe default/Escape choices; old dialog unchanged', () => {
  const icon = {} as import('electron').NativeImage;
  for (const zh of [false,true]) {
    const result = hostingQuitOptions(zh, icon, { connectedNames: ['Laptop'], known: true });
    assert.deepEqual(result.buttons, zh ? ['退出，保持运行','全部停止','取消'] : ['Quit, keep running','Stop everything','Cancel']);
    assert.equal(result.defaultId, 0); assert.equal(result.cancelId, 2);
    assert.equal(result.message, zh ? 'Laptop 正在使用本机' : 'Laptop is using this PC');
    assert.match(result.detail!, /Laptop/);
    assert.equal(hostingQuitOptions(zh, icon, { connectedNames: [], known: false }).message, zh ? '其他电脑可以使用本机' : 'Other computers can use this PC');
    assert.deepEqual(quitConfirmationOptions(zh, icon).buttons, zh ? ['继续运行','退出应用'] : ['Keep running','Exit application']);
    assert.equal(quitConfirmationOptions(zh, icon).cancelId, 0);
  }
  assert.equal(hostingQuitOptions(false, icon, { connectedNames: ['Laptop','Office'], known: true }).message, 'Laptop, Office are using this PC');
  assert.match(hostingQuitOptions(false, icon, { connectedNames: ['Laptop'], known: true }).detail!, /so Laptop keeps working/);
  assert.match(hostingQuitOptions(false, icon, { connectedNames: [], known: false }).detail!, /so other computers keep working/);
});
test('the quit dialog defaults to stopping everything only when it knows nobody is connected', () => {
  const icon = {} as import('electron').NativeImage;
  for (const zh of [false, true]) {
    const idle = hostingQuitOptions(zh, icon, { connectedNames: [], known: true });
    assert.equal(idle.defaultId, 1, 'Enter must stop everything when nobody is connected');
    assert.equal(idle.cancelId, 2);
    assert.equal(idle.message, zh ? '没有其他电脑在使用本机' : 'No other computer is using this PC');
    assert.match(idle.detail!, zh ? /退出，保持运行/ : /Quit, keep running/);
    assert.match(idle.detail!, zh ? /内存/ : /memory/);
    // Same buttons in the same order as the busy dialog; only the default moves.
    const busy = hostingQuitOptions(zh, icon, { connectedNames: ['Laptop'], known: true });
    assert.deepEqual(idle.buttons, busy.buttons);
    assert.equal(busy.defaultId, 0, 'a connected computer keeps "Quit, keep running" as the default');
    // An unreadable device list cannot prove nobody is connected, so it keeps the safe default.
    assert.equal(hostingQuitOptions(zh, icon, { connectedNames: [], known: false }).defaultId, 0);
  }
  assert.deepEqual([0, 1, 2].map(hostingQuitChoice), ['keep', 'stop', 'cancel']);
});

test('hosting QA choice is exact and never reads the variable in packaged apps', () => {
  for (const choice of ['keep','stop']) assert.equal(hostingQuitQaChoice(false,{THREADTERM_V3_QA_HOST_QUIT_CHOICE:choice}),choice);
  for (const choice of [undefined,'cancel','KEEP',' keep','1']) assert.equal(hostingQuitQaChoice(false,{THREADTERM_V3_QA_HOST_QUIT_CHOICE:choice}),undefined);
  const env = Object.defineProperty({}, 'THREADTERM_V3_QA_HOST_QUIT_CHOICE', { get() { throw Error('must not read packaged QA environment'); } });
  assert.equal(hostingQuitQaChoice(true,env),undefined);
});

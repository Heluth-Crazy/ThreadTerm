import './loopback-proxy.test.js';
import './machine-watcher.test.js';
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { PROTOCOL_VERSION, PROTOCOL_CONTRACT } from '@threadterm/protocol';
import { MachineRegistry } from '../src/machines.js';
import { MachineBindings, MachineViews } from '../src/machineViews.js';
import { createAppSessionPreparer } from '../src/appSession.js';
import { connectPinned, parsePairDescriptor, pairOnPinnedConnection, PeerHeartbeat, PeerTransportError } from '../src/peer-transport.js';
import { RuntimeClient } from '../src/runtime-client.js';

const scratch = mkdtempSync(join(tmpdir(), 'tt-machine-test-'));
let cert: Buffer, key: Buffer, pin: string;
before(() => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem'), '-subj', '/CN=127.0.0.1', '-days', '1'], { windowsHide: true, stdio: 'ignore' });
  cert = readFileSync(join(scratch, 'cert.pem')); key = readFileSync(join(scratch, 'key.pem')); pin = new X509Certificate(cert).fingerprint256;
});
after(() => rmSync(scratch, { recursive: true, force: true }));
const descriptor = () => ({ v: 1, serverUrl: 'https://127.0.0.1:4567', pairingId: randomUUID(), code: 'ABCD-'.repeat(7) + 'ABCD', tlsFingerprint: pin });
const text = (value: unknown) => `threadterm://pair?data=${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const secureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 0xAA)),
  decryptString: (value: Buffer) => Buffer.from([...value].map(byte => byte ^ 0xAA)).toString(),
};
test('registry round trips encrypted credentials and exposes metadata only', () => {
  const path = join(scratch, 'machines.json'), credential = 'SECRET-credential-for-host-only';
  const registry = new MachineRegistry(path, secureStorage);
  const entry = registry.add({ name: 'Office PC', color: '#aabbcc', endpoint: 'https://127.0.0.1:1234', pin }, credential);
  assert.equal(registry.list()[0].id, 'local');
  assert.ok(!readFileSync(path, 'utf8').includes(credential));
  assert.ok(!JSON.stringify(registry.list()).includes('Credential'));
  const restored = new MachineRegistry(path, secureStorage);
  assert.equal(restored.profile(entry.id).credential(), credential);
  assert.deepEqual(restored.list(), registry.list());
  restored.remove(entry.id); assert.equal(restored.list().length, 1);
});
test('an unreadable registry is moved aside instead of failing startup', () => {
  const path = join(scratch, 'damaged.json');
  writeFileSync(path, '{not json');
  const registry = new MachineRegistry(path, secureStorage);
  assert.deepEqual(registry.list().map(item => item.id), ['local']);
  assert.ok(!existsSync(path));
  assert.ok(readdirSync(scratch).some(name => name.startsWith('damaged.json.invalid-')));
});
test('registry refuses to add without encryption and never falls back to plaintext', () => {
  const registry = new MachineRegistry(join(scratch, 'unavailable.json'), { ...secureStorage, isEncryptionAvailable: () => false, encryptString: () => { throw new Error('must not encrypt'); } });
  assert.throws(() => registry.add({ name: 'PC', color: '#aabbcc', endpoint: 'https://127.0.0.1', pin }, 'secret'), /encrypted credential storage is unavailable/);
  assert.equal(registry.list().length, 1);
});
test('existing descriptor parses; wrong scheme, malformed/tampered fields and explicit expiry fail', () => {
  const offer = descriptor();
  assert.deepEqual(parsePairDescriptor(text(offer)), offer);
  assert.throws(() => parsePairDescriptor(text(offer).replace('threadterm:', 'https:')), /Invalid/);
  assert.throws(() => parsePairDescriptor(text({ ...offer, serverUrl: 'http://127.0.0.1' })), /Invalid/);
  assert.throws(() => parsePairDescriptor(text({ ...offer, tlsFingerprint: 'tampered' })), /Invalid/);
  assert.throws(() => parsePairDescriptor(text({ ...offer, expiresAt: new Date(0).toISOString() })), /expired/);
  assert.throws(() => parsePairDescriptor('threadterm://pair?data=broken'), /Invalid/);
});
function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value)), bytes = Buffer.alloc(4 + payload.length);
  bytes.writeUInt32LE(payload.length); payload.copy(bytes, 4); return bytes;
}
async function serverFixture(alpn = 'threadterm-peer/1', onSocket: (socket: tls.TLSSocket) => void = () => {}) {
  const sockets = new Set<tls.TLSSocket>();
  let bytes = 0;
  const server = tls.createServer({ cert, key, ALPNProtocols: alpn ? [alpn] : [] }, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('data', chunk => bytes += chunk.length);
    onSocket(socket);
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { endpoint, get bytes() { return bytes; }, async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
for (const failure of ['pin', 'alpn', 'alpn-alert']) test(`${failure} mismatch sends zero application bytes to a real Node TLS server`, async () => {
  const f = await serverFixture(failure === 'alpn' ? '' : failure === 'alpn-alert' ? 'http/1.1' : undefined);
  try {
    await assert.rejects(connectPinned(f.endpoint, failure === 'pin' ? '00'.repeat(32) : pin), error => error instanceof PeerTransportError && error.code === (failure === 'pin' ? 'pin-mismatch' : 'alpn-mismatch'));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.bytes, 0);
  } finally { await f.close(); }
});
test('pairing POST uses the checked HTTP ALPN socket and retains the desktop credential in main', async () => {
  let request = '';
  const f = await serverFixture('http/1.1', socket => {
    socket.on('data', chunk => {
      request += chunk.toString();
      if (!request.includes('\r\n\r\n') || !request.includes('deviceName')) return;
      const body = JSON.stringify({ token: 't'.repeat(43), device: { profile: 'desktop' } });
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  try {
    const socket = await connectPinned(f.endpoint, pin, 'http/1.1');
    assert.equal(f.bytes, 0, 'checking identity sends no pairing secret');
    const offer = parsePairDescriptor(text({ ...descriptor(), serverUrl: f.endpoint }));
    assert.equal(await pairOnPinnedConnection(socket, offer, 'Office'), 't'.repeat(43));
    assert.match(request, /^POST \/v1\/pair HTTP\/1.1/); assert.match(request, /"deviceName":"Office"/);
  } finally { await f.close(); }
});
async function peerFixture(incompatible = false, pinOverride?: string, controlOnly = false) {
  const auth: Record<string, unknown>[] = [], requests: Record<string, unknown>[] = [];
  let ignoreRequests = false;
  const f = await serverFixture(undefined, socket => {
    socket.write(frame({ kind: incompatible ? 'incompatible' : 'challenge', nonce: 'nonce', protocol: PROTOCOL_VERSION, contract: incompatible ? PROTOCOL_CONTRACT - 1 : PROTOCOL_CONTRACT, version: 'host-test' }));
    let incoming = Buffer.alloc(0);
    socket.on('data', chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      while (incoming.length >= 4) {
        const length = incoming.readUInt32LE(); if (incoming.length < length + 4) return;
        const value = JSON.parse(incoming.subarray(4, length + 4).toString()); incoming = incoming.subarray(length + 4);
        if (value.kind === 'auth') {
          auth.push(value);
          assert.equal(value.credential, 'credential-in-main');
          socket.write(frame({ kind: 'authenticated', protocol: PROTOCOL_VERSION, contract: PROTOCOL_CONTRACT, principal: `peer:device:${value.clientId}`, epoch: 'epoch' }));
        } else { requests.push(value); if (!ignoreRequests) socket.write(frame({ v: 1, id: value.id, result: value.method === 'browser.attach' ? { attachmentId: 'attachment', attachmentGeneration: 1, runtimeEpoch: 'browser-epoch', viewGeneration: 1 } : { version: 'host-test', epoch: 'epoch', contract: PROTOCOL_CONTRACT } })); }
      }
    });
  });
  let credentialReads = 0;
  const client = new RuntimeClient({ controlOnly, profile: { kind: 'peer', endpoint: f.endpoint, pin: pinOverride ?? pin, desktopVersion: 'client-test', credential: () => { credentialReads++; return 'credential-in-main'; } } });
  return { ...f, client, auth, requests, get credentialReads() { return credentialReads; }, ignore() { ignoreRequests = true; }, async close() { client.dispose(); await f.close(); } };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test('heartbeat sends health every 15 seconds and incoming frames extend the 45-second deadline', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  let health = 0, timeouts = 0;
  const heartbeat = new PeerHeartbeat(() => { health++; }, () => { timeouts++; });
  try {
    heartbeat.start(); t.mock.timers.tick(14999); assert.equal(health, 0);
    t.mock.timers.tick(1); assert.equal(health, 1);
    heartbeat.frame(); t.mock.timers.tick(30000); assert.equal(health, 3); assert.equal(timeouts, 0);
    t.mock.timers.tick(15000); assert.equal(timeouts, 1);
    t.mock.timers.tick(60000); assert.equal(health, 3); assert.equal(timeouts, 1);
  } finally { heartbeat.stop(); t.mock.timers.reset(); }
});
test('peer control/output share a group, heartbeat timeout rejects pending work and reconnects with a fresh clientId', async t => {
  const f = await peerFixture();
  try {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
    await f.client.request('runtime.health', {});
    assert.equal(f.auth.length, 2); assert.equal(f.auth[0].channel, 'control'); assert.equal(f.auth[0].epoch, null);
    assert.equal(f.auth[1].channel, 'output'); assert.equal(f.auth[1].epoch, 'epoch'); assert.equal(f.auth[0].clientId, f.auth[1].clientId);
    f.ignore();
    const pending = f.client.request('runtime.health', {});
    const rejection = assert.rejects(pending, /45 seconds/);
    await until(() => f.requests.length === 2);
    t.mock.timers.tick(45000);
    t.mock.timers.reset();
    await rejection;
    await until(() => f.auth.length >= 4);
    assert.notEqual(f.auth[0].clientId, f.auth[2].clientId);
    assert.equal(f.auth[2].clientId, f.auth[3].clientId);
    assert.equal(f.requests.filter(item => item.id === f.requests[1].id).length, 1, 'lost request is never replayed');
  } finally { t.mock.timers.reset(); await f.close(); }
});
test('incompatible is a typed UI transport state and sends no auth', async () => {
  const f = await peerFixture(true), events: unknown[] = [];
  f.client.onEvent(event => events.push(event.data));
  try {
    await assert.rejects(f.client.request('runtime.health', {}), error => error instanceof PeerTransportError && error.code === 'incompatible' && error.message.includes('client-test') && error.message.includes('host-test'));
    assert.ok(events.some(value => (value as { state?: string }).state === 'incompatible'));
    assert.equal(f.auth.length, 0);
  } finally { await f.close(); }
});
test('peer browser uses a separate pinned connection in the live control group', async () => {
  const f = await peerFixture();
  try {
    await f.client.request('runtime.health', {});
    assert.equal(f.auth.length, 2, 'browser stays idle until explicit use');
    await f.client.browserRequest('browser.attach', { viewId: 'view', workspaceId: 'workspace', workspaceRevision: 1, viewGeneration: 1 });
    assert.equal(f.auth.length, 3); assert.equal(f.auth[2].channel, 'browser');
    assert.equal(f.auth[2].clientId, f.auth[0].clientId); assert.equal(f.auth[2].epoch, 'epoch');
  } finally { await f.close(); }
});
test('pin mismatch is a typed UI state and never reads the credential source', async () => {
  const f = await peerFixture(false, '00'.repeat(32)), states: unknown[] = [];
  f.client.onEvent(event => states.push(event.data));
  try {
    await assert.rejects(f.client.request('runtime.health', {}), error => error instanceof PeerTransportError && error.code === 'pin-mismatch');
    assert.equal(f.credentialReads, 0); assert.equal(f.auth.length, 0);
    assert.ok(states.some(value => (value as { state?: string }).state === 'pin-mismatch'));
  } finally { await f.close(); }
});
test('sender bindings cannot be overridden by renderer machine fields or rebound', () => {
  const bindings = new MachineBindings<string>();
  bindings.bind(1, 'local', 'shared-window'); bindings.bind(2, 'remote', 'shared-window');
  const route = (sender: { id: number }, _payload: unknown) => bindings.get(sender.id).machineId;
  assert.equal(route({ id: 1 }, { machineId: 'remote' }), 'local');
  assert.equal(route({ id: 2 }, { machineId: 'local' }), 'remote');
  assert.throws(() => route({ id: 3 }, {}), /Unbound/);
  assert.throws(() => bindings.bind(1, 'remote', 'other'), /already bound/);
});
test('session setup runs once per partition object, including unavailable preload', () => {
  const calls: object[] = [], a = {}, b = {};
  const prepare = createAppSessionPreparer(session => { calls.push(session); return session !== b; });
  assert.equal(prepare(a), true); assert.equal(prepare(a), true);
  assert.equal(prepare(b), false); assert.equal(prepare(b), false);
  assert.deepEqual(calls, [a, b]);
});
test('view swapping retains views, shows exactly one, and sizes all views with the window', () => {
  const create = () => ({ visible: true, bounds: {}, setVisible(value: boolean) { this.visible = value; }, setBounds(value: object) { this.bounds = value; } });
  const local = create(), remotes: ReturnType<typeof create>[] = [];
  let size: [number, number] = [1440, 900];
  const views = new MachineViews(local, () => { const value = create(); remotes.push(value); return value; }, () => size);
  views.show('one'); views.show('two'); views.show('one');
  assert.equal(remotes.length, 2); assert.equal(views.all().filter(view => view.visible).length, 1);
  assert.equal(local.visible, false); assert.equal(remotes[0].visible, true);
  size = [1000, 700]; views.resize();
  for (const view of views.all()) assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1000, height: 700 });
  views.remove('one'); assert.equal(views.currentId, 'local'); assert.equal(local.visible, true);
  assert.equal(views.all().filter(view => view.visible).length, 1);
});

test('watch profile opens only control, refuses output/browser/leases and reconnects control only', async t => {
  const f = await peerFixture(false, undefined, true);
  try {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
    await f.client.request('runtime.health', {});
    assert.deepEqual(f.auth.map(value => value.channel), ['control']);
    await assert.rejects(f.client.subscribeOutput('session', 0, () => {}), /disabled/);
    await assert.rejects(f.client.browserRequest('browser.attach', {}), /disabled/);
    await assert.rejects(f.client.request('session.claim', { sessionId: 'session', clientId: 'watcher' }), /cannot claim/);
    assert.deepEqual(f.auth.map(value => value.channel), ['control']);
    f.ignore();
    const pending = f.client.request('runtime.health', {}), rejected = assert.rejects(pending, /45 seconds/);
    await until(() => f.requests.length === 2); t.mock.timers.tick(45000); t.mock.timers.reset();
    await rejected; await until(() => f.auth.length === 2);
    assert.deepEqual(f.auth.map(value => value.channel), ['control', 'control']);
    assert.notEqual(f.auth[0].clientId, f.auth[1].clientId);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('pairing a changed identity replaces only the matched stale address and preserves its presentation', () => {
  const path = join(scratch,'repair-machines.json'), registry = new MachineRegistry(path,secureStorage);
  const original = registry.add({name:'My office',color:'#123456',endpoint:'https://127.0.0.1:1234',pin},'old-secret');
  const other = registry.add({name:'Other',color:'#654321',endpoint:'https://127.0.0.1:4321',pin},'other-secret');
  const repaired = registry.add({name:'New offer name',color:'#ffffff',endpoint:'https://127.0.0.1:1234/',pin:'AB'.repeat(32)},'new-secret',new Set([original.id]));
  assert.equal(repaired.id,original.id); assert.equal(repaired.name,'My office'); assert.equal(repaired.color,'#123456');
  assert.equal(registry.list().length,3); assert.equal(registry.profile(original.id).pin,'AB'.repeat(32)); assert.equal(registry.profile(original.id).credential(),'new-secret');
  assert.equal(registry.profile(other.id).credential(),'other-secret');
  const added = registry.add({name:'Ordinary',color:'#ffffff',endpoint:'https://127.0.0.1:1234',pin},'ordinary-secret');
  assert.notEqual(added.id,original.id); assert.equal(registry.list().length,4);
  assert.equal(new MachineRegistry(path,secureStorage).profile(original.id).credential(),'new-secret');
});

test('version mismatch stops retries until explicit selection requests one new attempt; pin mismatch remains fenced', async () => {
  const client = new RuntimeClient({profile:{kind:'peer',endpoint:'https://127.0.0.1:1234',pin:'AB'.repeat(32),credential:()=> 'secret'}});
  const internal = client as unknown as { connectAndAuthenticate(): Promise<void>; incompatible?: Error; connecting?: Promise<void> };
  let attempts = 0;
  internal.connectAndAuthenticate = async () => { attempts++; throw new PeerTransportError('incompatible','Version mismatch'); };
  try {
    await assert.rejects(client.request('runtime.health',{}), /Version mismatch/);
    await new Promise(done=>setTimeout(done,450)); assert.equal(attempts,1);
    client.retryPeerConnection(); client.retryPeerConnection();
    await new Promise(done=>setTimeout(done,450)); assert.equal(attempts,2);
    internal.incompatible = new PeerTransportError('pin-mismatch','Pair again');
    client.retryPeerConnection(); await new Promise(done=>setTimeout(done,50)); assert.equal(attempts,2);
  } finally { client.dispose(); }
});

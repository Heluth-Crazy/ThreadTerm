import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { LoopbackProxy, isLoopbackUrl, isRemoteSignInUrl, externalLinkOpensInPanel } from '../src/loopbackProxy.js';
import { LengthPrefixedSocket } from '../src/runtime-client.js';
import { authenticatePeer } from '../src/peer-transport.js';
import { X509Certificate } from 'node:crypto';
import { PROTOCOL_CONTRACT, PROTOCOL_VERSION } from '@threadterm/protocol';

const scratch = mkdtempSync(join(tmpdir(), 'tt-proxy-test-'));
let cert: Buffer, key: Buffer;
before(() => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1'], { windowsHide: true, stdio: 'ignore' });
  cert = readFileSync(join(scratch, 'cert.pem')); key = readFileSync(join(scratch, 'key.pem'));
});
after(() => rmSync(scratch, { recursive: true, force: true }));
async function listen(server: net.Server, host = '127.0.0.1') { await new Promise<void>(resolve => server.listen(0, host, resolve)); return (server.address() as net.AddressInfo).port; }
async function dial(port: number, host = '127.0.0.1') { const socket = net.connect({ host, port }); socket.on('error', () => {}); await once(socket, 'connect'); return socket; }
const auth = (proxy: LoopbackProxy) => `Basic ${Buffer.from(`${proxy.username}:${proxy.secret}`).toString('base64')}`;
async function read(socket: net.Socket, predicate: (value: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error(`read timeout: ${bytes.toString()}`)); }, 3000);
    const data = (chunk: Buffer) => { bytes = Buffer.concat([bytes, chunk]); if (predicate(bytes)) { socket.pause(); cleanup(); resolve(bytes); } };
    const cleanup = () => { clearTimeout(timer); socket.off('data', data); socket.off('error', error); };
    const error = (error: Error) => { cleanup(); reject(error); };
    socket.on('data', data); socket.once('error', error); socket.resume();
  });
}
function get(proxy: string, url: string, authorization?: string, agent?: http.Agent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: Number(new URL(proxy).port), path: url, agent, headers: authorization ? { 'Proxy-Authorization': authorization, Host: new URL(url).host } : {} }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode!, body }));
    }); request.on('error', reject);
  });
}

test('all loopback spellings, including 127/8 and URL IPv4 aliases, are tunneled with Host preserved; secret is mandatory', async () => {
  const seen: Array<[number, string]> = [];
  // Connection: close makes every spelling dial its own tunnel, so each one's route is observed.
  const host = http.createServer((req, res) => { res.setHeader('Connection', 'close'); res.end(`HOST ${req.headers.host}`); }); const port = await listen(host);
  const proxy = new LoopbackProxy('Office-PC', async (port, ip) => { seen.push([port, ip]); return dial(port); }); const address = await proxy.listen();
  try {
    assert.equal((await get(address, `http://localhost:${port}/`)).status, 407); assert.equal(seen.length, 0);
    for (const hostname of ['localhost', 'app.localhost', '127.0.0.1', '127.8.9.10', '[::1]', '127.1', '0x7f000001', '[::ffff:127.0.0.1]']) {
      const url = `http://${hostname}:${port}/`;
      const result = await get(address, url, auth(proxy)); assert.equal(result.status, 200); assert.equal(result.body, `HOST ${new URL(url).host}`);
    }
    assert.equal(seen.length, 8); assert.equal(seen[4][1], '::1'); assert.ok(seen.filter((_, i) => i !== 4).every(([, ip]) => ip === '127.0.0.1'));
    assert.ok(!isLoopbackUrl('https://example.com')); assert.ok(isLoopbackUrl('http://LOCALHOST.')); assert.ok(!isLoopbackUrl('file:///etc/hosts'));
  } finally { proxy.close(); host.closeAllConnections(); await new Promise<void>(resolve => host.close(() => resolve())); }
});

test('one keep-alive proxy connection independently routes host then direct then host', async () => {
  const lan = Object.values(networkInterfaces()).flat().find(row => row?.family === 'IPv4' && !row.internal)?.address;
  assert.ok(lan, 'one non-loopback local interface is required for the direct fixture');
  let tunnels = 0, connections = 0;
  const host = http.createServer((_req, res) => res.end('HOST')); const hostPort = await listen(host);
  const direct = http.createServer((_req, res) => res.end('DIRECT')); const directPort = await listen(direct, '0.0.0.0');
  const proxy = new LoopbackProxy('Office-PC', async port => { tunnels++; return dial(port); }); const address = await proxy.listen();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const create = agent.createConnection.bind(agent); agent.createConnection = (options, callback) => { connections++; return create(options, callback); };
  try {
    for (const [url, body] of [[`http://localhost:${hostPort}/`, 'HOST'], [`http://${lan}:${directPort}/`, 'DIRECT'], [`http://127.9.8.7:${hostPort}/`, 'HOST']]) assert.equal((await get(address, url, auth(proxy), agent)).body, body);
    // Both loopback spellings of the host port share one reused upstream tunnel.
    assert.equal(tunnels, 1); assert.equal(connections, 1);
  } finally { agent.destroy(); proxy.close(); host.closeAllConnections(); direct.closeAllConnections(); host.close(); direct.close(); }
});

test('a name that resolves to loopback here goes to the host tunnel; other names connect to their checked addresses', async () => {
  const lan = Object.values(networkInterfaces()).flat().find(row => row?.family === 'IPv4' && !row.internal)?.address;
  assert.ok(lan, 'one non-loopback local interface is required for the direct fixture');
  let clientRequests = 0; const seen: Array<[number, string]> = [];
  const client = http.createServer((_req, res) => { clientRequests++; res.end('CLIENT'); }); const port = await listen(client);
  const host = http.createServer((req, res) => res.end(`HOST ${req.headers.host}`)); const hostPort = await listen(host);
  const direct = http.createServer((_req, res) => res.end('DIRECT')); const directPort = await listen(direct, '0.0.0.0');
  const names: Record<string, Array<{ address: string; family: number }>> = { 'lvh.test': [{ address: '127.0.0.1', family: 4 }], 'six.test': [{ address: '::1', family: 6 }], 'lan.test': [{ address: lan!, family: 4 }] };
  const proxy = new LoopbackProxy('Office-PC', async (_port, ip) => { seen.push([_port, ip]); return dial(hostPort); }, 64, async name => { if (!names[name]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); return names[name]; });
  const address = await proxy.listen();
  try {
    assert.deepEqual(await get(address, `http://lvh.test:${port}/`, auth(proxy)), { status: 200, body: `HOST lvh.test:${port}` });
    assert.deepEqual(await get(address, `http://six.test:${port}/`, auth(proxy)), { status: 200, body: `HOST six.test:${port}` });
    assert.deepEqual(seen, [[port, '127.0.0.1'], [port, '::1']]); assert.equal(clientRequests, 0);
    assert.deepEqual(await get(address, `http://lan.test:${directPort}/`, auth(proxy)), { status: 200, body: 'DIRECT' });
    const missing = await get(address, 'http://missing.test/', auth(proxy));
    assert.equal(missing.status, 502); assert.match(missing.body, /Cannot reach missing\.test/); assert.doesNotMatch(missing.body, /Office-PC/);
  } finally { proxy.close(); for (const server of [client, host, direct]) { server.closeAllConnections(); server.close(); } }
});

test('a read that fails on a reused idle upstream connection is sent once more on a new one', async () => {
  let tunnels = 0; const served = new WeakMap<net.Socket, number>();
  // The second request on a connection meets a server that has just dropped it, as at its keep-alive timeout.
  const host = http.createServer((req, res) => { const count = (served.get(req.socket) ?? 0) + 1; served.set(req.socket, count); if (count > 1) { req.socket.destroy(); return; } res.end('HOST'); });
  const hostPort = await listen(host);
  const proxy = new LoopbackProxy('Office-PC', async port => { tunnels++; return dial(port); }); const address = await proxy.listen();
  try {
    for (let index = 0; index < 2; index++) assert.deepEqual(await get(address, `http://localhost:${hostPort}/`, auth(proxy)), { status: 200, body: 'HOST' });
    assert.equal(tunnels, 2);
  } finally { proxy.close(); host.closeAllConnections(); host.close(); }
});

test('failed host tunnel gives named 502 without contacting a client-local service, and unauthenticated CONNECT gets 407', async () => {
  let clientRequests = 0, tunnels = 0;
  const client = http.createServer((_req, res) => { clientRequests++; res.end('CLIENT'); }); const port = await listen(client);
  const proxy = new LoopbackProxy('Office & PC', async () => { tunnels++; throw new Error('offline'); }); const address = await proxy.listen();
  const socket = await dial(Number(new URL(address).port));
  try {
    const response = await get(address, `http://localhost:${port}/`, auth(proxy)); assert.equal(response.status, 502); assert.match(response.body, /Office &amp; PC/); assert.equal(clientRequests, 0);
    socket.write(`CONNECT localhost:${port} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    assert.match((await read(socket, bytes => bytes.includes('\r\n\r\n'))).toString(), /^HTTP\/1.1 407/); assert.equal(tunnels, 1);
    const authenticated = await dial(Number(new URL(address).port));
    authenticated.write(`CONNECT localhost:${port} HTTP/1.1\r\nProxy-Authorization: ${auth(proxy)}\r\n\r\n`);
    assert.match((await read(authenticated, bytes => bytes.includes('\r\n\r\n'))).toString(), /^HTTP\/1.1 502/); authenticated.destroy(); assert.equal(clientRequests, 0);
  } finally { socket.destroy(); proxy.close(); client.closeAllConnections(); client.close(); }
});

test('CONNECT carries a real TLS handshake and HTTPS bytes unchanged', async () => {
  const server = tls.createServer({ cert, key }, socket => { socket.once('data', bytes => { assert.match(bytes.toString(), /^GET \/secure/); socket.end('HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nHOST HTTPS'); }); });
  const port = await listen(server); const proxy = new LoopbackProxy('Office-PC', port => dial(port)); const address = await proxy.listen();
  const socket = await dial(Number(new URL(address).port));
  try {
    socket.write(`CONNECT localhost:${port} HTTP/1.1\r\nHost: localhost:${port}\r\nProxy-Authorization: ${auth(proxy)}\r\n\r\n`);
    const response = await read(socket, bytes => bytes.includes('\r\n\r\n')); const end = response.indexOf('\r\n\r\n') + 4;
    assert.match(response.toString(), /^HTTP\/1.1 200/); if (response.length > end) socket.unshift(response.subarray(end));
    const secure = tls.connect({ socket, rejectUnauthorized: false }); await once(secure, 'secureConnect');
    secure.write('GET /secure HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.match((await read(secure, bytes => bytes.includes('HOST HTTPS'))).toString(), /HOST HTTPS/); secure.destroy();
  } finally { socket.destroy(); proxy.close(); server.close(); }
});

test('plain Upgrade preserves Host and forwards coalesced head exactly once; lifecycle closes both sockets', async () => {
  let received = Buffer.alloc(0), upstream: net.Socket | undefined;
  const server = net.createServer(socket => { upstream = socket; socket.on('data', bytes => { received = Buffer.concat([received, bytes]); if (received.includes('HEAD')) socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nREADY'); }); });
  const port = await listen(server); const proxy = new LoopbackProxy('Office-PC', port => dial(port)); const address = await proxy.listen(); const socket = await dial(Number(new URL(address).port));
  try {
    socket.write(`GET http://app.localhost:${port}/upgrade HTTP/1.1\r\nHost: app.localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: test\r\nProxy-Authorization: ${auth(proxy)}\r\n\r\nHEAD`);
    await read(socket, bytes => bytes.includes('READY'));
    assert.match(received.toString(), /^GET \/upgrade HTTP\/1.1/); assert.match(received.toString(), new RegExp(`Host: app.localhost:${port}`)); assert.equal(received.toString().split('HEAD').length - 1, 1); assert.ok(!received.includes('Proxy-Authorization'));
    const clientClosed = once(socket, 'close'), hostClosed = once(upstream!, 'close'); socket.resume(); proxy.closeConnections(); await Promise.all([clientClosed, hostClosed]);
  } finally { socket.destroy(); upstream?.destroy(); proxy.close(); server.close(); }
});

function frame(value: unknown) { const payload = Buffer.from(JSON.stringify(value)), bytes = Buffer.alloc(4 + payload.length); bytes.writeUInt32LE(payload.length); payload.copy(bytes, 4); return bytes; }
test('peer raw handoff retains coalesced arbitrary bytes after authenticated instead of parsing them', async () => {
  const raw = Buffer.from([255, 255, 255, 255, 0, 1, 2, 3, 4]);
  const server = tls.createServer({ cert, key, ALPNProtocols: ['threadterm-peer/1'] }, socket => {
    socket.write(frame({ kind: 'challenge', protocol: PROTOCOL_VERSION, contract: PROTOCOL_CONTRACT, nonce: 'nonce' }));
    socket.once('data', bytes => {
      const auth = JSON.parse(bytes.subarray(4).toString()); assert.equal(auth.channel, 'tunnel'); assert.equal(auth.port, 5173); assert.equal(auth.loopback, '127.0.0.1');
      socket.write(Buffer.concat([frame({ kind: 'authenticated', protocol: PROTOCOL_VERSION, contract: PROTOCOL_CONTRACT, principal: 'peer:device:client', epoch: 'epoch' }), raw]));
    }); socket.on('error', () => {});
  });
  const port = await listen(server), profile = { kind: 'peer' as const, endpoint: `https://127.0.0.1:${port}`, pin: new X509Certificate(cert).fingerprint256, credential: () => 'secret' };
  const connection = await LengthPrefixedSocket.connectPeer(profile);
  try {
    await authenticatePeer(connection, profile, 'tunnel', 'client', 'epoch', () => connection.takeRawSocket(), { port: 5173, loopback: '127.0.0.1' });
    const bytes = await read(connection.socket, bytes => bytes.length >= raw.length); assert.deepEqual(bytes, raw);
  } finally { connection.close(); server.close(); }
});
test('real IPv6 host socket is reachable through the normalized IPv6 tunnel target', async t => {
  const host = http.createServer((_req, res) => res.end('IPV6 HOST'));
  let port: number;
  try { port = await listen(host, '::1');const socket=await dial(port,'::1');socket.destroy(); } catch(error) { host.close();t.skip(`IPv6 loopback unavailable: ${String(error)}`);return; }
  const proxy = new LoopbackProxy('IPv6 PC', (port, ip) => dial(port, ip));const address=await proxy.listen();
  try {assert.deepEqual(await get(address,`http://[::1]:${port}/`,auth(proxy)),{status:200,body:'IPV6 HOST'});}
  finally {proxy.close();host.closeAllConnections();host.close();}
});

test('control loss and computer removal/disposal close real raw peer tunnels', async () => {
  const { RuntimeClient } = await import('../src/runtime-client.js');
  for(const reason of ['control','remove']) {
    let control: tls.TLSSocket | undefined, hostTunnel: tls.TLSSocket | undefined;
    const sockets=new Set<tls.TLSSocket>();const auths:Record<string,unknown>[]=[];
    const server=tls.createServer({cert,key,ALPNProtocols:['threadterm-peer/1']},socket=>{
      sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
      socket.write(frame({kind:'challenge',protocol:PROTOCOL_VERSION,contract:PROTOCOL_CONTRACT,nonce:'nonce'}));
      socket.once('data',bytes=>{
        const auth=JSON.parse(bytes.subarray(4).toString());auths.push(auth);
        if(auth.channel==='control')control=socket;
        if(auth.channel==='tunnel'&&auth.port===5174){socket.end(frame({kind:'tunnel_failed',code:'connection_refused'}));return;}
        socket.write(frame({kind:'authenticated',protocol:PROTOCOL_VERSION,contract:PROTOCOL_CONTRACT,principal:`peer:device:${auth.clientId}`,epoch:'epoch'}));
        if(auth.channel==='tunnel'){hostTunnel=socket;socket.on('data',bytes=>socket.write(bytes));}
      });
    });
    const port=await listen(server),client=new RuntimeClient({profile:{kind:'peer',endpoint:`https://127.0.0.1:${port}`,pin:new X509Certificate(cert).fingerprint256,credential:()=> 'secret'}});
    try {
      await assert.rejects(client.openTunnel(5174,'127.0.0.1'),/connection_refused/);
      const tunnel=await client.openTunnel(5173,'127.0.0.1');const echoed=read(tunnel,bytes=>bytes.length>=5);tunnel.write(Buffer.from([255,255,255,255,0]));assert.deepEqual(await echoed,Buffer.from([255,255,255,255,0]));
      const auth=auths.find(auth=>auth.channel==='tunnel'&&auth.port===5173)!;assert.equal(auth.clientId,auths[0].clientId);assert.equal(auth.epoch,'epoch');
      const closed=once(tunnel,'close'),hostClosed=once(hostTunnel!,'close');hostTunnel!.resume();
      if(reason==='control')control!.destroy();else client.dispose();await Promise.all([closed,hostClosed]);assert.ok(tunnel.destroyed);
    } finally {client.dispose();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
  await assert.rejects(new RuntimeClient().openTunnel(5173,'127.0.0.1'),/remote computer/);
});

test('control loss fences a tunnel establishment already in flight', async () => {
  const {PassThrough}=await import('node:stream');
  let establish:((socket:import('node:stream').Duplex)=>void)|undefined,started:()=>void;
  const pending=new Promise<void>(resolve=>started=resolve);
  const proxy=new LoopbackProxy('Office-PC',()=>new Promise(resolve=>{establish=resolve;started();}));const address=await proxy.listen();
  const socket=await dial(Number(new URL(address).port));
  try {
    socket.write(`CONNECT localhost:5173 HTTP/1.1\r\nProxy-Authorization: ${auth(proxy)}\r\n\r\n`);await pending;
    proxy.closeConnections();const late=new PassThrough();establish!(late);await new Promise(resolve=>setImmediate(resolve));assert.ok(late.destroyed,'a late result must not reopen a closed machine tunnel');
  } finally {socket.destroy();proxy.close();}
});

const signInCases: Array<[string, boolean]> = [
  ['https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback', true],
  ['https://auth.example/authorize?redirect_uri=http://localhost:1455/callback', true],
  ['https://auth.example/authorize?ReDiReCt_Url=https%3A%2F%2Fapp.localhost%3A443%2Fcallback', true],
  ['http://auth.example/?redirect_url=http://127.234.1.2:3000/callback', true],
  ['https://auth.example/?redirect_uri=http://[::1]:3000/callback', true],
  ['https://auth.example/?redirect_uri=http%3A%2F%2F%5B%3A%3Affff%3A127.2.3.4%5D%3A3000%2Fcallback', true],
  ['https://auth.example/?redirect_uri=http://[::ffff:7f02:304]:3000/callback', true],
  ['https://auth.example/?redirect_uri=http://LOCALHOST.:3000/callback', true],
  ['https://auth.example/?redirect_uri=http://127.1/callback', true],
  ['https://auth.example/?redirect_uri=http://0x7f000001/callback', true],
  ['https://auth.example/?redirect_uri=https://public.example/callback', false],
  ['https://auth.example/device', false],
  ['https://auth.example/code?user_code=QA', false],
  ['https://auth.example/?redirect_uri=http://localhost.example.com/callback', false],
  ['https://auth.example/?redirect_uri=http://lvh.me/callback', false],
  ['https://accounts.google.com/o/oauth2/auth?redirect_uri=http://localhost:3000/callback', false],
  ['https://signin.google.com/?redirect_url=http://127.0.0.1/callback', false],
  ['https://GOOGLE.COM./?redirect_uri=http://localhost/callback', false],
  ['https://notgoogle.com/?redirect_uri=http://localhost/callback', true],
  ['https://google.com.example/?redirect_uri=http://localhost/callback', true],
  ['ftp://auth.example/?redirect_uri=http://localhost/callback', false],
  ['javascript:alert(1)?redirect_uri=http://localhost/callback', false],
  ['https://auth.example/?redirect_uri=file:///C:/callback', false],
  ['https://auth.example/?redirect_uri=ws://localhost/callback', false],
  ['not a URL', false],
  ['https://auth.example/?redirect_uri=%ZZ&redirect_url=http://localhost/callback', true],
];


test('sign-in links use literal HTTP callbacks and exclude Google, with matching renderer/desktop cases', () => {
  for (const [url, expected] of signInCases) assert.equal(isRemoteSignInUrl(url), expected, url);
});

test('remote link decision opens host callbacks in the panel and keeps local, Google and device-code actions', () => {
  for (const [url, expected] of signInCases) {
    assert.equal(externalLinkOpensInPanel(url, true), expected, `remote ${url}`);
    assert.equal(externalLinkOpensInPanel(url, false), false, `local ${url}`);
  }
  for (const url of ['http://localhost:5173/', 'http://127.234.1.2:3000/', 'http://[::ffff:127.2.3.4]/']) {
    assert.equal(externalLinkOpensInPanel(url, true), true);
    assert.equal(externalLinkOpensInPanel(url, false), false);
  }
});

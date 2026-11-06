import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { PROTOCOL_VERSION, PROTOCOL_CONTRACT, isRecord } from '@threadterm/protocol';

export interface PeerProfile {
  kind: 'peer'; endpoint: string; pin: string; desktopVersion?: string; credential: () => string | Promise<string>;
}
export class PeerTransportError extends Error {
  constructor(readonly code: 'pin-mismatch' | 'incompatible' | 'alpn-mismatch', message: string) { super(message); this.name = 'PeerTransportError'; }
}
export function normalizePin(pin: string): string {
  const value = pin.replace(/:/g, '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(value)) throw new Error('Invalid certificate fingerprint');
  return value;
}
export function certificateCheckCode(pin: string): string {
  const value = normalizePin(pin).slice(0, 12);
  return `${value.slice(0, 4)} ${value.slice(4, 8)} ${value.slice(8)}`;
}
/** A computer reached across networks: its public iroh key, and the relay it last used (a hint). */
export interface IrohAddress { endpointId: string; relayUrl?: string }
export interface PairDescriptor { v: 1 | 2; serverUrl: string; pairingId: string; code: string; tlsFingerprint: string; expiresAt?: string; iroh?: IrohAddress }
const IROH_KEY = /^[0-9a-f]{64}$/;
function validRelay(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}
export function parsePairDescriptor(text: string, now = Date.now()): PairDescriptor {
  if (typeof text !== 'string' || text.length > 16384) throw new Error('Invalid pairing text');
  let value: unknown;
  try {
    const url = new URL(text.trim());
    if (url.protocol !== 'threadterm:' || url.hostname !== 'pair' || url.pathname || url.hash
      || [...url.searchParams.keys()].some(key => key !== 'data') || url.searchParams.getAll('data').length !== 1) throw new Error();
    const encoded = url.searchParams.get('data')!;
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch { throw new Error('Invalid ThreadTerm pairing text'); }
  if (!isRecord(value) || (value.v !== 1 && value.v !== 2) || typeof value.serverUrl !== 'string'
    || typeof value.pairingId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.pairingId)
    || typeof value.code !== 'string' || !/^[A-F0-9]{32}$/i.test(value.code.replace(/[-\s]/g, ''))
    || typeof value.tlsFingerprint !== 'string') throw new Error('Invalid pairing descriptor');
  // v2 adds the host's iroh key; v1 never carries one.
  if (value.v === 2 ? !isRecord(value.iroh) || typeof value.iroh.endpointId !== 'string' || !IROH_KEY.test(value.iroh.endpointId)
    || value.iroh.relayUrl !== undefined && !validRelay(value.iroh.relayUrl) : value.iroh !== undefined) throw new Error('Invalid pairing descriptor');
  peerEndpoint(value.serverUrl);
  normalizePin(value.tlsFingerprint);
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now)) throw new Error('Pairing offer expired');
  return value as unknown as PairDescriptor;
}
/** `iroh://<key>?relay=<url>`: the endpoint a computer paired across networks is stored and dialed under. */
export function irohEndpoint(address: IrohAddress): string {
  const url = new URL(`iroh://${address.endpointId}`);
  if (address.relayUrl) url.searchParams.set('relay', address.relayUrl);
  return url.href;
}
export function irohAddress(endpoint: string): IrohAddress | undefined {
  const url = new URL(endpoint);
  if (url.protocol !== 'iroh:') return undefined;
  const relayUrl = url.searchParams.get('relay') ?? undefined;
  return relayUrl ? { endpointId: url.hostname, relayUrl } : { endpointId: url.hostname };
}
/** The same computer, whichever relay it was last seen on. */
export function sameEndpoint(a: string, b: string): boolean {
  const left = irohAddress(a), right = irohAddress(b);
  if (left || right) return left?.endpointId === right?.endpointId;
  return peerEndpoint(a).href === peerEndpoint(b).href;
}
export function peerEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol === 'iroh:') {
    if (!IROH_KEY.test(url.hostname) || url.port || url.username || url.password || url.hash || !['', '/'].includes(url.pathname)
      || [...url.searchParams.keys()].some(key => key !== 'relay') || url.searchParams.getAll('relay').length > 1
      || url.searchParams.has('relay') && !validRelay(url.searchParams.get('relay'))) throw new Error('Invalid computer endpoint');
    return url;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Invalid computer endpoint');
  return url;
}
export type PeerDialer = (address: IrohAddress) => Promise<{ pipe: string; token: string }>;
let peerDialer: PeerDialer | undefined;
/** Main wires this to the local runtime's `device.peer.dial`, which bridges an iroh stream to a one-time pipe. */
export function setPeerDialer(dialer: PeerDialer | undefined): void { peerDialer = dialer; }
async function irohSocket(address: IrohAddress): Promise<net.Socket> {
  if (!peerDialer) throw new Error('iroh_unavailable: Connecting across networks is unavailable');
  const { pipe, token } = await peerDialer(address);
  return await new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    socket.once('error', reject);
    socket.once('connect', () => { socket.off('error', reject); socket.write(token); resolve(socket); });
  });
}
/** No application bytes may leave this socket until secureConnect verifies both identity and ALPN. Across networks
 * the same TLS runs over a pipe to the local runtime, which carries it through iroh. */
export function connectPinned(endpoint: string, pin: string, alpn = 'threadterm-peer/1'): Promise<tls.TLSSocket> {
  const url = peerEndpoint(endpoint), expected = normalizePin(pin), iroh = irohAddress(endpoint);
  return new Promise((resolve, reject) => {
    let socket: tls.TLSSocket | undefined, settled = false;
    // Across networks a first connection may wait on a relay and on hole punching.
    const timer = setTimeout(() => fail(Object.assign(new Error('Computer connection timed out'), { code: 'ETIMEDOUT' })), iroh ? 30000 : 10000);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket?.destroy();
      reject(/no application protocol/i.test(error.message) ? new PeerTransportError('alpn-mismatch', 'The computer did not negotiate the required connection protocol. Update one so they match.') : error);
    };
    const secure = (options: tls.ConnectionOptions) => {
      const current = tls.connect({ ...options, rejectUnauthorized: false, ALPNProtocols: [alpn] });
      socket = current;
      current.once('error', fail);
      current.once('secureConnect', () => {
      try {
        const actual = current.getPeerCertificate().fingerprint256;
        if (!actual || normalizePin(actual) !== expected) throw new PeerTransportError('pin-mismatch', 'This computer’s identity changed. Pair again before connecting.');
        if (current.alpnProtocol !== alpn) throw new PeerTransportError('alpn-mismatch', 'The computer did not negotiate the required connection protocol.');
        if (settled) { current.destroy(); return; }
        settled = true; clearTimeout(timer);
        if (!iroh) current.setKeepAlive(true, 30000);
        current.pause();
        resolve(current);
      } catch (error) { fail(error instanceof Error ? error : new Error('Certificate check failed')); }
      });
    };
    if (iroh) void irohSocket(iroh).then(raw => { if (settled) raw.destroy(); else secure({ socket: raw }); }, fail);
    else secure({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443) });
  });
}
/** Socket failures that mean nothing answered at the offer's address from this computer. */
const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENOTFOUND']);
/** A pairing check that never reached the other computer, as a code the Settings page explains with the address. */
export function pairingConnectError(error: unknown, endpoint: string): unknown {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (irohAddress(endpoint)) {
    const message = error instanceof Error ? error.message : String(error);
    return code && UNREACHABLE.has(code) || /iroh_unreachable/.test(message) ? new Error('iroh_unreachable: the other computer did not answer') : error;
  }
  return code && UNREACHABLE.has(code) ? new Error(`computer_unreachable: ${peerEndpoint(endpoint).host}`) : error;
}
export interface PeerFrames {
  write(payload: Buffer): void;
  onFrame(listener: (frame: Buffer) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
}
export class PeerHeartbeat {
  private timer?: ReturnType<typeof setInterval>;
  private lastFrame = Date.now();
  constructor(private readonly health: () => void, private readonly timeout: () => void) {}
  frame(): void { this.lastFrame = Date.now(); }
  start(): void {
    this.stop(); this.frame();
    this.timer = setInterval(() => {
      if (Date.now() - this.lastFrame >= 45000) { this.stop(); this.timeout(); }
      else this.health();
    }, 15000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
export async function authenticatePeer(connection: PeerFrames, profile: PeerProfile, channel: 'control' | 'output' | 'browser' | 'tunnel', clientId: string, epoch: string | null, onAuthenticated?: (session: { epoch: string }, proof: Buffer) => void, target?: { port: number; loopback: '127.0.0.1' | '::1' }): Promise<{ epoch: string }> {
  // Resolve credentials only after the TLS pin/ALPN checks have succeeded.
  const credential = await profile.credential();
  return new Promise((resolve, reject) => {
    let challenged = false;
    const timer = setTimeout(() => finish(new Error('Computer authentication timed out')), 10000);
    const cleanup = () => { clearTimeout(timer); removeFrame(); removeFailure(); };
    const finish = (error: Error) => { cleanup(); reject(error); };
    const removeFrame = connection.onFrame(frame => {
      try {
        const value: unknown = JSON.parse(frame.toString('utf8'));
        if (!isRecord(value)) throw new Error('Invalid computer handshake');
        if (value.kind === 'tunnel_failed') throw new Error(`Host tunnel failed: ${String(value.code)}`);
        if (value.kind === 'incompatible' || value.protocol !== PROTOCOL_VERSION || value.contract !== PROTOCOL_CONTRACT) {
          throw new PeerTransportError('incompatible', `Version mismatch: desktop ${profile.desktopVersion ?? 'unknown'} (contract ${PROTOCOL_CONTRACT}); computer ${typeof value.version === 'string' ? value.version : 'unknown'} (contract ${String(value.contract)}). Update one so they match.`);
        }
        if (value.kind === 'challenge' && !challenged && typeof value.nonce === 'string') {
          challenged = true;
          connection.write(Buffer.from(JSON.stringify({ kind: 'auth', protocol: PROTOCOL_VERSION, contract: PROTOCOL_CONTRACT, nonce: value.nonce, channel, clientId, credential, epoch, ...(channel === 'tunnel' ? target : {}) })));
          return;
        }
        if (!challenged || value.kind !== 'authenticated' || typeof value.epoch !== 'string' || typeof value.principal !== 'string' || !value.principal.endsWith(`:${clientId}`) || epoch !== null && value.epoch !== epoch) throw new Error('Computer authentication refused. Pair again if access was removed.');
        cleanup();
        onAuthenticated?.({ epoch: value.epoch }, frame);
        resolve({ epoch: value.epoch });
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid computer handshake')); }
    });
    const removeFailure = connection.onFailure(finish);
  });
}
/** POST uses the very socket whose pin was checked and shown to the user. */
export async function pairOnPinnedConnection(socket: tls.TLSSocket, descriptor: PairDescriptor, name: string): Promise<string> {
  if (socket.destroyed) throw new Error('Pairing connection expired. Paste the offer again.');
  const body = JSON.stringify({ pairingId: descriptor.pairingId, code: descriptor.code, deviceName: name });
  return new Promise<string>((resolve, reject) => {
    const agent = Object.assign(new http.Agent({ keepAlive: false }), { createConnection: () => socket });
    const request = http.request({ hostname: peerEndpoint(descriptor.serverUrl).hostname, path: '/v1/pair', method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' } }, response => {
      let bytes = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) response.destroy(new Error('Invalid pairing response')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || !isRecord(result) || typeof result.token !== 'string' || result.token.length < 32 || !isRecord(result.device) || result.device.profile !== 'desktop') throw new Error('Pairing refused. The offer may be expired, used, or removed.');
          resolve(result.token);
        } catch { reject(new Error('Pairing refused. The offer may be expired, used, or removed.')); }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('Pairing timed out')));
    request.on('error', () => reject(new Error('Pairing connection failed')));
    socket.resume();
    request.end(body);
  }).finally(() => socket.destroy());
}

import http from 'node:http';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { Duplex } from 'node:stream';

export type TunnelTarget = { host: string; port: number; loopback?: '127.0.0.1' | '::1' };
/** URL parsing also canonicalizes IPv4 shorthand/hex forms before routing. */
export function loopbackAddress(hostname: string): '127.0.0.1' | '::1' | undefined {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === '::1') return '::1';
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host) || /^::ffff:127(?:\.\d{1,3}){3}$/.test(host)) return '127.0.0.1';
  if (host === 'localhost' || host.endsWith('.localhost') || net.isIP(host) === 4 && host.split('.')[0] === '127') return '127.0.0.1';
  return undefined;
}
export function isLoopbackUrl(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && !!loopbackAddress(url.hostname); } catch { return false; }
}
/** A sign-in page opens in that computer's panel browser only when its callback is a literal loopback address.
 * Google forbids embedded sign-in; leave its normal route (and explicit preview choice) alone. */
export function isRemoteSignInUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || host === 'google.com' || host.endsWith('.google.com')) return false;
    for (const [name, value] of url.searchParams) {
      if (!['redirect_uri', 'redirect_url'].includes(name.toLowerCase())) continue;
      try {
        const callback = new URL(value);
        if (['http:', 'https:'].includes(callback.protocol) && loopbackAddress(callback.hostname)) return true;
      } catch { /* Another redirect parameter may still be valid. */ }
    }
  } catch { /* Invalid outer URL or redirect. */ }
  return false;
}

/** The caller supplies the trusted sender binding, never a renderer-selected machine. */
export function externalLinkOpensInPanel(value: string, remote: boolean): boolean {
  return remote && (isLoopbackUrl(value) || isRemoteSignInUrl(value));
}

function destination(value: string, connect = false): { url: URL; target: TunnelTarget } {
  const url = new URL(connect ? `http://${value}` : value);
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol) || connect && (url.pathname !== '/' || url.search)) throw new Error('Invalid proxy destination');
  const port = Number(url.port || (connect ? 443 : url.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid proxy port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return { url, target: { host, port, loopback: loopbackAddress(host) } };
}
export type Resolve = (host: string) => Promise<LookupAddress[]>;
const resolveAll: Resolve = host => lookup(host, { all: true });
/** A name that resolves to loopback here (lvh.me, a hosts-file entry) still means the other computer. */
async function route(target: TunnelTarget, resolve: Resolve): Promise<{ target: TunnelTarget; addresses?: LookupAddress[] }> {
  if (target.loopback || net.isIP(target.host)) return { target };
  const addresses = await resolve(target.host);
  if (!addresses.length) throw new Error('Address not found');
  const loopback = addresses.map(row => loopbackAddress(row.address)).find(Boolean);
  return loopback ? { target: { ...target, loopback } } : { target, addresses };
}
function direct(target: TunnelTarget, addresses?: LookupAddress[]): Promise<net.Socket> {
  // Callers must route loopback through the tunnel before reaching this helper.
  if (target.loopback || loopbackAddress(target.host) || addresses?.some(row => loopbackAddress(row.address))) return Promise.reject(new Error('Loopback requires a host tunnel'));
  return new Promise((resolve, reject) => {
    // Connect to the addresses already checked, not to a second lookup that could answer loopback.
    const socket = net.connect({ host: target.host, port: target.port, ...(addresses ? { lookup: (_host: string, options: LookupOptions, done: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => options.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family) } : {}) });
    const timer = setTimeout(() => socket.destroy(new Error('Proxy connection timed out')), 10000);
    socket.once('error', reject);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('close', () => clearTimeout(timer));
  });
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

/** A machine's private authenticated Chromium proxy. It never rewrites browser URLs. */
export class LoopbackProxy {
  readonly username = 'threadterm';
  readonly secret = randomBytes(32).toString('base64url');
  private readonly authorization = Buffer.from(`Basic ${Buffer.from(`${this.username}:${this.secret}`).toString('base64')}`);
  private readonly server: http.Server;
  private readonly clients = new Set<net.Socket>();
  private readonly upstreams = new Set<Duplex>();
  private readonly agents = new Map<string, http.Agent>();
  private pending = 0;
  private generation = 0;
  private stopped = false;
  private port = 0;
  constructor(readonly computer: string, private readonly tunnel: (port: number, loopback: '127.0.0.1' | '::1') => Promise<Duplex>, private readonly maxConnections = 64, private readonly resolve: Resolve = resolveAll) {
    this.server = http.createServer((request, response) => this.request(request, response));
    this.server.on('connection', socket => {
      if (this.stopped || this.clients.size >= this.maxConnections) { socket.destroy(); return; }
      this.clients.add(socket); socket.once('close', () => this.clients.delete(socket)); socket.on('error', () => {});
    });
    this.server.on('connect', (request, socket, head) => { void this.raw(request, socket, head, true); });
    this.server.on('upgrade', (request, socket, head) => { void this.raw(request, socket, head, false); });
    this.server.on('clientError', (_error, socket) => socket.destroy());
    this.server.headersTimeout = 15000;
    this.server.requestTimeout = 30000;
  }
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.port = (this.server.address() as net.AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }
  matches(host: string, port: number): boolean { return host === '127.0.0.1' && port === this.port && !this.stopped; }
  private authorized(request: http.IncomingMessage): boolean {
    const value = request.headers['proxy-authorization'];
    const actual = Buffer.from(typeof value === 'string' ? value : '');
    return actual.length === this.authorization.length && timingSafeEqual(actual, this.authorization);
  }
  private challenge(socket: Duplex): void { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="ThreadTerm computer"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); }
  private async dial(target: TunnelTarget): Promise<Duplex> {
    if (this.stopped || this.pending + this.upstreams.size >= this.maxConnections) throw new Error('Computer proxy connection limit');
    this.pending++;
    const generation=this.generation;
    try {
      const routed = await route(target, this.resolve);
      const socket = await (routed.target.loopback ? this.tunnel(routed.target.port, routed.target.loopback) : direct(routed.target, routed.addresses));
      if (this.stopped || generation!==this.generation) { socket.destroy(); throw new Error('Computer proxy closed'); }
      this.upstreams.add(socket); socket.once('close', () => this.upstreams.delete(socket)); socket.on('error', () => {});
      return socket;
    } finally { this.pending--; }
  }
  /** Plain HTTP reuses its upstream connections: a dev-server page loads hundreds of modules. */
  private agentFor(target: TunnelTarget): http.Agent {
    const key = `${target.loopback ?? target.host.toLowerCase()} ${target.port}`;
    let agent = this.agents.get(key);
    if (!agent) {
      // Idle connections close after 3 s, before a typical server's 5 s keep-alive ends them.
      agent = Object.assign(new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8, timeout: 3000 }), {
        createConnection: (_options: unknown, done: (error: Error | null, socket?: Duplex) => void) => {
          // A tunnel arrives paused; resume once the request has attached its parser.
          this.dial(target).then(socket => { done(null, socket); setImmediate(() => socket.resume()); }, error => done(error));
          return undefined;
        },
      });
      this.agents.set(key, agent);
    }
    return agent;
  }
  private request(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (!this.authorized(request)) { response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="ThreadTerm computer"', Connection: 'close', 'Content-Length': '0' }); response.end(); return; }
    let url: URL, target: TunnelTarget;
    try {
      ({ url, target } = destination(request.url!));
      if (url.protocol !== 'http:') throw new Error('HTTPS requires CONNECT');
    } catch { this.badGateway(response); return; }
    const headers = { ...request.headers };
    for (const name of ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive']) delete headers[name];
    const bodiless = !request.headers['transfer-encoding'] && (request.headers['content-length'] ?? '0') === '0';
    // A bodiless read that fails on a reused idle connection is sent once more on a new one.
    const replayable = bodiless && ['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '');
    let current: http.ClientRequest | undefined, ended = false;
    const send = (retry: boolean) => {
      const outgoing = current = http.request({ method: request.method, hostname: target.loopback ?? target.host, port: target.port, path: `${url.pathname}${url.search}`, headers, agent: this.agentFor(target) }, incoming => {
        const headers = { ...incoming.headers }; delete headers.connection; delete headers['keep-alive'];
        response.writeHead(incoming.statusCode ?? 502, headers); incoming.pipe(response);
        incoming.once('end', () => { ended = true; });
        incoming.on('error', () => response.destroy());
      });
      outgoing.on('error', () => {
        if (retry && outgoing.reusedSocket && !response.headersSent && !response.destroyed) { send(false); return; }
        if (!response.headersSent) this.badGateway(response, target); else response.destroy();
      });
      if (bodiless) outgoing.end(); else request.pipe(outgoing);
    };
    // A finished response leaves its connection in the pool; an abandoned one closes it.
    response.once('close', () => { if (!ended) current?.destroy(); });
    if (bodiless) request.resume();
    send(replayable);
  }
  private badGateway(response: http.ServerResponse, target?: TunnelTarget): void {
    if (response.destroyed) return;
    // Only a loopback address is served by the other computer; a public one failed on this computer's network.
    const body = !target || target.loopback
      ? `<!doctype html><title>Computer unavailable</title><h1>Cannot reach ${escapeHtml(this.computer)}</h1><p>The service on this computer is unavailable. Check the service and the computer connection.</p>`
      : `<!doctype html><title>Site unavailable</title><h1>Cannot reach ${escapeHtml(target.host)}</h1><p>The address did not respond.</p>`;
    response.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); response.end(body);
  }
  private async raw(request: http.IncomingMessage, client: Duplex, head: Buffer, connect: boolean): Promise<void> {
    if (!this.authorized(request)) { this.challenge(client); return; }
    client.pause();
    let upstream: Duplex | undefined;
    try {
      const { url, target } = destination(request.url!, connect);
      upstream = await this.dial(target);
      if (client.destroyed) { upstream.destroy(); return; }
      const paired = upstream;
      client.once('close', () => paired.destroy()); paired.once('close', () => client.destroy());
      client.once('error', () => paired.destroy()); paired.once('error', () => client.destroy());
      if (connect) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      else {
        const headers: string[] = [];
        for (let index = 0; index < request.rawHeaders.length; index += 2) if (!['proxy-authorization', 'proxy-connection'].includes(request.rawHeaders[index].toLowerCase())) headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
        paired.write(`${request.method} ${url.pathname}${url.search} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
      }
      if (head.length) paired.write(head);
      client.pipe(paired); paired.pipe(client); client.resume(); paired.resume();
    } catch { upstream?.destroy(); if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); }
  }
  /** Used on removal, control loss/gate-off and last partition user departure. */
  closeConnections(): void { this.generation++;for (const socket of this.upstreams) socket.destroy(); for (const socket of this.clients) socket.destroy(); }
  close(): void { this.stopped = true; this.closeConnections(); for (const agent of this.agents.values()) agent.destroy(); this.agents.clear(); this.server.close(); }
}

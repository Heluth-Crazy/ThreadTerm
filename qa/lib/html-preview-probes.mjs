import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createServer as tcpServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { delimiter, join } from 'node:path';

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

/** All attack endpoints stay on loopback. A detected OpenSSL provides a temporary test certificate. */
export async function startHtmlPreviewProbes(scratch) {
  const hits = { http: 0, https: 0, websocket: 0, stun: 0, turn: 0, revokeRace: 0 };
  const response = kind => (request, reply) => {
    hits[kind]++;
    if(request.url.includes('revoke-race'))hits.revokeRace++;
    reply.writeHead(200, { 'content-type': request.url.includes('svg') ? 'image/svg+xml' : 'text/plain', 'access-control-allow-origin': 'null', 'cache-control': 'no-store' });
    reply.end(request.url.includes('svg') ? '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/></svg>' : 'remote fixture loaded');
  };
  const http = httpServer(response('http'));
  http.on('upgrade', (_request, socket) => { hits.websocket++; socket.destroy(); });
  await listen(http);
  let https;
  const path = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? '';
  const executable = path.split(delimiter).flatMap(directory => [join(directory, process.platform === 'win32' ? 'openssl.exe' : 'openssl')]).find(existsSync);
  if (executable) {
    const key = join(scratch, 'loopback-key.pem'), cert = join(scratch, 'loopback-cert.pem');
    execFileSync(executable, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1', '-days', '1'], { windowsHide: true, stdio: 'ignore' });
    https = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, response('https'));
    await listen(https);
  }
  const udp = createSocket('udp4');
  udp.on('message', () => { hits.stun++; });
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  const turn = tcpServer(socket => { hits.turn++; socket.on('data', () => {}); socket.unref(); });
  await listen(turn);
  return {
    http, https, udp, turn, hits,
    httpUrl: `http://127.0.0.1:${http.address().port}/hit`,
    httpsUrl: https ? `https://127.0.0.1:${https.address().port}/hit` : undefined,
    stunPort: udp.address().port,
    turnPort: turn.address().port,
    async close() {
      for (const server of [http, https, turn].filter(Boolean)) {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(() => resolve()));
      }
      udp.close();
    },
  };
}

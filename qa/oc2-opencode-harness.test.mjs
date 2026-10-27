import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { bindOc2Mock } from './oc2-opencode-harness.mjs';

test('OC2 mock binding survives a stopped fork helper overwriting the port hint; mutations never retry', async () => {
  const scratch = await mkdtemp(join(resolve(process.env.THREADTERM_QA_SCRATCH ?? tmpdir()), 'oc2-mock-binding-')), portFile = join(scratch, 'port.txt');
  const requests = [];
  const source = http.createServer((request, response) => {
    let body = '';
    request.on('data', bytes => { body += bytes; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body });
      response.writeHead(request.url.startsWith('/qa/uncertain') ? 503 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ source: true }));
    });
  });
  const forkHelper = http.createServer();
  try {
    source.listen(0, '127.0.0.1'); await once(source, 'listening');
    forkHelper.listen(0, '127.0.0.1'); await once(forkHelper, 'listening');
    await writeFile(portFile, String(source.address().port));
    const native = await bindOc2Mock(portFile, 'D:/fixture space');
    await writeFile(portFile, String(forkHelper.address().port));
    await new Promise(done => forkHelper.close(done));
    assert.deepEqual(await native('/qa/recovery', { question: 'recover' }), { source: true });
    assert.equal(requests[1].url, '/qa/recovery?directory=D%3A%2Ffixture%20space');
    assert.deepEqual(JSON.parse(requests[1].body), { question: 'recover' });
    await assert.rejects(native('/qa/uncertain', {}), /POST \/qa\/uncertain at bound http:\/\/127\.0\.0\.1:\d+ failed:.*503/);
    assert.equal(requests.filter(request => request.url.startsWith('/qa/uncertain')).length, 1);
    assert.equal(requests.filter(request => request.method === 'GET').length, 1, 'readiness is read-only and runs once per binding');
  } finally {
    await Promise.all([source, forkHelper].map(server => new Promise(done => server.close(done))));
  }
});

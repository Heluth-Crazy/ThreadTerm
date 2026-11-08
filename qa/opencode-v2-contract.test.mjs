// Contract tests for the source-derived v2 fixture. They test the fixture's
// route and negative-case coverage, not ThreadTerm compatibility or a live CLI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function removeFixtureRoot(root) {
  const absolute = resolve(root);
  assert.equal(dirname(absolute), resolve(tmpdir()), 'cleanup stays in the fixture temp parent');
  assert.ok(basename(absolute).startsWith('threadterm-opencode-v2-contract-'), 'cleanup names the created fixture root');
  await rm(absolute, { recursive: true, force: true });
}
async function launch(mode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'threadterm-opencode-v2-contract-'));
  const portFile = join(root, 'port');
  const requestsFile = join(root, 'requests.jsonl');
  const password = 'fixture-password';
  const child = spawn(process.execPath, [resolve('qa/fixtures/mock-opencode-v2.mjs'), 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, OPENCODE_PASSWORD: password, TT_QA_OPENCODE_PORT_FILE: portFile, TT_QA_OPENCODE_REQUESTS: requestsFile, TT_QA_OPENCODE_V2_MODE: mode },
    windowsHide: true, stdio: 'ignore',
  });
  let port;
  try {
    for (let i = 0; i < 80; i += 1) {
      try { port = Number(await readFile(portFile, 'utf8')); if (port) break; } catch { await pause(25); }
    }
    assert.ok(port, 'fixture published a port');
  } catch (error) {
    if (child.exitCode === null) child.kill();
    await removeFixtureRoot(root);
    throw error;
  }
  const call = async (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...init, signal: init.signal || AbortSignal.timeout(1_500), headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, ...(init.headers || {}) },
  });
  return { child, root, requestsFile, call };
}
async function stop(fixture) {
  if (fixture.child.exitCode === null) fixture.child.kill();
  await Promise.race([new Promise(resolve => fixture.child.once('exit', resolve)), pause(1_000)]);
  await removeFixtureRoot(fixture.root);
}

{
  const fixture = await launch();
  try {
    const info = await fixture.call('/api/info');
    const serverInfo = await info.json();
    assert.equal(serverInfo.version, '2.2.5'); assert.equal(Number.isInteger(serverInfo.pid), true);
    assert.equal(typeof serverInfo.paths.tmp, 'string'); assert.equal(Array.isArray(serverInfo.urls), true);
    const location = await fixture.call('/api/location?location%5Bdirectory%5D=C%3A%2Fqa');
    assert.deepEqual(await location.json(), { directory: 'C:/qa', project: { id: 'prj_qa', directory: 'C:/qa', canonical: 'C:/qa' } });
    const create = await fixture.call('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ location: { directory: 'C:/qa' } }) });
    assert.equal(create.status, 200);
    const created = await create.json();
    assert.equal(created.data.directory, 'C:/qa'); assert.match(created.data.id, /^ses_v2_/);
    const id = created.data.id;
    assert.deepEqual(await (await fixture.call(`/api/session/${id}`)).json(), { data: { id, directory: 'C:/qa' } });
    const models = await fixture.call('/api/model?location%5Bdirectory%5D=C%3A%2Fqa');
    assert.deepEqual(await models.json(), { location: { directory: 'C:/qa' }, data: [{ providerID: 'openai', id: 'gpt-5', name: 'GPT 5' }] });
    const events = await fixture.call('/api/event');
    const firstFrame = await events.body.getReader().read();
    assert.equal(new TextDecoder().decode(firstFrame.value), ': heartbeat\n\n', 'fixture emits a complete SSE comment frame');
    const prompt = await fixture.call(`/api/session/${id}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'one native admission', resume: false }) });
    assert.equal(prompt.status, 200); assert.deepEqual((await prompt.json()).data, { id: 'msg_2', sessionID: id, time: { created: 1 }, type: 'user', payload: { text: 'one native admission' }, delivery: 'steer' });
    assert.deepEqual(await (await fixture.call(`/api/session/${id}/interrupt`, { method: 'POST' })).json(), { interrupted: true });
    const reply = await fixture.call(`/api/session/${id}/permission/request/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'once' }) });
    assert.equal(reply.status, 204);
    const requests = (await readFile(fixture.requestsFile, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(requests.filter(row => row.path.endsWith('/prompt')).length, 1, 'one prompt mutation');
    assert.equal(requests.find(row => row.path.endsWith('/prompt')).body.text, 'one native admission');
    assert.equal(requests.find(row => row.path === '/api/session').body.location.directory, 'C:/qa');
  } finally { await stop(fixture); }
}
{
  const fixture = await launch('html-info');
  try { const response = await fixture.call('/api/info'); assert.equal(response.headers.get('content-type'), 'text/html'); } finally { await stop(fixture); }
}
{
  const fixture = await launch('missing-envelope');
  try { const response = await fixture.call('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ location: { directory: 'C:/qa' } }) }); assert.equal((await response.json()).data, undefined); } finally { await stop(fixture); }
}
{
  const fixture = await launch('missing-native-id');
  try { const response = await fixture.call('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ location: { directory: 'C:/qa' } }) }); assert.equal((await response.json()).data.id, undefined); } finally { await stop(fixture); }
}
{
  const fixture = await launch();
  try {
    const response = await fixture.call('/api/info', { headers: { authorization: 'Basic d3Jvbmc6d3Jvbmc=' } });
    assert.equal(response.status, 401, 'wrong Basic user must not look ready');
  } finally { await stop(fixture); }
}
{
  const fixture = await launch('malformed-info');
  try {
    const info = await (await fixture.call('/api/info')).json();
    assert.equal(Number.isInteger(info.pid), false, 'mandatory ServerInfo fields must be validated by the adapter');
    assert.equal(info.paths, undefined);
  } finally { await stop(fixture); }
}
{
  const fixture = await launch('content-on-no-content');
  try {
    const created = await (await fixture.call('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ location: { directory: 'C:/qa' } }) })).json();
    const reply = await fixture.call(`/api/session/${created.data.id}/permission/request/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'once' }) });
    assert.equal(reply.status, 200, 'adapter must reject a body where this endpoint requires no content');
  } finally { await stop(fixture); }
}

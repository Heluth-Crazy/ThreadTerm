// OC2 root-route fixture contract. This starts only the local mock HTTP server.
import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = await mkdtemp('D:/project/ThreadTerm/tt-qa-temp/oc2-opencode-fixture-');
const stateFile = join(scratch, 'state.json'), requestsFile = join(scratch, 'requests.jsonl');
let port = 0;
const directory = 'D:/fixture';
const originalArgv = process.argv, keys = ['TT_QA_OPENCODE_STATE','TT_QA_OPENCODE_REQUESTS','TT_QA_OPENCODE_PORT_FILE'];
const originalEnv = new Map(keys.map(key => [key,process.env[key]]));
let server;
try {
  process.argv = [process.execPath, resolve('qa/fixtures/mock-opencode.mjs'), '--port', '0'];
  process.env.TT_QA_OPENCODE_STATE = stateFile; process.env.TT_QA_OPENCODE_REQUESTS = requestsFile; process.env.TT_QA_OPENCODE_PORT_FILE = join(scratch,'port.txt');
  ({server} = await import(`${pathToFileURL(resolve('qa/fixtures/mock-opencode.mjs')).href}?oc2=${Date.now()}`));
} finally {
  process.argv = originalArgv;
  for (const [key,value] of originalEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
if (!server.listening) await once(server,'listening');
port = server.address().port;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = async (path, method = 'GET', body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}?directory=${encodeURIComponent(directory)}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
};
const requests = async () => {
  try { return (await readFile(requestsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return []; }
};

for (let attempt = 0; attempt < 100; attempt += 1) { try { await request('/global/health'); break; } catch (error) { if (attempt === 99) throw error; await pause(20); } }

test('OC2 mock exposes command, capability, durable-action, and recovery root routes', async () => {
  const catalogue = await request('/provider');
  assert.equal(catalogue.all.find(provider => provider.id === 'vision').models['vision-1'].capabilities.input.image, true);
  assert.equal(catalogue.all.find(provider => provider.id === 'openai').models['gpt-5.2'].capabilities.input.image, false);
  assert.deepEqual((await request('/command')).map(command => [command.name, command.description]), [['review', 'Review the current changes'], ['compact', 'Compact conversation']]);

  const source = await request('/session', 'POST', {});
  const sourcePath = `/session/${source.id}`;
  await request(`${sourcePath}/command`, 'POST', { command: 'review', arguments: 'src', agent: 'build', model: 'vision/vision-1', variant: 'precise', parts: [{ type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AA==' }] });
  await pause(50);
  await request(`${sourcePath}/summarize`, 'POST', { providerID: 'vision', modelID: 'vision-1' });
  for (let attempt = 0; attempt < 100 && (await request('/session/status'))[source.id]?.type === 'busy'; attempt += 1) await pause(5);

  const seededMessages = [
    { info: { id: 'msg_keep', sessionID: source.id, role: 'assistant' }, parts: [] },
    { info: { id: 'msg_exclude', sessionID: source.id, role: 'assistant' }, parts: [] },
  ];
  await request('/qa/recovery', 'POST', { sessions: [{ id: source.id, messages: seededMessages }] });
  const fork = await request(`${sourcePath}/fork`, 'POST', { messageID: 'msg_exclude' });
  const latest = await request(`${sourcePath}/fork`, 'POST', {});
  const afterFork = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.deepEqual(afterFork.sessions[`${directory}|${fork.id}`].messages.map(message => message.info.id), ['msg_keep']);
  assert.deepEqual(afterFork.sessions[`${directory}|${latest.id}`].messages.map(message => message.info.id), ['msg_keep', 'msg_exclude']);

  await request('/qa/recovery', 'POST', { permissions: [{ id: 'per_recovery', sessionID: source.id, permission: 'bash', patterns: ['dir'], metadata: {} }], questions: [{ id: 'q_recovery', sessionID: source.id, questions: [{ question: 'Continue?', options: [] }] }], sessions: [{ id: source.id, todo: [{ content: 'Hydrated todo', status: 'pending', priority: 'high' }], children: [{ id: 'ses_child_recovery', parentID: source.id, directory }] }] });
  assert.equal((await request('/permission'))[0].id, 'per_recovery');
  assert.equal((await request('/question'))[0].id, 'q_recovery');
  assert.equal((await request(`${sourcePath}/todo`))[0].content, 'Hydrated todo');
  assert.ok((await request(`${sourcePath}/children`)).some(child => child.id === 'ses_child_recovery'));

  await request('/qa/fork-outcome', 'POST', { dropResponse: true });
  const beforeUnknown = JSON.parse(await readFile(stateFile, 'utf8'));
  const uncertain = await fetch(`http://127.0.0.1:${port}${sourcePath}/fork?directory=${encodeURIComponent(directory)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(uncertain.status, 503, 'fixture models an accepted native mutation with an uncertain HTTP result');
  const afterUnknown = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(Object.keys(afterUnknown.sessions).length, Object.keys(beforeUnknown.sessions).length + 1);
  assert.deepEqual(afterUnknown.sessions[`${directory}|${source.id}`].messages, beforeUnknown.sessions[`${directory}|${source.id}`].messages);
  await request('/qa/fork-outcome', 'POST', { dropResponse: false });
  const bodies = await requests();
  assert.deepEqual(bodies.filter(row => row.path.endsWith('/command')).findLast(row => row.body).body, { command: 'review', arguments: 'src', agent: 'build', model: 'vision/vision-1', variant: 'precise', parts: [{ type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AA==' }] });
  assert.deepEqual(bodies.filter(row => row.path.endsWith('/summarize')).findLast(row => row.body).body, { providerID: 'vision', modelID: 'vision-1' });
  assert.deepEqual(bodies.filter(row => row.path.endsWith('/fork') && row.body).map(row => row.body), [{ messageID: 'msg_exclude' }, {}, {}]);
});

test.after(() => new Promise(done => server.close(done)));

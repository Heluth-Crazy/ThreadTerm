// Source-derived OpenCode 2.2.5 fixture.  It deliberately has a different
// vocabulary from mock-opencode.mjs (the 1.18.31 regression fixture).
// Native capture may tighten this contract; do not treat it as live evidence.
import http from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.TT_QA_OPENCODE_CLI_DIAGNOSTIC) appendFileSync(process.env.TT_QA_OPENCODE_CLI_DIAGNOSTIC, `${JSON.stringify({ args })}\n`);
if (args.includes('--version')) { console.log('2.2.5-qa-source-fixture'); process.exit(0); }
if (args[0] === 'auth' && args[1] === '--help') {
  if (process.env.TT_QA_OPENCODE_V2_MODE === 'unknown-auth-help') { console.log('Unrecognized future auth help'); process.exit(0); }
  console.log('DESCRIPTION\n  manage integrations and credentials\n\nGLOBAL FLAGS\n  --standalone  Run with a private server instead of the background service\n\nSUBCOMMANDS\n  list      list integrations and credentials');
  process.exit(0);
}
if ((args[0] === 'auth' && args[1] === 'list') || (args[0] === '--standalone' && args[1] === 'auth' && args[2] === 'list')) { console.log('[]'); process.exit(0); }

const portArg = args.indexOf('--port');
const requestedPort = portArg < 0 ? 0 : Number(args[portArg + 1]);
const password = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || '';
const portFile = process.env.TT_QA_OPENCODE_PORT_FILE;
const requestsFile = process.env.TT_QA_OPENCODE_REQUESTS;
const mode = process.env.TT_QA_OPENCODE_V2_MODE || 'normal';
let sequence = 0;
const sessions = new Map();

function record(method, path, query, body) {
  if (requestsFile) appendFileSync(requestsFile, `${JSON.stringify({ method, path, query, body })}\n`);
}

function auth(req, res) {
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  if (process.env.TT_QA_OPENCODE_AUTH_DIAGNOSTIC) {
    const user = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':')[0];
    appendFileSync(process.env.TT_QA_OPENCODE_AUTH_DIAGNOSTIC, `${JSON.stringify({ path: req.url, user: ['opencode', 'threadterm'].includes(user) ? user : '[other]', passwordEnvironmentPresent: Boolean(password), passwordEnvironmentsMatch: process.env.OPENCODE_PASSWORD === process.env.OPENCODE_SERVER_PASSWORD, matched: req.headers.authorization === expected })}\n`);
  }
  if (req.headers.authorization === expected) return true;
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'unauthorized' } }));
  return false;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : undefined); } catch (error) { reject(error); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (!auth(req, res)) return;
  let body;
  try { body = await readJson(req); } catch { return send({ error: { code: 'bad_json' } }, 400); }
  record(req.method, url.pathname, Object.fromEntries(url.searchParams), body);

  if (url.pathname === '/api/info' && req.method === 'GET') {
    if (mode === 'html-info') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>not api</html>'); }
    if (mode === 'malformed-info') return send({ version: '2.2.5', pid: 'not-a-pid', urls: [] });
    return send({ version: '2.2.5', pid: process.pid, hostname: '127.0.0.1', urls: ['http://127.0.0.1'], paths: { tmp: 'C:/qa/tmp' }, capabilities: {} });
  }
  if (url.pathname === '/api/event' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': heartbeat\n\n');
    return;
  }
  if (url.pathname === '/api/location' && req.method === 'GET') {
    const directory = url.searchParams.get('location[directory]');
    if (!directory) return send({ error: { code: 'location_required' } }, 400);
    return send({ directory, project: { id: 'prj_qa', directory, canonical: directory } });
  }
  if (url.pathname === '/api/session' && req.method === 'POST') {
    const directory = body?.location?.directory;
    if (!directory) return send({ error: { code: 'location_required' } }, 400);
    const id = mode === 'missing-native-id' ? undefined : `ses_v2_${++sequence}`;
    if (id) sessions.set(id, { id, directory });
    const data = { directory, ...(id ? { id } : {}) };
    return send(mode === 'missing-envelope' ? data : { data }, 200);
  }
  if (url.pathname === '/api/model' && req.method === 'GET') {
    const directory = url.searchParams.get('location[directory]');
    if (!directory) return send({ error: { code: 'location_required' } }, 400);
    return send({ location: { directory }, data: [{ providerID: 'openai', id: 'gpt-5', name: 'GPT 5' }] });
  }
  const session = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/);
  if (!session) return send({ error: { code: 'not_found' } }, 404);
  const [, id, action = ''] = session;
  const current = sessions.get(id);
  if (!current) return send({ error: { code: 'not_found' } }, 404);
  if (!action && req.method === 'GET') return send(mode === 'missing-envelope' ? current : { data: current });
  if (action === 'prompt' && req.method === 'POST') {
    if (typeof body?.text !== 'string') return send({ error: { code: 'text_required' } }, 400);
    return send({ data: { id: `msg_${++sequence}`, sessionID: id, time: { created: 1 }, type: 'user', payload: { text: body.text }, delivery: 'steer' } });
  }
  if (action === 'interrupt' && req.method === 'POST') return send({ interrupted: true });
  if (action === 'permission/request/reply' && req.method === 'POST') {
    if (!['once', 'always', 'reject'].includes(body?.decision)) return send({ error: { code: 'decision_required' } }, 400);
    if (mode === 'content-on-no-content') return send({ data: { accepted: true } });
    res.writeHead(204); return res.end();
  }
  return send({ error: { code: 'not_found' } }, 404);
});

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  if (portFile && address && typeof address !== 'string') writeFileSync(portFile, String(address.port));
});


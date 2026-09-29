// Mock OpenCode 1.18.31 server for ThreadTerm QA. Speaks the REAL event shapes
// (verified against the installed server's OpenAPI /doc): flat PermissionRequest
// in permission.asked, requestID in permission.replied, message.part.delta as a
// separate event, session.status {type}. No model is ever contacted.
// State persists in mock-state.json beside this script so a respawned process
// (runtime reconnect) keeps the sessions.
import http from 'node:http';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('1.18.31-qa-mock'); process.exit(0); }
if (argv[0] === 'auth') { console.log('[]'); process.exit(0); }
const port = Number(argv[argv.indexOf('--port') + 1]);
if (!process.env.TT_QA_OPENCODE_STATE) throw new Error('TT_QA_OPENCODE_STATE is required');
const stateFile = resolve(process.env.TT_QA_OPENCODE_STATE);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { sessions: {} };
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const streams = new Set();
const stalledStreams = new Map();
let seq = Object.keys(state.sessions).length;

function emit(directory, type, properties) {
  if (type === 'message.part.updated' && properties.part?.messageID) {
    const record = sessionOf(directory, properties.sessionID);
    if (record) {
      let message = record.messages.find(row => row.info.id === properties.part.messageID);
      if (!message) {
        message = { info: { id: properties.part.messageID, sessionID: properties.sessionID, role: 'assistant' }, parts: [] };
        record.messages.push(message);
      }
      const index = message.parts.findIndex(part => part.id === properties.part.id);
      if (index < 0) message.parts.push(properties.part);
      else message.parts[index] = properties.part;
      save();
    }
  }
  const frame = `data: ${JSON.stringify({ directory, project: 'qa', payload: { id: `evt_${++seq}`, type, properties } })}\n\n`;
  for (const res of streams) if (!stalledStreams.has(res)) res.write(frame);
}
function sessionOf(dir, id) { return state.sessions[`${dir}|${id}`]; }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const dir = url.searchParams.get('directory') ?? '';
  const path = url.pathname;
  if (process.env.TT_QA_OPENCODE_REQUESTS) appendFileSync(process.env.TT_QA_OPENCODE_REQUESTS, JSON.stringify({ method: req.method, path, directory: dir }) + '\n');
  const json = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (path === '/global/health') return json({ healthy: true, version: '1.18.31-qa-mock' });
  if (path === '/global/event') {
    if (state.stallEventHeaders) return; // accepted TCP, deliberately no SSE headers
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ directory: 'global', payload: { id: `evt_${++seq}`, type: 'server.connected', properties: {} } })}\n\n`);
    streams.add(res);
    const heartbeat = setInterval(() => {
      const stallMode = stalledStreams.get(res);
      if (stallMode === 'comments') { res.write(': transport bytes without a native event\n\n'); return; }
      if (stallMode === 'partial') { res.write(' '); return; }
      if (stallMode === 'none') return;
      res.write(`data: ${JSON.stringify({ directory: 'global', payload: { id: `evt_${++seq}`, type: 'server.heartbeat', properties: {} } })}\n\n`);
    }, 10_000);
    req.on('close', () => { clearInterval(heartbeat); streams.delete(res); stalledStreams.delete(res); });
    return;
  }
  if (path === '/qa/stall-events' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const mode = JSON.parse(body).mode;
      if (mode !== 'comments' && mode !== 'partial' && mode !== 'none') return json({ error: 'unknown stall mode' }, 400);
      for (const stream of streams) {
        stalledStreams.set(stream, mode);
        if (mode === 'partial') stream.write('data: {');
      }
      json({ stalled: stalledStreams.size, mode });
    });
    return;
  }
  if (path === '/qa/drop-events') { for (const s of streams) s.end(); streams.clear(); return json({ dropped: true }); }
  if (path === '/qa/emit' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const frame = JSON.parse(body);
      emit(frame.directory ?? dir, frame.type, frame.properties ?? {});
      json({ emitted: true });
    });
    return;
  }
  if (path === '/qa/status' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const update = JSON.parse(body);
      const record = sessionOf(update.directory ?? dir, update.sessionID);
      if (!record) return json({ error: 'not found' }, 404);
      record.busy = Boolean(update.busy);
      save();
      json({ updated: true });
    });
    return;
  }
  if (path === '/qa/fail-status' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      state.failStatus = Boolean(JSON.parse(body).enabled);
      save();
      json({ enabled: state.failStatus });
    });
    return;
  }
  if (path === '/qa/bad-snapshot' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      state.badSnapshot = JSON.parse(body).messageID;
      save();
      json({ enabled: true });
    });
    return;
  }
  if (path === '/session' && req.method === 'POST') {
    const id = `ses_mock_${++seq}`;
    state.sessions[`${dir}|${id}`] = { id, messages: [], busy: false };
    save();
    emit(dir, 'session.created', { sessionID: id, info: { id, directory: dir } });
    return json({ id });
  }
  if (path === '/session/status') {
    if (state.failStatus) return json({ error: 'status unavailable' }, 503);
    const out = {};
    for (const [key, record] of Object.entries(state.sessions)) {
      if (key.startsWith(`${dir}|`) && record.busy) out[record.id] = { type: 'busy' };
    }
    return json(out);
  }
  const sessionMatch = path.match(/^\/session\/([^/]+)(\/.*)?$/);
  if (sessionMatch) {
    const id = sessionMatch[1];
    const sub = sessionMatch[2] ?? '';
    const record = sessionOf(dir, id);
    if (!record) return json({ error: 'not found' }, 404);
    if (sub === '' && req.method === 'GET') return json({ id: record.id, directory: dir });
    if (sub === '/message' && req.method === 'GET') {
      if (state.seedRace?.sessionID === id) {
        const message = record.messages.find(row => row.info.id === state.seedRace.messageID);
        const part = message?.parts.find(row => row.id === state.seedRace.partID);
        if (part) {
          part.text = 'AB';
          state.seedRace = null;
          save();
          // The native snapshot now contains B, yet the SSE delta remains in
          // the socket buffer when the adapter starts its reader.
          emit(dir, 'message.part.delta', { sessionID: id, messageID: message.info.id, partID: part.id, field: 'text', delta: 'B' });
        }
      }
      const limit = Number(url.searchParams.get('limit') || 0);
      return json(limit > 0 ? record.messages.slice(-limit) : record.messages);
    }
    const messageMatch = sub.match(/^\/message\/([^/]+)$/);
    if (messageMatch && req.method === 'GET') {
      const message = record.messages.find(row => row.info.id === messageMatch[1]);
      if (!message) return json({ error: 'message not found' }, 404);
      if (state.badSnapshot === messageMatch[1]) return json({ ...message, info: { ...message.info, id: 'msg_wrong_identity' } });
      return json(message);
    }
    if (sub === '/prompt_async' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const text = JSON.parse(body).parts?.[0]?.text ?? '';
        record.busy = true; save();
        if (text === 'fixture-early-permission') {
          // Native event precedes the prompt_async HTTP acknowledgement.
          emit(dir, 'permission.asked', { sessionID: id, id: 'per_early', permission: 'bash', patterns: ['echo'], metadata: {}, always: [] });
          setTimeout(() => json({}), 300);
          return;
        }
        if (text === 'fixture-early-permission-http-fail') {
          emit(dir, 'permission.asked', { sessionID: id, id: 'per_early_fail', permission: 'bash', patterns: ['echo'], metadata: {}, always: [] });
          setTimeout(() => json({ error: 'native action may already be waiting' }, 503), 300);
          return;
        }
        if (text === 'fixture-early-idle' || text === 'fixture-early-error') {
          record.busy = false; save();
          emit(dir, text === 'fixture-early-idle' ? 'session.idle' : 'session.error', { sessionID: id, error: { message: 'fixture early error' } });
          setTimeout(() => json({}), 300);
          return;
        }
        if (text === 'fixture-http-reject') {
          record.busy = false; save();
          return json({ error: 'fixture rejects prompt before execution' }, 422);
        }
        json({});
        setTimeout(() => {
          const messageID = `msg_${++seq}`;
          const partID = `prt_${++seq}`;
          if (text === 'fixture-two-parts') {
            emit(dir, 'message.part.updated', { sessionID: id, part: { id: partID, messageID, sessionID: id, type: 'text', text: 'FIRST-PART', time: { start: 1 } } });
            emit(dir, 'message.part.updated', { sessionID: id, part: { id: `prt_${++seq}`, messageID: `msg_${++seq}`, sessionID: id, type: 'text', text: 'SECOND-PART', time: { start: 2 } } });
          } else if (text === 'fixture-delta') {
            emit(dir, 'message.part.delta', { sessionID: id, messageID, partID, field: 'text', delta: 'Hello ' });
            emit(dir, 'message.part.delta', { sessionID: id, messageID, partID, field: 'text', delta: 'world' });
          } else if (text === 'fixture-seed') {
            emit(dir, 'message.part.updated', { sessionID: id, part: { id: partID, messageID, sessionID: id, type: 'text', text: 'A', time: { start: 1 } } });
          } else if (text === 'fixture-permission') {
            emit(dir, 'permission.asked', { sessionID: id, id: 'per_1', permission: 'bash', patterns: ['ls'], metadata: {}, always: [] });
            emit(dir, 'permission.asked', { sessionID: id, id: 'per_2', permission: 'write', patterns: ['x'], metadata: {}, always: [] });
            return; // keep the native turn running until QA explicitly ends it
          } else if (text === 'fixture-watchdog-permission') {
            emit(dir, 'permission.asked', { sessionID: id, id: 'per_watch_1', permission: 'bash', patterns: ['ls'], metadata: {}, always: [] });
            emit(dir, 'permission.asked', { sessionID: id, id: 'per_watch_2', permission: 'write', patterns: ['x'], metadata: {}, always: [] });
            return; // the SSE stream can go silent while native remains busy
          } else if (text === 'fixture-foreign') {
            emit(dir, 'message.part.updated', { sessionID: 'ses_FOREIGN', part: { id: 'prt_9', messageID: 'msg_9', sessionID: 'ses_FOREIGN', type: 'text', text: 'FOREIGN-CONTENT', time: { start: 1 } } });
            emit(dir, 'session.idle', { sessionID: 'ses_FOREIGN' });
          } else if (text === 'fixture-stuck') {
            emit(dir, 'message.part.delta', { sessionID: id, messageID, partID, field: 'text', delta: 'STUCK-PART ' });
            return; // never idle and never clears busy: the turn stays open
          } else {
            emit(dir, 'message.part.updated', { sessionID: id, part: { id: partID, messageID, sessionID: id, type: 'text', text: `echo:${text}`, time: { start: 1 } } });
          }
          record.busy = false; save();
          emit(dir, 'session.idle', { sessionID: id });
        }, 60);
      });
      return;
    }
    if (sub === '/abort' && req.method === 'POST') {
      record.busy = false; save();
      setTimeout(() => emit(dir, 'session.idle', { sessionID: id }), 30);
      return json({});
    }
    const permissionMatch = sub.match(/^\/permissions\/([^/]+)$/);
    if (permissionMatch && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const reply = JSON.parse(body).response ?? 'reject';
        json({});
        setTimeout(() => emit(dir, 'permission.replied', { sessionID: id, requestID: permissionMatch[1], reply }), 30);
      });
      return;
    }
  }
  if (path === '/instance/dispose') return json({});
  json({ error: 'unhandled ' + path }, 404);
});
server.listen(port, '127.0.0.1', () => {
  if (process.env.TT_QA_OPENCODE_PORT_FILE) writeFileSync(process.env.TT_QA_OPENCODE_PORT_FILE, String(port));
  console.log(`mock opencode listening on ${port}`);
});

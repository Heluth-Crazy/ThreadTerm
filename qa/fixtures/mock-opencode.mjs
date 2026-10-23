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
const requestsFile = process.env.TT_QA_OPENCODE_REQUESTS;
const portFile = process.env.TT_QA_OPENCODE_PORT_FILE;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { sessions: {}, questions: {} };
state.questions ??= {};
if (argv[0] === 'export') {
  const entry = Object.entries(state.sessions).find(([, value]) => value.id === argv[1]);
  if (!entry) { console.error('mock session not found'); process.exit(1); }
  const [key, record] = entry;
  console.log(JSON.stringify({ info: { id: record.id, directory: key.slice(0, key.lastIndexOf('|')), ...(record.parentID ? { parentID: record.parentID } : {}) }, messages: record.messages }));
  process.exit(0);
}
const save = () => {
  // Native fork can use a second isolated mock server. Preserve its durable
  // branches when the original server next saves its own source-session state.
  if (existsSync(stateFile)) {
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
    seq = Math.max(seq, persisted.sequence ?? 0);
    for (const [key, record] of Object.entries(persisted.sessions ?? {})) {
      if (!state.sessions[key]) state.sessions[key] = record;
      else if (record.children?.length) {
        const children = new Map(record.children.map(child => [child.id, child]));
        for (const child of state.sessions[key].children ?? []) children.set(child.id, child);
        state.sessions[key].children = [...children.values()];
      }
    }
  }
  state.sequence = seq; writeFileSync(stateFile, JSON.stringify(state));
};
const request = (method, path, directory, body) => {
  if (requestsFile) appendFileSync(requestsFile, JSON.stringify({ method, path, directory, ...(body === undefined ? {} : { body }) }) + '\n');
};
const model = (providerID, id, name, variants, image = false) => ({ id, name, providerID, status: 'active', ...(variants ? { variants } : {}), capabilities: { attachment: image, input: { text: true, audio: false, image, video: false, pdf: false } } });
const catalogues = {
  provider: {
    all: [
      { id: 'openai', name: 'OpenAI', models: { 'gpt-5.2': model('openai', 'gpt-5.2', 'GPT 5.2', { fast: {}, precise: {} }) } },
      { id: 'vision', name: 'Vision', models: { 'vision-1': model('vision', 'vision-1', 'Vision 1', undefined, true) } },
      { id: 'slash/provider', name: 'Slash Provider', models: { 'family/model/with/slash': model('slash/provider', 'family/model/with/slash', 'Slash Model') } },
      { id: 'offline', name: 'Offline', models: { unavailable: model('offline', 'unavailable', 'Unavailable') } },
    ],
    default: {},
    connected: ['openai', 'slash/provider'],
  },
  agent: [
    { name: 'build', mode: 'primary', description: 'Build changes' },
    { name: 'plan', mode: 'primary', description: 'Plan changes' },
    { name: 'custom', mode: 'all', description: 'Custom primary agent' },
    { name: 'hidden', mode: 'primary', hidden: true, description: 'Hidden agent' },
    { name: 'subagent', mode: 'subagent', description: 'Subagent only' },
  ],
};
const commands = [
  { name: 'review', description: 'Review the current changes', template: 'Review the current changes', hints: ['files'] },
  { name: 'compact', description: 'Compact conversation', template: 'Compact this conversation', hints: [] },
];
function configuredCatalogue() {
  const overrides = state.catalogueOverrides ?? {};
  const provider = structuredClone(catalogues.provider);
  for (const removal of overrides.removeModels ?? []) {
    const entry = provider.all.find(candidate => candidate.id === removal.providerID);
    if (entry) delete entry.models[removal.modelID];
  }
  if (Array.isArray(overrides.disconnectedProviders)) provider.connected = provider.connected.filter(id => !overrides.disconnectedProviders.includes(id));
  for (const id of overrides.connectedProviders ?? []) if (!provider.connected.includes(id)) provider.connected.push(id);
  return provider;
}
function configuredAgents() {
  const removed = new Set(state.catalogueOverrides?.removeAgents ?? []);
  return catalogues.agent.filter(agent => !removed.has(agent.name));
}
const streams = new Set();
const stalledStreams = new Map();
let seq = state.sequence ?? Object.keys(state.sessions).length;

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
function readJson(req, done) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => done(body ? JSON.parse(body) : {}));
}
function completeNativeTurn(directory, record, text) {
  record.busy = true;
  save();
  setTimeout(() => {
    if (text) emit(directory, 'message.part.updated', { sessionID: record.id, part: { id: `prt_${++seq}`, messageID: `msg_${++seq}`, sessionID: record.id, type: 'text', text, time: { start: 1 } } });
    record.busy = false;
    save();
    emit(directory, 'session.idle', { sessionID: record.id });
  }, 30);
}

export const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const dir = url.searchParams.get('directory') ?? '';
  const path = url.pathname;
  if (!/^\/session\/[^/]+\/(prompt_async|command|summarize|fork)$/.test(path)) request(req.method, path, dir);
  const json = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (path === '/global/health') return json({ healthy: true, version: '1.18.31-qa-mock' });
  if (path === '/provider' && req.method === 'GET') return json(configuredCatalogue());
  if (path === '/agent' && req.method === 'GET') return json(configuredAgents());
  if (path === '/command' && req.method === 'GET') return json(commands);
  if (path === '/permission' && req.method === 'GET') return json(state.pendingPermissions ?? []);
  if (path === '/question' && req.method === 'GET') return json(state.pendingQuestions ?? []);
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
  if (path === '/qa/stall-event-headers' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      state.stallEventHeaders = Boolean(JSON.parse(body).enabled);
      save();
      json({ enabled: state.stallEventHeaders });
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
  if (path === '/qa/recovery' && req.method === 'POST') {
    return readJson(req, recovery => {
      state.pendingPermissions = recovery.permissions ?? [];
      state.pendingQuestions = recovery.questions ?? [];
      for (const session of recovery.sessions ?? []) {
        if (!sessionOf(dir, session.id) && session.create === true) state.sessions[`${dir}|${session.id}`] = { id: session.id, messages: [], busy: false, parentID: session.parentID };
        const record = sessionOf(dir, session.id);
        if (record) {
          if (typeof session.busy === 'boolean') record.busy = session.busy;
          record.todo = session.todo ?? [];
          record.children = session.children ?? [];
          if (session.messages) record.messages = session.messages;
        }
      }
      save();
      json({ seeded: true });
    });
  }
  if (path === '/qa/catalogue' && req.method === 'POST') return readJson(req, body => { state.catalogueOverrides = { ...(state.catalogueOverrides ?? {}), ...body }; save(); json(configuredCatalogue()); });
  if (path === '/qa/fork-outcome' && req.method === 'POST') return readJson(req, body => { state.forkDropResponse = Boolean(body.dropResponse); save(); json({ dropResponse: state.forkDropResponse }); });
  const questionMatch = path.match(/^\/question\/([^/]+)\/(reply|reject)$/);
  if (questionMatch && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const [, requestID, action] = questionMatch;
      const question = state.questions[requestID];
      if (!question) return json({ error: 'unknown question' }, 404);
      const answers = action === 'reply' ? JSON.parse(body).answers : undefined;
      state.questionReplies ??= [];
      state.questionReplies.push({ requestID, action, answers, sessionID: question.sessionID });
      save();
      json({});
      setTimeout(() => {
        emit(question.directory, action === 'reply' ? 'question.replied' : 'question.rejected', { sessionID: question.sessionID, requestID, answers });
        const record = sessionOf(question.directory, question.sessionID);
        if (record) { record.busy = false; save(); emit(question.directory, 'session.idle', { sessionID: question.sessionID }); }
      }, 20);
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
    if (sub === '/todo' && req.method === 'GET') return json(record.todo ?? []);
    if (sub === '/children' && req.method === 'GET') return json(record.children ?? []);
    if (sub === '/command' && req.method === 'POST') {
      return readJson(req, body => {
        if (!commands.some(command => command.name === body.command)) return json({ error: 'unknown command' }, 404);
        request(req.method, path, dir, body);
        completeNativeTurn(dir, record, `command:${body.command}${body.arguments ? ` ${body.arguments}` : ''}`);
        json({ info: { id: `msg_command_${++seq}`, sessionID: id, role: 'assistant' }, parts: [] });
      });
    }
    if (sub === '/summarize' && req.method === 'POST') {
      return readJson(req, body => {
        request(req.method, path, dir, body);
        if (record.busy) return json({ error: 'session busy' }, 409);
        record.busy = true;
        save();
        setTimeout(() => {
          // A real server can append a hidden native summary. The adapter must
          // suppress this implementation detail and show only its receipt.
          const messageID = `msg_summary_${++seq}`, info = { id: messageID, sessionID: id, role: 'assistant', summary: true };
          record.messages.push({ info, parts: [] });
          emit(dir, 'message.updated', { info });
          emit(dir, 'message.part.updated', { sessionID: id, part: { id: `prt_summary_${++seq}`, messageID, sessionID: id, type: 'text', text: 'HIDDEN-NATIVE-SUMMARY', time: { start: 1 } } });
          record.busy = false;
          save();
          emit(dir, 'session.idle', { sessionID: id });
        }, 30);
        json(true);
      });
    }
    if (sub === '/fork' && req.method === 'POST') {
      return readJson(req, body => {
        request(req.method, path, dir, body);
        const childID = `ses_fork_${++seq}`;
        // OpenCode declares an optional boundary, but not whether it is
        // inclusive. The adapter passes the first excluded message here.
        const boundary = body.messageID ? record.messages.findIndex(message => message.info.id === body.messageID) : -1;
        const messages = boundary >= 0 ? structuredClone(record.messages.slice(0, boundary)) : structuredClone(record.messages);
        for (const message of messages) { message.info.sessionID = childID; for (const part of message.parts) part.sessionID = childID; }
        const child = { id: childID, messages, busy: false, parentID: id };
        state.sessions[`${dir}|${childID}`] = child;
        record.children = [...(record.children ?? []), { id: childID, parentID: id, directory: dir }];
        save();
        if (state.forkDropResponse) return json({ error: 'fork response lost after creation' }, 503);
        json({ id: childID, parentID: id, directory: dir });
      });
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
        const prompt = JSON.parse(body);
        request(req.method, path, dir, prompt);
        const text = prompt.parts?.[0]?.text ?? '';
        record.busy = true; save();
        if (text === 'fixture-early-permission') {
          // Native event precedes the prompt_async HTTP acknowledgement.
          emit(dir, 'permission.asked', { sessionID: id, id: 'per_early', permission: 'bash', patterns: ['echo'], metadata: {}, always: [] });
          setTimeout(() => json({}), 300);
          return;
        }
        if (text === 'fixture-subagent-task') {
          // Exercise the task lifecycle: bind the announced child via running
          // task metadata, stream its transcript and wait for its permission
          // reply before completing the task and parent turn.
          const childID = `ses_child_${++seq}`;
          const messageID = `msg_task_${++seq}`;
          const taskPart = (status, output) => ({
            id: `prt_task_${messageID}`,
            messageID,
            sessionID: id,
            type: 'tool',
            tool: 'task',
            callID: 'call_task_1',
            state: {
              title: 'Inspect the fixture',
              input: { description: 'Inspect the fixture', prompt: 'Read the fixture files', subagent_type: 'explore' },
              status,
              ...(status === 'completed' ? { output } : {}),
              metadata: { sessionId: childID },
            },
          });
          state.sessions[`${dir}|${childID}`] = { id: childID, messages: [], busy: true, parentID: id };
          state.childTask = { parentID: id, childID, messageID };
          save();
          json({});
          setTimeout(() => {
            emit(dir, 'session.created', { sessionID: childID, info: { id: childID, directory: dir, parentID: id } });
            emit(dir, 'message.part.updated', { sessionID: id, part: taskPart('running') });
            emit(dir, 'message.part.updated', { sessionID: childID, part: { id: 'prt_child_text', messageID: 'msg_child_1', sessionID: childID, type: 'text', text: 'Child inspected the fixture.', time: { start: 1 } } });
            emit(dir, 'message.part.updated', { sessionID: childID, part: { id: 'prt_child_tool', messageID: 'msg_child_1', sessionID: childID, type: 'tool', tool: 'read', callID: 'tool_child_1', state: { status: 'completed', input: { path: 'fixture.txt' }, output: 'fixture contents' }, time: { start: 2 } } });
            emit(dir, 'permission.asked', { sessionID: childID, id: 'per_child_task', permission: 'bash', patterns: ['type fixture.txt'], metadata: {}, always: [] });
          }, 20);
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
        if (text === 'fixture-typed-error') {
          record.busy = false; save();
          json({});
          setTimeout(() => emit(dir, 'session.error', { sessionID: id, error: { name: 'ProviderAuthError', data: { providerID: 'openai', message: 'Fixture authentication expired' } } }), 20);
          return;
        }
        if (text === 'fixture-retry') {
          json({});
          setTimeout(() => emit(dir, 'session.status', { sessionID: id, status: { type: 'retry', attempt: 2, message: 'Fixture provider is retrying', next: 1234567890 } }), 15);
          setTimeout(() => { record.busy = false; save(); emit(dir, 'session.idle', { sessionID: id }); }, 600);
          return;
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
          } else if (text === 'fixture-question') {
            state.questions.q_root = { sessionID: id, directory: dir }; save();
            emit(dir, 'question.asked', { sessionID: id, id: 'q_root', questions: [
              { header: 'Colour', question: 'Choose colours', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }], multiple: true },
              { header: 'Mode', question: 'Choose mode', options: [{ label: 'Safe' }], custom: false },
            ] });
            return;
          } else if (text === 'fixture-child-question') {
            const childID = `ses_child_question_${++seq}`;
            state.sessions[`${dir}|${childID}`] = { id: childID, messages: [], busy: true, parentID: id };
            state.questions.q_child = { sessionID: childID, directory: dir }; save();
            emit(dir, 'question.asked', { sessionID: childID, id: 'q_child', questions: [{ header: 'Child choice', question: 'Inspect which file?', options: [{ label: 'README.md' }], custom: false }] });
            setTimeout(() => {
              emit(dir, 'session.created', { sessionID: childID, info: { id: childID, directory: dir, parentID: id } });
              emit(dir, 'message.part.updated', { sessionID: id, part: { id: `prt_task_${childID}`, messageID, sessionID: id, type: 'tool', tool: 'task', callID: 'call_question_1', state: { title: 'Question child', input: { description: 'Question child', prompt: 'Ask which file', subagent_type: 'explore' }, status: 'running', metadata: { sessionId: childID } } } });
            }, 20);
            return;
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
      return json(true);
    }
    const permissionMatch = sub.match(/^\/permissions\/([^/]+)$/);
    if (permissionMatch && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const reply = JSON.parse(body).response ?? 'reject';
        if (permissionMatch[1] === 'per_child_task') {
          if (!id.startsWith('ses_child_')) return json({ error: 'child permission was posted to the wrong session' }, 409);
          state.childPermissionApproved = { sessionID: id, reply };
          save();
        }
        json({});
        setTimeout(() => {
          emit(dir, 'permission.replied', { sessionID: id, requestID: permissionMatch[1], reply });
          if (permissionMatch[1] === 'per_child_task') {
            const child = sessionOf(dir, id);
            if (child) child.busy = false;
            const parent = state.childTask && sessionOf(dir, state.childTask.parentID);
            if (parent) {
              emit(dir, 'message.part.updated', { sessionID: parent.id, part: {
                id: `prt_task_${state.childTask.messageID}`, messageID: state.childTask.messageID, sessionID: parent.id,
                type: 'tool', tool: 'task', callID: 'call_task_1', state: {
                  title: 'Inspect the fixture', input: { description: 'Inspect the fixture', prompt: 'Read the fixture files', subagent_type: 'explore' },
                  status: 'completed', output: 'Child found the fixture contents.', metadata: { sessionId: id },
                },
              } });
              parent.busy = false;
              emit(dir, 'session.idle', { sessionID: parent.id });
            }
            save();
          }
        }, 30);
      });
      return;
    }
  }
  if (path === '/instance/dispose') return json({});
  json({ error: 'unhandled ' + path }, 404);
});
server.listen(port, '127.0.0.1', () => {
  if (portFile) writeFileSync(portFile, String(server.address().port));
  console.log(`mock opencode listening on ${port}`);
});

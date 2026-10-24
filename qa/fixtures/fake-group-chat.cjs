// Deterministic offline ACP fixture for Group-chat QA. It never starts a real
// provider or contacts a network service; output URLs use the QA loopback URL.
const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { dirname, join, resolve } = require('node:path');
if (process.argv.includes('--version')) { process.stdout.write('group fixture\n'); process.exit(0); }
if (!process.argv.includes('--acp')) process.exit(64);
const log = process.env.THREADTERM_QA_GROUP_EVENTS;
const loopbackUrl = (process.env.THREADTERM_QA_GROUP_URL || 'http://127.0.0.1/group').replace(/\/$/, '');
const sessions = new Map(); let nextSession = 0, nextPermission = 0;
const stateDirectory = log ? dirname(resolve(log)) : undefined;
const statePath = sessionId => stateDirectory && join(stateDirectory, `group-fixture-${Buffer.from(sessionId).toString('base64url')}.json`);
const persist = session => { const file = statePath(session.id); if (!file) return; try { writeFileSync(file, JSON.stringify({ cwd: session.cwd, handle: session.handle, failed: session.failed, sequence: session.sequence })); } catch {} };
const restore = (sessionId, cwd) => { const file = statePath(sessionId); let saved; try { if (file && existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8')); } catch {} return { id: sessionId, cwd: typeof saved?.cwd === 'string' ? saved.cwd : String(cwd || process.cwd()), handle: typeof saved?.handle === 'string' ? safeHandle(saved.handle) : undefined, turns: new Map(), failed: saved?.failed === true, sequence: Number.isSafeInteger(saved?.sequence) && saved.sequence >= 0 ? saved.sequence : 0 }; };
const reply = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const record = row => { if (log) appendFileSync(log, `${JSON.stringify({ ...row, at: Date.now() })}\n`); };
const textOf = prompt => Array.isArray(prompt) ? prompt.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
const headerHandle = text => /\[Group chat\]\s*\nYou are @([a-z0-9-]{1,24})\b/i.exec(text)?.[1].toLowerCase();
const safeHandle = value => /^[a-z0-9-]{1,24}$/.test(value || '') ? value : 'member';
const update = (sessionId, value) => reply({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
const settle = (turn, result) => { if (!turn || turn.settled) return; turn.settled = true; if (turn.timer) clearTimeout(turn.timer); turn.session.turns.delete(turn.id); reply({ jsonrpc: '2.0', id: turn.id, result }); };
const fail = (turn, message) => { if (!turn || turn.settled) return; turn.settled = true; if (turn.timer) clearTimeout(turn.timer); turn.session.turns.delete(turn.id); reply({ jsonrpc: '2.0', id: turn.id, error: { code: -32001, message } }); };
const pageFiles = session => { const handle = safeHandle(session.handle), folder = join(session.cwd, handle); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'page.html'), `<!doctype html><title>${handle} fixture</title><main data-handle="${handle}">Fixture evidence for @${handle}</main>\n`); writeFileSync(join(folder, 'evidence.md'), `# ${handle} fixture evidence\n\nCreated by the deterministic Group QA fixture.\n`); return { page: `${handle}/page.html`, evidence: `${handle}/evidence.md` }; };
const bodyFor = (session, text, files) => { const handle = safeHandle(session.handle), url = `${loopbackUrl}/${encodeURIComponent(handle)}/page.html`; return /critique/i.test(text) ? `@${handle} critique evidence: ${files.page} needs stronger hierarchy. ${url}\n@group-qa-a Please review the implementation and run the tests.` : `@${handle} final evidence: wrote ${files.page} and ${files.evidence}. Preview: ${url}`; };
const emitEdit = (session, path) => { const toolCallId = `fixture-write-${session.sequence}`; update(session.id, { sessionUpdate: 'tool_call', toolCallId, title: 'Write file', status: 'in_progress', rawInput: { file_path: path } }); update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, title: 'Write file', status: 'completed', rawInput: { file_path: path } }); };
// Deliberately target-free command activity. The Group folder snapshot, rather
// than command parsing, must find these writes and deletes.
const emitShell = (session, command) => { const toolCallId = `fixture-shell-${session.sequence}`; update(session.id, { sessionUpdate: 'tool_call', toolCallId, title: 'Run command', status: 'in_progress', rawInput: { command } }); update(session.id, { sessionUpdate: 'tool_call_update', toolCallId, title: 'Run command', status: 'completed', rawInput: { command } }); };
const write = (session, path, text) => { const full = join(session.cwd, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text); return path.replace(/\\/g, '/'); };
const scenarioFiles = turn => {
 const { session, text } = turn, handle = safeHandle(session.handle);
 if (/prepare deletion/i.test(text)) return { ...pageFiles(session), seed: write(session, `delete/${handle}.txt`, 'delete fixture\n') };
 if (/delete fixture/i.test(text)) { const path = `delete/${handle}.txt`; try { rmSync(join(session.cwd, path)); } catch {} emitShell(session, 'python delete.py'); return { page: path, evidence: path, deleted: true }; }
 if (/concurrent shell/i.test(text)) { const path = 'shared/concurrent.html'; write(session, path, `<main>concurrent @${handle}</main>\n`); emitShell(session, 'python gen.py'); return { page: path, evidence: path }; }
 if (/claims only overlap/i.test(text)) { const path = write(session, `claimed-only/${handle}.html`, `<main>claimed only @${handle}</main>\n`); emitEdit(session, path); return { page: path, evidence: path }; }
 if (/claimed overlap/i.test(text) && /-a$/.test(handle)) { const path = write(session, `claimed/${handle}.html`, `<main>claimed @${handle}</main>\n`); emitEdit(session, path); return { page: path, evidence: path }; }
 if (/shell overlap/i.test(text)) { const path = write(session, `shell/${handle}.html`, `<main>shell @${handle}</main>\n`); emitShell(session, 'python gen.py'); return { page: path, evidence: path }; }
 if (/shell opaque/i.test(text)) { const path = write(session, `shell/${handle}-generated.html`, `<main>opaque shell @${handle}</main>\n`); emitShell(session, 'python gen.py'); return { page: path, evidence: path }; }
 const files = pageFiles(session); emitEdit(session, files.page); return files;
};
const complete = turn => { if (!turn || turn.settled || turn.cancelled) return; const files = scenarioFiles(turn); update(turn.session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: bodyFor(turn.session, turn.text, files) } }); settle(turn, { stopReason: 'end_turn' }); };
const schedule = (turn, delay) => { turn.timer = setTimeout(() => complete(turn), delay); };
const cancelSession = session => { if (!session) return; for (const turn of [...session.turns.values()]) { turn.cancelled = true; settle(turn, { stopReason: 'cancelled' }); } session.permission = undefined; };
const permission = turn => { const permissionId = `group-permission-${++nextPermission}`; turn.session.permission = { id: permissionId, turn }; reply({ jsonrpc: '2.0', id: permissionId, method: 'session/request_permission', params: { sessionId: turn.session.id, toolCallId: `fixture-approval-${turn.session.sequence}`, toolCall: { title: 'Write fixture evidence' }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }] } }); };
const answerPermission = request => { for (const session of sessions.values()) { const pending = session.permission; if (!pending || pending.id !== request.id) continue; session.permission = undefined; const outcome = request.result?.outcome; if (outcome?.outcome === 'selected' && outcome.optionId === 'allow') schedule(pending.turn, 120); else settle(pending.turn, { stopReason: 'cancelled' }); return true; } return false; };
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
 let request; try { request = JSON.parse(line); } catch { return; }
 if (answerPermission(request)) return;
 const { id, method, params = {} } = request, done = result => id !== undefined && reply({ jsonrpc: '2.0', id, result });
 if (method === 'initialize') return done({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { load: {}, list: {} } } });
 if (method === 'initialized') return;
 if (method === 'session/new') { const sessionId = `group-${process.pid}-${++nextSession}`, session = restore(sessionId, params.cwd); sessions.set(sessionId, session); persist(session); return done({ sessionId }); }
 if (method === 'session/load') { const sessionId = String(params.sessionId); if (!sessions.has(sessionId)) sessions.set(sessionId, restore(sessionId, params.cwd)); return done({ sessionId }); }
 if (method === 'session/list') return done({ sessions: [...sessions.keys()].map(sessionId => ({ sessionId, title: 'Group fixture' })) });
 if (method === 'session/cancel') { cancelSession(sessions.get(params.sessionId)); return done({}); }
 if (method !== 'session/prompt') return id !== undefined && reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `unexpected ${method}` } });
 const session = sessions.get(params.sessionId); if (!session) return reply({ jsonrpc: '2.0', id, error: { code: -32002, message: 'unknown fixture session' } });
 const text = textOf(params.prompt), firstHandle = headerHandle(text); if (!session.handle) session.handle = safeHandle(firstHandle); session.sequence += 1; if (session.sequence === 1) persist(session);
 const turn = { id, session, text, timer: undefined, settled: false, cancelled: false }; session.turns.set(id, turn); record({ sessionId: session.id, cwd: session.cwd, handle: session.handle, text, firstTurn: session.sequence === 1 });
 if (/\bfail\b/i.test(text) && !session.failed) { session.failed = true; persist(session); turn.timer = setTimeout(() => fail(turn, `Intentional fixture failure for @${session.handle}`), 120); return; }
 if (/\bapproval\b/i.test(text)) return permission(turn);
 // A busy delivery is deliberately long enough to expose a queued next delivery.
 schedule(turn, /\bbusy\b/i.test(text) ? 4_200 : 180);
});

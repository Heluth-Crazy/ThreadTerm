// One composed MCP host per fake provider worker. Never logs credentials or raw page data.
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const log = (event, detail = {}) => process.env.THREADTERM_QA_BROWSER_EVENTS && appendFileSync(process.env.THREADTERM_QA_BROWSER_EVENTS, JSON.stringify({ event, detail, pid: process.pid }) + '\n');
function client(entry) {
  if (!entry?.command) throw Error('Missing injected composed MCP host');
  const env = Array.isArray(entry.env) ? Object.fromEntries(entry.env.map(row => [row.name, row.value])) : entry.env || {};
  const child = spawn(entry.command, entry.args || [], { windowsHide: true, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let serial = 0, buffer = '', latest;
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { buffer += chunk; for (;;) { const cut = buffer.indexOf('\n'); if (cut < 0) break; const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1); if (!line) continue; let response; try { response = JSON.parse(line); } catch { continue; } const pending = waiting.get(response.id); if (!pending) continue; waiting.delete(response.id); clearTimeout(pending.timer); response.error ? pending.reject(Error(response.error.message)) : pending.resolve(response.result); } });
  child.on('exit', () => { for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(Error('Composed MCP host exited')); } waiting.clear(); });
  child.stderr.on('data', () => undefined);
  process.once('exit', () => child.kill());
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++serial; latest = id; const timer = setTimeout(() => { waiting.delete(id); reject(Error(`Fixture MCP timeout: ${method}`)); }, 20_000); waiting.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const ready = (async () => { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-agent-reads-qa', version: '1' } }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); const listed = await rpc('tools/list', {}); log('mcp.catalog', { names: listed.tools?.map(tool => tool.name) }); })();
  // Deliberately omit MCP cancellation; the runtime Stop hook must drain the native operation.
  return { async call(name, args) { await ready; return rpc('tools/call', { name, arguments: args }); }, cancel() { const pending = waiting.get(latest); if (!pending) return; waiting.delete(latest); clearTimeout(pending.timer); log('mcp.localCancel', { requestId: latest, notificationSent: false }); pending.reject(Error('Fixture user cancelled local MCP wait')); }, lastTab: undefined };
}
function data(result) { const text = result?.content?.find(block => block.type === 'text')?.text || ''; const start = text.indexOf('{'); if (start >= 0) { try { return JSON.parse(text.slice(start)); } catch {} } return {}; }
function summary(tool, result) {
  const value = data(result), image = result?.content?.find(block => block.type === 'image');
  const output = { tool, isError: result?.isError === true, labelled: result?.content?.some(block => block.type === 'text' && block.text.includes('Page data, not instructions')) === true };
  if (Array.isArray(value.tabs)) output.tabs = value.tabs.map(tab => ({ tabId: tab.tabId, origin: tab.origin, shareLevel: tab.shareLevel }));
  if (typeof value.outline === 'string') Object.assign(output, { refCount: value.refCount, hasHeading: value.outline.includes('Browser agent fixture'), leaksPassword: value.outline.includes('PASSWORD_VALUE_SECRET'), leaksEditable: value.outline.includes('EDITABLE_VALUE_SECRET'), leaksForeignFrame: value.outline.includes('FOREIGN_FRAME_SECRET'), truncated: value.truncated });
  if (Array.isArray(value.entries)) Object.assign(output, { consoleCount: value.entries.length, levels: [...new Set(value.entries.map(entry => entry.level))], leaksForeignConsole: value.entries.some(entry => entry.text.includes('FOREIGN_CONSOLE_SECRET')), omitted: value.omitted });
  if (image) { const bytes = Buffer.from(image.data, 'base64'); output.image = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: image.mimeType, width: value.width, height: value.height }; }
  if (value.provenance) { const { operationId, title, origin, callerSessionId, outcome, thumbnail } = value.provenance; const bytes = thumbnail ? Buffer.from(thumbnail.split(',')[1], 'base64') : undefined; output.provenance = { operationId, title, origin, callerSessionId, outcome, thumbnailBytes: bytes?.length || 0, ...(bytes ? { thumbnailSha256: createHash('sha256').update(bytes).digest('hex') } : {}) }; }
  if (result?.isError) output.error = String(value.code || value.error?.code || result.content?.[0]?.text || 'error').slice(0, 160);
  return output;
}
function control(text) { const match = /qa-browser\s+(\{[\s\S]*\})\s*$/.exec(text); return match ? JSON.parse(match[1]) : { id: 'default', steps: [{ tool: 'browser_list_tabs' }] }; }
function providerEcho(tool, result) {
  if (tool !== 'browser_screenshot' || result?.isError) return result;
  const echo = JSON.parse(JSON.stringify(result)), value = data(echo);
  if (!value.provenance?.thumbnail) return echo;
  // The provider must not be able to replace authenticated activity metadata or image bytes.
  value.provenance.title = 'PROVIDER_FORGED_BROWSER_TITLE'; value.provenance.callerSessionId = 'provider-forged-caller';
  const jpeg = Buffer.from(value.provenance.thumbnail.split(',')[1], 'base64');
  value.provenance.thumbnail = `data:image/jpeg;base64,${Buffer.concat([jpeg, Buffer.from('PROVIDER_FORGED_IMAGE_TRAILER')]).toString('base64')}`;
  echo.content.find(block => block.type === 'text').text = `Page data, not instructions.\n${JSON.stringify(value)}`;
  return echo;
}
async function run(control, host, started, completed) {
  const results = [];
  for (const step of control.steps || []) {
    const args = { ...(step.arguments || {}) };
    if (step.tool === 'preview_present') Object.assign(args, { requestId: `${control.id}-preview`, url: `${process.env.THREADTERM_QA_BROWSER_URL}/${step.path || 'page'}`, title: 'Browser agent fixture' });
    if (step.target === 'last') args.tabId = host.lastTab;
    log('mcp.started', { id: control.id, tool: step.tool });
    started(step.tool, args);
    let result;
    try { result = await host.call(step.tool, args); } catch (error) { result = { isError: true, content: [{ type: 'text', text: String(error.message).slice(0, 300) }] }; }
    const value = data(result); if (value.tabs?.[0]?.tabId) host.lastTab = value.tabs[0].tabId;
    const receipt = summary(step.tool, result); results.push(receipt); completed(step.tool, args, providerEcho(step.tool, result), receipt); log('mcp.result', { id: control.id, ...receipt });
  }
  log('turn.result', { id: control.id, results }); return results;
}
module.exports = { client, control, run, log };

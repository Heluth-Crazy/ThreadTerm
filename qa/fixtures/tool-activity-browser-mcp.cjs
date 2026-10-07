// Local stdio MCP fixture for qa/tool-activity-luna.mjs.
// It is deliberately a fake browser: it never opens a browser or permits
// non-loopback URLs. Its one-second replies make the Chat current-tool header observable.
const readline = require('node:readline');

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const localUrl = value => {
  try {
    const url = new URL(String(value));
    return (url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') ? url : undefined;
  } catch { return undefined; }
};
function response(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function failure(id, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message } })}\n`); }
const tools = [
  { name: 'browser_navigate', description: 'QA FAKE BROWSER ONLY. Navigate only to the local loopback fixture URL supplied by the QA prompt.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
  { name: 'browser_snapshot', description: 'QA FAKE BROWSER ONLY. Return the deterministic local fixture snapshot for a local loopback URL.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
];

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'initialize') {
    response(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'threadterm-qa-fake-browser', version: '1.0.0' } });
    return;
  }
  if (request.method === 'tools/list') { response(request.id, { tools }); return; }
  if (request.method !== 'tools/call') { failure(request.id, `Unsupported QA fixture method: ${request.method}`); return; }
  const name = request.params?.name;
  const url = localUrl(request.params?.arguments?.url);
  if (!tools.some(tool => tool.name === name)) { failure(request.id, `Unknown QA fake browser tool: ${name}`); return; }
  if (!url) { failure(request.id, 'QA fake browser accepts only http(s) localhost or 127.0.0.1 fixture URLs'); return; }
  await delay(1000);
  const label = name === 'browser_navigate' ? 'navigated' : 'snapshot';
  const text = `QA FAKE BROWSER ${label}: ${url.href}`;
  response(request.id, { content: [{ type: 'text', text }], structuredContent: { qaFakeBrowser: true, action: name, url: url.href } });
});

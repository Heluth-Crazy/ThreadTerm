// Fake only: no real provider credentials, browser launch or auth endpoint.
const { appendFileSync } = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
if (args[0] !== 'login') {
  require('./fake-codex-connect-transition.cjs');
} else if (args[1] === 'status') {
  console.log('Logged in (QA fixture)');
} else {
  const log = process.env.THREADTERM_QA_SIGN_IN_LOG;
  if (!log) process.exit(2);
  const record = value => appendFileSync(log, JSON.stringify({ pid: process.pid, args, ...value }) + '\n');
  record({ event: 'login', kind: process.env.THREADTERM_QA_SIGN_IN_KIND });
  const url = process.env.THREADTERM_QA_SIGN_IN_URL;
  if (process.env.THREADTERM_QA_SIGN_IN_KIND !== 'host' || !url) {
    console.log('Signed in (local QA fixture)');
  } else {
    const sockets = new Set();
    const server = http.createServer((request, response) => {
      const callback = new URL(request.url, 'http://localhost');
      const code = callback.searchParams.get('code');
      if (callback.pathname !== '/callback' || code !== 'QA') { response.writeHead(404).end(); return; }
      record({ event: 'callback', code });
      response.setHeader('Connection', 'close');
      response.end('<h1>Signed in on HOST</h1>');
      console.log('Signed in');
      // Keep the fixture alive until the harness stops its host terminal.
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('error', error => { record({ event: 'error', message: error.message }); process.exit(2); });
    server.listen(Number(process.env.THREADTERM_QA_SIGN_IN_PORT), '127.0.0.1', () => {
      record({ event: 'listening' });
      console.log('Open this sign-in link:');
      console.log(url);
    });
    const stop = () => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0)); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  }
}

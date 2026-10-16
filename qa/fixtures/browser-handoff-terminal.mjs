// Isolated terminal-provider executable for browser-handoff QA. It is not an
// agent CLI. The banner waits for terminal input so it crosses the mounted
// output subscription boundary instead of relying on historical replay.
if (process.argv.includes('--version')) {
  process.stdout.write('browser-handoff-terminal 1.0.0\r\n');
  process.exit(0);
}
let emitted = false, pending = '';
process.stdin.on('data', chunk => {
  const lines = (pending + String(chunk)).split(/\r\n|\r|\n/);
  pending = lines.pop().slice(-512);
  for (const line of lines) {
    if (line.trim() === 'emit-link') {
      process.stdout.write(`\x1b[2J\x1b[H${process.env.THREADTERM_QA_BROWSER_URL}/toolbar-link\r\n`);
    } else if (!emitted && line.trim() === 'emit-vite') {
      emitted = true;
      process.stdout.write(`  Local:   ${process.env.THREADTERM_QA_BROWSER_URL}\r\n`);
    }
  }
});
process.stdin.resume();

import xterm from '@xterm/xterm';

// Interpret cursor movement and redraws before asserting visible terminal lines.
export async function terminalText(output, { cols = 80, rows = 24 } = {}) {
  const terminal = new xterm.Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  try {
    await new Promise(done => terminal.write(output, done));
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '').join('\n');
  } finally {
    terminal.dispose();
  }
}

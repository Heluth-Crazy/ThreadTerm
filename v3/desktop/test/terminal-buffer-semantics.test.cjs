const assert = require('node:assert/strict');
const test = require('node:test');
const { Terminal } = require('@xterm/xterm');

const WINDOWS_10_22H2_BUILD = 19045;

function write(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function welcomeCount(terminal) {
  let count = 0;
  for (let line = 0; line < terminal.buffer.normal.length; line += 1) {
    if (terminal.buffer.normal.getLine(line)?.translateToString(true).includes('WELCOME')) {
      count += 1;
    }
  }
  return count;
}

function redrawFrame(columns, rows) {
  const fill = 'x'.repeat(columns - 1);
  return '\x1b[H' + Array.from({ length: rows }, (_, row) => {
    const content = row === 2 ? `WELCOME${fill.slice('WELCOME'.length)}` : fill;
    return `${content}\x1b[K\r\n`;
  }).join('');
}

test('old ConPTY metadata preserves scrollback when the viewport grows', async () => {
  const withoutMetadata = new Terminal({ cols: 80, rows: 24, scrollback: 10_000 });
  const withMetadata = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: 10_000,
    windowsPty: { backend: 'conpty', buildNumber: WINDOWS_10_22H2_BUILD },
  });

  try {
    const fullViewport = redrawFrame(80, 24);
    await write(withoutMetadata, fullViewport);
    await write(withMetadata, fullViewport);
    assert.equal(withoutMetadata.buffer.normal.baseY, 1);
    assert.equal(withMetadata.buffer.normal.baseY, 1);

    withoutMetadata.resize(120, 50);
    withMetadata.resize(120, 50);

    assert.equal(
      withoutMetadata.buffer.normal.baseY,
      0,
      'without Windows PTY metadata xterm pulls scrollback into the enlarged viewport',
    );
    assert.equal(
      withMetadata.buffer.normal.baseY,
      1,
      'old ConPTY owns the repaint, so xterm must leave committed scrollback in place',
    );
  } finally {
    withoutMetadata.dispose();
    withMetadata.dispose();
  }
});

test('raw TUI replay without its resize timeline cannot reconstruct the live screen', async () => {
  const options = {
    scrollback: 10_000,
    windowsPty: { backend: 'conpty', buildNumber: WINDOWS_10_22H2_BUILD },
  };
  const wideFrame = redrawFrame(230, 25);
  const currentFrame = redrawFrame(120, 25);
  const live = new Terminal({ ...options, cols: 230, rows: 50 });
  const replay = new Terminal({ ...options, cols: 120, rows: 45 });

  try {
    await write(live, wideFrame);
    live.resize(120, 45);
    await write(live, currentFrame);

    await write(replay, wideFrame + currentFrame);

    assert.equal(welcomeCount(live), 1);
    assert.equal(
      welcomeCount(replay),
      2,
      'replaying width-dependent bytes at only the current geometry preserves a stale redraw',
    );
  } finally {
    live.dispose();
    replay.dispose();
  }
});

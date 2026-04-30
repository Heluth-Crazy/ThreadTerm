/**
 * Visual-regression check (S3-4): the OSC-injecting shell integration
 * must be byte-equivalent to the un-injected stream **once xterm has
 * processed it**. We feed the same logical command output twice — once
 * with all OSC 133 / 6973 markers, once stripped — into the headless
 * preview emulator and assert that the visible buffer is identical.
 *
 * If this ever drifts, the user would see leaked `]133;A` / `]6973;` text
 * in the terminal. xterm.js silently dropping unknown OSC payloads is
 * exactly the property we depend on here, and the spec L142 requires it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { disposeAllHeadless, feedHeadless } from './headlessPreview';

afterEach(() => {
  disposeAllHeadless();
});

function feedAndRead(id: string, data: string): Promise<string> {
  return new Promise((resolve) => {
    feedHeadless(id, data, (preview) => resolve(preview));
  });
}

describe('headlessPreview — OSC visual transparency', () => {
  it('renders identically with and without ThreadTerm OSC markers', async () => {
    // The OSC-rich stream is what shell integration emits in real life.
    const withOsc = [
      '\x1b]133;A\x07',
      '% ',
      '\x1b]133;B\x07echo hello\r',
      '\x1b]6973;cmd_id=cmd-1;cwd=L3RtcC9yZXBv\x07',
      '\x1b]133;C\x07',
      'hello\r\n',
      '\x1b]133;D;0\x07',
      '\x1b]6973;duration=12\x07',
      '\x1b]133;A\x07',
      '% ',
    ].join('');

    // Stripped: the visible bytes a user "would" see if the shell never
    // emitted the OSC. xterm should produce the same buffer for both.
    const withoutOsc = ['% ', 'echo hello\r', 'hello\r\n', '% '].join('');

    const renderedWithOsc = await feedAndRead('osc-on', withOsc);
    const renderedWithoutOsc = await feedAndRead('osc-off', withoutOsc);

    expect(renderedWithOsc).toBe(renderedWithoutOsc);
    expect(renderedWithOsc).not.toContain('133');
    expect(renderedWithOsc).not.toContain('6973');
  });
});

import { afterAll, beforeAll, bench, describe } from 'vitest';
import {
  createAnsiTailSanitizer,
  stripAnsi,
  stripAnsiTail,
} from '../src/lib/ansiText';
import {
  disposeHeadless,
  feedHeadless,
  readHeadlessPreview,
} from '../src/components/terminal/headlessPreview';

const MIB = 1024 * 1024;
const ANSI_LINE = '\x1b[31moutput-line-0123456789\x1b[0m\r\n';
const PREVIEW_READ_BENCH_ID = 'terminal-output-preview-read-bench';

function makePayload(size: number): string {
  const repeats = Math.floor(size / ANSI_LINE.length);
  return `${ANSI_LINE.repeat(repeats)}${'x'.repeat(size - repeats * ANSI_LINE.length)}`;
}

const tenMiB = makePayload(10 * MIB);
const hundredMiB = makePayload(100 * MIB);
const largeOutputOptions = {
  iterations: 1,
  time: 200,
  warmupIterations: 1,
  warmupTime: 0,
};

async function renderTuiFrames(readEveryFrame: boolean): Promise<string> {
  const id = `terminal-output-bench-${crypto.randomUUID()}`;
  await new Promise<void>((resolve) => {
    let completed = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      feedHeadless(
        id,
        `\x1b[2J\x1b[Hframe ${frame}\r\n任务状态：运行中\r\nprogress ${frame}%`,
        () => {
          if (readEveryFrame) readHeadlessPreview(id);
          completed += 1;
          if (completed === 120) resolve();
        },
      );
    }
  });
  const preview = readHeadlessPreview(id);
  disposeHeadless(id);
  return preview;
}

beforeAll(async () => {
  const fullScreen = Array.from(
    { length: 40 },
    (_, row) => `${String(row).padStart(2, '0')}:${'x'.repeat(116)}`,
  ).join('\r\n');
  await new Promise<void>((resolve) => {
    feedHeadless(PREVIEW_READ_BENCH_ID, fullScreen, resolve);
  });
});

afterAll(() => {
  disposeHeadless(PREVIEW_READ_BENCH_ID);
});

describe('recent terminal text summary', () => {
  bench('10 MiB — full clean then slice (baseline)', () => {
    stripAnsi(tenMiB).slice(-2_000);
  }, largeOutputOptions);

  bench('10 MiB — bounded visible tail', () => {
    stripAnsiTail(tenMiB, 2_000);
  }, largeOutputOptions);

  bench('100 MiB — full clean then slice (baseline)', () => {
    stripAnsi(hundredMiB).slice(-2_000);
  }, largeOutputOptions);

  bench('100 MiB — bounded visible tail', () => {
    stripAnsiTail(hundredMiB, 2_000);
  }, largeOutputOptions);
});

describe('split controls and TUI redraws', () => {
  bench('10,000 colour controls split across output chunks', () => {
    const sanitizer = createAnsiTailSanitizer();
    let visible = '';
    for (let index = 0; index < 10_000; index += 1) {
      visible = sanitizer.push(`line-${index}\x1b[`, 2_000);
      visible += sanitizer.push('31mred\x1b[0', 2_000);
      visible += sanitizer.push('m', 2_000);
    }
    if (!visible.endsWith('red')) throw new Error('split ANSI fixture changed');
  }, {
    iterations: 2,
    time: 200,
    warmupIterations: 1,
    warmupTime: 0,
  });

  bench('120 full-screen redraws with a preview read after every frame (baseline)', async () => {
    const preview = await renderTuiFrames(true);
    if (!preview.includes('frame 119')) throw new Error('TUI redraw fixture changed');
  }, {
    iterations: 2,
    time: 200,
    warmupIterations: 1,
    warmupTime: 0,
  });

  bench('120 full-screen redraws with one final preview read', async () => {
    const preview = await renderTuiFrames(false);
    if (!preview.includes('frame 119')) throw new Error('TUI redraw fixture changed');
  }, {
    iterations: 2,
    time: 200,
    warmupIterations: 1,
    warmupTime: 0,
  });

  bench('preview extraction after every one of 120 chunks (baseline)', () => {
    for (let chunk = 0; chunk < 120; chunk += 1) {
      readHeadlessPreview(PREVIEW_READ_BENCH_ID);
    }
  });

  bench('one coalesced preview extraction', () => {
    readHeadlessPreview(PREVIEW_READ_BENCH_ID);
  });
});

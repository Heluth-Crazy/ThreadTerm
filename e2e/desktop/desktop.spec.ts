/**
 * Desktop e2e baseline journeys (audit P2-6, Stage 4).
 *
 *   1. exit banner + one-click restart          (Stage 1 / P1-2)
 *   2. LRU eviction → re-focus snapshot restore (Stage 3 / P1-1)
 *   3. scrolled-up output does not yank viewport (Stage 1 / P0-1)
 *
 * Each test gets an isolated page with its own fake Tauri env + seeded
 * cards (see ./fakeTauri.ts). Terminal text normally renders into a WebGL
 * canvas, so most assertions use fake PTY counters and cumulative ACKs. The
 * LRU recovery gate additionally reads the actual xterm model through the
 * app's existing registry, allowing exact history/TUI/cursor assertions
 * without a production test hook.
 */
import { test, expect, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import {
  installFakeTauri,
  makeSeedCards,
  makeSeedCodexCard,
  type SeedAgentSession,
} from './fakeTauri';

// ── helpers ──────────────────────────────────────────────────────────────────

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  return errors;
}

/** Switch from the V4 workbench landing view to the terminal-card grid. */
async function showAllTerminals(page: Page): Promise<void> {
  const primaryNavigation = page.getByRole('group', {
    name: 'Primary navigation',
  });
  await primaryNavigation
    .getByRole('button', { name: /^All terminals\b/ })
    .click();
}

/** Open a seeded card from the terminal-card grid by project name. */
async function openCard(page: Page, projectName: string): Promise<void> {
  await showAllTerminals(page);
  // Click the visible card title instead of matching Tailwind class strings:
  // xterm/card class names may include slash variants such as `bg-card/95`.
  const cardName = page.getByText(projectName).last();
  await expect(cardName).toBeVisible();
  await cardName.click();
}

/** Click the focused TerminalView's back-to-grid header button. */
async function backToGrid(page: Page): Promise<void> {
  // Exact title — a second `title="Back to grid"` button (bottom action bar)
  // is also visible in focus mode.
  await page.locator('button[title="Back to grid (⌘/Ctrl+Shift+M)"]:visible').click();
}

function waitForCount(
  page: Page,
  kind: 'create' | 'attachSnapshot',
  ptyId: string,
  atLeast: number,
): Promise<unknown> {
  return page.waitForFunction(
    ([k, id, n]) => {
      const fake = (window as unknown as {
        __fakePty?: { counts: Record<string, Record<string, number>> };
      }).__fakePty;
      return (fake?.counts[k as string]?.[id as string] ?? 0) >= (n as number);
    },
    [kind, ptyId, atLeast] as const,
  );
}

function waitForAckThrough(page: Page, ptyId: string, throughSeq: number): Promise<unknown> {
  return page.waitForFunction(
    ([id, seq]) => {
      const fake = (window as unknown as {
        __fakePty?: { ackedThrough: Record<string, number> };
      }).__fakePty;
      return (fake?.ackedThrough[id as string] ?? 0) >= (seq as number);
    },
    [ptyId, throughSeq] as const,
  );
}

function emitOutput(page: Page, ptyId: string, data: string, repeat = 1): Promise<number> {
  return page.evaluate(
    ([id, chunk, count]) => {
      const fake = (window as unknown as {
        __fakePty: { emitOutput: (id: string, data: string) => number };
      }).__fakePty;
      let throughSeq = 0;
      for (let i = 0; i < (count as number); i += 1) {
        throughSeq = fake.emitOutput(
          id as string,
          (chunk as string).replace('{i}', String(i)),
        );
      }
      return throughSeq;
    },
    [ptyId, data, repeat] as const,
  );
}

function emitExit(page: Page, ptyId: string, code: number): Promise<void> {
  return page.evaluate(
    ([id, exitCode]) => {
      const fake = (window as unknown as {
        __fakePty: { emitExit: (id: string, code: number) => void };
      }).__fakePty;
      fake.emitExit(id as string, exitCode as number);
    },
    [ptyId, code] as const,
  );
}

interface TerminalBufferSnapshot {
  activeType: string;
  normalText: string;
  alternateText: string;
  activeText: string;
  cursorX: number;
  cursorY: number;
  viewportY: number;
  baseY: number;
}

/**
 * Read the actual xterm model registered by the running app. Vite serves the
 * same ESM singleton that Shell imports, so this inspects the real terminal
 * buffer without adding a production-only test hook or relying on WebGL
 * canvas pixels.
 */
function readTerminalBuffer(
  page: Page,
  ptyId: string,
): Promise<TerminalBufferSnapshot | null> {
  return page.evaluate(async (id) => {
    interface BufferLine {
      translateToString(trimRight?: boolean): string;
    }
    interface BufferModel {
      type: string;
      length: number;
      cursorX: number;
      cursorY: number;
      viewportY: number;
      baseY: number;
      getLine(index: number): BufferLine | undefined;
    }
    interface RegisteredTerminal {
      buffer: {
        active: BufferModel;
        normal: BufferModel;
        alternate: BufferModel;
      };
    }

    const registryModulePath = '/src/components/terminal/xtermRegistry.ts';
    const registry = (await import(registryModulePath)) as {
      getTerminal(candidateId: string): RegisteredTerminal | undefined;
    };
    const term = registry.getTerminal(id);
    if (!term) return null;

    const readBuffer = (buffer: BufferModel): string => {
      const lines: string[] = [];
      for (let index = 0; index < buffer.length; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
      }
      return lines.join('\n');
    };

    return {
      activeType: term.buffer.active.type,
      normalText: readBuffer(term.buffer.normal),
      alternateText: readBuffer(term.buffer.alternate),
      activeText: readBuffer(term.buffer.active),
      cursorX: term.buffer.active.cursorX,
      cursorY: term.buffer.active.cursorY,
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY,
    };
  }, ptyId);
}

async function expectVisibleTerminalHasTextOrInk(page: Page, expectedText: string): Promise<void> {
  const host = page.locator('.threadterm-xterm-host:visible').first();
  await expect(host).toBeVisible();
  await expect(async () => {
    const text = await host.evaluate((source) => (source.textContent ?? '').trim());
    const screenshot = await host.screenshot();
    const stats = countContrastingPngPixels(screenshot);
    expect(stats.width).toBeGreaterThan(0);
    expect(stats.height).toBeGreaterThan(0);
    expect(text.includes(expectedText) || stats.contrastingPixels > 300).toBeTruthy();
  }).toPass({ timeout: 10_000 });
}

function countContrastingPngPixels(png: Buffer): {
  width: number;
  height: number;
  contrastingPixels: number;
} {
  const signature = png.subarray(0, 8).toString('hex');
  expect(signature).toBe('89504e470d0a1a0a');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  expect(bitDepth).toBe(8);
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  expect(bytesPerPixel).toBeGreaterThan(0);

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(height * stride);
  let inputOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset] ?? 0;
    inputOffset += 1;
    const rowOffset = y * stride;
    const prevRowOffset = rowOffset - stride;

    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inputOffset] ?? 0;
      inputOffset += 1;
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] ?? 0 : 0;
      const up = y > 0 ? pixels[prevRowOffset + x] ?? 0 : 0;
      const upLeft = y > 0 && x >= bytesPerPixel
        ? pixels[prevRowOffset + x - bytesPerPixel] ?? 0
        : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paethPredictor(left, up, upLeft);
      pixels[rowOffset + x] = (raw + predictor) & 0xff;
    }
  }

  const histogram = new Map<string, number>();
  for (let i = 0; i < pixels.length; i += bytesPerPixel) {
    const key = `${(pixels[i] ?? 0) >> 4},${(pixels[i + 1] ?? 0) >> 4},${(pixels[i + 2] ?? 0) >> 4}`;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  const backgroundKey = Array.from(histogram.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '0,0,0';
  const [bgR, bgG, bgB] = backgroundKey.split(',').map((part) => Number(part) * 16 + 8);

  let contrastingPixels = 0;
  for (let i = 0; i < pixels.length; i += bytesPerPixel) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    if (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB) > 40) {
      contrastingPixels += 1;
    }
  }

  return { width, height, contrastingPixels };
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

test('workbench detail contains an unbroken terminal signal at narrow width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 407, height: 471 });
  const [seedCard] = makeSeedCards(1);
  const cards = [
    {
      ...seedCard,
      // Persisted transient states intentionally migrate back to idle; use a
      // durable completed card so the execution group survives app startup.
      status: 'completed',
      lastReplyPreview: `| > | ${'─'.repeat(180)}`,
    },
  ] as unknown as ReturnType<typeof makeSeedCards>;
  await installFakeTauri(page, cards);
  const errors = trackPageErrors(page);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const groupCard = page
    .locator('section[aria-labelledby="workbench-groups-heading"]')
    .getByRole('button', { name: new RegExp(seedCard.projectName) });
  await expect(groupCard).toBeVisible();
  await groupCard.click();

  const panel = page.getByTestId('workbench-detail-panel');
  const signal = page.getByTestId('workbench-latest-signal');
  await expect(panel).toBeVisible();
  await expect(signal).toBeVisible();

  const geometry = await panel.evaluate((panelElement) => {
    const signalElement = panelElement.querySelector(
      '[data-testid="workbench-latest-signal"]',
    );
    if (!(signalElement instanceof HTMLElement)) return null;
    const panelRect = panelElement.getBoundingClientRect();
    const signalRect = signalElement.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      panelLeft: panelRect.left,
      panelRight: panelRect.right,
      signalLeft: signalRect.left,
      signalRight: signalRect.right,
      signalClientWidth: signalElement.clientWidth,
      signalScrollWidth: signalElement.scrollWidth,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.documentScrollWidth).toBeLessThanOrEqual(
    geometry?.viewportWidth ?? 0,
  );
  expect(geometry?.signalLeft).toBeGreaterThanOrEqual(geometry?.panelLeft ?? 0);
  expect(geometry?.signalRight).toBeLessThanOrEqual((geometry?.panelRight ?? 0) + 1);
  expect(geometry?.signalScrollWidth).toBeLessThanOrEqual(
    (geometry?.signalClientWidth ?? 0) + 1,
  );
  expect(errors).toEqual([]);
});

// ── Journey 1: exit banner + restart ─────────────────────────────────────────

test('exit banner appears on non-zero exit and restart respawns the PTY', async ({ page }) => {
  const cards = makeSeedCards(1);
  const ptyId = cards[0].ptyId;
  await installFakeTauri(page, cards);
  const errors = trackPageErrors(page);

  await page.goto('/');
  await openCard(page, cards[0].projectName);

  // Shell connected: PTY spawned once.
  await waitForCount(page, 'create', ptyId, 1);

  // Live output reaches xterm — `ack` fires only after term.write() completes
  // (text itself lives in a WebGL canvas, not the DOM).
  const throughSeq = await emitOutput(page, ptyId, 'hello from pty\r\n');
  await waitForAckThrough(page, ptyId, throughSeq);

  // Non-zero exit → exit strip with restart entry; screen is NOT cleared.
  await emitExit(page, ptyId, 1);
  const exitStrip = page.getByTestId('shell-exit-strip');
  await expect(exitStrip).toBeVisible();

  await exitStrip.getByRole('button', { name: 'Restart session' }).click();
  await expect(exitStrip).toBeHidden();
  await waitForCount(page, 'create', ptyId, 2);

  expect(errors).toEqual([]);
});

// ── Journey 2: LRU eviction → re-focus restores via attachSnapshot ──────────

test('evicted terminal view restores hidden history, cursor, and TUI state on re-focus', async ({
  page,
}) => {
  // 7 cards > MAX_MOUNTED_TERMINAL_VIEWS (6) → focusing all of them evicts
  // the first card's view; re-focusing it must go through attachSnapshot
  // again to restore screen + scrollback.
  const cards = makeSeedCards(7);
  await installFakeTauri(page, cards);
  const errors = trackPageErrors(page);

  await page.goto('/');

  const initialHistorySentinel = 'P0-3 history before LRU eviction';
  const hiddenHistorySentinel = 'P0-3 output produced while renderer was evicted';
  const finalTuiSentinel = 'P0-3 FINAL TUI FRAME';

  for (const [index, card] of cards.entries()) {
    await openCard(page, card.projectName);
    // Wait until this card's Shell finished connecting (snapshot applied)
    // before navigating away, so LRU touches happen in a known order.
    await waitForCount(page, 'create', card.ptyId, 1);
    await waitForCount(page, 'attachSnapshot', card.ptyId, 1);
    // Give the evicted-but-preserved PTY some history to restore later.
    const historyLine = index === 0
      ? `${initialHistorySentinel}\r\n`
      : `history for ${card.id}\r\n`;
    const throughSeq = await emitOutput(page, card.ptyId, historyLine);
    await waitForAckThrough(page, card.ptyId, throughSeq);
    await backToGrid(page);
  }

  // Card 1 is now LRU-evicted but its PTY is intentionally still alive.
  await expect
    .poll(() => readTerminalBuffer(page, cards[0].ptyId))
    .toBeNull();

  // Stream more than the Rust 200 KB high-watermark while no Shell owns it;
  // the always-mounted TerminalEventBridge must advance the cumulative ACK
  // watermark through the final emitted sequence.
  let throughSeq = await emitOutput(
    page,
    cards[0].ptyId,
    `${hiddenHistorySentinel}\r\n`,
  );
  const hiddenOutputChunks = Array.from({ length: 28 }, (_, chunkIndex) =>
    Array.from({ length: 100 }, (_, lineIndex) => {
      const index = chunkIndex * 100 + lineIndex;
      return `hidden-row-${String(index).padStart(4, '0')} ${'x'.repeat(58)}\r\n`;
    }).join(''),
  );
  expect(Buffer.byteLength(hiddenOutputChunks.join(''), 'utf8')).toBeGreaterThan(200 * 1024);
  for (const chunk of hiddenOutputChunks) {
    throughSeq = await emitOutput(page, cards[0].ptyId, chunk);
  }

  // Finish in alternate-screen mode with a deterministic cursor position.
  // A correct attach must restore both the normal-buffer history above and
  // this final TUI frame, not merely reconnect an empty xterm.
  throughSeq = await emitOutput(
    page,
    cards[0].ptyId,
    `\x1b[?1049h\x1b[2J\x1b[H${finalTuiSentinel}\r\nstatus: restored\x1b[10;7H`,
  );
  await waitForAckThrough(page, cards[0].ptyId, throughSeq);

  // Card 1 was evicted when card 7 mounted (cap 6). Re-focusing it must
  // create a fresh Shell that re-attaches the preserved session snapshot.
  await openCard(page, cards[0].projectName);
  await waitForCount(page, 'attachSnapshot', cards[0].ptyId, 2);

  await expect
    .poll(async () => (await readTerminalBuffer(page, cards[0].ptyId))?.activeText ?? '')
    .toContain(finalTuiSentinel);

  const restored = await readTerminalBuffer(page, cards[0].ptyId);
  expect(restored).not.toBeNull();
  expect(restored?.normalText).toContain(initialHistorySentinel);
  expect(restored?.normalText).toContain(hiddenHistorySentinel);
  expect(restored?.normalText).toContain('hidden-row-2799');
  expect(restored?.activeType).toBe('alternate');
  expect(restored?.alternateText).toContain(finalTuiSentinel);
  expect({ x: restored?.cursorX, y: restored?.cursorY }).toEqual({ x: 6, y: 9 });

  // Restored view is healthy: no exit/reconnect strip, no JS errors.
  await expect(page.getByTestId('shell-exit-strip')).toBeHidden();
  await expect(page.getByTestId('shell-reconnect-strip')).toBeHidden();
  expect(errors).toEqual([]);
});

// ── Journey 3: scrolled-up viewport is not yanked by streaming output ───────

test('streaming output does not yank a scrolled-up viewport; button returns to bottom', async ({
  page,
}) => {
  const cards = makeSeedCards(1);
  const ptyId = cards[0].ptyId;
  await installFakeTauri(page, cards);
  const errors = trackPageErrors(page);

  await page.goto('/');
  await openCard(page, cards[0].projectName);
  await waitForCount(page, 'create', ptyId, 1);

  // Fill the scrollback well past one viewport.
  const scrollbackThroughSeq = await emitOutput(page, ptyId, 'scrollback line {i}\r\n', 200);
  await waitForAckThrough(page, ptyId, scrollbackThroughSeq);

  // Use xterm's public buffer coordinates instead of internal viewport DOM
  // metrics. xterm 6 moved scrolling to a custom scrollable element, so
  // `.xterm-viewport.scrollTop` no longer represents the visible buffer row.
  const readScrollDistance = async () => {
    const buffer = await readTerminalBuffer(page, ptyId);
    return buffer ? buffer.baseY - buffer.viewportY : 0;
  };

  const host = page.locator('.threadterm-xterm-host:visible');
  await host.hover();
  await expect(async () => {
    await page.mouse.wheel(0, -400);
    expect(await readScrollDistance()).toBeGreaterThan(5);
  }).toPass({ timeout: 15_000 });

  // More output while reading history: the viewport must NOT be yanked back
  // to the bottom, and the "scroll to bottom" indicator must appear.
  const liveThroughSeq = await emitOutput(page, ptyId, 'new output line {i}\r\n', 50);
  await waitForAckThrough(page, ptyId, liveThroughSeq);

  const scrollButton = page.getByTestId('shell-scroll-to-bottom');
  await expect(scrollButton).toBeVisible();
  expect(await readScrollDistance()).toBeGreaterThan(5);

  // Explicit return-to-bottom restores follow mode and hides the button.
  await scrollButton.click();
  await expect(scrollButton).toBeHidden();
  await expect(async () => {
    expect(await readScrollDistance()).toBe(0);
  }).toPass({ timeout: 5_000 });

  expect(errors).toEqual([]);
});

test('synchronized agent repaint clears the old prompt layout before drawing the new one', async ({
  page,
}) => {
  const cards = makeSeedCards(1);
  const ptyId = cards[0].ptyId;
  await installFakeTauri(page, cards);
  const errors = trackPageErrors(page);

  await page.goto('/');
  await openCard(page, cards[0].projectName);
  await waitForCount(page, 'create', ptyId, 1);

  const staleLayout = [
    'You have 3 usage limit resets available. Run /',
    '  usage to use one.',
    '╭ stale input ╮',
  ].join('\r\n');
  let throughSeq = await emitOutput(page, ptyId, staleLayout);
  await waitForAckThrough(page, ptyId, throughSeq);

  const stableLayout = [
    '\x1b[?2026h\x1b[2J\x1b[H',
    '• You have 3 usage limit resets available. Run /usage to use one.\r\n',
    '╭ stable input ╮',
    '\x1b[?2026l',
  ].join('');
  throughSeq = await emitOutput(page, ptyId, stableLayout);
  await waitForAckThrough(page, ptyId, throughSeq);

  await expect(async () => {
    const buffer = await readTerminalBuffer(page, ptyId);
    expect(buffer?.activeText).toContain(
      '• You have 3 usage limit resets available. Run /usage to use one.\n╭ stable input ╮',
    );
    expect(buffer?.activeText).not.toContain('usage to use one.\n╭ stale input ╮');
    expect(buffer?.activeText).not.toContain('stale input');
  }).toPass({ timeout: 5_000 });

  expect(errors).toEqual([]);
});

// ── Journey 4: Codex chat ↔ terminal keeps xterm visible ────────────────────

test('codex chat to terminal restore shows terminal output without stale bottom prompt', async ({
  page,
}) => {
  const card = makeSeedCodexCard();
  await installFakeTauri(page, [card]);
  const errors = trackPageErrors(page);

  await page.goto('/');
  await openCard(page, card.projectName);

  // Codex cards open in chat mode by default. Switching to terminal mounts
  // Shell for the first time and starts/restores the PTY.
  await page.locator('button[title="Terminal mode"]').click();
  await waitForCount(page, 'create', card.ptyId, 1);
  await waitForCount(page, 'attachSnapshot', card.ptyId, 1);
  const throughSeq = await emitOutput(page, card.ptyId, 'codex terminal line\r\n');
  await waitForAckThrough(page, card.ptyId, throughSeq);
  await expectVisibleTerminalHasTextOrInk(page, 'codex terminal line');
  await expect(page.getByTestId('shell-scroll-to-bottom')).toBeHidden();

  // Returning to chat unmounts Shell; going back to terminal must restore the
  // preserved PTY snapshot instead of leaving an empty terminal surface.
  await page.locator('button[title="Chat mode"]').click();
  await page.locator('button[title="Terminal mode"]').click();
  await waitForCount(page, 'attachSnapshot', card.ptyId, 2);
  await expectVisibleTerminalHasTextOrInk(page, 'codex terminal line');
  await expect(page.getByTestId('shell-scroll-to-bottom')).toBeHidden();

  expect(errors).toEqual([]);
});

// ── Journey 5: local history is lazy and materializes only selected cards ──

test('session recovery stays lazy and resumes selected Codex history only when opened', async ({
  page,
}) => {
  const codexChildId = '019f514a-8678-7c33-b6cf-3a8c40e53052';
  const codexRootId = '019f513b-d9ae-7833-8e9e-d878ac9e9fe5';
  const agentSessions: SeedAgentSession[] = [
    {
      provider: 'claude',
      id: 'claude-history-1',
      projectPath: '/tmp/claude-history-project',
      nativeTitle: 'Release checklist',
      titleKind: 'explicit',
      firstUserMessagePreview: 'Prepare the release checklist',
      updatedAt: 1_700_000_000_000,
      resumable: true,
    },
    {
      provider: 'codex',
      id: codexChildId,
      resumeTargetId: codexRootId,
      projectPath: '/tmp/codex-history-project',
      nativeTitle: 'Fix auth race',
      titleKind: 'explicit',
      firstUserMessagePreview: 'Fix the auth race',
      updatedAt: 1_700_000_100_000,
      resumable: true,
    },
  ];
  await installFakeTauri(page, [], agentSessions);
  const errors = trackPageErrors(page);

  await page.goto('/');
  const recoveryButton = page.locator('button[title="Restore local Agent sessions"]');
  await expect(recoveryButton).toBeVisible();

  expect(
    await page.evaluate(() => {
      const state = (window as unknown as {
        __fakeAgentSessions: { catalogCalls: unknown[]; recentListCalls: number };
      }).__fakeAgentSessions;
      return { catalogCalls: state.catalogCalls.length, recentListCalls: state.recentListCalls };
    }),
  ).toEqual({ catalogCalls: 0, recentListCalls: 0 });

  await recoveryButton.click();
  const dialog = page.getByRole('dialog', { name: 'Restore local sessions' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Release checklist', { exact: true })).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Release checklist' }).check();

  await dialog.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(dialog.getByText('Fix auth race', { exact: true })).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Fix auth race' }).check();

  expect(
    await page.evaluate(() =>
      (window as unknown as {
        __fakeAgentSessions: { catalogCalls: Array<{ provider: string }> };
      }).__fakeAgentSessions.catalogCalls.map((call) => call.provider),
    ),
  ).toEqual(['claude', 'codex']);

  await dialog.getByRole('button', { name: 'Restore selected' }).click();
  await expect(dialog).toBeHidden();
  await showAllTerminals(page);
  await expect(page.getByText('Release checklist', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Fix auth race', { exact: true }).last()).toBeVisible();

  expect(
    await page.evaluate(() =>
      Object.values(
        (window as unknown as {
          __fakePty: { counts: { create: Record<string, number> } };
        }).__fakePty.counts.create,
      ).reduce((total, count) => total + count, 0),
    ),
  ).toBe(0);

  await page
    .getByText('/tmp/codex-history-project', { exact: true })
    .last()
    .click();
  await waitForCount(page, 'create', codexChildId, 1);
  await expect
    .poll(() =>
      page.evaluate((ptyId) => {
        const fake = (window as unknown as {
          __fakePty: { inputs: Record<string, string[]> };
        }).__fakePty;
        return fake.inputs[ptyId] ?? [];
      }, codexChildId),
    )
    .toContain(`codex resume ${codexRootId} --no-alt-screen\r`);

  expect(
    await page.evaluate(() => {
      const state = (window as unknown as {
        __fakeAgentSessions: {
          resumeResolveCalls: Array<{ provider: string; sessionId: string }>;
          codexAppOpenCardCalls: number;
        };
      }).__fakeAgentSessions;
      return {
        resumeResolveCalls: state.resumeResolveCalls,
        codexAppOpenCardCalls: state.codexAppOpenCardCalls,
      };
    }),
  ).toEqual({
    resumeResolveCalls: [
      { provider: 'codex', sessionId: codexChildId },
      { provider: 'codex', sessionId: codexRootId },
    ],
    codexAppOpenCardCalls: 0,
  });
  expect(errors).toEqual([]);
});

// ── Journey 6: edit an existing card without recreating it ──────────────────

async function openFocusedTerminalEditor(page: Page) {
  const moreButton = page.locator('button[title="More"]:visible').last();
  await moreButton.click();
  await page.getByRole('menuitem', { name: 'Edit terminal', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit terminal' });
  await expect(dialog).toBeVisible();
  return dialog;
}

interface PersistedTerminalCard {
  id: string;
  ptyId: string;
  terminalType: string;
  providerSessionId?: string;
  providerSessionState?: string;
}

interface PersistedTerminalState {
  state?: {
    cards?: PersistedTerminalCard[];
    pendingTerminalConfigurations?: Record<string, unknown>;
  };
}

function readPersistedTerminalState(page: Page): Promise<PersistedTerminalState> {
  return page.evaluate(() => {
    const managedState = (window as unknown as {
      __fakeManagedState: { getItem: (key: string) => string | null };
    }).__fakeManagedState;
    return JSON.parse(
      managedState.getItem('threadterm-terminal-store') ?? '{}',
    ) as PersistedTerminalState;
  });
}

test('terminal edit save-only stays pending, then apply restarts exactly once', async ({
  page,
}) => {
  const card = makeSeedCards(1)[0];
  await installFakeTauri(page, [card]);
  const errors = trackPageErrors(page);

  await page.goto('/');
  await openCard(page, card.projectName);
  await waitForCount(page, 'create', card.ptyId, 1);

  let dialog = await openFocusedTerminalEditor(page);
  await dialog.getByRole('button', { name: 'Codex', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Run command', exact: true })
    .click();
  await dialog
    .getByPlaceholder('Enter the exact command to run')
    .fill('codex --no-alt-screen');
  await dialog.getByRole('button', { name: 'Save only', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Pending', { exact: true }).last()).toBeVisible();

  expect(
    await page.evaluate((ptyId) => {
      const fake = (window as unknown as {
        __fakePty: { counts: { kill: Record<string, number> } };
      }).__fakePty;
      return fake.counts.kill[ptyId] ?? 0;
    }, card.ptyId),
  ).toBe(0);
  const savedOnlyState = await readPersistedTerminalState(page);
  const savedOnlyCard = savedOnlyState.state?.cards?.find(
    (candidate) => candidate.id === card.id,
  );
  expect({
    terminalType: savedOnlyCard?.terminalType,
    ptyId: savedOnlyCard?.ptyId,
    pending: Boolean(
      savedOnlyState.state?.pendingTerminalConfigurations?.[card.id],
    ),
  }).toEqual({
    terminalType: 'shell',
    ptyId: card.ptyId,
    pending: true,
  });

  dialog = await openFocusedTerminalEditor(page);
  await expect(dialog.locator('textarea')).toHaveValue(
    'codex --no-alt-screen',
  );
  await dialog
    .getByRole('button', { name: 'Save and restart', exact: true })
    .click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(async () => {
      const persisted = await readPersistedTerminalState(page);
      return persisted.state?.cards?.find(
        (candidate) => candidate.id === card.id,
      )?.ptyId;
    })
    .not.toBe(card.ptyId);
  const restartedState = await readPersistedTerminalState(page);
  const nextPtyId = restartedState.state?.cards?.find(
    (candidate) => candidate.id === card.id,
  )?.ptyId;
  expect(typeof nextPtyId).toBe('string');
  await waitForCount(page, 'create', nextPtyId as string, 1);

  expect(
    await page.evaluate((ptyId) => {
      const fake = (window as unknown as {
        __fakePty: { counts: { kill: Record<string, number> } };
      }).__fakePty;
      return fake.counts.kill[ptyId] ?? 0;
    }, card.ptyId),
  ).toBe(1);
  await expect
    .poll(() =>
      page.evaluate((ptyId) => {
        const fake = (window as unknown as {
          __fakePty: { inputs: Record<string, string[]> };
        }).__fakePty;
        return fake.inputs[ptyId] ?? [];
      }, nextPtyId as string),
    )
    .toContain('codex --no-alt-screen\r');
  expect(errors).toEqual([]);
});

test('terminal edit resumes the canonical Codex history before replacing the PTY', async ({
  page,
}) => {
  const card = makeSeedCards(1)[0];
  const childSessionId = '019f-edit-child';
  const rootSessionId = '019f-edit-root';
  const agentSessions: SeedAgentSession[] = [
    {
      provider: 'codex',
      id: childSessionId,
      resumeTargetId: rootSessionId,
      projectPath: card.projectPath,
      nativeTitle: 'Canonical edit history',
      titleKind: 'explicit',
      updatedAt: 1_700_000_200_000,
      resumable: true,
    },
  ];
  await installFakeTauri(page, [card], agentSessions);
  const errors = trackPageErrors(page);

  await page.goto('/');
  await openCard(page, card.projectName);
  await waitForCount(page, 'create', card.ptyId, 1);

  const dialog = await openFocusedTerminalEditor(page);
  await dialog.getByRole('button', { name: 'Codex', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Resume session', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: /Canonical edit history/ })
    .click();
  await dialog
    .getByRole('button', { name: 'Save and restart', exact: true })
    .click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(async () => {
      const persisted = await readPersistedTerminalState(page);
      return persisted.state?.cards?.find(
        (candidate) => candidate.id === card.id,
      );
    })
    .toMatchObject({
      terminalType: 'codex',
      providerSessionId: rootSessionId,
      providerSessionState: 'bound',
    });
  const resumedState = await readPersistedTerminalState(page);
  const nextPtyId = resumedState.state?.cards?.find(
    (candidate) => candidate.id === card.id,
  )?.ptyId;
  expect(typeof nextPtyId).toBe('string');
  expect(nextPtyId).not.toBe(card.ptyId);
  await waitForCount(page, 'create', nextPtyId as string, 1);
  await expect
    .poll(() =>
      page.evaluate((ptyId) => {
        const fake = (window as unknown as {
          __fakePty: { inputs: Record<string, string[]> };
        }).__fakePty;
        return fake.inputs[ptyId] ?? [];
      }, nextPtyId as string),
    )
    .toContain(`codex resume ${rootSessionId} --no-alt-screen\r`);

  expect(
    await page.evaluate(
      ({ oldPtyId }) => {
        const win = window as unknown as {
          __fakePty: { counts: { kill: Record<string, number> } };
          __fakeAgentSessions: {
            resumeResolveCalls: Array<{
              provider: string;
              sessionId: string;
            }>;
          };
        };
        return {
          oldPtyKills: win.__fakePty.counts.kill[oldPtyId] ?? 0,
          resumeResolveCalls: win.__fakeAgentSessions.resumeResolveCalls,
        };
      },
      { oldPtyId: card.ptyId },
    ),
  ).toEqual({
    oldPtyKills: 1,
    resumeResolveCalls: [
      { provider: 'codex', sessionId: childSessionId },
      { provider: 'codex', sessionId: rootSessionId },
    ],
  });
  expect(errors).toEqual([]);
});

test('invalid historical session leaves the running terminal untouched', async ({
  page,
}) => {
  const card = makeSeedCards(1)[0];
  await installFakeTauri(page, [card], []);
  const errors = trackPageErrors(page);

  await page.goto('/');
  await openCard(page, card.projectName);
  await waitForCount(page, 'create', card.ptyId, 1);
  const dialog = await openFocusedTerminalEditor(page);
  await dialog.getByRole('button', { name: 'Codex', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Resume session', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Or enter a session ID', exact: true })
    .click();
  await dialog
    .getByPlaceholder('Provider session ID')
    .fill('missing-session');
  await dialog
    .getByRole('button', { name: 'Save and restart', exact: true })
    .click();

  await expect(
    dialog.getByText(
      'The provider could not find this historical session. The current terminal was not changed.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    await page.evaluate((ptyId) => {
      const fake = (window as unknown as {
        __fakePty: { counts: { kill: Record<string, number> } };
      }).__fakePty;
      return fake.counts.kill[ptyId] ?? 0;
    }, card.ptyId),
  ).toBe(0);
  expect(errors).toEqual([]);
});

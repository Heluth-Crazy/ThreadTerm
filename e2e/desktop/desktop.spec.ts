/**
 * Desktop e2e baseline journeys (audit P2-6, Stage 4).
 *
 *   1. exit banner + one-click restart          (Stage 1 / P1-2)
 *   2. LRU eviction → re-focus snapshot restore (Stage 3 / P1-1)
 *   3. scrolled-up output does not yank viewport (Stage 1 / P0-1)
 *
 * Each test gets an isolated page with its own fake Tauri env + seeded
 * cards (see ./fakeTauri.ts). Terminal text renders into a WebGL canvas, so
 * assertions go through the fake PTY's call counters (`create`,
 * `attachSnapshot`) and cumulative ACK watermark (advanced only after xterm
 * completed the write), plus Stage 1 strip test-ids instead of DOM text.
 */
import { test, expect, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import { installFakeTauri, makeSeedCards, makeSeedCodexCard } from './fakeTauri';

// ── helpers ──────────────────────────────────────────────────────────────────

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  return errors;
}

/** Click a card in the (visible) grid by its seeded project name. */
async function openCard(page: Page, projectName: string): Promise<void> {
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

test('evicted terminal view re-attaches its snapshot on re-focus', async ({ page }) => {
  // 7 cards > MAX_MOUNTED_TERMINAL_VIEWS (6) → focusing all of them evicts
  // the first card's view; re-focusing it must go through attachSnapshot
  // again to restore screen + scrollback.
  const cards = makeSeedCards(7);
  await installFakeTauri(page, cards);
  const errors = trackPageErrors(page);

  await page.goto('/');

  for (const card of cards) {
    await openCard(page, card.projectName);
    // Wait until this card's Shell finished connecting (snapshot applied)
    // before navigating away, so LRU touches happen in a known order.
    await waitForCount(page, 'create', card.ptyId, 1);
    await waitForCount(page, 'attachSnapshot', card.ptyId, 1);
    // Give the evicted-but-preserved PTY some history to restore later.
    const throughSeq = await emitOutput(page, card.ptyId, `history for ${card.id}\r\n`);
    await waitForAckThrough(page, card.ptyId, throughSeq);
    await backToGrid(page);
  }

  // Card 1 is now LRU-evicted but its PTY is intentionally still alive.
  // Stream more than the Rust 200 KB high-watermark while no Shell owns it;
  // the always-mounted TerminalEventBridge must advance the cumulative ACK
  // watermark through the final emitted sequence.
  const throughSeq = await emitOutput(
    page,
    cards[0].ptyId,
    `${'x'.repeat(1024)}{i}\r\n`,
    256,
  );
  await waitForAckThrough(page, cards[0].ptyId, throughSeq);

  // Card 1 was evicted when card 7 mounted (cap 6). Re-focusing it must
  // create a fresh Shell that re-attaches the preserved session snapshot.
  await openCard(page, cards[0].projectName);
  await waitForCount(page, 'attachSnapshot', cards[0].ptyId, 2);

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

  // Scroll up over the terminal host. Note: a pure user wheel scroll goes
  // through xterm's Viewport with `suppressScrollEvent: true`, so the
  // indicator appears on the NEXT output chunk (the actual P0-1 scenario:
  // streaming output while the user reads history).
  const viewport = page.locator('.threadterm-xterm-host:visible .xterm-viewport');
  const readScroll = () =>
    viewport.evaluate((el) => ({
      scrollTop: el.scrollTop,
      bottom: el.scrollHeight - el.clientHeight,
    }));

  const host = page.locator('.threadterm-xterm-host:visible');
  await host.hover();
  await expect(async () => {
    await page.mouse.wheel(0, -400);
    const state = await readScroll();
    expect(state.bottom - state.scrollTop).toBeGreaterThan(100);
  }).toPass({ timeout: 15_000 });

  // More output while reading history: the viewport must NOT be yanked back
  // to the bottom, and the "scroll to bottom" indicator must appear.
  const liveThroughSeq = await emitOutput(page, ptyId, 'new output line {i}\r\n', 50);
  await waitForAckThrough(page, ptyId, liveThroughSeq);

  const scrollButton = page.getByTestId('shell-scroll-to-bottom');
  await expect(scrollButton).toBeVisible();
  const scrolledState = await readScroll();
  expect(scrolledState.bottom - scrolledState.scrollTop).toBeGreaterThan(100);

  // Explicit return-to-bottom restores follow mode and hides the button.
  await scrollButton.click();
  await expect(scrollButton).toBeHidden();
  await expect(async () => {
    const state = await readScroll();
    expect(state.bottom - state.scrollTop).toBeLessThan(50);
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

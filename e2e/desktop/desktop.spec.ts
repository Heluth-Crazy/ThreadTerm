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
 * `attachSnapshot`, `ack` — ack fires only after xterm completed the write)
 * and the Stage 1 strip test-ids instead of DOM text.
 */
import { test, expect, type Page } from '@playwright/test';
import { installFakeTauri, makeSeedCards } from './fakeTauri';

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
  // Card root is the only `bg-card` surface containing the project name —
  // the sidebar project button and the TerminalView header use other
  // backgrounds, and hidden layers are excluded by the visibility check.
  await page
    .locator('[class*="bg-card"]')
    .filter({ hasText: projectName })
    .first()
    .click();
}

/** Click the focused TerminalView's back-to-grid header button. */
async function backToGrid(page: Page): Promise<void> {
  // Exact title — a second `title="Back to grid"` button (bottom action bar)
  // is also visible in focus mode.
  await page.locator('button[title="Back to grid (⌘/Ctrl+Shift+M)"]:visible').click();
}

function waitForCount(
  page: Page,
  kind: 'create' | 'attachSnapshot' | 'ack',
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

function emitOutput(page: Page, ptyId: string, data: string, repeat = 1): Promise<void> {
  return page.evaluate(
    ([id, chunk, count]) => {
      const fake = (window as unknown as {
        __fakePty: { emitOutput: (id: string, data: string) => void };
      }).__fakePty;
      for (let i = 0; i < (count as number); i += 1) {
        fake.emitOutput(id as string, (chunk as string).replace('{i}', String(i)));
      }
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
  await emitOutput(page, ptyId, 'hello from pty\r\n');
  await waitForCount(page, 'ack', ptyId, 1);

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
    await emitOutput(page, card.ptyId, `history for ${card.id}\r\n`);
    await waitForCount(page, 'ack', card.ptyId, 1);
    await backToGrid(page);
  }

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
  await emitOutput(page, ptyId, 'scrollback line {i}\r\n', 200);
  await waitForCount(page, 'ack', ptyId, 200);

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
  await emitOutput(page, ptyId, 'new output line {i}\r\n', 50);
  await waitForCount(page, 'ack', ptyId, 250);

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

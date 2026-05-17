import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';

// xterm's DOM renderer paints the visible terminal text into `.xterm-rows`
// (spans positioned by the renderer). Playwright's getByText().toBeVisible()
// is unreliable on those rows (per-glyph spans + helper layers), but the row
// container's textContent is the authoritative "what the user sees" signal —
// it is empty when the terminal is black/unpainted and contains the text once
// the DOM renderer has drawn a frame. This is the decisive black-screen guard.
async function expectXtermText(scope: Locator, needle: string): Promise<void> {
  await expect
    .poll(
      async () =>
        scope.locator('.xterm-rows').first().evaluate((el) => el.textContent ?? ''),
      { timeout: 10_000 },
    )
    .toContain(needle);
}

// E2E for the P2 single-xterm mobile shell. There is no chat/TUI block
// architecture anymore: MainTerminal renders ONE xterm instance with the
// default DOM renderer (the WebGL addon was removed because iOS WKWebView can
// return a non-compositing webgl2 context and leave a black screen). With the
// DOM renderer, xterm writes the visible text into `.xterm-rows` in the DOM,
// so the decisive proof is that the snapshot/output text is actually visible
// (and captured in a real WebKit/Chromium screenshot).

const ARTIFACT_DIR = path.resolve(process.cwd(), 'e2e-artifacts');

const snapshot = {
  protocol_version: 1,
  kind: 'snapshot',
  notifications: [
    {
      id: 'notify-1',
      cardId: 'card-1',
      kind: 'waiting',
      message: 'Input requested by the active session',
      createdAt: 123,
    },
  ],
  cards: [
    {
      id: 'card-1',
      status: 'running',
      projectPath: '/Users/me/projects/ThreadTerm',
      projectName: 'ThreadTerm',
      lastReplyPreview: 'ThreadTerm mobile e2e ready',
      summaryLine: 'ThreadTerm mobile e2e ready',
      hiddenLineCount: 0,
      recentOutputBytes: 4096,
    },
    {
      id: 'card-2',
      status: 'completed',
      projectPath: '/Users/me/projects/docs',
      projectName: 'docs-builder',
      lastReplyPreview: 'Build completed yesterday',
      summaryLine: 'Build completed yesterday',
      hiddenLineCount: 2,
      recentOutputBytes: 1024,
    },
  ],
};

const theme = {
  protocol_version: 1,
  kind: 'theme',
  mode: 'dark',
  app: {
    background: '#10151d',
    foreground: '#e8edf5',
    card: '#151b24',
    cardForeground: '#e8edf5',
    popover: '#151b24',
    popoverForeground: '#e8edf5',
    primary: '#4f8bd6',
    primaryForeground: '#f8fafc',
    secondary: '#263242',
    secondaryForeground: '#e8edf5',
    muted: '#202a38',
    mutedForeground: '#9aa7b7',
    accent: '#314154',
    accentForeground: '#e8edf5',
    destructive: '#ef4444',
    destructiveForeground: '#f8fafc',
    border: '#2d3948',
    input: '#263242',
    ring: '#4f8bd6',
  },
  terminal: {
    background: '#000000',
    foreground: '#f8fafc',
    cursor: '#f8fafc',
    cursorAccent: '#000000',
    selection: '#334155',
    selectionForeground: '#f8fafc',
    black: '#0f172a',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#eab308',
    blue: '#3b82f6',
    magenta: '#d946ef',
    cyan: '#06b6d4',
    white: '#e2e8f0',
    brightBlack: '#475569',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#facc15',
    brightBlue: '#60a5fa',
    brightMagenta: '#e879f9',
    brightCyan: '#22d3ee',
    brightWhite: '#f8fafc',
  },
};

// Snapshot line + a short incremental output line. Both must stay on-screen
// together: real terminals scroll the oldest rows off the viewport, and xterm's
// DOM renderer only paints rows currently in the viewport. A multi-screen burst
// of output would legitimately scroll SNAPSHOT_TEXT out of `.xterm-rows`, so the
// fixture keeps the live screen small enough that both lines remain visible —
// that is the honest "the terminal is actually painting" assertion.
const SNAPSHOT_TEXT = 'ThreadTerm mobile e2e ready';
const OUTPUT_TEXT = 'mobile e2e incremental output line';

let snapshotRequests = 0;

test.beforeAll(() => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  snapshotRequests = 0;
  await page.route('**/snapshot*', async (route) => {
    snapshotRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(snapshot),
    });
  });

  await page.addInitScript(({ snapshotMessage, themeMessage }) => {
    window.localStorage.setItem('threadterm.bridgeToken', 'device-token');
    if (!window.localStorage.getItem('threadterm.bridgePermission')) {
      window.localStorage.setItem('threadterm.bridgePermission', 'full');
    }

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;

      readyState = MockWebSocket.CONNECTING;
      sent: string[] = [];
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      private seq = 4;

      constructor(public url: string) {
        ((window as unknown) as { __threadtermWs: MockWebSocket[] }).__threadtermWs ??= [];
        ((window as unknown) as { __threadtermWs: MockWebSocket[] }).__threadtermWs.push(this);
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          this.emit(themeMessage);
          this.emit(snapshotMessage);
          // terminal_snapshot history establishes the initial visible screen.
          this.emit({
            protocol_version: 1,
            kind: 'terminal_snapshot',
            snapshot: {
              cardId: 'card-1',
              data: '',
              seq: 1,
              rows: 24,
              cols: 80,
              cursorRow: 1,
              cursorCol: 1,
              history: '[32mThreadTerm mobile e2e ready[0m\n',
            },
          });
          // Incremental output: one short line that stays on the same visible
          // screen as the snapshot line (realistic AI CLI screen size).
          this.emit({
            protocol_version: 1,
            kind: 'terminal_output',
            card_id: 'card-1',
            data: 'mobile e2e incremental output line\n',
            seq: 2,
          });
          // Raw alt-screen / box-drawing control codes: the single xterm must
          // not crash when it receives them (no block classifier in P2). The
          // alt buffer is entered and immediately exited so the main screen
          // (snapshot + output) is restored.
          this.emit({
            protocol_version: 1,
            kind: 'terminal_output',
            card_id: 'card-1',
            data: '[?1049h[1;1H┌──────── status ────────┐[2;1H│ codex reconnecting │[?1049l',
            seq: 3,
          });
        }, 0);
      }

      send(data: string) {
        this.sent.push(data);
        try {
          const parsed = JSON.parse(data) as { kind?: string; data?: string };
          if (parsed.kind === 'input') {
            window.setTimeout(() => {
              this.emit({
                protocol_version: 1,
                kind: 'terminal_output',
                card_id: 'card-1',
                data: `\nmobile command acknowledged: ${parsed.data ?? ''}\n`,
                seq: this.seq++,
              });
            }, 5);
          }
        } catch {
          // Test transport only records malformed sends.
        }
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }

      emit(message: unknown) {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
      }
    }

    ((window as unknown) as { WebSocket: typeof WebSocket }).WebSocket =
      MockWebSocket as unknown as typeof WebSocket;
  }, { snapshotMessage: snapshot, themeMessage: theme });
});

test('mobile shell renders preview + detail xterm content, theme lock, and input round-trip', async ({
  page,
  browserName,
}, testInfo) => {
  await page.goto('/pair');

  await expect(page.getByRole('heading', { name: 'ThreadTerm' })).toBeVisible();

  // --- Multi-session overview: the Terminal home lists ALL bridge sessions
  // (the desktop can run several terminals at once), not just the active one.
  // The fixture publishes card-1 (running) and card-2 (completed); both must
  // be present and openable from the home screen. ---
  const allSessions = page.locator('.section-block', { hasText: 'All Sessions' });
  await expect(allSessions).toBeVisible();
  const sessionRows = allSessions.locator('.instance-row');
  await expect(sessionRows).toHaveCount(2);
  await expect(sessionRows.filter({ hasText: 'ThreadTerm' })).toHaveCount(1);
  await expect(sessionRows.filter({ hasText: 'docs-builder' })).toHaveCount(1);

  // --- Active Session preview: xterm exists, has real layout, and the DOM
  // renderer has actually painted the snapshot text into the DOM. The preview
  // frame is pointer-events:none, so nothing here depends on a click. ---
  const previewXterm = page.locator('.terminal-preview-frame .xterm');
  await expect(previewXterm).toBeVisible();
  const previewBox = await previewXterm.boundingBox();
  expect(previewBox?.width ?? 0).toBeGreaterThan(0);
  expect(previewBox?.height ?? 0).toBeGreaterThan(0);
  await expectXtermText(page.locator('.terminal-preview-frame'), SNAPSHOT_TEXT);

  // --- Open detail: tap the preview ("Tap to focus"). ---
  await page.getByText('Tap to focus').click();
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();

  const detailScreen = page.locator('.terminal-detail-screen');
  const detailXterm = detailScreen.locator('.xterm');
  await expect(detailXterm).toBeVisible();
  const detailBox = await detailXterm.boundingBox();
  expect(detailBox?.width ?? 0).toBeGreaterThan(0);
  expect(detailBox?.height ?? 0).toBeGreaterThan(0);

  // Snapshot text + incremental output text are painted in the detail xterm.
  await expectXtermText(detailScreen, SNAPSHOT_TEXT);
  await expectXtermText(detailScreen, OUTPUT_TEXT);
  // With an active card there is no empty-state overlay.
  await expect(detailScreen.locator('.terminal-empty-overlay')).toHaveCount(0);

  // --- Decisive forensic screenshot of the live terminal area. ---
  await expect
    .poll(async () =>
      detailScreen.locator('.xterm-rows').evaluate((el) => (el.textContent ?? '').trim().length),
    )
    .toBeGreaterThan(0);
  const shotName =
    browserName === 'webkit' ? 'terminal-detail-webkit.png' : 'terminal-detail-chromium.png';
  await page
    .locator('[aria-label="Terminal output"]')
    .screenshot({ path: path.join(ARTIFACT_DIR, shotName) });
  await testInfo.attach(shotName, {
    path: path.join(ARTIFACT_DIR, shotName),
    contentType: 'image/png',
  });

  // --- Input round-trip: type a command, the bridge echoes a sentinel. ---
  await page.getByLabel('Mobile terminal input').fill('hello from mobile');
  await page.locator('.input-bar').getByRole('button', { name: 'Enter' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sockets = ((window as unknown) as { __threadtermWs?: Array<{ sent: string[] }> })
          .__threadtermWs;
        return sockets?.at(-1)?.sent ?? [];
      }),
    )
    .toContainEqual(expect.stringContaining('"data":"hello from mobile\\r"'));
  await expectXtermText(detailScreen, 'mobile command acknowledged');

  // --- Light system theme must NOT lighten the terminal: it stays locked to
  // pure black regardless of the desktop/system theme. ---
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Input requested by the active session')).toBeVisible();
  await page.getByRole('button', { name: /light/ }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.mobileThemeMode))
    .toBe('light');

  await page.getByRole('button', { name: 'Terminal' }).click();
  await page.getByText('Tap to focus').click();
  const hostBg = await page
    .locator('.terminal-xterm-host')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(hostBg).toBe('rgb(0, 0, 0)');
  const viewportBg = await page
    .locator('.xterm-viewport')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(viewportBg).toBe('rgb(0, 0, 0)');
});

test('terminal content survives viewport changes, lifecycle resume, and lag snapshot fetch', async ({
  page,
}) => {
  await page.goto('/pair');

  await expectXtermText(page.locator('.terminal-preview-frame'), SNAPSHOT_TEXT);
  await expect(page.locator('.ios-header.safe-top')).toBeVisible();
  await expect(page.locator('.tab-bar.safe-bottom')).toBeVisible();

  // Viewport resize + zoom-like change: stored terminal messages must replay
  // so the snapshot text survives a refit.
  await page.setViewportSize({ width: 390, height: 620 });
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
    window.visualViewport?.dispatchEvent(new Event('resize'));
  });
  await expectXtermText(page.locator('.terminal-preview-frame'), SNAPSHOT_TEXT);
  await page.evaluate(() => {
    document.documentElement.style.zoom = '1.15';
    window.dispatchEvent(new Event('resize'));
    window.visualViewport?.dispatchEvent(new Event('resize'));
  });
  await expectXtermText(page.locator('.terminal-preview-frame'), SNAPSHOT_TEXT);
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
    window.dispatchEvent(new Event('resize'));
  });

  // Enter detail and stream a large output burst; the xterm scrollback must
  // keep the new content and allow scrolling.
  await page.getByText('Tap to focus').click();
  await expect(page.locator('.terminal-nav.safe-top')).toBeVisible();
  await expect(page.locator('.input-bar.safe-bottom')).toBeVisible();
  const detailScreen = page.locator('.terminal-detail-screen');
  await expectXtermText(detailScreen, SNAPSHOT_TEXT);

  await page.evaluate(() => {
    const sockets = ((window as unknown) as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: Array.from({ length: 80 }, (_, index) => `scroll sentinel ${index}`).join('\n') + '\n',
      seq: 88,
    });
  });
  // The burst scrolled the snapshot line out of the 24-row viewport (real
  // terminal behavior). The decisive "not black / live stream" signal is that
  // the LATEST streamed content is painted in the DOM.
  await expectXtermText(detailScreen, 'scroll sentinel 79');

  // Back to the preview: the preview xterm is a separate mount replaying the
  // SAME stored transcript, so it ends scrolled to the same latest content.
  // This proves the transcript survives the detail->preview remount.
  await page.getByRole('button', { name: 'Back' }).click();
  await expectXtermText(page.locator('.terminal-preview-frame'), 'scroll sentinel 79');

  // Backpressure error -> the app fetches /snapshot again and merges it
  // without losing the rendered terminal content.
  await page.evaluate(() => {
    const sockets = ((window as unknown) as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'error',
      code: 'backpressure',
      message: 'lagged behind',
    });
  });
  await expect.poll(() => snapshotRequests).toBeGreaterThan(1);
  await expectXtermText(page.locator('.terminal-preview-frame'), 'scroll sentinel 79');

  // Visibility / pagehide-pageshow recovery reconnects and replays without
  // dropping content.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => ((window as unknown) as { __threadtermWs?: unknown[] }).__threadtermWs?.length ?? 0,
      ),
    )
    .toBeGreaterThan(1);
  await expectXtermText(page.locator('.terminal-preview-frame'), 'scroll sentinel 79');
});

test('history survives a reconnect snapshot with a higher seq (issue 5)', async ({ page }) => {
  await page.goto('/pair');
  await page.getByText('Tap to focus').click();
  const detailScreen = page.locator('.terminal-detail-screen');
  await expectXtermText(detailScreen, SNAPSHOT_TEXT);

  // Build up real scrollback the user would be reading.
  await page.evaluate(() => {
    const sockets = ((window as unknown) as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: Array.from({ length: 80 }, (_, index) => `scroll sentinel ${index}`).join('\n') + '\n',
      seq: 88,
    });
  });
  await expectXtermText(detailScreen, 'scroll sentinel 79');

  // A real reconnect re-sends a FRESH terminal_snapshot whose seq is the live
  // PTY seq (much higher than the first one) and whose serialized history is
  // only the current screen — NOT the full scrollback. The old code reset the
  // xterm on it and the user's history vanished. It must now be ignored as a
  // non-destructive resync, and continued output must still stream in.
  await page.evaluate(() => {
    const sockets = ((window as unknown) as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_snapshot',
      snapshot: {
        cardId: 'card-1',
        data: '',
        seq: 500,
        rows: 24,
        cols: 80,
        cursorRow: 1,
        cursorCol: 1,
        history: 'reconnect screen only\n',
      },
    });
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: 'post-reconnect streamed line\n',
      seq: 501,
    });
  });

  // The pre-reconnect history is still there AND the new output streamed in.
  await expectXtermText(detailScreen, 'post-reconnect streamed line');
  await expectXtermText(detailScreen, 'scroll sentinel 79');
});

test('backpressure recovery snapshot is applied and repaints the dropped segment (D1)', async ({
  page,
}) => {
  // The /snapshot HTTP endpoint is what onLagged -> loadSnapshot fetches. For
  // this test it must return a RECOVERY terminal_snapshot (higher seq, carrying
  // the repainted segment) instead of the card-list snapshot. The route is
  // re-registered AFTER the initial load so the home screen still boots
  // normally, then a backpressure error triggers the recovery fetch.
  await page.goto('/pair');
  await page.getByText('Tap to focus').click();
  const detailScreen = page.locator('.terminal-detail-screen');
  await expectXtermText(detailScreen, SNAPSHOT_TEXT);

  // Build visible sentinel history the user would be reading. seq 88 is the
  // last applied terminal_output seq before backpressure.
  await page.evaluate(() => {
    const sockets = ((window as unknown) as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: Array.from({ length: 80 }, (_, index) => `scroll sentinel ${index}`).join('\n') + '\n',
      seq: 88,
    });
  });
  await expectXtermText(detailScreen, 'scroll sentinel 79');

  // Re-point /snapshot at the recovery terminal_snapshot. Its history carries
  // the segment the broadcast Lagged dropped (RECOVERY MARKER) and its seq is
  // far higher than the last applied output seq (same monotonic output_seq
  // source on the server).
  await page.route('**/snapshot*', async (route) => {
    snapshotRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        protocol_version: 1,
        kind: 'terminal_snapshot',
        snapshot: {
          cardId: 'card-1',
          data: '',
          seq: 900,
          rows: 24,
          cols: 80,
          cursorRow: 1,
          cursorCol: 1,
          history: 'BACKPRESSURE RECOVERY MARKER repainted\n',
        },
      }),
    });
  });

  // Server broadcast Lagged -> error/backpressure. The app must arm a one-shot
  // snapshot re-apply and fetch the recovery snapshot.
  await page.evaluate(() => {
    const sockets = ((window as unknown) as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'error',
      code: 'backpressure',
      message: 'Client fell behind; intermediate events were dropped.',
    });
  });

  // The recovery snapshot was actually APPLIED (not swallowed by the issue-5
  // epoch guard): the dropped segment is repainted on screen.
  await expectXtermText(detailScreen, 'BACKPRESSURE RECOVERY MARKER repainted');
  await expect.poll(() => snapshotRequests).toBeGreaterThan(1);

  // A stale lower/equal-seq terminal_output replayed after recovery must NOT
  // be re-written (the seq guard still holds: snapshot reset seq to 900).
  await page.evaluate(() => {
    const sockets = ((window as unknown) as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: 'STALE REPLAYED LINE must not appear\n',
      seq: 88,
    });
    // A genuinely new post-recovery line (seq > 900) DOES stream in, proving
    // the live stream continues from the recovered epoch.
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: 'post-recovery streamed line\n',
      seq: 901,
    });
  });

  await expectXtermText(detailScreen, 'post-recovery streamed line');
  // The recovery marker is still on-screen and the stale low-seq replay was
  // dropped by the seq guard.
  await expect
    .poll(async () =>
      detailScreen.locator('.xterm-rows').first().evaluate((el) => el.textContent ?? ''),
    )
    .not.toContain('STALE REPLAYED LINE');
});

test('a plain reconnect snapshot still does NOT destroy history (issue-5 guard, no nonce bump)', async ({
  page,
}) => {
  // Twin of the D1 test: verifies the recovery nonce is NOT bumped on a plain
  // reconnect path. Without a backpressure error, a higher-seq reconnect
  // terminal_snapshot must still be ignored as a non-destructive resync so the
  // pre-existing scrollback sentinel survives.
  await page.goto('/pair');
  await page.getByText('Tap to focus').click();
  const detailScreen = page.locator('.terminal-detail-screen');
  await expectXtermText(detailScreen, SNAPSHOT_TEXT);

  await page.evaluate(() => {
    const sockets = ((window as unknown) as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: Array.from({ length: 80 }, (_, index) => `scroll sentinel ${index}`).join('\n') + '\n',
      seq: 88,
    });
  });
  await expectXtermText(detailScreen, 'scroll sentinel 79');

  // Visibility / pageshow recovery reconnect (NOT backpressure): a fresh
  // higher-seq terminal_snapshot arrives over the socket. The recovery nonce
  // must stay put, so the issue-5 guard ignores this snapshot and history
  // survives.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => ((window as unknown) as { __threadtermWs?: unknown[] }).__threadtermWs?.length ?? 0,
      ),
    )
    .toBeGreaterThan(1);

  await page.evaluate(() => {
    const sockets = ((window as unknown) as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_snapshot',
      snapshot: {
        cardId: 'card-1',
        data: '',
        seq: 600,
        rows: 24,
        cols: 80,
        cursorRow: 1,
        cursorCol: 1,
        history: 'reconnect screen only\n',
      },
    });
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: 'post-reconnect streamed line\n',
      seq: 601,
    });
  });

  await expectXtermText(detailScreen, 'post-reconnect streamed line');
  // Decisive issue-5 assertion: pre-reconnect history was NOT wiped because the
  // plain reconnect did not bump the recovery nonce.
  await expectXtermText(detailScreen, 'scroll sentinel 79');
});

test('mobile shell follows the desktop language injected into the pair URL', async ({ page }) => {
  // The desktop injects ?lang=<i18n.language> into the pairing URL (same
  // pattern as the theme_* colors). With lang=zh-CN the mobile chrome must
  // render Chinese instead of the English default.
  await page.goto('/pair?lang=zh-CN');

  await expect(page.getByRole('heading', { name: 'ThreadTerm' })).toBeVisible();
  await expect(page.locator('.section-block', { hasText: '全部会话' })).toBeVisible();
  await expect(page.getByText('点击进入')).toBeVisible();
  await expect(page.locator('.tab-bar').getByText('终端')).toBeVisible();
  await expect(page.locator('.tab-bar').getByText('设置')).toBeVisible();

  // The Settings screen exposes a language switcher; "跟随桌面" (follow
  // desktop) is the active default and English can still be chosen manually.
  await page.locator('.tab-bar').getByText('设置').click();
  await expect(page.getByRole('heading', { name: '语言' })).toBeVisible();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('.tab-bar').getByText('Terminal')).toBeVisible();
});

test('mobile input touch sends exactly once and read-only mode hides controls', async ({ page }) => {
  await page.goto('/pair');
  await page.getByText('Tap to focus').click();

  await page.getByLabel('Mobile terminal input').fill('touch once');
  const enter = page.locator('.input-bar').getByRole('button', { name: 'Enter' });
  await enter.evaluate((button) => {
    button.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const sockets = ((window as unknown) as { __threadtermWs?: Array<{ sent: string[] }> })
          .__threadtermWs;
        return sockets?.at(-1)?.sent.filter((item) => item.includes('touch once')) ?? [];
      }),
    )
    .toHaveLength(1);

  await page.evaluate(() => {
    window.localStorage.setItem('threadterm.bridgePermission', 'read_only');
    window.location.reload();
  });
  await expect(page.getByText('Read-only').first()).toBeVisible();
  await page.getByText('Tap to focus').click();
  await expect(page.getByText('Read-only device')).toBeVisible();
  await expect(page.getByLabel('Mobile terminal input')).toHaveCount(0);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

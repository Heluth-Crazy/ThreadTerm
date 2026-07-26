import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

const ARTIFACT_DIR = path.resolve(process.cwd(), 'e2e-artifacts');
const SNAPSHOT_TEXT = 'ThreadTerm mobile e2e ready';
const OUTPUT_TEXT = 'mobile e2e incremental output line';

async function expectXtermText(scope: Locator, needle: string): Promise<void> {
  await expect
    .poll(
      async () =>
        scope.locator('.xterm-rows').first().evaluate((element) => element.textContent ?? ''),
      { timeout: 10_000 },
    )
    .toContain(needle);
}

async function openTerminal(page: Page, cardName = 'ThreadTerm'): Promise<Locator> {
  const terminalTab = page.getByRole('button', { name: 'Terminal', exact: true });
  if (await terminalTab.isVisible().catch(() => false)) {
    await terminalTab.click();
  }
  const row = page.locator('.instance-row', { hasText: cardName });
  await expect(row).toHaveCount(1);
  await row.locator('.instance-row-main').click();
  const detail = page.locator('.terminal-detail-screen');
  await expect(detail).toBeVisible();
  return detail;
}

const snapshot = {
  protocol_version: 1,
  kind: 'snapshot',
  serverId: 'e2e-computer',
  runtimeId: 'runtime-e2e',
  streamSeq: 0,
  warmingUp: false,
  notifications: [
    {
      id: 'notify-1',
      cardId: 'card-1',
      kind: 'waiting',
      message: 'Input requested by the active session',
      title: 'Terminal waiting for input',
      body: 'Input requested by the active session',
      read: false,
      createdAt: Date.now() - 60_000,
      routing: {
        origin: 'pty',
        family: 'interaction',
        episodeKey: 'card-1:waiting',
      },
    },
  ],
  cards: [
    {
      id: 'card-1',
      status: 'waiting_for_input',
      projectPath: '/Users/me/projects/ThreadTerm',
      projectName: 'ThreadTerm',
      worktreePath: '/Users/me/projects/ThreadTerm/.worktrees/mobile-workbench',
      branchLabel: 'mobile-workbench',
      terminalType: 'codex',
      lastReplyPreview: SNAPSHOT_TEXT,
      summaryLine: SNAPSHOT_TEXT,
      hiddenLineCount: 0,
      recentOutputBytes: 4096,
      ptyLive: true,
      ptyState: 'waiting_for_input',
      attachable: true,
    },
    {
      id: 'card-2',
      status: 'completed',
      projectPath: '/Users/me/projects/docs',
      projectName: 'docs-builder',
      worktreePath: '/Users/me/projects/docs',
      branchLabel: 'main',
      terminalType: 'shell',
      lastReplyPreview: 'Build completed yesterday',
      summaryLine: 'Build completed yesterday',
      hiddenLineCount: 2,
      recentOutputBytes: 1024,
      ptyLive: false,
      ptyState: 'completed',
      attachable: true,
    },
  ],
  workbench: {
    generatedAt: Date.now(),
    summary: {
      attention: 2,
      normalRunning: 0,
      review: 1,
      failed: 0,
    },
    attentionItems: [
      {
        id: 'attention-approval',
        cardId: 'card-1',
        kind: 'approval',
        severity: 'critical',
        sourceKind: 'structured_request',
        sourceId: 'request-1',
        occurredAt: Date.now() - 60_000,
        projectPath: '/Users/me/projects/ThreadTerm',
        projectName: 'ThreadTerm',
        worktreePath: '/Users/me/projects/ThreadTerm/.worktrees/mobile-workbench',
        branchLabel: 'mobile-workbench',
        terminalType: 'codex',
        title: 'Confirm workspace write',
        detail: 'Codex requests permission to update the mobile Workbench implementation.',
        reasonCode: 'structured_approval',
        capability: {
          openRequest: true,
          openTerminal: true,
          openNotification: false,
          openEvidence: true,
        },
      },
      {
        id: 'attention-review',
        cardId: 'card-2',
        kind: 'review',
        severity: 'info',
        sourceKind: 'notification',
        sourceId: 'notify-review',
        occurredAt: Date.now() - 120_000,
        projectPath: '/Users/me/projects/docs',
        projectName: 'docs-builder',
        worktreePath: '/Users/me/projects/docs',
        branchLabel: 'main',
        terminalType: 'shell',
        title: 'Documentation build completed',
        detail: 'The completed result is still unread.',
        reasonCode: 'completed_unread',
        capability: {
          openRequest: false,
          openTerminal: true,
          openNotification: true,
          openEvidence: true,
        },
      },
    ],
    executionGroups: [
      {
        id: 'group-threadterm',
        projectPath: '/Users/me/projects/ThreadTerm',
        projectName: 'ThreadTerm',
        worktreePath: '/Users/me/projects/ThreadTerm/.worktrees/mobile-workbench',
        branchLabel: 'mobile-workbench',
        cardIds: ['card-1'],
        terminalCount: 1,
        terminalTypes: ['codex'],
        attentionCount: 1,
        status: 'attention',
        terminalStatuses: ['waiting'],
        lastActivity: Date.now() - 60_000,
        preview: SNAPSHOT_TEXT,
      },
      {
        id: 'group-docs',
        projectPath: '/Users/me/projects/docs',
        projectName: 'docs-builder',
        worktreePath: '/Users/me/projects/docs',
        branchLabel: 'main',
        cardIds: ['card-2'],
        terminalCount: 1,
        terminalTypes: ['shell'],
        attentionCount: 1,
        status: 'review',
        terminalStatuses: ['completed'],
        lastActivity: Date.now() - 120_000,
        preview: 'Build completed yesterday',
      },
    ],
    rules: {
      includeWaiting: true,
      includeFailed: true,
      includeCompletedReview: true,
      stalledEnabled: true,
      stalledThresholdMinutes: 15,
      stalledExcludedCount: 0,
    },
    capabilities: {
      openTerminal: true,
      respondToStructuredRequest: false,
      updateRules: false,
      updateNotificationReadState: false,
    },
  },
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
    background: '#0b0f14',
    foreground: '#e8edf5',
    cursor: '#e8edf5',
    cursorAccent: '#0b0f14',
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
    window.sessionStorage.setItem('threadterm.bridgeToken', 'device-token');
    window.sessionStorage.setItem('threadterm.bridgeServerId', 'e2e-computer');
    if (!window.sessionStorage.getItem('threadterm.bridgePermission')) {
      window.sessionStorage.setItem('threadterm.bridgePermission', 'full');
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
      private streamSeq = 3;
      private runtimeId = 'runtime-e2e';

      constructor(public url: string) {
        const scope = window as unknown as { __threadtermWs: MockWebSocket[] };
        scope.__threadtermWs ??= [];
        scope.__threadtermWs.push(this);
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          this.emit(themeMessage);
          this.emit(snapshotMessage);
          this.emit({
            protocol_version: 1,
            kind: 'terminal_snapshot',
            snapshot: {
              cardId: 'card-1',
              data: '',
              seq: 1,
              runtimeId: this.runtimeId,
              streamSeq: 0,
              rows: 24,
              cols: 80,
              cursorRow: 1,
              cursorCol: 1,
              history: '\u001b[32mThreadTerm mobile e2e ready\u001b[0m\n',
            },
          });
          this.emit({
            protocol_version: 1,
            kind: 'terminal_output',
            card_id: 'card-1',
            data: 'mobile e2e incremental output line\n',
            seq: 2,
            runtimeId: this.runtimeId,
            streamSeq: 1,
          });
          this.emit({
            protocol_version: 1,
            kind: 'terminal_output',
            card_id: 'card-1',
            data: '\u001b[?1049h\u001b[1;1H┌──── status ────┐\u001b[2;1H│ reconnecting │\u001b[?1049l',
            seq: 3,
            runtimeId: this.runtimeId,
            streamSeq: 2,
          });
        }, 0);
      }

      send(data: string) {
        this.sent.push(data);
        try {
          const parsed = JSON.parse(data) as { kind?: string; data?: string };
          if (parsed.kind === 'ping') {
            window.setTimeout(() => {
              this.emit({
                protocol_version: 1,
                kind: 'pong',
                t: Date.now(),
              });
            }, 0);
          }
          if (parsed.kind === 'input') {
            window.setTimeout(() => {
              this.emit({
                protocol_version: 1,
                kind: 'terminal_output',
                card_id: 'card-1',
                data: `\nmobile command acknowledged: ${parsed.data ?? ''}\n`,
                seq: this.seq++,
                runtimeId: this.runtimeId,
                streamSeq: this.streamSeq++,
              });
            }, 5);
          }
          if (parsed.kind === 'terminal_resync') {
            window.setTimeout(() => {
              this.emit({
                ...snapshotMessage,
                runtimeId: this.runtimeId,
                streamSeq: this.streamSeq - 1,
              });
              this.emit({
                protocol_version: 1,
                kind: 'terminal_snapshot',
                snapshot: {
                  cardId: 'card-1',
                  data: '',
                  seq: 900,
                  runtimeId: this.runtimeId,
                  streamSeq: this.streamSeq - 1,
                  rows: 24,
                  cols: 80,
                  cursorRow: 1,
                  cursorCol: 1,
                  history: 'MOBILE GAP RECOVERY MARKER repainted\n',
                },
              });
            }, 0);
          }
        } catch {
          // The test transport only records malformed sends.
        }
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }

      emit(message: unknown) {
        const sequenced = message as {
          runtimeId?: string;
          streamSeq?: number;
          snapshot?: { runtimeId?: string; streamSeq?: number };
        };
        const runtimeId = sequenced.runtimeId ?? sequenced.snapshot?.runtimeId;
        const streamSeq = sequenced.streamSeq ?? sequenced.snapshot?.streamSeq;
        if (runtimeId && runtimeId !== this.runtimeId) {
          this.runtimeId = runtimeId;
          this.streamSeq = typeof streamSeq === 'number' ? streamSeq + 1 : 0;
        } else if (typeof streamSeq === 'number') {
          this.streamSeq = Math.max(this.streamSeq, streamSeq + 1);
        }
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
      }
    }

    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      MockWebSocket as unknown as typeof WebSocket;
  }, { snapshotMessage: snapshot, themeMessage: theme });
});

test('Workbench is default and terminal detail renders themed xterm with input round-trip', async ({
  page,
  browserName,
}, testInfo) => {
  await page.goto('/pair');

  await expect(page.getByRole('heading', { name: 'Workbench' })).toBeVisible();
  await expect(page.getByText('Confirm workspace write')).toBeVisible();
  await expect(page.locator('.execution-group-card')).toHaveCount(2);
  await expect(page.locator('.xterm')).toHaveCount(0);
  await page.screenshot({
    path: path.join(
      ARTIFACT_DIR,
      browserName === 'webkit'
        ? 'mobile-workbench-webkit.png'
        : 'mobile-workbench-chromium.png',
    ),
  });

  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Terminals' })).toBeVisible();
  const rows = page.locator('.instance-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'ThreadTerm' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'docs-builder' })).toHaveCount(1);
  await expect(page.locator('.xterm')).toHaveCount(0);

  const detail = await openTerminal(page);
  const detailXterm = detail.locator('.xterm');
  await expect(detailXterm).toBeVisible();
  expect((await detailXterm.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  await expectXtermText(detail, SNAPSHOT_TEXT);
  await expectXtermText(detail, OUTPUT_TEXT);

  const screenshotName =
    browserName === 'webkit' ? 'mobile-workbench-terminal-webkit.png' : 'mobile-workbench-terminal-chromium.png';
  await detail.locator('[aria-label="Terminal output"]').screenshot({
    path: path.join(ARTIFACT_DIR, screenshotName),
  });
  await testInfo.attach(screenshotName, {
    path: path.join(ARTIFACT_DIR, screenshotName),
    contentType: 'image/png',
  });

  await page.getByLabel('Mobile terminal input').fill('hello from mobile');
  await page.locator('.input-bar').getByRole('button', { name: 'Enter' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sockets = (window as unknown as { __threadtermWs?: Array<{ sent: string[] }> })
          .__threadtermWs;
        return sockets?.at(-1)?.sent ?? [];
      }),
    )
    .toContainEqual(expect.stringContaining('"data":"hello from mobile\\r"'));
  await expectXtermText(detail, 'mobile command acknowledged');

  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'light', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.mobileThemeMode))
    .toBe('light');

  const themedDetail = await openTerminal(page);
  const hostBackground = await themedDetail
    .locator('.terminal-xterm-host')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(hostBackground).toBe('rgb(11, 15, 20)');
  const viewportBackground = await themedDetail
    .locator('.xterm-viewport')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(viewportBackground).toBe('rgb(11, 15, 20)');
});

test('360px Workbench routes preserve context and never overflow horizontally', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/pair');

  await page.getByText('Confirm workspace write').click();
  await expect(page.getByRole('heading', { name: 'Signal details' })).toBeVisible();
  await expect(page.getByText('Desktop confirmation required')).toBeVisible();
  await page.getByRole('button', { name: 'Open terminal' }).click();
  await expectXtermText(page.locator('.terminal-detail-screen'), SNAPSHOT_TEXT);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Signal details' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Workbench' })).toBeVisible();

  await page.getByRole('button', { name: 'Notifications' }).click();
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByText('Terminal waiting for input')).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('terminal transcript survives viewport changes, remount, resume, and lag refresh', async ({
  page,
}) => {
  await page.goto('/pair');
  let detail = await openTerminal(page);
  await expectXtermText(detail, SNAPSHOT_TEXT);

  await page.setViewportSize({ width: 390, height: 620 });
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
    window.visualViewport?.dispatchEvent(new Event('resize'));
  });
  await expectXtermText(detail, SNAPSHOT_TEXT);

  await page.evaluate(() => {
    const sockets = (window as unknown as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: `${Array.from({ length: 80 }, (_, index) => `scroll sentinel ${index}`).join('\n')}\n`,
      seq: 88,
    });
  });
  await expectXtermText(detail, 'scroll sentinel 79');

  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('.xterm')).toHaveCount(0);
  detail = await openTerminal(page);
  await expectXtermText(detail, 'scroll sentinel 79');

  await page.evaluate(() => {
    const sockets = (window as unknown as {
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
  await expectXtermText(detail, 'scroll sentinel 79');
  const requestsBeforeResume = snapshotRequests;

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
        () => (window as unknown as { __threadtermWs?: unknown[] }).__threadtermWs?.length ?? 0,
      ),
    )
    .toBe(1);
  expect(snapshotRequests).toBe(requestsBeforeResume);
  await expectXtermText(detail, 'scroll sentinel 79');
});

test('closed connections recover, while revoked devices stop retrying', async ({ page }) => {
  await page.goto('/pair');
  await expect(page.getByRole('heading', { name: 'Workbench' })).toBeVisible();

  await page.evaluate(() => {
    const sockets = (window as unknown as {
      __threadtermWs?: Array<{ close: () => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.close();
  });

  await expect(page.getByRole('status')).toHaveText('Reconnecting…');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __threadtermWs?: unknown[] }).__threadtermWs?.length ?? 0,
      ),
    )
    .toBe(2);
  await expect(page.getByRole('status')).toHaveCount(0);

  await page.evaluate(() => {
    const sockets = (window as unknown as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'error',
      code: 'auth_revoked',
      message: 'Device authorization was revoked',
    });
  });

  await expect(page.getByRole('status')).toHaveText(
    'Device access ended. Reopen the desktop QR link to pair again.',
  );
  await page.waitForTimeout(750);
  expect(
    await page.evaluate(
      () => (window as unknown as { __threadtermWs?: unknown[] }).__threadtermWs?.length ?? 0,
    ),
  ).toBe(2);
});

test('plain reconnect snapshot does not destroy terminal history', async ({ page }) => {
  await page.goto('/pair');
  const detail = await openTerminal(page);

  await page.evaluate(() => {
    const sockets = (window as unknown as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: `${Array.from({ length: 80 }, (_, index) => `history sentinel ${index}`).join('\n')}\n`,
      seq: 88,
    });
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

  await expectXtermText(detail, 'post-reconnect streamed line');
  await expectXtermText(detail, 'history sentinel 79');
});

test('backpressure recovery snapshot repaints the dropped segment', async ({ page }) => {
  await page.goto('/pair');
  const detail = await openTerminal(page);
  await expectXtermText(detail, SNAPSHOT_TEXT);

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

  await page.evaluate(() => {
    const sockets = (window as unknown as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'error',
      code: 'backpressure',
      message: 'Client fell behind; intermediate events were dropped.',
    });
  });

  await expectXtermText(detail, 'BACKPRESSURE RECOVERY MARKER repainted');
  await expect.poll(() => snapshotRequests).toBeGreaterThan(1);
});

test('a missing mobile output frame requests one full terminal refresh', async ({ page }) => {
  await page.goto('/pair');
  const detail = await openTerminal(page);
  await expectXtermText(detail, SNAPSHOT_TEXT);

  await page.evaluate(() => {
    const socket = (window as unknown as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs?.at(-1);
    socket?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: 'frame after a missing mobile message\n',
      seq: 100,
      runtimeId: 'runtime-e2e',
      streamSeq: 4,
    });
    socket?.emit({
      protocol_version: 1,
      kind: 'terminal_output',
      card_id: 'card-1',
      data: 'second frame while recovery is pending\n',
      seq: 101,
      runtimeId: 'runtime-e2e',
      streamSeq: 6,
    });
  });

  await expectXtermText(detail, 'MOBILE GAP RECOVERY MARKER repainted');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sent = (window as unknown as {
          __threadtermWs?: Array<{ sent: string[] }>;
        }).__threadtermWs?.at(-1)?.sent ?? [];
        return sent
          .map((entry) => JSON.parse(entry) as { kind?: string })
          .filter((entry) => entry.kind === 'terminal_resync').length;
      }),
    )
    .toBe(1);
});

test('desktop process restart repaints the terminal even when sequence numbers restart', async ({
  page,
}) => {
  await page.goto('/pair');
  const detail = await openTerminal(page);
  await expectXtermText(detail, SNAPSHOT_TEXT);

  await page.evaluate((nextSnapshot) => {
    const socket = (window as unknown as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs?.at(-1);
    socket?.emit({
      ...nextSnapshot,
      runtimeId: 'runtime-after-desktop-restart',
      streamSeq: 0,
    });
    socket?.emit({
      protocol_version: 1,
      kind: 'terminal_snapshot',
      snapshot: {
        cardId: 'card-1',
        data: '',
        seq: 1,
        runtimeId: 'runtime-after-desktop-restart',
        streamSeq: 0,
        rows: 24,
        cols: 80,
        cursorRow: 1,
        cursorCol: 1,
        history: 'DESKTOP RESTART RECOVERY MARKER\n',
      },
    });
  }, snapshot);

  await expectXtermText(detail, 'DESKTOP RESTART RECOVERY MARKER');
});

test('incremental card add/remove and natural exit update the terminal list', async ({ page }) => {
  await page.goto('/pair');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const rows = page.locator('.instance-row');
  await expect(rows).toHaveCount(2);

  await page.evaluate(() => {
    const sockets = (window as unknown as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'card_added',
      card: {
        id: 'card-3',
        status: 'running',
        projectPath: '/Users/me/projects/api-server',
        projectName: 'api-server',
        worktreePath: '/Users/me/projects/api-server',
        branchLabel: 'main',
        terminalType: 'shell',
        lastReplyPreview: 'api-server booting',
        summaryLine: 'api-server booting',
        hiddenLineCount: 0,
        recentOutputBytes: 256,
      },
    });
  });
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'api-server' })).toHaveCount(1);

  await page.evaluate(() => {
    const sockets = (window as unknown as {
      __threadtermWs?: Array<{ emit: (message: unknown) => void }>;
    }).__threadtermWs;
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'card_removed',
      card: {
        id: 'card-2',
        status: 'completed',
        projectPath: '/Users/me/projects/docs',
        projectName: 'docs-builder',
        lastReplyPreview: '',
        summaryLine: null,
        hiddenLineCount: 0,
        recentOutputBytes: 0,
      },
    });
    sockets?.at(-1)?.emit({
      protocol_version: 1,
      kind: 'exit',
      card_id: 'card-1',
      code: 137,
    });
  });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'docs-builder' })).toHaveCount(0);
  await expect(rows.filter({ hasText: 'ThreadTerm' }).locator('.status-badge-failed')).toHaveCount(1);
  expect(snapshotRequests).toBe(1);
});

test('desktop language, touch input, and read-only capability remain correct', async ({ page }) => {
  await page.goto('/pair?lang=zh-CN');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await expect(page.getByRole('heading', { name: '终端' })).toBeVisible();
  await page.locator('.instance-row', { hasText: 'ThreadTerm' }).locator('.instance-row-main').click();

  await page.getByLabel('移动终端输入').fill('touch once');
  const enter = page.locator('.input-bar').getByRole('button', { name: 'Enter' });
  await enter.evaluate((button) => {
    button.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sockets = (window as unknown as { __threadtermWs?: Array<{ sent: string[] }> })
          .__threadtermWs;
        return sockets?.at(-1)?.sent.filter((item) => item.includes('touch once')) ?? [];
      }),
    )
    .toHaveLength(1);

  await page.evaluate(() => {
    window.sessionStorage.setItem('threadterm.bridgePermission', 'read_only');
    window.location.reload();
  });
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await page.locator('.instance-row', { hasText: 'ThreadTerm' }).locator('.instance-row-main').click();
  await expect(page.getByText('只读设备')).toBeVisible();
  await expect(page.getByLabel('移动终端输入')).toHaveCount(0);

  await page.getByRole('button', { name: '返回' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /语言/ }).click();
  await expect(page.getByRole('heading', { name: '语言' })).toBeVisible();
  await page.getByRole('button', { name: 'English English', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
});

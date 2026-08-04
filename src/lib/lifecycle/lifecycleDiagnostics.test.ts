import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLifecycleDiagnosticsSnapshot,
  collectLifecycleDiagnostics,
  installLifecycleDiagnosticsGlobal,
  registerLifecycleDiagnosticsPublisher,
} from './lifecycleDiagnostics';

describe('lifecycleDiagnostics', () => {
  afterEach(() => {
    // Publishers are process-global; each test unregisters via returned cleanup.
  });

  it('builds a schema-stable empty snapshot', () => {
    const snapshot = buildLifecycleDiagnosticsSnapshot({
      capturedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.kind).toBe('threadterm-lifecycle-diagnostics');
    expect(snapshot.terminalSurfaces.maxMountedTerminalViews).toBe(6);
    expect(snapshot.terminalSurfaces.featureFlags.terminalSurfacePoolEnabled).toBe(true);
    expect(snapshot.xterm.registrationCount).toBe(0);
    expect(snapshot.overlays.selector).toBe('unknown');
    expect(snapshot.workspace.maxWarmCleanEditorViews).toBe(2);
    expect(snapshot.workspace.directoryCacheMaxEntries).toBe(128);
    expect(snapshot.workspace.directoryCacheMaxEstimatedBytes).toBe(4 * 1024 * 1024);
    expect(snapshot.workspace.changesCacheMaxEntries).toBe(16);
    expect(snapshot.workspace.agentCatalogMaxRowCount).toBe(2_400);
    expect(snapshot.workspace.agentMetadataCacheMaxEntries).toBe(512);
    expect(snapshot.chat.claudeCleanupPendingCount).toBe(0);
    expect(snapshot.chat.claudeCleanupFailedCount).toBe(0);
    expect(snapshot.chat.mountedRowsPerViewLimit).toBe(160);
    expect(snapshot.chat.mountedMessageRowCount).toBeNull();
  });

  it('merges publisher fragments without inventing windows', () => {
    const stopA = registerLifecycleDiagnosticsPublisher({
      terminalSurfaces: () => ({
        mountedCardIds: ['a', 'b'],
        focusedCardId: 'a',
        maxMountedTerminalViews: 6,
      }),
      cards: () => ({ total: 37, activePtyEstimate: 12 }),
    });
    const stopB = registerLifecycleDiagnosticsPublisher({
      xterm: () => ({
        registrationCount: 2,
        distinctPtyIds: 2,
        ptyIds: ['pty-a', 'pty-b'],
        webglInstanceCount: 2,
      }),
      bridge: () => ({
        activeRuntimeCount: 12,
        activeHeadlessCount: 12,
        pendingBackgroundOutputCount: 0,
        pendingAckCount: 0,
      }),
    });

    const snapshot = collectLifecycleDiagnostics();
    expect(snapshot.cards.total).toBe(37);
    expect(snapshot.cards.activePtyEstimate).toBe(12);
    expect(snapshot.terminalSurfaces.mountedCardIds).toEqual(['a', 'b']);
    expect(snapshot.xterm.registrationCount).toBe(2);
    expect(snapshot.bridge.activeRuntimeCount).toBe(12);

    stopA();
    stopB();
  });

  it('installs a read-only window hook', () => {
    const uninstall = installLifecycleDiagnosticsGlobal();
    expect(typeof window.__threadtermLifecycleDiagnostics).toBe('function');
    const snapshot = window.__threadtermLifecycleDiagnostics?.();
    expect(snapshot?.kind).toBe('threadterm-lifecycle-diagnostics');
    uninstall();
    expect(window.__threadtermLifecycleDiagnostics).toBeUndefined();
  });

  it('swallows publisher errors so sampling cannot crash the UI', () => {
    const stop = registerLifecycleDiagnosticsPublisher({
      cards: () => {
        throw new Error('boom');
      },
      terminalSurfaces: () => ({ mountedCardIds: ['safe'] }),
    });
    expect(() => collectLifecycleDiagnostics()).not.toThrow();
    stop();
  });
});

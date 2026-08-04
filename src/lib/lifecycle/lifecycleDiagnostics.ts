/**
 * lifecycleDiagnostics — read-only snapshot of mounted heavy UI surfaces.
 *
 * Used by Release memory sampling (tools/webview-memory-lifecycle) and tests.
 * Publishing counts must never create windows, start PTYs, or change lifecycle.
 */

export type TerminalSurfacePhase = 'visible' | 'warm' | 'cold' | 'mounted';

export interface TerminalSurfaceDiagnostics {
  /** Card ids currently mounted as TerminalView (xterm may be live). */
  mountedCardIds: string[];
  /** Cards actually shown (main focus and/or float). Empty until Batch 2. */
  visibleCardIds: string[];
  /** Single hidden pre-warm surface after Batch 2; empty until then. */
  warmCardIds: string[];
  /** Cards with live PTY/session but no xterm surface. */
  coldCardIds: string[];
  focusedCardId: string | null;
  floatCardId: string | null;
  maxMountedTerminalViews: number;
  featureFlags: {
    terminalSurfacePoolEnabled: boolean;
  };
}

export interface XtermDiagnostics {
  registrationCount: number;
  distinctPtyIds: number;
  ptyIds: string[];
  webglInstanceCount: number | null;
}

export interface OverlayWindowDiagnostics {
  selector: 'not-created' | 'visible' | 'hidden-low-memory' | 'destroyed' | 'unknown';
  float: 'not-created' | 'visible' | 'hidden-low-memory' | 'destroyed' | 'unknown';
  settings: 'not-created' | 'visible' | 'destroyed' | 'unknown';
}

export interface WorkspaceEditorDiagnostics {
  tabCount: number;
  dirtyTabCount: number;
  activeTabCount: number;
  /** Live CodeMirror / merge editors when reporters are wired. */
  liveEditorInstanceCount: number | null;
  maxWarmCleanEditorViews: number;
  directoryCacheEntryCount: number;
  directoryCacheEstimatedBytes: number;
  directoryCacheMaxEntries: number;
  directoryCacheMaxEstimatedBytes: number;
  directoryCacheEvictionCount: number;
  changesCacheEntryCount: number;
  changesCacheEstimatedBytes: number;
  changesCacheMaxEntries: number;
  changesCacheMaxEstimatedBytes: number;
  changesCacheEvictionCount: number;
  agentCatalogRowCount: number;
  agentCatalogMaxRowCount: number;
  agentCatalogEstimatedBytes: number;
  agentCatalogSelectedSummaryCount: number;
  agentMetadataCacheEntryCount: number;
  agentMetadataCacheMaxEntries: number;
}

export interface ChatDiagnostics {
  claudeCardCount: number;
  claudeItemCount: number;
  claudePendingRequestCount: number;
  codexCardCount: number;
  codexPendingRequestCount: number;
  /** Mounted React rows; null only when no live diagnostics publisher is mounted. */
  mountedMessageRowCount: number | null;
  claudeMountedMessageRowCount: number;
  codexMountedMessageRowCount: number;
  authoritativeMessageCount: number;
  conversationViewCount: number;
  mountedRowsPerViewLimit: number;
  claudeCleanupPendingCount: number;
  claudeCleanupFailedCount: number;
  claudeCleanupSucceededCount: number;
  claudeCleanupRetryCount: number;
}

export interface BridgeRuntimeDiagnostics {
  activeRuntimeCount: number;
  activeHeadlessCount: number;
  pendingBackgroundOutputCount: number;
  pendingAckCount: number;
}

export interface LifecycleDiagnosticsSnapshot {
  schemaVersion: 1;
  kind: 'threadterm-lifecycle-diagnostics';
  capturedAt: string;
  cards: {
    total: number;
    activePtyEstimate: number | null;
  };
  terminalSurfaces: TerminalSurfaceDiagnostics;
  xterm: XtermDiagnostics;
  overlays: OverlayWindowDiagnostics;
  workspace: WorkspaceEditorDiagnostics;
  chat: ChatDiagnostics;
  bridge: BridgeRuntimeDiagnostics;
  notes: string[];
}

export interface LifecycleDiagnosticsPublisher {
  terminalSurfaces?: () => Partial<TerminalSurfaceDiagnostics> | null;
  xterm?: () => Partial<XtermDiagnostics> | null;
  overlays?: () => Partial<OverlayWindowDiagnostics> | null;
  workspace?: () => Partial<WorkspaceEditorDiagnostics> | null;
  chat?: () => Partial<ChatDiagnostics> | null;
  bridge?: () => Partial<BridgeRuntimeDiagnostics> | null;
  cards?: () => { total: number; activePtyEstimate?: number | null } | null;
}

const publishers = new Set<LifecycleDiagnosticsPublisher>();

const DEFAULT_TERMINAL_SURFACES: TerminalSurfaceDiagnostics = {
  mountedCardIds: [],
  visibleCardIds: [],
  warmCardIds: [],
  coldCardIds: [],
  focusedCardId: null,
  floatCardId: null,
  maxMountedTerminalViews: 6,
  featureFlags: {
    terminalSurfacePoolEnabled: true,
  },
};

const DEFAULT_XTERM: XtermDiagnostics = {
  registrationCount: 0,
  distinctPtyIds: 0,
  ptyIds: [],
  webglInstanceCount: null,
};

const DEFAULT_OVERLAYS: OverlayWindowDiagnostics = {
  selector: 'unknown',
  float: 'unknown',
  settings: 'unknown',
};

const DEFAULT_WORKSPACE: WorkspaceEditorDiagnostics = {
  tabCount: 0,
  dirtyTabCount: 0,
  activeTabCount: 0,
  liveEditorInstanceCount: null,
  maxWarmCleanEditorViews: 2,
  directoryCacheEntryCount: 0,
  directoryCacheEstimatedBytes: 0,
  directoryCacheMaxEntries: 128,
  directoryCacheMaxEstimatedBytes: 4 * 1024 * 1024,
  directoryCacheEvictionCount: 0,
  changesCacheEntryCount: 0,
  changesCacheEstimatedBytes: 0,
  changesCacheMaxEntries: 16,
  changesCacheMaxEstimatedBytes: 2 * 1024 * 1024,
  changesCacheEvictionCount: 0,
  agentCatalogRowCount: 0,
  agentCatalogMaxRowCount: 2_400,
  agentCatalogEstimatedBytes: 0,
  agentCatalogSelectedSummaryCount: 0,
  agentMetadataCacheEntryCount: 0,
  agentMetadataCacheMaxEntries: 512,
};

const DEFAULT_CHAT: ChatDiagnostics = {
  claudeCardCount: 0,
  claudeItemCount: 0,
  claudePendingRequestCount: 0,
  codexCardCount: 0,
  codexPendingRequestCount: 0,
  mountedMessageRowCount: null,
  claudeMountedMessageRowCount: 0,
  codexMountedMessageRowCount: 0,
  authoritativeMessageCount: 0,
  conversationViewCount: 0,
  mountedRowsPerViewLimit: 160,
  claudeCleanupPendingCount: 0,
  claudeCleanupFailedCount: 0,
  claudeCleanupSucceededCount: 0,
  claudeCleanupRetryCount: 0,
};

const DEFAULT_BRIDGE: BridgeRuntimeDiagnostics = {
  activeRuntimeCount: 0,
  activeHeadlessCount: 0,
  pendingBackgroundOutputCount: 0,
  pendingAckCount: 0,
};

export function registerLifecycleDiagnosticsPublisher(
  publisher: LifecycleDiagnosticsPublisher,
): () => void {
  publishers.add(publisher);
  return () => {
    publishers.delete(publisher);
  };
}

function mergeDefined<T extends object>(base: T, patch: Partial<T> | null | undefined): T {
  if (!patch) return base;
  const next = { ...base };
  for (const [key, value] of Object.entries(patch) as Array<[keyof T, T[keyof T]]>) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Pure merge helper for tests and the live snapshot builder.
 */
export function buildLifecycleDiagnosticsSnapshot(
  parts: {
    terminalSurfaces?: Partial<TerminalSurfaceDiagnostics> | null;
    xterm?: Partial<XtermDiagnostics> | null;
    overlays?: Partial<OverlayWindowDiagnostics> | null;
    workspace?: Partial<WorkspaceEditorDiagnostics> | null;
    chat?: Partial<ChatDiagnostics> | null;
    bridge?: Partial<BridgeRuntimeDiagnostics> | null;
    cards?: { total: number; activePtyEstimate?: number | null } | null;
    capturedAt?: string;
    notes?: string[];
  } = {},
): LifecycleDiagnosticsSnapshot {
  const cards = parts.cards ?? { total: 0, activePtyEstimate: null };
  return {
    schemaVersion: 1,
    kind: 'threadterm-lifecycle-diagnostics',
    capturedAt: parts.capturedAt ?? new Date().toISOString(),
    cards: {
      total: cards.total,
      activePtyEstimate: cards.activePtyEstimate ?? null,
    },
    terminalSurfaces: mergeDefined(DEFAULT_TERMINAL_SURFACES, parts.terminalSurfaces),
    xterm: mergeDefined(DEFAULT_XTERM, parts.xterm),
    overlays: mergeDefined(DEFAULT_OVERLAYS, parts.overlays),
    workspace: mergeDefined(DEFAULT_WORKSPACE, parts.workspace),
    chat: mergeDefined(DEFAULT_CHAT, parts.chat),
    bridge: mergeDefined(DEFAULT_BRIDGE, parts.bridge),
    notes: parts.notes ?? [
      'Read-only diagnostics. Sampling must not create WebViews or change lifecycle.',
      'terminalSurfacePoolEnabled=false restores the legacy fixed 6-view cap.',
    ],
  };
}

type CardDiagnosticsPart = { total: number; activePtyEstimate?: number | null };

export function collectLifecycleDiagnostics(): LifecycleDiagnosticsSnapshot {
  let terminalSurfaces: Partial<TerminalSurfaceDiagnostics> = {};
  let xterm: Partial<XtermDiagnostics> = {};
  let overlays: Partial<OverlayWindowDiagnostics> = {};
  let workspace: Partial<WorkspaceEditorDiagnostics> = {};
  let chat: Partial<ChatDiagnostics> = {};
  let bridge: Partial<BridgeRuntimeDiagnostics> = {};
  let cardTotals: CardDiagnosticsPart | null = null;

  for (const publisher of publishers) {
    try {
      Object.assign(terminalSurfaces, publisher.terminalSurfaces?.() ?? {});
      Object.assign(xterm, publisher.xterm?.() ?? {});
      Object.assign(overlays, publisher.overlays?.() ?? {});
      Object.assign(workspace, publisher.workspace?.() ?? {});
      Object.assign(chat, publisher.chat?.() ?? {});
      Object.assign(bridge, publisher.bridge?.() ?? {});
      const cardPatch = publisher.cards?.();
      if (cardPatch) {
        // Last publisher wins for card totals (hosts publish once).
        cardTotals = {
          total: cardPatch.total,
          activePtyEstimate: cardPatch.activePtyEstimate ?? null,
        };
      }
    } catch {
      // Diagnostics must never throw into product UI.
    }
  }

  return buildLifecycleDiagnosticsSnapshot({
    terminalSurfaces,
    xterm,
    overlays,
    workspace,
    chat,
    bridge,
    cards: cardTotals,
  });
}

declare global {
  interface Window {
    __threadtermLifecycleDiagnostics?: () => LifecycleDiagnosticsSnapshot;
  }
}

let installCount = 0;

/** Install/uninstall the global read hook used by operators and sample scripts. */
export function installLifecycleDiagnosticsGlobal(): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  installCount += 1;
  window.__threadtermLifecycleDiagnostics = collectLifecycleDiagnostics;
  return () => {
    installCount = Math.max(0, installCount - 1);
    if (installCount === 0 && window.__threadtermLifecycleDiagnostics === collectLifecycleDiagnostics) {
      delete window.__threadtermLifecycleDiagnostics;
    }
  };
}

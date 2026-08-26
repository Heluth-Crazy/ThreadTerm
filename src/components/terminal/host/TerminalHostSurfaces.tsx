import { useEffect, useMemo } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { emitTerminalHostSurface } from '../../../lib/terminalHostBus';
import {
  useTerminalHostSurfacesStore,
  type TerminalHostSurfaceState,
} from '../../../stores/terminalHostStore';
import { useTerminalStore } from '../../../stores/terminalStore';
import { TerminalHostSurfaceCard } from './TerminalHostSurfaceCard';

/** Normalizes Windows paths (`\\?\` verbatim prefixes, slashes) for matching. */
export function normalizeWorkspacePath(path: string | null | undefined): string {
  if (!path) return '';
  const stripped = path.replace(/^\\\\\?\\/, '');
  return stripped.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Hosts every daemon workspace surface inside the main window. Subscribes
 * once to the scoped terminal-host events on the `main` webview, fans them
 * out per handle, and renders one embedded xterm card per presented session.
 */
export function TerminalHostSurfaces() {
  const { t } = useTranslation();
  const order = useTerminalHostSurfacesStore((s) => s.order);
  const surfaces = useTerminalHostSurfacesStore((s) => s.surfaces);
  const applyPresent = useTerminalHostSurfacesStore((s) => s.applyPresent);
  const markReady = useTerminalHostSurfacesStore((s) => s.markReady);
  const markExited = useTerminalHostSurfacesStore((s) => s.markExited);
  const remove = useTerminalHostSurfacesStore((s) => s.remove);
  const clear = useTerminalHostSurfacesStore((s) => s.clear);
  const selectedProjectPath = useTerminalStore((s) => s.selectedProjectPath);

  useEffect(
    () =>
      subscribeToTerminalHostEvents({
        applyPresent,
        markReady,
        markExited,
        remove,
        clear,
      }),
    [applyPresent, markReady, markExited, remove, clear],
  );

  const visible = useMemo(
    () =>
      order
        .map((handle) => surfaces[handle])
        .filter((surface): surface is TerminalHostSurfaceState => Boolean(surface))
        .filter(
          (surface) =>
            !selectedProjectPath ||
            normalizeWorkspacePath(surface.workspacePath) ===
              normalizeWorkspacePath(selectedProjectPath),
        ),
    [order, surfaces, selectedProjectPath],
  );

  if (order.length === 0) return null;

  return (
    <section
      data-testid="terminal-host-surfaces"
      className="border-b border-border bg-background/40 px-4 py-3"
    >
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('terminalHost.workspaceSection', {
          defaultValue: 'Daemon terminals',
          count: order.length,
        })}
      </h2>
      {visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('terminalHost.filteredOut', {
            defaultValue:
              'Terminal sessions are presented in the workspace they were created for.',
          })}
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {visible.map((surface) => (
            <div key={surface.handle} className="h-64 w-[calc(50%-0.375rem)] min-w-[320px]">
              <TerminalHostSurfaceCard
                surface={surface}
                onCloseFailed={(handle, message) => {
                  setMessageFor(handle, message);
                }}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Per-card transient messages live inside each card; a failed close keeps the
// card mounted and simply logs through the console for diagnostics.
function setMessageFor(_handle: string, message: string): void {
  console.warn(`[terminal-host] ${message}`);
}

interface TerminalHostEventHandlers {
  applyPresent: (present: {
    handle: string;
    revision?: number;
    workspacePath?: string | null;
    presentation: 'background' | 'focused';
  }) => void;
  markReady: (handle: string) => void;
  markExited: (handle: string, exitCode: number | null | undefined) => void;
  remove: (handle: string) => void;
  clear: () => void;
}

function subscribeToTerminalHostEvents(handlers: TerminalHostEventHandlers): () => void {
  const unlistens: Array<UnlistenFn | undefined> = [];
  let disposed = false;
  const webviewWindow = getCurrentWebviewWindow();
  void Promise.all([
    webviewWindow.listen<{ handle: string; revision?: number; workspacePath?: string | null; presentation: 'background' | 'focused' }>(
      'terminal-host-workspace-present',
      (event) => handlers.applyPresent(event.payload),
    ),
    webviewWindow.listen<{ handle: string }>(
      'terminal-host-workspace-retired',
      (event) => handlers.remove(event.payload.handle),
    ),
    webviewWindow.listen<unknown>(
      'terminal-host-workspace-cleared',
      () => handlers.clear(),
    ),
    webviewWindow.listen<{
      runtimeId: string;
      handle: string;
      streamId: string;
      attachId: string;
      seq: number;
      dataBase64: string;
    }>('terminal-host-output', (event) =>
      emitTerminalHostSurface({
        kind: 'output',
        payload: event.payload,
      }),
    ),
    webviewWindow.listen<{
      runtimeId: string;
      handle: string;
      streamId: string;
      attachId: string;
      revision: number;
      code?: number | null;
      exitBehavior: 'keep' | 'close-on-success' | 'close-on-exit';
    }>('terminal-host-exit', (event) => {
      handlers.markExited(event.payload.handle, event.payload.code);
      emitTerminalHostSurface({ kind: 'exit', payload: event.payload });
    }),
    webviewWindow.listen<{
      runtimeId: string;
      handle: string;
      streamId: string;
      attachId: string;
    }>('terminal-host-resync-required', (event) =>
      emitTerminalHostSurface({ kind: 'resyncRequired', payload: event.payload }),
    ),
    webviewWindow.listen<{
      runtimeId: string;
      handle: string;
      streamId: string;
      attachId: string;
    }>('terminal-host-ready-confirmed', (event) => {
      handlers.markReady(event.payload.handle);
      emitTerminalHostSurface({ kind: 'readyConfirmed', payload: event.payload });
    }),
    webviewWindow.listen<{ handle: string; revision: number }>(
      'terminal-host-surface-changed',
      (event) => {
        emitTerminalHostSurface({ kind: 'surfaceChanged', payload: event.payload });
      },
    ),
  ]).then((fns) => {
    if (disposed) fns.forEach((fn) => fn?.());
    else unlistens.push(...fns);
  });

  return () => {
    disposed = true;
    unlistens.forEach((fn) => fn?.());
  };
}

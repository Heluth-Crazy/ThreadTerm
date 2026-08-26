import type {
  TerminalExitEvent,
  TerminalOutputEvent,
} from '../windows/terminal-host/protocol';

/** Attachment identity shared by the daemon's control events. */
export interface TerminalHostSurfaceIdentity {
  runtimeId: string;
  handle: string;
  streamId: string;
  attachId: string;
}

/**
 * Per-handle event fan-out for daemon workspace cards hosted in the main
 * window. The Rust side emits one scoped Tauri event per kind to the `main`
 * webview; this bus forwards each payload to the card that owns its handle so
 * many surfaces can share a single webview without cross-talk.
 */
export type TerminalHostSurfaceEvent =
  | { kind: 'output'; payload: TerminalOutputEvent }
  | { kind: 'exit'; payload: TerminalExitEvent }
  | { kind: 'resyncRequired'; payload: TerminalHostSurfaceIdentity }
  | { kind: 'readyConfirmed'; payload: TerminalHostSurfaceIdentity }
  | { kind: 'surfaceChanged'; payload: { handle: string; revision: number } };

type Listener = (event: TerminalHostSurfaceEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function onTerminalHostSurface(
  handle: string,
  listener: Listener,
): () => void {
  let set = listeners.get(handle);
  if (!set) {
    set = new Set();
    listeners.set(handle, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(handle);
  };
}

export function emitTerminalHostSurface(event: TerminalHostSurfaceEvent): void {
  const set = listeners.get(
    event.kind === 'surfaceChanged' ? event.payload.handle : event.payload.handle,
  );
  if (!set) return;
  for (const listener of [...set]) listener(event);
}

/** Test hook: drops every registration. */
export function resetTerminalHostSurfaceListeners(): void {
  listeners.clear();
}

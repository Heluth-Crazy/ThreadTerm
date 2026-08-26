import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { decodeBase64Bytes, encodeBase64Bytes } from './base64';
import type { SurfaceBootstrap, TerminalExitEvent, TerminalHostRequest, TerminalOutputEvent } from './protocol';
import { requestFor } from './protocol';
import { OutputSequenceGuard } from './sequencing';
import { TerminalWriteQueue } from './writeQueue';
import { shouldFocusAfterSurfaceReady } from './presentation';
import { SurfaceReadyGate } from './readyGate';
import { shouldCloseForExit } from './exitBehavior';
import { BootstrapEventGuard, matchesSurfaceIdentity } from './bootstrap';
import { listenOnTerminalWindow } from './windowEvents';
import './terminal-host.css';

const SURFACE_CLASS = 'threadterm-xterm-host';
const BOOTSTRAP_EVENT = 'terminal-host-bootstrap';
const READY_CONFIRMED_EVENT = 'terminal-host-ready-confirmed';

interface BootstrapEventPayload {
  surface: SurfaceBootstrap;
  notifyReady: boolean;
}

function identity(surface: SurfaceBootstrap) {
  return {
    runtimeId: surface.runtimeId,
    handle: surface.handle,
    streamId: surface.streamId,
    attachId: surface.attachId,
  };
}

function hasUsableGeometry(surface: HTMLElement, terminal: Terminal): boolean {
  return surface.clientWidth > 0 && surface.clientHeight > 0 && terminal.rows > 0 && terminal.cols > 0;
}

function readyKey(surface: SurfaceBootstrap): string {
  return `${surface.runtimeId}:${surface.handle}:${surface.revision}:${surface.streamId}:${surface.attachId}`;
}

export function TerminalHostApp() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const surfaceRef = useRef<SurfaceBootstrap | null>(null);
  const guardRef = useRef(new OutputSequenceGuard());
  const queueRef = useRef<TerminalWriteQueue | null>(null);
  const resyncingRef = useRef(false);
  const closingSurfaceRef = useRef<string | null>(null);
  const [message, setMessage] = useState('Connecting terminal…');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      scrollback: 3000,
      scrollOnEraseInDisplay: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const webviewWindow = getCurrentWebviewWindow();
    terminalRef.current = terminal;
    queueRef.current = new TerminalWriteQueue(terminal);
    const readyGate = new SurfaceReadyGate();
    const bootstrapEvents = new BootstrapEventGuard();

    const invokeRequest = <T,>(command: string, request: TerminalHostRequest): Promise<T> =>
      invoke<T>(command, { request });

    const resize = () => {
      const surface = surfaceRef.current;
      if (!surface || !hasUsableGeometry(host, terminal)) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (!hasUsableGeometry(host, terminal)) return;
      void invoke('terminal_host_resize', {
        request: { ...requestFor(surface), rows: terminal.rows, cols: terminal.cols },
      }).catch(() => {});
    };

    const acknowledge = (surface: SurfaceBootstrap, throughSeq: number) =>
      invoke('terminal_host_ack', {
        request: { ...requestFor(surface), throughSeq },
      }).catch(() => {});

    const trySurfaceReady = () => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const key = readyKey(surface);
      try {
        fit.fit();
      } catch {
        return;
      }
      if (!hasUsableGeometry(host, terminal)) {
        setMessage('Waiting for a usable terminal size…');
        return;
      }
      if (!readyGate.takeIfReady(key, true)) return;
      // Dynamic terminal WebViews can execute a custom command while never
      // settling its response Promise. Native owns resize -> ready ordering;
      // correctness does not depend on a WebView command continuation.
      void invoke('terminal_host_surface_ready', {
        request: { ...requestFor(surface), rows: terminal.rows, cols: terminal.cols },
      }).catch(() => {});
    };

    const installSnapshot = (surface: SurfaceBootstrap, ready: boolean) => {
      const queue = queueRef.current;
      if (!queue) return;
      if (surface.placement !== 'window') {
        setMessage(`Unsupported terminal placement: ${surface.placement}`);
        return;
      }
      surfaceRef.current = surface;
      closingSurfaceRef.current = null;
      guardRef.current.beginEpoch(identity(surface), surface.barrierSeq);
      if (ready) readyGate.arm(readyKey(surface));
      // One-way geometry checkpoint: command execution does not depend on its
      // response Promise, and the snapshot remains authoritative for the PTY.
      void invoke('terminal_host_resize', {
        request: {
          ...requestFor(surface),
          rows: surface.snapshot.rows,
          cols: surface.snapshot.cols,
        },
      }).catch(() => {});
      // A snapshot replaces (rather than appends to) a previous renderer epoch.
      queue.replaceAll([
        ...(surface.snapshot.historyBase64 ? [decodeBase64Bytes(surface.snapshot.historyBase64)] : []),
        decodeBase64Bytes(surface.snapshot.contentBase64),
      ], () => terminal.reset(), () => {
        acknowledge(surface, surface.barrierSeq);
        if (!ready) return;
        readyGate.markSnapshotWritten(readyKey(surface));
        trySurfaceReady();
      });
    };

    const acceptBootstrap = (surface: SurfaceBootstrap, notifyReady: boolean) => {
      if (!bootstrapEvents.take(surface)) return;
      resyncingRef.current = false;
      installSnapshot(surface, notifyReady);
    };

    const onBootstrap = (event: { payload: BootstrapEventPayload }) => {
      acceptBootstrap(event.payload.surface, event.payload.notifyReady);
    };

    const onReadyConfirmed = (event: { payload: TerminalHostRequest }) => {
      const surface = surfaceRef.current;
      if (!surface || !matchesSurfaceIdentity(surface, event.payload)) return;
      setMessage('');
      // A background presentation must never focus its WebView or xterm.
      if (shouldFocusAfterSurfaceReady(surface.presentation)) terminal.focus();
    };

    const bootstrap = () => {
      // Native pushes the typed bootstrap via the scoped window event; the
      // command continuation is intentionally not depended upon.
      void invoke<void>('terminal_host_surface_bootstrap').catch(() => {});
    };

    const resync = () => {
      const surface = surfaceRef.current;
      if (!surface || resyncingRef.current) return;
      resyncingRef.current = true;
      void invokeRequest<void>('terminal_host_resync', requestFor(surface)).catch(() => {});
    };

    const onOutput = (event: { payload: TerminalOutputEvent }) => {
      const current = surfaceRef.current;
      const queue = queueRef.current;
      if (!current || !queue) return;
      const payload = event.payload;
      const decision = guardRef.current.decide(payload, payload.seq);
      if (decision === 'resync') {
        resync();
        return;
      }
      if (decision !== 'accept') return;
      queue.write(decodeBase64Bytes(payload.dataBase64), () => acknowledge(current, payload.seq));
    };

    const onResync = (event: { payload: Omit<TerminalOutputEvent, 'seq' | 'dataBase64'> }) => {
      if (!guardRef.current.matches(event.payload)) return;
      resync();
    };

    const onExit = (event: { payload: TerminalExitEvent }) => {
      const current = surfaceRef.current;
      const queue = queueRef.current;
      if (!current || !queue
        || event.payload.runtimeId !== current.runtimeId
        || event.payload.handle !== current.handle
        || event.payload.streamId !== current.streamId
        || event.payload.attachId !== current.attachId
        // The exit transition bumps the daemon revision past the presented
        // revision; only strictly older revisions are stale.
        || event.payload.revision < current.revision) return;
      setMessage(event.payload.code == null ? 'Terminal exited.' : `Terminal exited (${event.payload.code}).`);
      if (!shouldCloseForExit(event.payload.exitBehavior, event.payload.code)) return;
      const key = readyKey(current);
      if (closingSurfaceRef.current === key) return;
      closingSurfaceRef.current = key;
      queue.whenDrained(() => {
        void invoke('terminal_host_surface_hidden', { request: requestFor(current) }).catch(() => {
          if (surfaceRef.current != null && readyKey(surfaceRef.current) === key) {
            closingSurfaceRef.current = null;
            setMessage('Terminal exited, but its window could not be closed.');
          }
        });
      });
    };

    const observer = new ResizeObserver(() => {
      resize();
      trySurfaceReady();
    });
    observer.observe(host);
    const unlistens: UnlistenFn[] = [];
    let disposed = false;
    void Promise.all([
      listenOnTerminalWindow<BootstrapEventPayload>(webviewWindow, BOOTSTRAP_EVENT, onBootstrap),
      listenOnTerminalWindow<TerminalHostRequest>(webviewWindow, READY_CONFIRMED_EVENT, onReadyConfirmed),
      listenOnTerminalWindow<TerminalOutputEvent>(webviewWindow, 'terminal-host-output', onOutput),
      listenOnTerminalWindow<Omit<TerminalOutputEvent, 'seq' | 'dataBase64'>>(
        webviewWindow,
        'terminal-host-resync-required',
        onResync,
      ),
      listenOnTerminalWindow<TerminalExitEvent>(webviewWindow, 'terminal-host-exit', onExit),
      // A same-handle present transfer reuses this WebView. The daemon has
      // already detached the former lease; bootstrap establishes the new epoch.
      listenOnTerminalWindow<{ revision: number }>(webviewWindow, 'terminal-host-surface-changed', bootstrap),
    ]).then((nextUnlistens) => {
      if (disposed) nextUnlistens.forEach((unlisten) => unlisten());
      else {
        unlistens.push(...nextUnlistens);
        // The daemon may start output as soon as surface.ready succeeds, so
        // establish every event listener before bootstrapping that handshake.
        bootstrap();
      }
    }).catch(() => setMessage('Terminal event channel is unavailable.'));

    terminal.onData((data) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const bytes = new TextEncoder().encode(data);
      void invoke('terminal_host_input', {
        request: { ...requestFor(surface), dataBase64: encodeBase64Bytes(bytes) },
      }).catch(() => {});
    });

    return () => {
      disposed = true;
      observer.disconnect();
      unlistens.forEach((unlisten) => unlisten());
      terminal.dispose();
      terminalRef.current = null;
      queueRef.current = null;
    };
  }, []);

  return (
    <main className="terminal-host-window">
      <div ref={hostRef} className={SURFACE_CLASS} data-terminal-context-menu="true" />
      {message && <div className="terminal-host-status" role="status">{message}</div>}
    </main>
  );
}

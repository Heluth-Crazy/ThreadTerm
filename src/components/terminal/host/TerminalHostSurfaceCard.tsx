import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { useTheme } from '../../../theme/ThemeContext';
import {
  decodeBase64Bytes,
  encodeBase64Bytes,
} from '../../../windows/terminal-host/base64';
import type {
  SurfaceBootstrap,
  TerminalExitEvent,
  TerminalHostRequest,
  TerminalOutputEvent,
} from '../../../windows/terminal-host/protocol';
import { requestFor } from '../../../windows/terminal-host/protocol';
import { OutputSequenceGuard } from '../../../windows/terminal-host/sequencing';
import { TerminalWriteQueue } from '../../../windows/terminal-host/writeQueue';
import { SurfaceReadyGate } from '../../../windows/terminal-host/readyGate';
import { shouldCloseForExit } from '../../../windows/terminal-host/exitBehavior';
import {
  onTerminalHostSurface,
  type TerminalHostSurfaceEvent,
} from '../../../lib/terminalHostBus';
import type { TerminalHostSurfaceState } from '../../../stores/terminalHostStore';

interface TerminalHostSurfaceCardProps {
  surface: TerminalHostSurfaceState;
  onCloseFailed: (handle: string, message: string) => void;
}

/**
 * One daemon session rendered as an embedded xterm card inside the main
 * window. Mirrors the dedicated-window renderer's snapshot/ACK/ready state
 * machine, but addresses its surface by handle because many cards share the
 * `main` webview.
 */
export function TerminalHostSurfaceCard({
  surface,
  onCloseFailed,
}: TerminalHostSurfaceCardProps) {
  const { handle, workspacePath, presentation, status, exitCode } = surface;
  const { terminalTheme } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const surfaceRef = useRef<SurfaceBootstrap | null>(null);
  const queueRef = useRef<TerminalWriteQueue | null>(null);
  const guardRef = useRef(new OutputSequenceGuard());
  const gateRef = useRef(new SurfaceReadyGate());
  const closingRef = useRef<string | null>(null);
  const [message, setMessage] = useState('Connecting…');
  const [closingUi, setClosingUi] = useState(false);

  const hasUsableGeometry = (): boolean => {
    const host = hostRef.current;
    const terminal = terminalRef.current;
    return Boolean(
      host &&
        terminal &&
        host.clientWidth > 0 &&
        host.clientHeight > 0 &&
        terminal.rows > 0 &&
        terminal.cols > 0,
    );
  };

  const acknowledge = useCallback(
    (target: SurfaceBootstrap, throughSeq: number) => {
      void invoke('terminal_host_ack', {
        request: { ...requestFor(target), throughSeq },
      }).catch(() => {});
    },
    [],
  );

  const tryReady = useCallback(() => {
    const target = surfaceRef.current;
    const fit = fitRef.current;
    if (!target || !fit) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    if (!hasUsableGeometry()) {
      setMessage('Waiting for a usable terminal size…');
      return;
    }
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (!gateRef.current.takeIfReady(requestKey(target), true)) return;
    void invoke('terminal_host_surface_ready', {
      request: {
        ...requestFor(target),
        rows: terminal.rows,
        cols: terminal.cols,
      },
    })
      .then(() => setMessage(''))
      .catch(() => {
        // The renderer never depends on the command continuation; readiness
        // is confirmed through the scoped ready-confirmed event instead.
      });
  }, []);

  const installSnapshot = useCallback(
    (payload: SurfaceBootstrap, notifyReady: boolean) => {
      const queue = queueRef.current;
      const terminal = terminalRef.current;
      if (!queue || !terminal) return;
      surfaceRef.current = payload;
      closingRef.current = null;
      guardRef.current.beginEpoch(
        {
          runtimeId: payload.runtimeId,
          handle: payload.handle,
          streamId: payload.streamId,
          attachId: payload.attachId,
        },
        payload.barrierSeq,
      );
      if (notifyReady) gateRef.current.arm(requestKey(payload));
      void invoke('terminal_host_resize', {
        request: {
          ...requestFor(payload),
          rows: payload.snapshot.rows,
          cols: payload.snapshot.cols,
        },
      }).catch(() => {});
      queue.replaceAll(
        [
          ...(payload.snapshot.historyBase64
            ? [decodeBase64Bytes(payload.snapshot.historyBase64)]
            : []),
          decodeBase64Bytes(payload.snapshot.contentBase64),
        ],
        () => terminal.reset(),
        () => {
          acknowledge(payload, payload.barrierSeq);
          if (!notifyReady) return;
          gateRef.current.markSnapshotWritten(requestKey(payload));
          tryReady();
        },
      );
    },
    [acknowledge, tryReady],
  );

  const bootstrap = useCallback(() => {
    void invoke<SurfaceBootstrap>('terminal_host_surface_bootstrap', { handle })
      .then((payload) => installSnapshot(payload, true))
      .catch(() => setMessage('Terminal session is unavailable.'));
  }, [handle, installSnapshot]);

  // Mount xterm once; re-run the bootstrap handshake whenever the epoch
  // changes (present/re-present/resync).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily:
        'Cascadia Mono, Menlo, Monaco, "Courier New", Consolas, monospace',
      allowProposedApi: true,
      scrollback: 3000,
      scrollOnEraseInDisplay: false,
      theme: terminalTheme,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    queueRef.current = new TerminalWriteQueue(terminal);
    setMessage(status === 'exited' ? 'Terminal exited.' : 'Connecting…');

    terminal.onData((data) => {
      const target = surfaceRef.current;
      if (!target) return;
      const bytes = new TextEncoder().encode(data);
      void invoke('terminal_host_input', {
        request: {
          ...requestFor(target),
          dataBase64: encodeBase64Bytes(bytes),
        },
      }).catch(() => {});
    });

    bootstrap();

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      queueRef.current = null;
      surfaceRef.current = null;
    };
    // `status === 'exited'` only differs on remount-after-transfer; the epoch
    // restart is driven by the surface-changed bus event below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  // Theme updates apply live.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = terminalTheme;
  }, [terminalTheme]);

  // Resize with layout.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const fit = fitRef.current;
      if (!fit) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const target = surfaceRef.current;
      const terminal = terminalRef.current;
      if (target && terminal && hasUsableGeometry()) {
        void invoke('terminal_host_resize', {
          request: {
            ...requestFor(target),
            rows: terminal.rows,
            cols: terminal.cols,
          },
        }).catch(() => {});
      }
      tryReady();
    });
    observer.observe(host);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-handle daemon events.
  useEffect(() => {
    const listener = (event: TerminalHostSurfaceEvent): void => {
      const target = surfaceRef.current;
      if (!target) return;
      switch (event.kind) {
        case 'output': {
          const payload = event.payload as TerminalOutputEvent;
          const queue = queueRef.current;
          if (!queue || !matchesIdentity(target, payload)) return;
          const decision = guardRef.current.decide(
            {
              runtimeId: payload.runtimeId,
              handle: payload.handle,
              streamId: payload.streamId,
              attachId: payload.attachId,
            },
            payload.seq,
          );
          if (decision === 'resync') {
            void invoke('terminal_host_resync', {
              request: requestFor(target),
            }).catch(() => {});
            return;
          }
          if (decision !== 'accept') return;
          queue.write(decodeBase64Bytes(payload.dataBase64), () =>
            acknowledge(target, payload.seq),
          );
          return;
        }
        case 'exit': {
          const payload = event.payload as TerminalExitEvent;
          if (
            payload.runtimeId !== target.runtimeId ||
            payload.handle !== target.handle ||
            payload.streamId !== target.streamId ||
            payload.attachId !== target.attachId
          ) {
            return;
          }
          setMessage(
            payload.code == null
              ? 'Terminal exited.'
              : `Terminal exited (${payload.code}).`,
          );
          if (!shouldCloseForExit(payload.exitBehavior, payload.code)) return;
          const key = requestKey(target);
          if (closingRef.current === key) return;
          closingRef.current = key;
          const queue = queueRef.current;
          const finishClose = () => {
            void invoke('terminal_host_surface_hidden', {
              request: requestFor(target),
            })
              .catch(() => {
                onCloseFailed(handle, 'Terminal exited, but its card could not be closed.');
              })
              .finally(() => setClosingUi(false));
          };
          if (queue) queue.whenDrained(finishClose);
          else finishClose();
          return;
        }
        case 'resyncRequired':
          if (matchesIdentity(target, event.payload)) {
            void invoke('terminal_host_resync', {
              request: requestFor(target),
            }).catch(() => {});
          }
          return;
        case 'surfaceChanged':
          if (event.payload.handle === handle) bootstrap();
          return;
        case 'readyConfirmed':
          if (matchesIdentity(target, event.payload)) {
            setMessage('');
            if (presentation === 'focused') terminalRef.current?.focus();
          }
          return;
        default:
          return;
      }
    };
    return onTerminalHostSurface(handle, listener);
  }, [handle, presentation, acknowledge, bootstrap, onCloseFailed]);

  const closeManually = () => {
    const target = surfaceRef.current;
    if (!target || closingUi) return;
    setClosingUi(true);
    void invoke('terminal_host_surface_hidden', { request: requestFor(target) })
      .catch(() => {
        setClosingUi(false);
        onCloseFailed(handle, 'The terminal card could not be closed.');
      })
      .finally(() => setClosingUi(false));
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-[#111827]" data-testid="terminal-host-card">
      <div className="flex items-center gap-2 border-b border-border bg-background/60 px-3 py-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden
          className={
            status === 'ready'
              ? 'h-2 w-2 rounded-full bg-emerald-500'
              : status === 'exited'
                ? 'h-2 w-2 rounded-full bg-zinc-500'
                : 'h-2 w-2 animate-pulse rounded-full bg-amber-400'
          }
        />
        <span className="truncate font-medium" title={workspacePath ?? handle}>
          {workspacePath ?? handle}
        </span>
        <span className="ml-auto shrink-0 opacity-70">
          {status === 'exited' ? `exited${exitCode != null ? ` · ${exitCode}` : ''}` : 'daemon'}
        </span>
        <button
          type="button"
          aria-label="Hide terminal"
          disabled={closingUi}
          onClick={closeManually}
          className="rounded p-0.5 hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="threadterm-xterm-host absolute inset-0" />
        {message && (
          <div className="pointer-events-none absolute bottom-2 left-3 right-3 rounded bg-black/80 px-2 py-1 text-xs text-zinc-300">
            {message}
          </div>
        )}
      </div>
    </div>
  );
}

function requestKey(surface: SurfaceBootstrap): string {
  return `${surface.runtimeId}:${surface.handle}:${surface.revision}:${surface.streamId}:${surface.attachId}`;
}

function matchesIdentity(
  surface: SurfaceBootstrap,
  request: Pick<
    TerminalHostRequest,
    'runtimeId' | 'handle' | 'streamId' | 'attachId'
  >,
): boolean {
  return (
    surface.runtimeId === request.runtimeId &&
    surface.handle === request.handle &&
    surface.streamId === request.streamId &&
    surface.attachId === request.attachId
  );
}

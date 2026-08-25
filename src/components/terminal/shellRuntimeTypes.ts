import type { createOutputAcknowledger } from './outputAcknowledger';
import type { createOutputSequencer } from './outputSequencer';
import type { OneShotRunState, TerminalExecutionMode } from '../../types/terminal';
import type { PtyProviderStartupIntent } from '../../types/ptyStartup';

export type OutputSequencer = ReturnType<typeof createOutputSequencer>;
export type OutputAcknowledger = ReturnType<typeof createOutputAcknowledger>;
export type Unlisten = () => void;

export interface ShellProject {
  name: string;
  path: string;
  fullPath?: string;
}

export interface ShellProps {
  selectedProject?: ShellProject | null;
  /** Provider id used to inject the per-process statistics proxy route. */
  terminalType?: string;
  initialCommand?: string;
  /** Backend-owned Provider launch descriptor. Never dispatched through `pty.input`. */
  providerStartup?: PtyProviderStartupIntent;
  minimal?: boolean;
  autoConnect?: boolean;
  paneId?: string;
  onDisconnect?: () => void;
  active?: boolean;
  rendererScope?: string;
  preservePtyOnUnmount?: boolean;
  suppressInitialCommandWhenPtyExists?: boolean;
  resumeLoading?: boolean;
  autoReconnectOnExit?: boolean;
  /** Opt-in execute-and-exit launch; interactive remains the default. */
  executionMode?: TerminalExecutionMode;
  oneShotRunState?: OneShotRunState;
  oneShotFinalOutput?: string;
  onOneShotRunStarted?: () => void;
  onOneShotRunInterrupted?: () => void;
  onUserSubmit?: () => void;
}

export interface TerminalSize {
  rows: number;
  cols: number;
}

export interface ShellExitInfo {
  code: number | null;
}

export interface RendererOutputConsumer {
  ptyId: string;
  consumerId: string;
  acknowledger: OutputAcknowledger;
  heartbeatTimer: number | null;
  needsSnapshotRecovery: boolean;
  recoveryPromise: Promise<boolean> | null;
  disposed: boolean;
}

export interface DetachCurrentPtyOptions {
  clearTerminal?: boolean;
  kill?: boolean;
}

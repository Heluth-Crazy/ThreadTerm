import type { createOutputAcknowledger } from './outputAcknowledger';
import type { createOutputSequencer } from './outputSequencer';

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
  initialCommand?: string;
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
  onInitialCommandSent?: () => void;
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

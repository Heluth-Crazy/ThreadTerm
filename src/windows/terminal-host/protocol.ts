export type Presentation = 'background' | 'focused';
export type ExitBehavior = 'keep' | 'close-on-success' | 'close-on-exit';

export interface TerminalSnapshot {
  contentBase64: string;
  historyBase64?: string | null;
  rows: number;
  cols: number;
  cursorRow: number;
  cursorCol: number;
}

export interface SurfaceBootstrap {
  runtimeId: string;
  handle: string;
  revision: number;
  placement: string;
  presentation: Presentation;
  attachId: string;
  streamId: string;
  barrierSeq: number;
  snapshot: TerminalSnapshot;
}

export interface TerminalOutputEvent {
  runtimeId: string;
  handle: string;
  streamId: string;
  attachId: string;
  seq: number;
  dataBase64: string;
}

export interface TerminalExitEvent {
  runtimeId: string;
  handle: string;
  streamId: string;
  attachId: string;
  revision: number;
  code?: number | null;
  exitBehavior: ExitBehavior;
}

export interface TerminalHostRequest {
  runtimeId: string;
  handle: string;
  revision: number;
  attachId: string;
  streamId: string;
}

export function requestFor(
  surface: Pick<SurfaceBootstrap, 'runtimeId' | 'handle' | 'revision' | 'attachId' | 'streamId'>,
): TerminalHostRequest {
  return {
    runtimeId: surface.runtimeId,
    handle: surface.handle,
    revision: surface.revision,
    attachId: surface.attachId,
    streamId: surface.streamId,
  };
}

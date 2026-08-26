import { beforeEach, describe, expect, it } from 'vitest';
import {
  emitTerminalHostSurface,
  onTerminalHostSurface,
  resetTerminalHostSurfaceListeners,
} from './terminalHostBus';
import { useTerminalHostSurfacesStore } from '../stores/terminalHostStore';
import type { TerminalOutputEvent } from '../windows/terminal-host/protocol';

function presentArgs(handle: string) {
  return {
    handle,
    revision: 2,
    workspacePath: 'D:/repo',
    presentation: 'background' as const,
  };
}

describe('terminal host workspace surfaces', () => {
  beforeEach(() => {
    resetTerminalHostSurfaceListeners();
    useTerminalHostSurfacesStore.getState().clear();
  });

  it('registers a surface on present and keeps insertion order', () => {
    const store = useTerminalHostSurfacesStore.getState();
    store.applyPresent(presentArgs('handle-a'));
    store.applyPresent(presentArgs('handle-b'));
    const state = useTerminalHostSurfacesStore.getState();
    expect(state.order).toEqual(['handle-a', 'handle-b']);
    expect(state.surfaces['handle-a']).toMatchObject({
      handle: 'handle-a',
      revision: 2,
      workspacePath: 'D:/repo',
      status: 'attaching',
    });
  });

  it('re-presenting an existing handle restarts the handshake without duplicating order', () => {
    const store = useTerminalHostSurfacesStore.getState();
    store.applyPresent(presentArgs('handle-a'));
    useTerminalHostSurfacesStore.getState().markReady('handle-a');
    store.applyPresent({ ...presentArgs('handle-a'), revision: 3 });
    const state = useTerminalHostSurfacesStore.getState();
    expect(state.order).toEqual(['handle-a']);
    expect(state.surfaces['handle-a']).toMatchObject({
      revision: 3,
      status: 'attaching',
    });
  });

  it('markExited records the exit code and remove drops the card', () => {
    const store = useTerminalHostSurfacesStore.getState();
    store.applyPresent(presentArgs('handle-a'));
    useTerminalHostSurfacesStore.getState().markExited('handle-a', 0);
    expect(useTerminalHostSurfacesStore.getState().surfaces['handle-a'].status).toBe(
      'exited',
    );
    expect(
      useTerminalHostSurfacesStore.getState().surfaces['handle-a'].exitCode,
    ).toBe(0);
    useTerminalHostSurfacesStore.getState().remove('handle-a');
    expect(useTerminalHostSurfacesStore.getState().order).toEqual([]);
    expect(useTerminalHostSurfacesStore.getState().surfaces).toEqual({});
  });

  it('clear drops every surface (runtime identity change)', () => {
    const store = useTerminalHostSurfacesStore.getState();
    store.applyPresent(presentArgs('handle-a'));
    store.applyPresent(presentArgs('handle-b'));
    useTerminalHostSurfacesStore.getState().clear();
    expect(useTerminalHostSurfacesStore.getState().surfaces).toEqual({});
    expect(useTerminalHostSurfacesStore.getState().order).toEqual([]);
  });

  it('fans bus events out only to the owning handle', () => {
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const unlistenA = onTerminalHostSurface('handle-a', (event) => {
      if (event.kind === 'output') receivedA.push(event.payload.dataBase64);
    });
    onTerminalHostSurface('handle-b', (event) => {
      if (event.kind === 'output') receivedB.push(event.payload.dataBase64);
    });
    const payload: TerminalOutputEvent = {
      runtimeId: 'rt',
      handle: 'handle-a',
      streamId: 'stream-a',
      attachId: 'attach-a',
      seq: 1,
      dataBase64: 'YQ==',
    };
    // A payload for handle-b must not reach the handle-a listener.
    emitTerminalHostSurface({ kind: 'output', payload: { ...payload, handle: 'handle-b' } });
    expect(receivedA).toEqual([]);
    expect(receivedB).toEqual(['YQ==']);
    // The stale listener is removable without affecting others.
    unlistenA();
    emitTerminalHostSurface({ kind: 'output', payload });
    expect(receivedA).toEqual([]);
    expect(receivedB).toEqual(['YQ==']);
  });

  it('surfaceChanged events route by handle from the payload itself', () => {
    const changed: string[] = [];
    const unlisten = onTerminalHostSurface('handle-x', (event) => {
      if (event.kind === 'surfaceChanged') changed.push(event.payload.handle);
    });
    emitTerminalHostSurface({
      kind: 'surfaceChanged',
      payload: { handle: 'handle-x', revision: 5 },
    });
    unlisten();
    emitTerminalHostSurface({
      kind: 'surfaceChanged',
      payload: { handle: 'handle-x', revision: 6 },
    });
    expect(changed).toEqual(['handle-x']);
  });
});

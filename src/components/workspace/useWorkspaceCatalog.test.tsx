import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceEvent,
  WorkspaceRecord,
  WorkspaceSnapshot,
  WorkspaceTab,
} from '../../lib/workspace/types';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  getSnapshot: vi.fn(),
  onEvent: vi.fn(),
  event: null as ((event: WorkspaceEvent) => void) | null,
  calls: [] as string[],
}));

vi.mock('../../lib/workspace/client', () => ({
  workspaceClient: {
    list: (...args: unknown[]) => mocks.list(...args),
    get: (...args: unknown[]) => mocks.get(...args),
    getSnapshot: (...args: unknown[]) => mocks.getSnapshot(...args),
    onEvent: (callback: (event: WorkspaceEvent) => void) => {
      mocks.calls.push('listen');
      mocks.event = callback;
      return mocks.onEvent(callback);
    },
  },
}));

import { createWorkspaceCatalogController } from './useWorkspaceCatalog';

function record(id: string, root: string): WorkspaceRecord {
  return {
    id,
    canonicalRoot: root,
    displayPath: root,
    availability: 'available',
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
}

function tab(id: string, workspaceId: string, order = 1): WorkspaceTab {
  return {
    id,
    workspaceId,
    kind: 'file',
    title: `${id}.ts`,
    cardId: null,
    relativePath: `${id}.ts`,
    sharedOrder: order,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
}

function snapshot(workspace: WorkspaceRecord, tabs: WorkspaceTab[]): WorkspaceSnapshot {
  return { workspace, tabs, draftMetas: [], viewStates: [], activeLeases: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls = [];
  mocks.event = null;
  mocks.onEvent.mockResolvedValue(vi.fn());
  mocks.list.mockImplementation(async () => {
    mocks.calls.push('list');
    return [];
  });
});

afterEach(() => vi.restoreAllMocks());

describe('workspace catalog controller', () => {
  it('subscribes before one coalesced list and isolates normalized roots', async () => {
    const a = record('ws-a', 'D:/Repo/A');
    const b = record('ws-b', 'D:/Repo/B');
    mocks.list.mockImplementation(async () => {
      mocks.calls.push('list');
      return [a, b, record('orphan', 'D:/Orphan')];
    });
    mocks.getSnapshot.mockImplementation(async (id: string) => (
      id === 'ws-a' ? snapshot(a, [tab('a', 'ws-a')]) : snapshot(b, [tab('b', 'ws-b')])
    ));
    const controller = createWorkspaceCatalogController();
    controller.mount();
    controller.registerRoot('d:\\repo\\a\\');
    controller.registerRoot('D:/Repo/B');

    await waitFor(() => expect(controller.getEntry('D:/Repo/A').tabs).toHaveLength(1));
    await waitFor(() => expect(controller.getEntry('D:/Repo/B').tabs).toHaveLength(1));
    expect(mocks.calls.slice(0, 2)).toEqual(['listen', 'list']);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(controller.getEntries().some((entry) => entry.workspaceId === 'orphan')).toBe(false);
    controller.unmount();
  });

  it('patches and refreshes only the workspace named by an event', async () => {
    const a = record('ws-a', '/repo/a');
    const b = record('ws-b', '/repo/b');
    mocks.list.mockResolvedValue([a, b]);
    mocks.getSnapshot.mockImplementation(async (id: string) => (
      id === 'ws-a' ? snapshot(a, [tab('a', 'ws-a')]) : snapshot(b, [tab('b', 'ws-b')])
    ));
    const controller = createWorkspaceCatalogController();
    controller.mount();
    controller.registerRoot('/repo/a');
    controller.registerRoot('/repo/b');
    await waitFor(() => expect(controller.getEntry('/repo/b').tabs).toHaveLength(1));
    mocks.getSnapshot.mockClear();

    mocks.event?.({
      type: 'draftRevision',
      workspaceId: 'ws-b',
      tabId: 'b',
      revision: 2,
      dirty: true,
      conflict: 'none',
    });
    expect(controller.getEntry('/repo/b').dirtyByTabId.b).toBe(true);
    expect(controller.getEntry('/repo/a').dirtyByTabId.a).toBeUndefined();
    await waitFor(() => expect(mocks.getSnapshot).toHaveBeenCalledWith('ws-b'));
    expect(mocks.getSnapshot).not.toHaveBeenCalledWith('ws-a');
    controller.unmount();
  });

  it('ignores lease and known inactive-root events without authority reads', async () => {
    const ws = record('ws-a', '/repo/a');
    mocks.list.mockResolvedValue([ws]);
    mocks.getSnapshot.mockResolvedValue(snapshot(ws, [tab('a', 'ws-a')]));
    const controller = createWorkspaceCatalogController();
    controller.mount();
    controller.registerRoot('/repo/a');
    await waitFor(() => expect(controller.getEntry('/repo/a').tabs).toHaveLength(1));
    mocks.get.mockClear();
    mocks.getSnapshot.mockClear();

    mocks.event?.({
      type: 'leaseChanged',
      workspaceId: 'unknown-lease',
      tabId: 'a',
      holderSurfaceId: 'surface',
      revision: 1,
    });
    controller.unregisterRoot('/repo/a');
    mocks.event?.({ type: 'tabsChanged', workspaceId: 'ws-a', tabIds: ['a'] });

    await Promise.resolve();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
    controller.unmount();
  });

  it('rejects an event-invalidated snapshot and converges with one follow-up', async () => {
    const ws = record('ws-a', '/repo/a');
    const stale = deferred<WorkspaceSnapshot>();
    const fresh = deferred<WorkspaceSnapshot>();
    mocks.list.mockResolvedValue([ws]);
    mocks.getSnapshot
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    const controller = createWorkspaceCatalogController();
    controller.mount();
    controller.registerRoot('/repo/a');
    await waitFor(() => expect(mocks.getSnapshot).toHaveBeenCalledTimes(1));

    mocks.event?.({ type: 'tabsChanged', workspaceId: 'ws-a', tabIds: ['new'] });
    stale.resolve(snapshot(ws, [tab('old', 'ws-a')]));
    await waitFor(() => expect(mocks.getSnapshot).toHaveBeenCalledTimes(2));
    expect(controller.getEntry('/repo/a').tabs).toEqual([]);
    fresh.resolve(snapshot(ws, [tab('new', 'ws-a')]));
    await waitFor(() => expect(controller.getEntry('/repo/a').tabs[0]?.id).toBe('new'));
    expect(mocks.getSnapshot).toHaveBeenCalledTimes(2);
    controller.unmount();
  });

  it('discovers an unknown workspace only when its canonical root is registered', async () => {
    const ws = record('ws-late', '\\\\?\\D:\\Repo\\Late');
    mocks.list.mockResolvedValue([]);
    mocks.get.mockResolvedValue(ws);
    mocks.getSnapshot.mockResolvedValue(snapshot(ws, [tab('late', 'ws-late')]));
    const controller = createWorkspaceCatalogController();
    controller.mount();
    controller.registerRoot('d:/repo/late');
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());

    mocks.event?.({ type: 'tabsChanged', workspaceId: 'ws-late', tabIds: ['late'] });
    await waitFor(() => expect(controller.getEntry('D:/Repo/Late').tabs[0]?.id).toBe('late'));
    expect(mocks.get).toHaveBeenCalledWith('ws-late');
    controller.unmount();
  });

  it('does not let a stale bootstrap list erase an event-discovered workspace', async () => {
    const ws = record('ws-event', '/repo/event');
    const listRequest = deferred<WorkspaceRecord[]>();
    mocks.list.mockReturnValue(listRequest.promise);
    mocks.get.mockResolvedValue(ws);
    mocks.getSnapshot.mockResolvedValue(snapshot(ws, [tab('event', 'ws-event')]));
    const controller = createWorkspaceCatalogController();
    controller.mount();
    controller.registerRoot('/repo/event');
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    mocks.event?.({ type: 'tabsChanged', workspaceId: 'ws-event', tabIds: ['event'] });
    await waitFor(() => expect(controller.getEntry('/repo/event').tabs[0]?.id).toBe('event'));
    const revisionBeforeListReturns = controller.getRevision();
    listRequest.resolve([]);
    await waitFor(() => {
      expect(controller.getRevision()).toBeGreaterThan(revisionBeforeListReturns);
    });

    expect(controller.getEntry('/repo/event')).toMatchObject({
      workspaceId: 'ws-event',
      tabs: [{ id: 'event' }],
    });
    controller.unmount();
  });

  it('does not let a stale bootstrap failure mark an event-discovered workspace as failed', async () => {
    const ws = record('ws-event', '/repo/event');
    const listRequest = deferred<WorkspaceRecord[]>();
    mocks.list.mockReturnValue(listRequest.promise);
    mocks.get.mockResolvedValue(ws);
    mocks.getSnapshot.mockResolvedValue(snapshot(ws, [tab('event', 'ws-event')]));
    const controller = createWorkspaceCatalogController();
    controller.mount();
    controller.registerRoot('/repo/event');
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    mocks.event?.({ type: 'tabsChanged', workspaceId: 'ws-event', tabIds: ['event'] });
    await waitFor(() => expect(controller.getEntry('/repo/event').tabs[0]?.id).toBe('event'));
    listRequest.reject(new Error('stale list failure'));
    await waitFor(() => {
      expect(controller.getEntry('/repo/event')).toMatchObject({
        workspaceId: 'ws-event',
        tabs: [{ id: 'event' }],
        loading: false,
        error: null,
      });
    });

    controller.unmount();
  });

  it('overlays selected tabs but marks a row current only in Workspace mode', () => {
    const controller = createWorkspaceCatalogController();
    const ws = record('ws', '/repo');
    mocks.list.mockResolvedValue([ws]);
    mocks.getSnapshot.mockResolvedValue(snapshot(ws, [tab('cached', 'ws')]));
    controller.mount();
    controller.registerRoot('/repo');
    return waitFor(() => expect(controller.getEntry('/repo').workspaceId).toBe('ws')).then(() => {
      controller.setSelectedOverlay({
        workspaceId: 'ws',
        rootPath: '/repo',
        tabs: [tab('selected', 'ws')],
        dirtyByTabId: { selected: true },
        conflictByTabId: {},
        activeTabId: 'selected',
        workspaceVisible: false,
      });
      expect(controller.getEntry('/repo')).toMatchObject({
        activeTabId: null,
        tabs: [{ id: 'selected' }],
        dirtyByTabId: { selected: true },
      });
      controller.setSelectedOverlay({
        workspaceId: 'ws',
        rootPath: '/repo',
        tabs: [tab('selected', 'ws')],
        dirtyByTabId: { selected: true },
        conflictByTabId: {},
        activeTabId: 'selected',
        workspaceVisible: true,
      });
      expect(controller.getEntry('/repo').activeTabId).toBe('selected');
      controller.unmount();
    });
  });

  it('limits snapshot fetching to four concurrent requests', async () => {
    const records = Array.from({ length: 7 }, (_, index) => record(`ws-${index}`, `/repo/${index}`));
    const pending = records.map(() => deferred<WorkspaceSnapshot>());
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    mocks.list.mockResolvedValue(records);
    mocks.getSnapshot.mockImplementation((workspaceId: string) => {
      const index = records.findIndex((item) => item.id === workspaceId);
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      return pending[index].promise.finally(() => { activeRequests -= 1; });
    });
    const controller = createWorkspaceCatalogController();
    controller.mount();
    records.forEach((item) => controller.registerRoot(item.canonicalRoot));

    await waitFor(() => expect(mocks.getSnapshot).toHaveBeenCalledTimes(4));
    expect(maximumActiveRequests).toBe(4);
    pending.slice(0, 4).forEach((request, index) => request.resolve(snapshot(records[index], [])));
    await waitFor(() => expect(mocks.getSnapshot).toHaveBeenCalledTimes(7));
    pending.slice(4).forEach((request, offset) => request.resolve(snapshot(records[offset + 4], [])));
    await waitFor(() => expect(controller.getEntries().every((entry) => !entry.loading)).toBe(true));
    expect(maximumActiveRequests).toBe(4);
    controller.unmount();
  });

  it('remounts with a fresh snapshot while an old in-flight request resolves late', async () => {
    const ws = record('ws-a', '/repo/a');
    const oldSnapshot = deferred<WorkspaceSnapshot>();
    const freshSnapshot = deferred<WorkspaceSnapshot>();
    mocks.list.mockResolvedValue([ws]);
    mocks.getSnapshot
      .mockReturnValueOnce(oldSnapshot.promise)
      .mockReturnValueOnce(freshSnapshot.promise);
    const controller = createWorkspaceCatalogController();
    controller.mount();
    controller.registerRoot('/repo/a');
    await waitFor(() => expect(mocks.getSnapshot).toHaveBeenCalledTimes(1));

    controller.unmount();
    controller.mount();
    await waitFor(() => expect(mocks.getSnapshot).toHaveBeenCalledTimes(2));

    freshSnapshot.resolve(snapshot(ws, [tab('fresh', 'ws-a')]));
    await waitFor(() => expect(controller.getEntry('/repo/a').tabs[0]?.id).toBe('fresh'));
    oldSnapshot.resolve(snapshot(ws, [tab('stale', 'ws-a')]));
    await Promise.resolve();

    expect(controller.getEntry('/repo/a').tabs[0]?.id).toBe('fresh');
    controller.unmount();
  });

  it('cancels queued old-lifecycle snapshots before a >4-root remount', async () => {
    const records = Array.from({ length: 7 }, (_, index) => record(`ws-${index}`, `/repo/${index}`));
    const oldSnapshots = records.slice(0, 4).map(() => deferred<WorkspaceSnapshot>());
    const freshSnapshots = records.map(() => deferred<WorkspaceSnapshot>());
    let call = 0;
    mocks.list.mockResolvedValue(records);
    mocks.getSnapshot.mockImplementation(() => {
      const request = call;
      call += 1;
      return request < 4
        ? oldSnapshots[request].promise
        : freshSnapshots[request - 4].promise;
    });
    const controller = createWorkspaceCatalogController();
    controller.mount();
    records.forEach((workspace) => controller.registerRoot(workspace.canonicalRoot));
    await waitFor(() => expect(mocks.getSnapshot).toHaveBeenCalledTimes(4));

    controller.unmount();
    controller.mount();
    oldSnapshots.forEach((request, index) => request.resolve(snapshot(records[index], [tab(`old-${index}`, records[index].id)])));

    // The three old queued tasks were settled on unmount rather than started.
    // Only the remounted lifecycle occupies the next four slots.
    await waitFor(() => expect(mocks.getSnapshot).toHaveBeenCalledTimes(8));
    freshSnapshots.slice(0, 4).forEach((request, index) => {
      request.resolve(snapshot(records[index], [tab(`fresh-${index}`, records[index].id)]));
    });
    await waitFor(() => expect(mocks.getSnapshot).toHaveBeenCalledTimes(11));
    freshSnapshots.slice(4).forEach((request, offset) => {
      const index = offset + 4;
      request.resolve(snapshot(records[index], [tab(`fresh-${index}`, records[index].id)]));
    });

    await waitFor(() => {
      expect(records.every((workspace, index) => (
        controller.getEntry(workspace.canonicalRoot).tabs[0]?.id === `fresh-${index}`
      ))).toBe(true);
    });
    controller.unmount();
  });

  it('retains at most sixteen inactive snapshot entries', async () => {
    const records = Array.from({ length: 18 }, (_, index) => record(`ws-${index}`, `/repo/${index}`));
    mocks.list.mockResolvedValue(records);
    mocks.getSnapshot.mockImplementation(async (workspaceId: string) => {
      const workspace = records.find((item) => item.id === workspaceId)!;
      return snapshot(workspace, []);
    });
    const controller = createWorkspaceCatalogController();
    controller.mount();
    records.forEach((item) => controller.registerRoot(item.canonicalRoot));
    await waitFor(() => expect(controller.getEntries().every((entry) => !entry.loading)).toBe(true));

    records.forEach((item) => controller.unregisterRoot(item.canonicalRoot));
    expect(controller.getEntries()).toHaveLength(16);
    expect(controller.getEntry('/repo/0').workspaceId).toBeNull();
    expect(controller.getEntry('/repo/17').workspaceId).toBe('ws-17');
    controller.unmount();
  });
});

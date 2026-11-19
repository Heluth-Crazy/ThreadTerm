import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { MachineBridge, MachineSnapshot, MachineTreeFeed } from './machineTypes';
import type { PairedDevice } from '@threadterm/protocol';

export function machineBridge(): MachineBridge | undefined {
  const bridge = window.threadterm as typeof window.threadterm & Partial<MachineBridge>;
  return typeof bridge.machineList === 'function' ? bridge as typeof window.threadterm & MachineBridge : undefined;
}
const MachineTreeContext = createContext<MachineTreeFeed>({ machines: [], expanded: {} });
export const useMachineTree = () => useContext(MachineTreeContext);
/** Folds a shared tree row: shown at once, then saved by the main process, which echoes the same state back. */
const MachineExpandContext = createContext<(key: string, open: boolean) => Promise<void>>(async (key, open) => { await machineBridge()?.machineExpand(key, open); });
export const useMachineExpand = () => useContext(MachineExpandContext);
const MachineContext = createContext<MachineSnapshot>({ enabled: false, currentId: 'local', machines: [] });
export function MachineProvider({ children }: { children: ReactNode }) {
  const bridge = machineBridge();
  // `loaded` lets the sidebar wait for the folds it will show instead of drawing defaults first (11-19: rows opened,
  // closed and opened again while the machine list and then the tree arrived).
  const [tree, setTree] = useState<MachineTreeFeed>(() => ({ machines: [], expanded: {}, loaded: !bridge?.machineTree || !bridge.onMachineTree }));
  useEffect(() => {
    if (!bridge?.machineTree || !bridge.onMachineTree) return;
    let alive = true, revision = 0;
    const unsubscribe = bridge.onMachineTree(value => { revision++; if (alive) setTree({ ...value, loaded: true }); });
    const initialRevision = revision;
    void bridge.machineTree().then(value => { if (alive && revision === initialRevision) setTree({ ...value, loaded: true }); })
      .catch(() => { if (alive) setTree(current => current.loaded ? current : { ...current, loaded: true }); });
    return () => { alive = false; unsubscribe(); };
  }, [bridge]);
  const expand = useCallback(async (key: string, open: boolean) => {
    setTree(current => current.expanded[key] === open ? current : { ...current, expanded: { ...current.expanded, [key]: open } });
    await bridge?.machineExpand(key, open);
  }, [bridge]);
  const [snapshot, setSnapshot] = useState<MachineSnapshot>(() => ({ enabled: false, currentId: bridge?.machineId ?? 'local', machines: [], loaded: !bridge }));
  useEffect(() => {
    if (!bridge) return;
    let alive = true, generation = 0;
    const refresh = () => {
      const current = ++generation;
      void bridge.machineList().then(value => { if (alive && current === generation) setSnapshot({ ...value, loaded: true }); })
        .catch(() => { if (alive && current === generation) setSnapshot(previous => previous.loaded ? previous : { ...previous, loaded: true }); });
    };
    refresh(); const unsubscribe = bridge.onMachinesChanged(refresh);
    return () => { alive = false; unsubscribe(); };
  }, [bridge]);
  return <MachineContext.Provider value={snapshot}><MachineTreeContext.Provider value={tree}><MachineExpandContext.Provider value={expand}>{children}</MachineExpandContext.Provider></MachineTreeContext.Provider></MachineContext.Provider>;
}
/** Sidebar and current-machine failure alerts must observe the same watcher state. */
export function machineSnapshotWithTree(snapshot: MachineSnapshot, tree: MachineTreeFeed): MachineSnapshot {
  if (!snapshot.enabled) return snapshot;
  const watched = new Map(tree.machines.map(row => [row.machine.id, row.machine]));
  return { ...snapshot, machines: snapshot.machines.map(machine => ({ ...machine, ...watched.get(machine.id) })) };
}
export const useMachines = () => machineSnapshotWithTree(useContext(MachineContext), useContext(MachineTreeContext));
export function isHostSettingsPage(tab: string): boolean { return ['data', 'mobile', 'computers'].includes(tab); }
/** Computers stays visible on This PC while the preview is off: its switch lives there. */
export function settingsPageVisible(tab: string, remote: boolean): boolean {
  return !(remote && isHostSettingsPage(tab));
}
export function devicesForProfile(devices: PairedDevice[], profile: 'phone' | 'desktop'): PairedDevice[] {
  return devices.filter(device => (device.profile ?? 'phone') === profile);
}

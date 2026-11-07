import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { MachineBridge, MachineSnapshot, MachineTreeFeed } from './machineTypes';
import type { PairedDevice } from '@threadterm/protocol';

export function machineBridge(): MachineBridge | undefined {
  const bridge = window.threadterm as typeof window.threadterm & Partial<MachineBridge>;
  return typeof bridge.machineList === 'function' ? bridge as typeof window.threadterm & MachineBridge : undefined;
}
const MachineTreeContext = createContext<MachineTreeFeed>({ machines: [], expanded: {} });
export const useMachineTree = () => useContext(MachineTreeContext);
const MachineContext = createContext<MachineSnapshot>({ enabled: false, currentId: 'local', machines: [] });
export function MachineProvider({ children }: { children: ReactNode }) {
  const bridge = machineBridge();
  const [tree, setTree] = useState<MachineTreeFeed>({ machines: [], expanded: {} });
  useEffect(() => {
    if (!bridge?.machineTree || !bridge.onMachineTree) return;
    let alive = true, revision = 0;
    const unsubscribe = bridge.onMachineTree(value => { revision++; if (alive) setTree(value); });
    const initialRevision = revision;
    void bridge.machineTree().then(value => { if (alive && revision === initialRevision) setTree(value); }).catch(() => {});
    return () => { alive = false; unsubscribe(); };
  }, [bridge]);
  const [snapshot, setSnapshot] = useState<MachineSnapshot>({ enabled: false, currentId: bridge?.machineId ?? 'local', machines: [] });
  useEffect(() => {
    if (!bridge) return;
    let alive = true, generation = 0;
    const refresh = () => {
      const current = ++generation;
      void bridge.machineList().then(value => { if (alive && current === generation) setSnapshot(value); }).catch(() => {});
    };
    refresh(); const unsubscribe = bridge.onMachinesChanged(refresh);
    return () => { alive = false; unsubscribe(); };
  }, [bridge]);
  return <MachineContext.Provider value={snapshot}><MachineTreeContext.Provider value={tree}>{children}</MachineTreeContext.Provider></MachineContext.Provider>;
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
/** Persisted rows from before profiles existed are legacy terminal phones. */
export function devicesForProfile(devices: PairedDevice[], profile: 'phone' | 'mobile' | 'desktop'): PairedDevice[] {
  return devices.filter(device => (device.profile ?? 'phone') === profile);
}

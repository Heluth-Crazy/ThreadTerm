import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { MachineBridge, MachineSnapshot } from './machineTypes';
import type { PairedDevice } from '@threadterm/protocol';

export function machineBridge(): MachineBridge | undefined {
  const bridge = window.threadterm as typeof window.threadterm & Partial<MachineBridge>;
  return typeof bridge.machineList === 'function' ? bridge as typeof window.threadterm & MachineBridge : undefined;
}
const MachineContext = createContext<MachineSnapshot>({ enabled: false, currentId: 'local', machines: [] });
export function MachineProvider({ children }: { children: ReactNode }) {
  const bridge = machineBridge();
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
  return <MachineContext.Provider value={snapshot}>{children}</MachineContext.Provider>;
}
export const useMachines = () => useContext(MachineContext);
export function isHostSettingsPage(tab: string): boolean { return ['data', 'mobile', 'computers'].includes(tab); }
/** Computers stays visible on This PC while the preview is off: its switch lives there. */
export function settingsPageVisible(tab: string, remote: boolean): boolean {
  return !(remote && isHostSettingsPage(tab));
}
export function devicesForProfile(devices: PairedDevice[], profile: 'phone' | 'desktop'): PairedDevice[] {
  return devices.filter(device => (device.profile ?? 'phone') === profile);
}

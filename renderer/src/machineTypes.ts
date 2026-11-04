/** Public machine metadata only. Credentials stay in Electron main. */
export type MachineState = 'local' | 'connecting' | 'connected' | 'disconnected' | 'incompatible' | 'pin-mismatch';
export interface MachineInfo { id: string; name: string; color: string; state: MachineState; message?: string }
export interface MachineSnapshot { enabled: boolean; currentId: string; machines: MachineInfo[] }
export interface MachineBridge {
  readonly machineId: string;
  machineList(): Promise<MachineSnapshot>;
  machineShow(id: string): Promise<void>;
  machinePrepare(text: string): Promise<{ checkCode: string; endpoint: string }>;
  machineAdd(options: { name: string; color: string }): Promise<MachineInfo>;
  machineRemove(id: string): Promise<void>;
  onMachinesChanged(listener: () => void): () => void;
}

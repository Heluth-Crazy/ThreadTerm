import { requireNativeModule, type EventSubscription } from 'expo-modules-core';

export type MachineRecord = {
  id: string;
  name: string;
  color: string;
  transport: 'iroh' | 'tls';
  endpoint: string;
  tlsFingerprint: string;
  permission: 'readonly' | 'fullcontrol';
  expiresAt: string;
};

export type PairingPreparation = {
  pendingId: string;
  checkCode: string;
  endpoint: string;
  transport: 'iroh' | 'tls';
};

export type PickedAttachment = { name: string; size: number; uri: string };
export type RuntimeEvent = { machineId: string; eventJson: string };
export type ConnectionStateEvent = {
  machineId: string;
  state: 'connecting' | 'connected' | 'disconnected' | 'incompatible' | 'pin-mismatch' | 'revoked';
  message?: string;
};
export type ControlLockEvent = { locked: boolean };

export interface ThreadTermMobileNativeModule {
  listMachines(): Promise<MachineRecord[]>;
  preparePairing(text: string): Promise<PairingPreparation>;
  confirmPairing(pendingId: string, deviceName: string, name: string, color: string): Promise<MachineRecord>;
  cancelPairing(pendingId: string): Promise<void>;
  removeMachine(machineId: string): Promise<void>;
  renameMachine(machineId: string, name: string, color: string): Promise<void>;
  connect(machineId: string): Promise<{ epoch: string; permission: 'readonly' | 'fullcontrol' }>;
  disconnect(machineId: string): Promise<void>;
  request(machineId: string, method: string, paramsJson: string): Promise<string>;
  unlockControl(): Promise<boolean>;
  lockControl(): Promise<void>;
  openPreview(machineId: string, url: string): Promise<void>;
  chooseAttachment(): Promise<PickedAttachment | null>;
  readAttachment(uri: string, offset: number, length: number): Promise<string>;
  addListener(event: 'onRuntimeEvent', listener: (event: RuntimeEvent) => void): EventSubscription;
  addListener(event: 'onConnectionState', listener: (event: ConnectionStateEvent) => void): EventSubscription;
  addListener(event: 'onControlLock', listener: (event: ControlLockEvent) => void): EventSubscription;
}

export default requireNativeModule<ThreadTermMobileNativeModule>('ThreadTermMobile');

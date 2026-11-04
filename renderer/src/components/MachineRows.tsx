import { useState, type CSSProperties } from 'react';
import { machineBridge, useMachines } from '../machines';
import type { MachineSnapshot } from '../machineTypes';

export function MachineRows({ zh }: { zh: boolean }) {
  return <MachineRowsView zh={zh} snapshot={useMachines()} />;
}
export function MachineRowsView({ zh, snapshot }: { zh: boolean; snapshot: MachineSnapshot }) {
  const [issue, setIssue] = useState<string>();
  if (!snapshot.enabled || snapshot.machines.length < 2) return null;
  return <nav className="machine-rows" aria-label={zh ? '电脑' : 'Computers'}>
    {snapshot.machines.map(machine => <button type="button" key={machine.id} className={`machine-row${snapshot.currentId === machine.id ? ' active' : ''}`} aria-current={snapshot.currentId === machine.id ? 'true' : undefined} style={{ '--machine-color': machine.color } as CSSProperties} onClick={() => { setIssue(undefined); void machineBridge()?.machineShow(machine.id).catch(error => setIssue(error instanceof Error ? error.message : String(error))); }}>
      <i className="machine-dot" aria-hidden="true" /><span className="machine-name">{machine.id === 'local' && zh ? '这台电脑' : machine.name}</span><small>{machineStateLabel(machine.state, zh)}</small>
    </button>)}
    {issue && <p role="alert" className="surface-error">{issue}</p>}
  </nav>;
}
export function machineStateLabel(state: MachineSnapshot['machines'][number]['state'], zh: boolean): string {
  const labels = zh ? { local: '本机', connected: '已连接', disconnected: '未连接', connecting: '连接中', incompatible: '版本不一致', 'pin-mismatch': '需重新配对' } : { local: 'Local', connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting', incompatible: 'Version mismatch', 'pin-mismatch': 'Pair again' };
  return labels[state];
}
export function MachineChrome({ zh }: { zh: boolean }) {
  const snapshot = useMachines(), machine = snapshot.machines.find(item => item.id === snapshot.currentId);
  if (snapshot.currentId === 'local' || !machine) return null;
  return <span className="machine-chip" style={{ '--machine-color': machine.color } as CSSProperties}><i className="machine-dot" aria-hidden="true" />{zh ? `在 ${machine.name}` : `on ${machine.name}`}</span>;
}

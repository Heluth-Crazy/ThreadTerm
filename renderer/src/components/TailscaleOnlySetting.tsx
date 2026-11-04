import { useEffect, useId, useState } from 'react';
import type { RemoteAccessStatus } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { isRemoteFiles } from '../remoteFiles';
import { SettingsSwitch } from './SettingsControls';

export function TailscaleOnlyControl({ zh, checked, disabled, onChange }: { zh: boolean; checked: boolean; disabled: boolean; onChange: (enabled: boolean) => void }) {
  const hint = useId();
  return <div className="tailscale-only-setting">
    <SettingsSwitch checked={checked} disabled={disabled} onChange={onChange} aria-describedby={hint}>{zh ? '仅接受我的 Tailscale 网络中的设备' : 'Only accept devices on my Tailscale network'}</SettingsSwitch>
    <p id={hint} className="hint">{zh ? '同时适用于电脑和手机。' : 'Applies to computers and phones.'}</p>
  </div>;
}

/** Both host administration pages use this one persisted listener policy. */
export function TailscaleOnlySetting({ zh, active = true }: { zh: boolean; active?: boolean }) {
  const [status, setStatus] = useState<RemoteAccessStatus>(), [busy, setBusy] = useState(false), [issue, setIssue] = useState<string>();
  const remote = isRemoteFiles();
  useEffect(() => {
    if (!active || remote) return;
    let alive = true;
    void request('device.status', {}).then(value => { if (alive) { setStatus(value); setIssue(undefined); } }).catch(error => { if (alive) setIssue(String(error)); });
    return () => { alive = false; };
  }, [active, remote]);
  if (remote) return null;
  const change = (enabled: boolean) => {
    if (busy || !status) return;
    setBusy(true); setIssue(undefined);
    void request('device.tailscaleOnly.set', { enabled, operationId: operationId() }).then(setStatus).catch(error => setIssue(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
  };
  return <>
    <TailscaleOnlyControl zh={zh} checked={status?.tailscaleOnly ?? false} disabled={busy || !status} onChange={change} />
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </>;
}

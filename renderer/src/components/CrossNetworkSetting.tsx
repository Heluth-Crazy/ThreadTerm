import { useEffect, useId, useState } from 'react';
import type { RemoteAccessStatus } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { userErrorText } from '../runtimeError';
import { SettingsSwitch } from './SettingsControls';

/** "Connect across networks": computers on other networks reach This PC through iroh. Off by default. */
export function CrossNetworkControl({ zh, status, busy, onChange }: {
  zh: boolean; status?: RemoteAccessStatus; busy: boolean; onChange: (enabled: boolean, relayUrl: string | null) => void;
}) {
  const hint = useId();
  const tailscaleOnly = status?.tailscaleOnly ?? false, enabled = !!status?.irohEnabled && !tailscaleOnly;
  const [relay, setRelay] = useState(status?.irohRelayUrl ?? '');
  useEffect(() => setRelay(status?.irohRelayUrl ?? ''), [status?.irohRelayUrl]);
  const saved = (status?.irohRelayUrl ?? '') === relay.trim();
  return <div className="cross-network-setting">
    <SettingsSwitch checked={enabled} disabled={busy || !status || tailscaleOnly} onChange={value => onChange(value, status?.irohRelayUrl ?? null)} aria-describedby={hint}>
      {zh ? '跨网络连接' : 'Connect across networks'}
    </SettingsSwitch>
    <p id={hint} className="hint">{tailscaleOnly
      ? (zh ? '要使用此功能，请先关闭“仅接受我的 Tailscale 网络中的设备”。' : 'Turn off “Only accept devices on my Tailscale network” to use this.')
      : (zh ? '让其他网络中的电脑连接本机，例如家里和办公室。连接加密，无法直连时经中继转发。开启后请重新配对。'
        : 'Lets computers on other networks reach this PC, such as home and office. Connections are encrypted and go through a relay when no direct path exists. Pair again after turning this on.')}</p>
    {enabled && <details className="cross-network-relay">
      <summary>{zh ? '中继服务器' : 'Relay server'}</summary>
      <label>{zh ? '自建中继地址（留空则使用默认的公共中继）' : 'Your own relay (leave empty for the default public relays)'}
        <input type="url" value={relay} placeholder="https://relay.example.com" disabled={busy} onChange={event => setRelay(event.target.value)} />
      </label>
      <button type="button" className="btn btn-sm" disabled={busy || saved} onClick={() => onChange(true, relay.trim() || null)}>{zh ? '保存' : 'Save'}</button>
    </details>}
    {status?.irohError && enabled && <p className="surface-error" role="alert">{status.irohError}</p>}
  </div>;
}

/** Computers page only: phones keep using addresses on the local network or Tailscale. */
export function CrossNetworkSetting({ zh, status, onStatus }: { zh: boolean; status?: RemoteAccessStatus; onStatus: (status: RemoteAccessStatus) => void }) {
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string>();
  const change = (enabled: boolean, relayUrl: string | null) => {
    if (busy || !status) return;
    setBusy(true); setIssue(undefined);
    void request('device.iroh.set', { enabled, relayUrl, operationId: operationId() })
      .then(onStatus)
      .catch(error => setIssue(userErrorText(error, zh ? '操作未完成。' : 'That didn’t work.', zh)))
      .finally(() => setBusy(false));
  };
  return <>
    <CrossNetworkControl zh={zh} status={status} busy={busy} onChange={change} />
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </>;
}

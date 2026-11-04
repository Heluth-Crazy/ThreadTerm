import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { PairedDevice, PairingOffer, Settings } from '@threadterm/protocol';
import { operationId, request, subscribeEvents } from '../bridge';
import { devicesForProfile, machineBridge, useMachines } from '../machines';
import { machineStateLabel } from './MachineRows';
import { TailscaleOnlySetting } from './TailscaleOnlySetting';
import { SettingsSwitch } from './SettingsControls';
import { useVisibleTicker } from '../visibleTicker';

export function MachineSettings({ settings, zh, update }: { settings: Settings; zh: boolean; update: (patch: Record<string, unknown>) => Promise<void> }) {
  const enabled = !!(settings.remoteMachines as { enabled?: boolean } | undefined)?.enabled;
  const snapshot = useMachines(), [offer, setOffer] = useState<PairingOffer>(), [devices, setDevices] = useState<PairedDevice[]>([]);
  const [qr, setQr] = useState(''), [text, setText] = useState(''), [name, setName] = useState(''), [color, setColor] = useState('#3fb8a6');
  const [checked, setChecked] = useState<{ checkCode: string; endpoint: string }>(), [busy, setBusy] = useState(false), [issue, setIssue] = useState<string>(), [notice, setNotice] = useState<string>();
  const [now, setNow] = useState(Date.now()), alive = useRef(true), locked = useRef(false);
  const label = (en: string, cn: string) => zh ? cn : en;
  const refresh = async () => { const rows = await request('device.list', {}); if (alive.current) setDevices(devicesForProfile(rows, 'desktop')); };
  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => { alive.current = false; };
    void refresh().catch(error => { if (alive.current) setIssue(String(error)); });
    const unsubscribe = subscribeEvents(event => { if (event.event === 'state.changed' && !locked.current) void refresh().catch(() => {}); });
    return () => { alive.current = false; unsubscribe(); };
  }, [enabled]);
  useEffect(() => {
    let current = true; setQr('');
    if (offer) void QRCode.toDataURL(offer.qrPayload, { width: 172, margin: 2, errorCorrectionLevel: 'M' }).then(value => { if (current) setQr(value); }).catch(() => {});
    return () => { current = false; };
  }, [offer]);
  const active = !!offer && Date.parse(offer.expiresAt) > now;
  useVisibleTicker(() => setNow(Date.now()), enabled && active);
  const run = (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setIssue(undefined); setNotice(undefined);
    void action().catch(error => { if (alive.current) setIssue(error instanceof Error ? error.message : String(error)); }).finally(() => { locked.current = false; if (alive.current) setBusy(false); });
  };
  return <section className="machine-settings" aria-label={label('Computers', '电脑')}>
    <h3>{label('Computers', '电脑')} <small>{label('Preview', '预览')}</small></h3>
    <SettingsSwitch checked={enabled} disabled={busy} onChange={value => run(() => update({ remoteMachines: { enabled: value } }))}>{label('Enable Computers preview', '启用电脑连接预览')}</SettingsSwitch>
    {!enabled && <p className="hint">{label('Use this PC from another ThreadTerm computer, or use another computer from here.', '让另一台装有 ThreadTerm 的电脑使用本机，或从这里使用另一台电脑。')}</p>}
    {enabled && <>
      <TailscaleOnlySetting zh={zh} />
      <h4>{label('Add another computer', '让另一台电脑连接')}</h4>
      <p className="hint">{label('A paired computer can use everything on this PC, as you. Share this offer only with a computer you trust.', '已配对电脑可以以你的身份使用本机的全部功能。请仅向你信任的电脑分享此配对信息。')}</p>
      <button type="button" className="btn" disabled={busy} onClick={() => run(async () => {
        const status = await request('device.status', {});
        if (!status.enabled) await request('device.enable', { operationId: operationId() });
        if (offer) await request('device.pairing.cancel', { pairingId: offer.id, operationId: operationId() });
        const next = await request('device.pairing.create', { permission: 'fullcontrol', profile: 'desktop', operationId: operationId() });
        if (alive.current) { setOffer(next); setNow(Date.now()); }
      })}>{label('Create pairing offer', '创建配对信息')}</button>
      {offer && <div className="machine-offer">
        {qr && active && <img src={qr} width="172" height="172" alt={label('Computer pairing QR code', '电脑配对二维码')} />}
        <div><p>{label('Check code', '核对码')}: <strong className="machine-check-code">{checkCode(offer.tlsFingerprint)}</strong></p><p>{active ? `${label('Expires', '到期时间')} ${new Date(offer.expiresAt).toLocaleTimeString()}` : label('Expired — create a new offer.', '已过期，请重新创建。')}</p>
          <label>{label('Pairing text', '配对文本')}<textarea readOnly rows={3} value={offer.qrPayload} /></label>
          <button type="button" className="btn btn-sm" disabled={busy || !active} onClick={() => run(async () => { await navigator.clipboard.writeText(offer.qrPayload); setNotice(label('Copied.', '已复制。')); })}>{label('Copy offer', '复制配对信息')}</button>
        </div>
      </div>}
      {devices.length > 0 && <ul className="device-list">{devices.map(device => <li key={device.id}><span><b>{device.name}</b><small>{label('Last used', '上次访问')}: {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : label('Never', '尚未使用')}</small></span><button type="button" className="btn btn-sm btn-danger" disabled={busy || !!device.revokedAt} onClick={() => run(async () => { await request('device.revoke', { deviceId: device.id, operationId: operationId() }); await refresh(); })}>{device.revokedAt ? label('Removed', '已移除') : label('Remove', '移除')}</button></li>)}</ul>}
      <h4>{label('Add a computer', '添加电脑')}</h4>
      <label>{label('Paste pairing text from the other computer', '粘贴另一台电脑的配对文本')}<textarea rows={3} value={text} onChange={event => { setText(event.target.value); setChecked(undefined); }} disabled={busy} /></label>
      <div className="machine-local-fields"><label>{label('Name', '名称')}<input value={name} maxLength={80} onChange={event => setName(event.target.value)} disabled={busy} /></label><label>{label('Color', '颜色')}<input type="color" value={color} onChange={event => setColor(event.target.value)} disabled={busy} /></label></div>
      {!checked ? <button type="button" className="btn" disabled={busy || !text.trim()} onClick={() => run(async () => { const bridge = machineBridge(); if (!bridge) throw new Error('Computer connections are unavailable'); setChecked(await bridge.machinePrepare(text)); })}>{busy ? label('Checking…', '正在检查…') : label('Check computer', '检查电脑')}</button> : <div className="machine-confirm"><p>{label('Compare this code on both computers before adding:', '添加前，请核对两台电脑上的核对码：')}</p><strong className="machine-check-code">{checked.checkCode}</strong><p className="hint">{checked.endpoint}</p><button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => run(async () => { setChecked(undefined); await machineBridge()!.machineAdd({ name: name.trim(), color }); setText(''); setName(''); setNotice(label('Computer added. Choose it in the sidebar.', '电脑已添加，请在侧栏选择。')); })}>{label('Codes match — Add computer', '核对码一致，添加电脑')}</button></div>}
      {snapshot.machines.length > 1 && <ul className="device-list">{snapshot.machines.filter(item => item.id !== 'local').map(machine => <li key={machine.id}><span><b>{machine.name}</b><small>{machineStateLabel(machine.state, zh)}</small></span><button type="button" className="btn btn-sm" onClick={() => run(async () => { await machineBridge()!.machineShow(machine.id); })}>{label('Open', '打开')}</button><button type="button" className="btn btn-sm btn-danger" onClick={() => run(async () => { await machineBridge()!.machineRemove(machine.id); })}>{label('Remove', '移除')}</button></li>)}</ul>}
    </>}
    {busy && <p role="status">{label('Working…', '正在处理…')}</p>}{notice && <p role="status">{notice}</p>}{issue && <p role="alert" className="surface-error">{issue}</p>}
  </section>;
}
function checkCode(pin: string) { return pin.replace(/:/g, '').toUpperCase().slice(0, 12).match(/.{1,4}/g)?.join(' ') ?? ''; }

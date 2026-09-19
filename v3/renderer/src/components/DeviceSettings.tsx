import { Select } from "./ui/Select";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { DevicePermission, PairedDevice, PairingOffer, RemoteAccessStatus } from "@threadterm/protocol";
import { operationId, request, subscribeEvents } from "../bridge";
import type { Locale } from "../i18n";
import { SurfaceDialog } from "./SurfaceDialog";
import { SettingsSwitch } from "./SettingsControls";

type Props = { language: Locale };
export function DeviceSettings({ language }: Props) {
  const zh = language === "zh-CN", text = (cn: string, en: string) => zh ? cn : en;
  const [status, setStatus] = useState<RemoteAccessStatus>(), [devices, setDevices] = useState<PairedDevice[]>([]);
  const [permission, setPermission] = useState<DevicePermission>("readonly"), [offer, setOffer] = useState<PairingOffer>(), [qr, setQr] = useState("");
  const [now, setNow] = useState(Date.now()), [busy, setBusy] = useState(false), [issue, setIssue] = useState<string>(), [notice, setNotice] = useState<string>();
  const [renaming, setRenaming] = useState<PairedDevice>(), [name, setName] = useState("");
  const generation = useRef(0), locked = useRef(false), alive = useRef(true);
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    const [access, list] = await Promise.allSettled([request("device.status", {}), request("device.list", {})]);
    if (!alive.current || token !== generation.current) return;
    if (access.status === "fulfilled") setStatus(access.value);
    if (list.status === "fulfilled") setDevices(list.value);
    const failure = [access, list].find(result => result.status === "rejected");
    if (failure?.status === "rejected") setIssue(errorText(failure.reason));
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    const unsubscribe = subscribeEvents(event => { if (event.event === "state.changed" && !locked.current) void refresh(); });
    const timer = window.setInterval(() => { setNow(Date.now()); if (!locked.current) void refresh(); }, 3000);
    return () => { alive.current = false; generation.current++; unsubscribe(); window.clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    let current = true; setQr("");
    if (offer && Date.parse(offer.expiresAt) > Date.now()) void QRCode.toDataURL(offer.qrPayload, { width: 196, margin: 2, errorCorrectionLevel: "M", color: { dark: "#111111", light: "#ffffff" } }).then(value => { if (current) setQr(value); }).catch(error => { if (current) setIssue(errorText(error)); });
    return () => { current = false; };
  }, [offer]);
  const run = (action: () => Promise<void>) => {
    if (locked.current) return; locked.current = true; generation.current++; setBusy(true); setIssue(undefined); setNotice(undefined);
    void action().catch(error => { if (alive.current) setIssue(errorText(error)); }).finally(() => { locked.current = false; if (alive.current) setBusy(false); });
  };
  const pairingActive = !!offer && Date.parse(offer.expiresAt) > now;
  const replacePairing = async (access = permission) => {
    if (offer) { await request("device.pairing.cancel", { pairingId: offer.id, operationId: operationId() }); setOffer(undefined); }
    const next = await request("device.pairing.create", { permission: access, operationId: operationId() });
    setOffer(next); setNow(Date.now()); setNotice(text("新配对码已生成，有效期 5 分钟。", "A new pairing code is ready for 5 minutes."));
  };
  const setEnabled = (enabled: boolean) => run(async () => {
    const next = enabled ? await request("device.enable", { operationId: operationId() }) : await request("device.disable", { operationId: operationId() });
    setStatus(next);
    if (!next.enabled) { if (offer) await request("device.pairing.cancel", { pairingId: offer.id, operationId: operationId() }); setOffer(undefined); }
    if (next.error) throw new Error(next.error);
    if (enabled) await replacePairing();
    await refresh();
  });
  const expirePairing = () => run(async () => {
    if (!offer) return;
    await request("device.pairing.cancel", { pairingId: offer.id, operationId: operationId() });
    setOffer({ ...offer, expiresAt: new Date(0).toISOString() }); setNow(Date.now());
    setNotice(text("此配对码已立即作废。", "This pairing code is now invalid."));
  });
  const copy = (value: string) => run(async () => { await navigator.clipboard.writeText(value); setNotice(text("已复制。", "Copied.")); });
  return <section className="device-settings" aria-label={text("桌面移动连接", "Desktop mobile access")}>
    <h3>{text("桌面移动连接", "Desktop mobile access")}</h3>
    <SettingsSwitch checked={status?.enabled ?? false} disabled={busy || !status} onChange={setEnabled}>{text("启用移动访问", "Enable mobile access")}</SettingsSwitch>
    {!status && !issue && <p role="status">{text("正在加载连接状态…", "Loading connection status…")}</p>}
    <p className="pair-code">{status?.enabled ? offer ? <>{text("配对码", "Pairing code")}: <strong>{offer.code}</strong> · {pairingActive ? `${text("到期时间", "Expires at")} ${time(offer.expiresAt, language)}` : text("已过期", "Expired")} <button className="btn-subtle" disabled={busy} onClick={() => run(() => replacePairing())}>{text("续期", "Renew")}</button> <button className="btn-subtle" disabled={busy || !pairingActive} onClick={expirePairing}>{text("立即使配对码过期", "Expire pairing code")}</button></> : <button className="btn-subtle" disabled={busy} onClick={() => run(() => replacePairing())}>{text("创建 5 分钟配对码", "Create a 5-minute pairing code")}</button> : text("启用后生成二维码和短期配对码。", "Enable access to generate a QR code and short-lived pairing code.")}</p>
    {status?.enabled && <>
      {qr && pairingActive && <img className="device-qr" src={qr} width="196" height="196" alt={text("设备配对二维码", "Device pairing QR code")} />}
      <label>{text("新设备权限", "New device access")}<Select value={permission} disabled={busy} onChange={event => { const next = event.target.value as DevicePermission; setPermission(next); if (offer) run(() => replacePairing(next)); }}><option value="readonly">{text("只读", "Read-only")}</option><option value="fullcontrol">{text("完全控制", "Full control")}</option></Select></label>
      <p className="hint">{permission === "readonly" ? text("可查看会话和终端输出。", "Can view sessions and terminal output.") : text("可创建、输入、调整大小和停止终端会话。", "Can create, type into, resize and stop terminal sessions.")}</p>
      {offer && <div className="inline-actions"><button className="btn-subtle" disabled={busy || !pairingActive} onClick={() => copy(offer.code)}>{text("复制配对码", "Copy code")}</button><button className="btn-subtle" disabled={busy || !pairingActive} onClick={() => copy(offer.qrPayload)}>{text("复制配对链接", "Copy pairing link")}</button></div>}
    </>}
    {status?.enabled && <div className="inline-actions"><button className="btn-subtle" disabled={busy} onClick={() => setEnabled(false)}>{text("断开所有设备", "Disconnect all devices")}</button><button className="btn-subtle" disabled={busy} onClick={() => run(refresh)}>{text("刷新设备状态", "Refresh device status")}</button></div>}
    {status?.enabled && <details className="device-connection-details"><summary>{text("连接地址与证书", "Connection address & certificate")}</summary>{status.url && <p>{status.url}</p>}<p className="hint">{text("在设备上核对此证书指纹。", "Verify this certificate fingerprint on your device.")}</p><code>{status.tlsFingerprint}</code></details>}
    {status?.error && <p className="surface-error" role="alert">{status.error}</p>}
    <ul className="device-list">{devices.length ? devices.map(device => {
      const revoked = !!device.revokedAt, expired = Date.parse(device.expiresAt) <= now;
      return <li key={device.id}><span><b>{device.name}</b><small>{device.permission === "readonly" ? text("只读", "Read-only") : text("完全控制", "Full control")} · {revoked ? text("已撤销", "Revoked") : expired ? text("授权已过期", "Access expired") : text("授权有效", "Access active")} · {time(device.expiresAt, language)}{device.lastSeenAt && <><br />{text("上次访问", "Last seen")} {time(device.lastSeenAt, language)}</>}</small></span><button className="btn-subtle" disabled={busy} onClick={() => { setRenaming(device); setName(device.name); setIssue(undefined); }}>{text("改名", "Rename")}</button><button className="btn-subtle" disabled={busy || revoked} title={text("延长现有设备授权 24 小时", "Extend existing device access for 24 hours")} onClick={() => run(async () => { await request("device.renew", { deviceId: device.id, operationId: operationId() }); await refresh(); setNotice(text("设备授权已续期 24 小时。", "Device access extended for 24 hours.")); })}>{text("续期授权", "Renew access")}</button><button className="btn-subtle" disabled={busy || revoked} onClick={() => run(async () => { await request("device.revoke", { deviceId: device.id, operationId: operationId() }); await refresh(); setNotice(text("已撤销设备访问权限。", "Device access revoked.")); })}>{text("撤销", "Revoke")}</button></li>;
    }) : <li>{text("没有已配对设备", "No paired devices")}</li>}</ul>
    {notice && <p role="status">{notice}</p>}{issue && <p className="surface-error" role="alert">{issue}</p>}
    {renaming && <SurfaceDialog title={text("重命名设备", "Rename device")} icon="panel" size="sm" onClose={() => { if (!busy) setRenaming(undefined); }} footer={<><button className="btn" disabled={busy} onClick={() => setRenaming(undefined)}>{text("取消", "Cancel")}</button><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => run(async () => { await request("device.rename", { deviceId: renaming.id, name: name.trim(), operationId: operationId() }); await refresh(); setRenaming(undefined); })}>{text("保存", "Save")}</button></>}><label className="device-name-input">{text("设备名称", "Device name")}<input autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>{issue && <p className="surface-error" role="alert">{issue}</p>}</SurfaceDialog>}
  </section>;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function time(value: string, locale: Locale) { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date) : "—"; }

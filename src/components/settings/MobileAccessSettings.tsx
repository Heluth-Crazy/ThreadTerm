import { useEffect, useState } from 'react';
import {
  Copy,
  ExternalLink,
  Power,
  QrCode,
  RefreshCw,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  isTauriEnv,
  mobileBridge,
  type BridgeDevice,
  type BridgeDevicePermission,
  type BridgeStatus,
  type PairQrResponse,
} from '../../lib/tauri-bridge';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

type ActionState = 'idle' | 'busy' | 'failed';
type BindHost = '127.0.0.1' | '0.0.0.0';

const DEFAULT_BIND_HOST: BindHost = '127.0.0.1';
const LAN_BIND_HOST: BindHost = '0.0.0.0';

const stoppedStatus: BridgeStatus = {
  running: false,
  host: null,
  port: null,
  url: null,
};

function pairUrlWithPermission(
  pairQr: PairQrResponse | null,
  permission: BridgeDevicePermission,
): string {
  if (!pairQr?.url) return '';

  try {
    const url = new URL(pairQr.url);
    url.searchParams.set('permission', permission);
    return url.toString();
  } catch {
    const joiner = pairQr.url.includes('?') ? '&' : '?';
    return `${pairQr.url}${joiner}permission=${permission}`;
  }
}

export function MobileAccessSettings() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<BridgeStatus>(stoppedStatus);
  const [pairQr, setPairQr] = useState<PairQrResponse | null>(null);
  const [pairPermission, setPairPermission] =
    useState<BridgeDevicePermission>('read_only');
  const [devices, setDevices] = useState<BridgeDevice[]>([]);
  const [bindHost, setBindHost] = useState<BindHost>(DEFAULT_BIND_HOST);
  const [lanConfirmVisible, setLanConfirmVisible] = useState(false);
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [error, setError] = useState<string | null>(null);

  const createPairQrForStatus = async (
    nextStatus: BridgeStatus,
    fallbackHost?: string,
  ) => {
    if (!nextStatus.running) {
      setPairQr(null);
      return;
    }

    try {
      setPairQr(await mobileBridge.pairQr(nextStatus.host ?? fallbackHost));
    } catch (err) {
      setPairQr(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadDevices = async () => {
    try {
      setDevices(await mobileBridge.devices());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const refresh = async () => {
    if (!isTauriEnv()) return;

    setError(null);
    try {
      const nextStatus = await mobileBridge.status();
      setStatus(nextStatus);
      await createPairQrForStatus(nextStatus);
      await loadDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const runStartBridge = async (host: BindHost) => {
    setLanConfirmVisible(false);
    setActionState('busy');
    setError(null);
    try {
      const nextStatus = await mobileBridge.start(host);
      setStatus(nextStatus);
      await createPairQrForStatus(nextStatus, host);
      await loadDevices();
      setActionState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActionState('failed');
    }
  };

  const startBridge = async () => {
    if (bindHost === LAN_BIND_HOST) {
      setLanConfirmVisible(true);
      return;
    }

    await runStartBridge(bindHost);
  };

  const stopBridge = async () => {
    setActionState('busy');
    setError(null);
    try {
      setStatus(await mobileBridge.stop());
      setPairQr(null);
      setLanConfirmVisible(false);
      setActionState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActionState('failed');
    }
  };

  const createPairQr = async () => {
    setActionState('busy');
    setError(null);
    try {
      setPairQr(await mobileBridge.pairQr(status.host ?? undefined));
      setActionState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActionState('failed');
    }
  };

  const revokeDevice = async (deviceId: string) => {
    setActionState('busy');
    setError(null);
    try {
      await mobileBridge.revokeDevice(deviceId);
      setDevices(await mobileBridge.devices());
      setActionState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActionState('failed');
    }
  };

  const pairUrl = pairUrlWithPermission(pairQr, pairPermission);

  const copyPairUrl = async () => {
    if (!pairUrl || !navigator.clipboard) return;
    await navigator.clipboard.writeText(pairUrl);
  };

  const isBusy = actionState === 'busy';

  return (
    <section className="rounded-xl border border-border/60 bg-card/72 p-4 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold text-foreground">
              {t('mobileAccess.title')}
            </h3>
            <Badge variant={status.running ? 'success' : 'muted'}>
              {status.running ? t('mobileAccess.running') : t('mobileAccess.stopped')}
            </Badge>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {t('mobileAccess.description')}
          </p>
          {!isTauriEnv() && (
            <p className="mt-2 text-xs text-amber-600">
              {t('mobileAccess.desktopOnly')}
            </p>
          )}
          {status.running && (
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">
                  {t('mobileAccess.listeningAddress')}
                </span>{' '}
                <span className="font-mono">
                  {`${status.host ?? DEFAULT_BIND_HOST}:${status.port ?? ''}`}
                </span>
              </p>
              <p className="flex flex-wrap gap-x-3 gap-y-1">
                <a
                  href="https://tailscale.com/kb/1017/install"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {t('mobileAccess.docs.tailscale')}
                  <ExternalLink className="h-3 w-3" />
                </a>
                <a
                  href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {t('mobileAccess.docs.cloudflare')}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </div>
          )}
          {error && (
            <p className="mt-2 text-xs text-destructive">
              {t('mobileAccess.error', { message: error })}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 md:items-end">
          <div
            role="radiogroup"
            aria-label={t('mobileAccess.bind.label')}
            className="grid gap-1 rounded-lg border border-border/70 bg-background/70 p-1 text-xs"
          >
            {[
              { value: DEFAULT_BIND_HOST, label: t('mobileAccess.bind.loopback') },
              { value: LAN_BIND_HOST, label: t('mobileAccess.bind.lan') },
            ].map((option) => (
              <label
                key={option.value}
                className="inline-flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-muted-foreground has-[:checked]:bg-accent has-[:checked]:text-foreground"
              >
                <input
                  type="radio"
                  name="mobile-bridge-bind-host"
                  value={option.value}
                  checked={bindHost === option.value}
                  disabled={status.running || isBusy}
                  onChange={() => {
                    setBindHost(option.value as BindHost);
                    setLanConfirmVisible(false);
                  }}
                  aria-label={option.label}
                  className="h-3 w-3"
                />
                {option.label}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" onClick={status.running ? stopBridge : startBridge} disabled={!isTauriEnv() || isBusy}>
              <Power />
              {status.running ? t('mobileAccess.stop') : t('mobileAccess.start')}
            </Button>
            <Button size="sm" variant="outline" onClick={refresh} disabled={!isTauriEnv() || isBusy}>
              <RefreshCw />
              {t('mobileAccess.refresh')}
            </Button>
          </div>
        </div>
      </div>

      {lanConfirmVisible && !status.running && (
        <div className="mt-4 rounded-xl border border-amber-500/35 bg-amber-500/10 p-3">
          <p className="text-xs leading-5 text-foreground">
            {t('mobileAccess.lanConfirm')}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => runStartBridge(LAN_BIND_HOST)} disabled={isBusy}>
              <Power />
              {t('mobileAccess.confirmLanStart')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setLanConfirmVisible(false)}
              disabled={isBusy}
            >
              {t('mobileAccess.cancelLanStart')}
            </Button>
          </div>
        </div>
      )}

      {status.running && (
        <div className="mt-4 rounded-xl border border-border/60 bg-background/70 p-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <QrCode className="h-4 w-4 text-muted-foreground" />
                {t('mobileAccess.pairingTitle')}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t('mobileAccess.pairingDescription')}
              </p>
              <div
                role="radiogroup"
                aria-label={t('mobileAccess.permissionMode.label')}
                className="mt-3 grid gap-1 rounded-lg border border-border/70 bg-card/70 p-1 text-xs sm:inline-grid"
              >
                {[
                  {
                    value: 'read_only' as const,
                    label: t('mobileAccess.permissions.read_only'),
                  },
                  {
                    value: 'full' as const,
                    label: t('mobileAccess.permissions.full'),
                  },
                ].map((option) => (
                  <label
                    key={option.value}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-muted-foreground has-[:checked]:bg-accent has-[:checked]:text-foreground"
                  >
                    <input
                      type="radio"
                      name="mobile-bridge-pair-permission"
                      value={option.value}
                      checked={pairPermission === option.value}
                      onChange={() => setPairPermission(option.value)}
                      aria-label={option.label}
                      className="h-3 w-3"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                {t('mobileAccess.permissionMode.hint')}
              </p>
              {pairQr && (
                <div className="mt-2 space-y-1">
                  <div className="font-mono text-sm text-foreground">
                    {pairQr.otp}
                  </div>
                  <div className="break-all font-mono text-[11px] text-muted-foreground">
                    {pairUrl}
                  </div>
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={createPairQr} disabled={isBusy}>
                <QrCode />
                {t('mobileAccess.newPairCode')}
              </Button>
              <Button size="sm" variant="outline" onClick={copyPairUrl} disabled={!pairUrl}>
                <Copy />
                {t('mobileAccess.copyUrl')}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="text-sm font-medium text-foreground">
          {t('mobileAccess.devicesTitle')}
        </div>
        {devices.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('mobileAccess.noDevices')}
          </p>
        ) : (
          <div className="mt-2 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
            {devices.map((device) => (
              <div
                key={device.id}
                className="flex items-center justify-between gap-3 bg-background/70 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {device.name}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t(`mobileAccess.permissions.${device.permission}`)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => revokeDevice(device.id)}
                  disabled={isBusy}
                >
                  <Trash2 />
                  {t('mobileAccess.revoke')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

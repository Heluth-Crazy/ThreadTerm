import { useEffect, useState } from 'react';
import { Copy, Power, QrCode, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  isTauriEnv,
  mobileBridge,
  type BridgeDevice,
  type BridgeStatus,
  type PairQrResponse,
} from '../../lib/tauri-bridge';

type ActionState = 'idle' | 'busy' | 'failed';

const stoppedStatus: BridgeStatus = {
  running: false,
  host: null,
  port: null,
  url: null,
};

export function MobileAccessSettings() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<BridgeStatus>(stoppedStatus);
  const [pairQr, setPairQr] = useState<PairQrResponse | null>(null);
  const [devices, setDevices] = useState<BridgeDevice[]>([]);
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!isTauriEnv()) return;

    try {
      const [nextStatus, nextDevices] = await Promise.all([
        mobileBridge.status(),
        mobileBridge.devices(),
      ]);
      setStatus(nextStatus);
      setDevices(nextDevices);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const startBridge = async () => {
    setActionState('busy');
    setError(null);
    try {
      const nextStatus = await mobileBridge.start();
      const nextPairQr = await mobileBridge.pairQr(nextStatus.host ?? undefined);
      setStatus(nextStatus);
      setPairQr(nextPairQr);
      setDevices(await mobileBridge.devices());
      setActionState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setActionState('failed');
    }
  };

  const stopBridge = async () => {
    setActionState('busy');
    setError(null);
    try {
      setStatus(await mobileBridge.stop());
      setPairQr(null);
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

  const copyPairUrl = async () => {
    if (!pairQr?.url || !navigator.clipboard) return;
    await navigator.clipboard.writeText(pairQr.url);
  };

  const isBusy = actionState === 'busy';

  return (
    <section className="rounded-2xl border border-border/60 bg-card/72 p-4 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold text-foreground">
              {t('mobileAccess.title')}
            </h3>
            <span
              className={[
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                status.running
                  ? 'bg-green-500/10 text-green-600'
                  : 'bg-muted text-muted-foreground',
              ].join(' ')}
            >
              {status.running ? t('mobileAccess.running') : t('mobileAccess.stopped')}
            </span>
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
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              {status.url ?? `${status.host}:${status.port}`}
            </p>
          )}
          {error && (
            <p className="mt-2 text-xs text-destructive">
              {t('mobileAccess.error', { message: error })}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={status.running ? stopBridge : startBridge}
            disabled={!isTauriEnv() || isBusy}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Power className="h-3.5 w-3.5" />
            {status.running ? t('mobileAccess.stop') : t('mobileAccess.start')}
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={!isTauriEnv() || isBusy}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('mobileAccess.refresh')}
          </button>
        </div>
      </div>

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
              {pairQr && (
                <div className="mt-2 space-y-1">
                  <div className="font-mono text-sm text-foreground">
                    {pairQr.otp}
                  </div>
                  <div className="break-all font-mono text-[11px] text-muted-foreground">
                    {pairQr.url}
                  </div>
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={createPairQr}
                disabled={isBusy}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <QrCode className="h-3.5 w-3.5" />
                {t('mobileAccess.newPairCode')}
              </button>
              <button
                type="button"
                onClick={copyPairUrl}
                disabled={!pairQr?.url}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Copy className="h-3.5 w-3.5" />
                {t('mobileAccess.copyUrl')}
              </button>
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
                <button
                  type="button"
                  onClick={() => revokeDevice(device.id)}
                  disabled={isBusy}
                  className="inline-flex shrink-0 items-center justify-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('mobileAccess.revoke')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

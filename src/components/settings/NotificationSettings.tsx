import { useEffect, useRef, useState } from 'react';
import { BellRing, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import { isTauriEnv } from '../../lib/tauri-bridge';
import {
  createNotificationTestId,
  notificationTestActivationRegistry,
  sendOsNotification,
  type NotificationDeliveryReason,
  type NotificationDeliveryStatus,
  type NotificationIdentitySource,
} from '../../lib/notificationDelivery';
import { SettingsSection } from './SettingsSection';

type TestState =
  | 'idle'
  | 'sent'
  | 'clicked'
  | 'degraded'
  | 'disabled-by-system'
  | 'failed';

interface ReceiptDetail {
  readonly reason?: NotificationDeliveryReason;
  readonly identitySource?: NotificationIdentitySource;
}

function statusFromReceipt(status: NotificationDeliveryStatus): Exclude<TestState, 'idle' | 'clicked'> {
  if (status === 'accepted') return 'sent';
  return status;
}

export function NotificationSettings() {
  const { t } = useTranslation('settings');
  const [testState, setTestState] = useState<TestState>('idle');
  const [receiptDetail, setReceiptDetail] = useState<ReceiptDetail | null>(null);
  const [sending, setSending] = useState(false);
  const registrationRef = useRef<(() => void) | null>(null);
  const osNotificationsEnabled = useTerminalStore((state) => state.osNotificationsEnabled);
  const focusedCardId = useTerminalStore((state) => state.focusedCardId);

  useEffect(() => () => {
    registrationRef.current?.();
    registrationRef.current = null;
  }, []);

  const sendTestNotification = async () => {
    registrationRef.current?.();
    registrationRef.current = null;
    setSending(true);
    setTestState('idle');
    setReceiptDetail(null);

    if (!osNotificationsEnabled || !isTauriEnv()) {
      setTestState('disabled-by-system');
      setSending(false);
      return;
    }

    const notificationId = createNotificationTestId();
    let activationClicked = false;
    registrationRef.current = notificationTestActivationRegistry.register(
      notificationId,
      focusedCardId,
      () => {
        activationClicked = true;
        setTestState('clicked');
        registrationRef.current = null;
      },
    );

    try {
      const receipt = await sendOsNotification({
        notificationId,
        cardId: focusedCardId,
        title: t('notifications.testTitle'),
        body: t('notifications.testBody'),
      });
      // Native activation may arrive before the delivery promise resolves.
      // Once clicked, the user-visible state is terminal for this test and
      // must not be overwritten by the later accepted receipt.
      if (activationClicked) return;
      const nextState = statusFromReceipt(receipt.status);
      setReceiptDetail({
        reason: receipt.reason,
        identitySource: receipt.identitySource,
      });
      setTestState(nextState);
      if (nextState !== 'sent') {
        registrationRef.current?.();
        registrationRef.current = null;
      }
    } catch {
      // The shared adapter normally returns a failed receipt, but keep this
      // guard so a future adapter implementation cannot leave a registration.
      setTestState('failed');
      registrationRef.current?.();
      registrationRef.current = null;
    } finally {
      setSending(false);
    }
  };

  const statusKey: Record<Exclude<TestState, 'idle'>, string> = {
    sent: 'notifications.sent',
    clicked: 'notifications.clicked',
    degraded: 'notifications.degraded',
    'disabled-by-system': 'notifications.disabledBySystem',
    failed: 'notifications.failed',
  };
  const reasonKey: Record<NotificationDeliveryReason, string> = {
    'identity-unavailable': 'notifications.reason.identityUnavailable',
    'disabled-for-application': 'notifications.reason.disabledForApplication',
    'disabled-for-user': 'notifications.reason.disabledForUser',
    'disabled-by-group-policy': 'notifications.reason.disabledByGroupPolicy',
    'disabled-by-manifest': 'notifications.reason.disabledByManifest',
    'native-show-failed': 'notifications.reason.nativeShowFailed',
    'plugin-fallback-failed': 'notifications.reason.pluginFallbackFailed',
  };
  const identitySourceKey: Record<NotificationIdentitySource, string> = {
    'nsis-shortcut': 'notifications.identitySource.nsisShortcut',
    'runtime-registration': 'notifications.identitySource.runtimeRegistration',
  };

  return (
    <SettingsSection>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold text-foreground">
              {t('notifications.title')}
            </h3>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {t('notifications.description')}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {t('notifications.devModeHint')}
          </p>
          {!isTauriEnv() && (
            <p className="mt-2 text-xs text-warning">
              {t('notifications.desktopOnly')}
            </p>
          )}
          {testState !== 'idle' && (
            <div
              className={`mt-2 text-xs ${
                testState === 'failed' || testState === 'disabled-by-system'
                  ? 'text-destructive'
                  : 'text-success'
              }`}
              role="status"
              aria-live="polite"
            >
              <p>{t(statusKey[testState])}</p>
              {(receiptDetail?.reason || receiptDetail?.identitySource) && (
                <p className="mt-1 text-muted-foreground">
                  {[
                    receiptDetail.reason ? t(reasonKey[receiptDetail.reason]) : null,
                    receiptDetail.identitySource
                      ? t(identitySourceKey[receiptDetail.identitySource])
                      : null,
                  ].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void sendTestNotification()}
          disabled={sending}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          {sending ? t('notifications.sending') : t('notifications.sendTest')}
        </button>
      </div>
    </SettingsSection>
  );
}

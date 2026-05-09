import { useState } from 'react';
import { BellRing, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke, isTauriEnv } from '../../lib/tauri-bridge';

type TestState = 'idle' | 'sent' | 'failed';

export function NotificationSettings() {
  const { t } = useTranslation('settings');
  const [testState, setTestState] = useState<TestState>('idle');
  const [sending, setSending] = useState(false);

  const sendTestNotification = async () => {
    setSending(true);
    setTestState('idle');
    try {
      await invoke('notification_send_os', {
        title: t('notifications.testTitle'),
        body: t('notifications.testBody'),
        cardId: null,
      });
      setTestState('sent');
    } catch {
      setTestState('failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="rounded-[var(--radius)] border border-white/10 bg-white/5 backdrop-blur-md p-4 shadow-sm">
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
            <p className="mt-2 text-xs text-amber-600">
              {t('notifications.desktopOnly')}
            </p>
          )}
          {testState === 'sent' && (
            <p className="mt-2 text-xs text-green-600">
              {t('notifications.sent')}
            </p>
          )}
          {testState === 'failed' && (
            <p className="mt-2 text-xs text-destructive">
              {t('notifications.failed')}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={sendTestNotification}
          disabled={!isTauriEnv() || sending}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          {sending ? t('notifications.sending') : t('notifications.sendTest')}
        </button>
      </div>
    </section>
  );
}


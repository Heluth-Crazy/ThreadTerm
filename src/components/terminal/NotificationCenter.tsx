/**
 * NotificationCenter — right-side drawer that aggregates unread
 * "attention" events for all terminal cards.
 *
 * The bell button lives in the {@link TerminalManager} top bar; this
 * component is just the drawer contents. It is only mounted once in
 * {@link App} so animations and persisted state are shared across the
 * whole session.
 */
import { useMemo } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CheckCheck,
  Clock,
  Inbox,
  Trash2,
  X,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore';
import type { NotificationEntry, NotificationKind } from '../../types/terminal';
import { openNotificationTarget } from './notificationTarget';

const kindIconMap: Record<NotificationKind, typeof AlertTriangle> = {
  waiting: Clock,
  completed: CheckCircle2,
  failed: AlertTriangle,
  attention: Circle,
};

const kindToneMap: Record<NotificationKind, string> = {
  waiting: 'text-amber-500',
  completed: 'text-sky-500',
  failed: 'text-red-500',
  attention: 'text-muted-foreground',
};

function formatTime(
  ts: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const d = Date.now() - ts;
  if (d < 60_000) return t('card.justNow');
  if (d < 3_600_000) return t('card.ago', { time: `${Math.floor(d / 60_000)}m` });
  if (d < 86_400_000) return t('card.ago', { time: `${Math.floor(d / 3_600_000)}h` });
  return new Date(ts).toLocaleString();
}

export function NotificationCenter() {
  const { t } = useTranslation('terminal');
  const reduceMotion = useReducedMotion();
  const open = useTerminalStore((s) => s.notificationCentreOpen);
  const notifications = useTerminalStore((s) => s.notifications);
  const toggle = useTerminalStore((s) => s.toggleNotificationCentre);
  const markAll = useTerminalStore((s) => s.markAllNotificationsRead);
  const removeOne = useTerminalStore((s) => s.removeNotification);
  const clearAll = useTerminalStore((s) => s.clearNotifications);
  const cards = useTerminalStore((s) => s.cards);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  const cardNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of cards) map[c.id] = c.projectName;
    return map;
  }, [cards]);

  const handleClick = (n: NotificationEntry) => {
    if (openNotificationTarget(n.cardId)) {
      toggle(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="nc-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => toggle(false)}
            className="fixed inset-0 z-40 bg-black/30"
          />
          <motion.aside
            key="nc-drawer"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 flex h-full w-[360px] max-w-full flex-col border-l border-white/10 bg-background shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <Inbox className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">{t('notifications.title')}</h2>
                {unreadCount > 0 && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600">
                    {t('notifications.unread', { count: unreadCount })}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  title={t('notifications.markAllRead')}
                  onClick={markAll}
                  disabled={unreadCount === 0}
                  className="rounded-[var(--radius-md)] p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
                >
                  <CheckCheck className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title={t('notifications.clearAll')}
                  onClick={clearAll}
                  disabled={notifications.length === 0}
                  className="rounded-[var(--radius-md)] p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => toggle(false)}
                  className="rounded-[var(--radius-md)] p-1.5 hover:bg-accent hover:text-accent-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                  <Inbox className="h-10 w-10 opacity-50" />
                  <p className="text-sm">{t('notifications.emptyTitle')}</p>
                  <p className="text-[11px] opacity-70">
                    {t('notifications.emptyDescription')}
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {notifications.map((n) => {
                    const Icon = kindIconMap[n.kind];
                    const tone = kindToneMap[n.kind];
                    const projectName = cardNameById[n.cardId];
                    const missing = !projectName;
                    return (
                      <li
                        key={n.id}
                        onClick={() => handleClick(n)}
                        className={[
                          'group flex items-start gap-3 px-4 py-3 hover:bg-accent/40',
                          n.read ? 'opacity-70' : '',
                        ].join(' ')}
                      >
                        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <p className="truncate text-sm font-medium">{n.title}</p>
                            {!n.read && (
                              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                            )}
                          </div>
                          {n.body && (
                            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                              {n.body}
                            </p>
                          )}
                          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span>{formatTime(n.at, t)}</span>
                            {missing ? (
                              <span className="italic opacity-70">{t('notifications.cardClosed')}</span>
                            ) : (
                              <span className="truncate">· {projectName}</span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          title={t('notifications.dismiss')}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeOne(n.id);
                          }}
                          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

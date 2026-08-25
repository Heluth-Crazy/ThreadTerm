import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Circle, Clock, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminalStore } from '../../stores/terminalStore';
import type { NotificationEntry, NotificationKind } from '../../types/terminal';
import type { NotificationPresentationSnapshot } from '../../lib/notificationPresentation';
import { resolveNotificationTarget } from './notificationTarget';
import { describeCardSource, formatCardSourceLabel } from './notificationSource';
import { useNotificationPresentationController } from './NotificationPresentationProvider';

const EMPTY_SNAPSHOT: NotificationPresentationSnapshot = Object.freeze({
  visible: Object.freeze([]),
  queued: Object.freeze([]),
  background: Object.freeze([]),
  windowFocused: true,
  paused: false,
  hidden: false,
});

const noopSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY_SNAPSHOT;

const kindIconMap: Record<NotificationKind, typeof AlertTriangle> = {
  waiting: Clock,
  completed: CheckCircle2,
  failed: AlertTriangle,
  attention: Circle,
};

const kindToneMap: Record<NotificationKind, string> = {
  waiting: 'text-warning',
  completed: 'text-info',
  failed: 'text-destructive',
  attention: 'text-muted-foreground',
};

function formatNotificationTime(
  timestamp: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return t('card.justNow', { defaultValue: 'just now' });
  if (elapsed < 3_600_000) {
    return t('card.ago', {
      time: `${Math.floor(elapsed / 60_000)}m`,
      defaultValue: `${Math.floor(elapsed / 60_000)}m ago`,
    });
  }
  if (elapsed < 86_400_000) {
    return t('card.ago', {
      time: `${Math.floor(elapsed / 3_600_000)}h`,
      defaultValue: `${Math.floor(elapsed / 3_600_000)}h ago`,
    });
  }
  return new Date(timestamp).toLocaleString();
}

function targetFeedbackKeyForResult(result: { feedbackKey?: string }): string | null {
  return result.feedbackKey ?? null;
}

export interface NotificationToastStackProps {
  /** Blocking modal/palette state supplied by the owning terminal surface. */
  blocked?: boolean;
}

/**
 * Bottom-right, in-surface notification presentation. The controller owns
 * admission, FIFO order, timers, and lifecycle; this component only renders
 * the current immutable snapshot and forwards interaction signals.
 */
export function NotificationToastStack({ blocked = false }: NotificationToastStackProps) {
  const { t } = useTranslation('terminal');
  const reduceMotion = useReducedMotion();
  const controller = useNotificationPresentationController();
  const notificationCentreOpen = useTerminalStore((state) => state.notificationCentreOpen);
  const cards = useTerminalStore((state) => state.cards);
  const archivedCards = useTerminalStore((state) => state.archivedCards);
  const [feedback, setFeedback] = useState<{ id: string; message: string } | null>(null);

  const subscribe = controller?.subscribe ?? noopSubscribe;
  const getSnapshot = controller?.getSnapshot ?? emptySnapshot;
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const presentationBlocked = blocked || notificationCentreOpen;
  useEffect(() => {
    if (!controller) return;
    controller.setGlobalPresentationState({
      paused: presentationBlocked,
      hidden: presentationBlocked,
    });
  }, [controller, presentationBlocked]);

  useEffect(() => {
    if (!feedback) return undefined;
    const timer = window.setTimeout(() => setFeedback(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const sourceLabelByCardId = useMemo(() => {
    const translate = (key: string, fallback?: string) =>
      t(key, { defaultValue: fallback ?? key });
    const labels: Record<string, string> = {};
    for (const card of [...cards, ...archivedCards]) {
      labels[card.id] = formatCardSourceLabel(describeCardSource(card), translate);
    }
    return labels;
  }, [archivedCards, cards, t]);

  if (
    !controller ||
    presentationBlocked ||
    snapshot.hidden ||
    (snapshot.visible.length === 0 && !feedback)
  ) return null;

  const handleOpen = async (entry: NotificationEntry) => {
    setFeedback(null);
    const result = await resolveNotificationTarget(entry.id, entry.cardId);
    if (result.accepted) return;
    const feedbackKey = targetFeedbackKeyForResult(result);
    if (feedbackKey) {
      setFeedback({ id: entry.id, message: t(feedbackKey) });
    }
  };

  const handleEscape = (event: React.KeyboardEvent<HTMLElement>, id: string) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    controller.close(id);
  };

  const kindLabel = (kind: NotificationKind): string => {
    const fallback = kind.charAt(0).toUpperCase() + kind.slice(1);
    return t(`notifications.kind.${kind}`, { defaultValue: fallback });
  };

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
      data-testid="notification-toast-stack"
      aria-label={t('notifications.presentationLabel', {
        defaultValue: 'Terminal notifications',
      })}
      aria-live="polite"
    >
      <div className="absolute bottom-3 right-3 flex max-w-[min(22rem,calc(100%-1.5rem))] flex-col-reverse items-end gap-2">
        <AnimatePresence initial={false}>
          {snapshot.visible.map((item) => {
            const Icon = kindIconMap[item.entry.kind];
            const sourceLabel = item.entry.cardId.startsWith('system:')
              ? t('notifications.systemSource')
              : sourceLabelByCardId[item.entry.cardId] ?? t('notifications.cardClosed');
            const summary =
              item.summary ||
              t('notifications.presentationEmptySummary', {
                defaultValue: 'This terminal needs your attention.',
              });
            const title = item.entry.title || kindLabel(item.entry.kind);
            const bodyLabel = t('notifications.presentationOpen', {
              defaultValue: 'Open notification: {{title}}',
              title,
            });

            return (
              <motion.div
                key={item.id}
                layout
                initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
                transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
                className="pointer-events-auto flex w-full max-w-[22rem] items-stretch overflow-hidden rounded-xl border border-border/80 bg-card/95 text-card-foreground shadow-studio backdrop-blur-xl"
                data-testid={`notification-toast-${item.id}`}
                data-notification-id={item.id}
                onMouseEnter={() => controller.setItemHover(item.id, true)}
                onMouseLeave={() => controller.setItemHover(item.id, false)}
                onFocus={() => controller.setItemKeyboardFocus(item.id, true)}
                onBlur={(event) => {
                  const next = event.relatedTarget as Node | null;
                  if (!next || !event.currentTarget.contains(next)) {
                    controller.setItemKeyboardFocus(item.id, false);
                  }
                }}
                onKeyDown={(event) => handleEscape(event, item.id)}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  aria-label={bodyLabel}
                  onClick={() => void handleOpen(item.entry)}
                >
                  <span className="flex items-start gap-2">
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${kindToneMap[item.entry.kind]}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-semibold">{title}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {kindLabel(item.entry.kind)}
                        </span>
                      </span>
                      <span className="mt-1 block line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                        {summary}
                      </span>
                      <span className="mt-1 block truncate text-[10px] text-muted-foreground">
                        {formatNotificationTime(item.entry.at, t)} · {sourceLabel}
                      </span>
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="self-start rounded-md p-2 text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t('notifications.presentationClose', {
                    defaultValue: 'Dismiss notification',
                  })}
                  title={t('notifications.presentationClose', {
                    defaultValue: 'Dismiss notification',
                  })}
                  onClick={() => controller.close(item.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {feedback && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto max-w-[22rem] rounded-md border border-border bg-muted/90 px-3 py-2 text-[11px] text-muted-foreground shadow-sm"
            data-testid="notification-toast-feedback"
          >
            {feedback.message}
          </div>
        )}
      </div>
    </div>
  );
}

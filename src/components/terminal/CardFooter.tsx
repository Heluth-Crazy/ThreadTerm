import { memo, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Circle,
  Clock,
  Trash2,
} from 'lucide-react';
import type { TerminalCard as TerminalCardType, NotificationKind } from '../../types/terminal';
import type { AiCliSessionBadge } from './providerSession';
import { AiIntentSelect } from './AiIntentSelect';
import { CardActions, type CardActionDensity } from './CardActions';
import { AutoRestartStatus } from './AutoRestartStatus';
import { useTerminalStore } from '../../stores/terminalStore';

/** 最近通知标记的 kind 图标/色调 —— 与通知中心保持同一视觉语言。 */
const recentKindIconMap: Record<NotificationKind, typeof AlertTriangle> = {
  waiting: Clock,
  completed: CheckCircle2,
  failed: AlertTriangle,
  attention: Circle,
};

const recentKindToneMap: Record<NotificationKind, string> = {
  waiting: 'text-warning',
  completed: 'text-info',
  failed: 'text-destructive',
  attention: 'text-muted-foreground',
};

function formatRelativeShort(
  at: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const d = Date.now() - at;
  if (d < 60_000) return t('card.justNow');
  if (d < 3_600_000) return t('card.ago', { time: `${Math.floor(d / 60_000)}m` });
  if (d < 86_400_000) return t('card.ago', { time: `${Math.floor(d / 3_600_000)}h` });
  return new Date(at).toLocaleString();
}

export interface CardFooterProps {
  card: TerminalCardType;
  aiSessionBadge: AiCliSessionBadge | null;
  attentionHint: string | null;
  pinned: boolean;
  pinFull: boolean;
  onCopyCwd?: () => void;
  onOpenDir?: () => void;
  onTogglePin: () => void;
  onArchive?: () => void;
  autoRestartEnabled: boolean;
  autoRestartMaxRetries: number;
  onToggleAutoRestart: () => void;
  onChangeAutoRestartMaxRetries: (value: number) => void;
  onExportAiSession?: () => void;
  aiSessionExporting?: boolean;
  aiSessionExportStatus?: 'saved' | 'error' | null;
  onRename?: () => void;
  onClose?: () => void;
}

const stopPropagation = (fn?: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn?.();
};

export function getCardFooterDensity(width: number): CardActionDensity {
  if (width <= 0) return 'wide';
  if (width < 300) return 'narrow';
  if (width < 360) return 'compact';
  return 'wide';
}

function useCardFooterDensity() {
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [density, setDensity] = useState<CardActionDensity>('wide');

  useEffect(() => {
    const node = footerRef.current;
    if (!node) return;

    const updateDensity = (width: number) => {
      setDensity(getCardFooterDensity(width));
    };

    updateDensity(node.getBoundingClientRect().width);

    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => updateDensity(node.getBoundingClientRect().width);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.getBoundingClientRect().width;
      updateDensity(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { footerRef, density };
}

export const CardFooter = memo(function CardFooter({
  card,
  aiSessionBadge,
  attentionHint,
  pinned,
  pinFull,
  onCopyCwd,
  onOpenDir,
  onTogglePin,
  onArchive,
  autoRestartEnabled,
  autoRestartMaxRetries,
  onToggleAutoRestart,
  onChangeAutoRestartMaxRetries,
  onExportAiSession,
  aiSessionExporting,
  aiSessionExportStatus,
  onRename,
  onClose,
}: CardFooterProps) {
  const { t } = useTranslation('terminal');
  const { footerRef, density } = useCardFooterDensity();
  // Latest notification for this card (`notifications` is newest-first).
  // Entry identity is stable across unrelated store updates, so this
  // per-card subscription only re-renders when this card's mark changes.
  const recentNotification = useTerminalStore((s) =>
    s.notifications.find((n) => n.cardId === card.id),
  );
  const showInlineAiIntent = Boolean(aiSessionBadge && density === 'wide');
  const overflowAiIntent =
    aiSessionBadge && density !== 'wide' ? (
      <AiIntentSelect cardId={card.id} value={card.aiIntent} compact />
    ) : null;

  // Quick actions on the left, attention hint as a truncating middle band,
  // attention state in the middle, intent select + close on the right. Narrow
  // card widths move optional actions into the More menu so the close button
  // and core actions stay reachable.
  return (
    <div
      ref={footerRef}
      data-card-footer-density={density}
      className="flex shrink-0 items-center border-t border-border bg-muted/20 px-1 py-1.5 overflow-hidden sm:px-1.5"
    >
      <div className="flex shrink-0 items-center">
        <CardActions
          pinned={pinned}
          pinFull={pinFull}
          onRename={onRename}
          onCopyCwd={onCopyCwd}
          onOpenDir={onOpenDir}
          onTogglePin={onTogglePin}
          onArchive={onArchive}
          autoRestartEnabled={autoRestartEnabled}
          autoRestartMaxRetries={autoRestartMaxRetries}
          onToggleAutoRestart={onToggleAutoRestart}
          onChangeAutoRestartMaxRetries={onChangeAutoRestartMaxRetries}
          onExportAiSession={onExportAiSession}
          aiSessionExporting={aiSessionExporting}
          aiSessionExportStatus={aiSessionExportStatus}
          density={density}
          overflowContent={overflowAiIntent}
        />
      </div>

      <div
        className="flex min-w-0 flex-1 items-center justify-center px-0.5"
        title={
          recentNotification
            ? `${recentNotification.title} · ${formatRelativeShort(recentNotification.at, t)}`
            : attentionHint ?? undefined
        }
      >
        {card.status === 'failed' && attentionHint ? (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          </span>
        ) : recentNotification ? (
          // 最近通知标记：回到界面也能看出这张卡刚触发过通知。随通知条目
          // 一起过期（读后 2h 清理），已读后色调转灰不再抢注意力。
          (() => {
            const RecentIcon = recentKindIconMap[recentNotification.kind];
            const tone = recentNotification.read
              ? 'text-muted-foreground/70'
              : recentKindToneMap[recentNotification.kind];
            return (
              <span className={`inline-flex items-center gap-0.5 text-[11px] ${tone}`}>
                <RecentIcon className="h-3.5 w-3.5 shrink-0" />
              </span>
            );
          })()
        ) : attentionHint ? (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-warning">
            <BellRing className="h-3.5 w-3.5 shrink-0" />
            {/* Never show text hint in grid cards footer, icons are enough for small space */}
          </span>
        ) : null}
        <div className="shrink-0">
          <AutoRestartStatus card={card} />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 ml-auto">
        {showInlineAiIntent && (
          <div className="max-w-[70px] sm:max-w-none overflow-hidden">
            <AiIntentSelect cardId={card.id} value={card.aiIntent} compact />
          </div>
        )}
        <button
          type="button"
          title={t('card.close')}
          onClick={stopPropagation(onClose)}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
});

import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronRight,
  Clock,
  Inbox,
  PanelRightOpen,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NotificationKind, TerminalStatus } from '../types/terminal';
import type { PetCardSummary } from './petState';

interface PetPanelProps {
  cards: PetCardSummary[];
  unreadCount: number;
  onFocusCard: (cardId: string) => void;
  onOpenNotificationCenter: () => void;
}

const statusIconMap: Record<TerminalStatus, typeof Clock> = {
  idle: Clock,
  running: Clock,
  waiting: Bell,
  completed: CheckCircle2,
  failed: AlertTriangle,
};

const statusClassMap: Record<TerminalStatus, string> = {
  idle: 'text-muted-foreground',
  running: 'text-sky-500',
  waiting: 'text-amber-500',
  completed: 'text-emerald-500',
  failed: 'text-red-500',
};

const kindClassMap: Record<NotificationKind, string> = {
  waiting: 'text-amber-500',
  completed: 'text-sky-500',
  failed: 'text-red-500',
  attention: 'text-muted-foreground',
};

export function PetPanel({
  cards,
  unreadCount,
  onFocusCard,
  onOpenNotificationCenter,
}: PetPanelProps) {
  const { t } = useTranslation('settings');

  return (
    <section className="pet-panel glass-reflection" aria-label={t('desktopPet.panel.ariaLabel')}>
      <header className="pet-panel-header px-4 pt-4 pb-2" data-tauri-drag-region>
        <div className="flex flex-col gap-0.5" data-tauri-drag-region>
          <div className="flex items-center gap-2" data-tauri-drag-region>
            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            <span className="pet-panel-title tracking-tight" data-tauri-drag-region>
              ThreadTerm
            </span>
          </div>
          <div className="pet-panel-subtitle opacity-60 pl-3.5" data-tauri-drag-region>
            {unreadCount > 0
              ? t('desktopPet.panel.unread', { count: unreadCount })
              : t('desktopPet.panel.noUnread')}
          </div>
        </div>
      </header>

      <div className="pet-panel-list px-2 py-1">
        {cards.length === 0 ? (
          <div className="pet-empty py-12 flex flex-col items-center justify-center gap-3 opacity-40">
            <Inbox className="h-10 w-10 stroke-[1.5]" />
            <span className="text-[11px] font-medium tracking-wide uppercase">{t('desktopPet.panel.allClear')}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {cards.map((card) => {
              const Icon = statusIconMap[card.status];
              const tone = card.latestKind
                ? kindClassMap[card.latestKind]
                : statusClassMap[card.status];
              return (
                <button
                  type="button"
                  className="pet-card-row group relative overflow-hidden rounded-xl border border-transparent hover:border-white/10 hover:bg-white/5 transition-all duration-200"
                  key={card.id}
                  onClick={() => onFocusCard(card.id)}
                >
                  <div className={`absolute left-0 top-0 bottom-0 w-1 opacity-0 group-hover:opacity-100 transition-opacity ${tone.split(' ')[0] === 'text' ? tone.replace('text', 'bg') : 'bg-primary'}`} />
                  <div className="flex items-center gap-3 p-3">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 shrink-0 ${tone}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="pet-card-copy min-w-0 flex-1">
                      <div className="pet-card-title flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-bold tracking-tight">{card.projectName}</span>
                        {card.unreadCount > 0 && (
                          <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-black text-primary-foreground shadow-sm">
                            {card.unreadCount}
                          </span>
                        )}
                      </div>
                      <span className="pet-card-preview truncate text-[11px] opacity-50 font-medium">
                        {card.preview || card.projectPath}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="p-3 mt-auto">
        <button
          type="button"
          className="pet-panel-footer w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/10 transition-all group"
          onClick={onOpenNotificationCenter}
        >
          <PanelRightOpen className="h-4 w-4 opacity-50 group-hover:opacity-100 group-hover:scale-110 transition-all" />
          <span className="text-[11px] font-bold tracking-wide uppercase opacity-70 group-hover:opacity-100">{t('desktopPet.panel.viewAll')}</span>
        </button>
      </div>
    </section>
  );
}

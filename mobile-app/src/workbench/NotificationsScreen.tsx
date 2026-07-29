import { Bell, ChevronRight } from 'lucide-react';
import type { NotificationEntry } from '@shared/mobile/bridge/protocol';
import { useI18n } from '../i18n';
import { DetailScaffold, WorkbenchEmptyState } from './workbenchComponents';
import {
  formatRelativeTime,
  notificationKindLabel,
} from './workbenchPresentation';

export function NotificationsScreen({
  notifications,
  onBack,
  onOpenTerminal,
}: {
  notifications: NotificationEntry[];
  onBack: () => void;
  onOpenTerminal: (cardId: string) => void;
}) {
  const { language } = useI18n();
  const zh = language === 'zh';
  return (
    <DetailScaffold title={zh ? '通知' : 'Notifications'} onBack={onBack}>
      <div className="mobile-info-card">
        <strong>
          {zh ? '通知与工作台已合流' : 'Notifications feed Workbench'}
        </strong>
        <span>
          {zh
            ? '已读状态由桌面端管理；移动端当前提供完整历史和终端导航。'
            : 'Read state is managed on desktop; mobile provides history and terminal navigation.'}
        </span>
      </div>
      {notifications.length > 0 ? (
        <div className="notification-list">
          {notifications.map((entry) => (
            <button
              className={`notification-row ${entry.read === true ? 'read' : ''}`}
              type="button"
              key={entry.id}
              onClick={() => onOpenTerminal(entry.cardId)}
            >
              <i className="notification-unread-dot" />
              <span>
                <strong>
                  {entry.title || notificationKindLabel(entry.kind, zh)}
                </strong>
                <small>{entry.body || entry.message}</small>
                <time>{formatRelativeTime(entry.createdAt, zh)}</time>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      ) : (
        <WorkbenchEmptyState
          icon={<Bell size={22} />}
          title={zh ? '没有通知' : 'No notifications'}
          copy={
            zh
              ? '新的完成、异常和等待信号会出现在这里。'
              : 'New completion, failure and waiting signals appear here.'
          }
        />
      )}
    </DetailScaffold>
  );
}
